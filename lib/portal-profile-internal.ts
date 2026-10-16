import "server-only";
/**
 * ES4 S24d · «Mis datos» del portal: lectura del perfil y escritura del pedido de cambio (brief §4 fila S24d, §3.5).
 *
 * Por qué el portal NO escribe la ficha: el teléfono, el email, el contacto de emergencia y la obra social los usa el
 * consultorio para cobrar (la cobertura decide el copago, `lib/copago.ts`) y para avisar. Un cambio directo desde el
 * portal cambiaría el copago de turnos impagos sin que nadie lo vea. El paciente deja un pedido
 * (`PatientChangeRequest` PENDING, M1) y el consultorio lo aprueba o lo rechaza (S24r). Lo fija el test de grep de
 * `tests/integration/portal-profile.test.ts`.
 *
 * Canal `prismaService` (BYPASSRLS, sin Actor): cada query lleva el par `tenantId` + `patientId` que sale de
 * `requirePortalPatient` / `listPortalPatients` (nunca de la entrada).
 *
 * Una sola PENDING por ficha (único parcial `PatientChangeRequest_patient_pending_key`, M1). Escritura:
 *   1. se lee la PENDING;
 *   2. sin PENDING → INSERT; si otra request la creó en el medio, el INSERT tira P2002 del parcial → se reintenta y la
 *      segunda vuelta la encuentra y hace UPDATE;
 *   3. con PENDING → UPDATE con CAS de `updatedAt` (`updateMany` con count 1): si el consultorio la decidió o la pisó
 *      otra pestaña entre la lectura y el write, count 0 → se reintenta sobre lo que haya ahora.
 *   Máximo 3 vueltas; después «probá de nuevo» (nunca un 500).
 * El UPDATE FUSIONA por campo (lo nuevo pisa lo viejo, lo que no se toca queda): pedir el teléfono y después la obra
 * social deja un pedido con los dos, no solo el último. Si lo guardado no valida contra el contrato (no debería: solo
 * lo escribe esta función), se reemplaza en vez de arrastrarlo.
 */
import { Prisma } from "@prisma/client";
// Superficie del paciente, sin Actor: canal service (BYPASSRLS). Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { getPortalUser, listPortalPatients, type PortalPatientRef } from "@/lib/portal-identity-internal";
import {
  PortalPendingChanges,
  changedFieldNames,
  type PortalPendingChangesT,
} from "@/lib/portal-pending-changes";
import type { PortalProfileDTO } from "@/lib/portal-profile-types";

/** Vueltas del CAS antes de rendirse. Tres alcanzan para dos carreras seguidas; más sería un loop contra un bug. */
const MAX_ATTEMPTS = 3;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Lo nuevo pisa lo viejo campo por campo; si lo guardado no cumple el contrato, se descarta. */
export function mergePendingChanges(stored: unknown, next: PortalPendingChangesT): PortalPendingChangesT {
  const prev = PortalPendingChanges.safeParse(stored);
  return prev.success ? { ...prev.data, ...next } : next;
}

export type PendingWriteResult =
  | { ok: true; mode: "created" | "updated"; fields: string[] }
  | { ok: false; reason: "busy" | "invalid" };

/** Escribe el pedido de cambio de la ficha del ref (INSERT o UPDATE de la PENDING, con CAS). Nunca toca `Patient`. */
export async function upsertPendingChangeRequest(
  ref: Pick<PortalPatientRef, "tenantId" | "patientId" | "userId">,
  changes: PortalPendingChangesT
): Promise<PendingWriteResult> {
  const { tenantId, patientId, userId } = ref;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await prisma.patientChangeRequest.findFirst({
      where: { tenantId, patientId, status: "PENDING" },
      select: { id: true, changes: true, updatedAt: true },
    });

    if (!current) {
      try {
        await prisma.patientChangeRequest.create({
          data: { tenantId, patientId, changes: changes as Prisma.InputJsonValue, requestedByUserId: userId },
        });
        return { ok: true, mode: "created", fields: changedFieldNames(changes) };
      } catch (e) {
        // Otra request creó la PENDING entre la lectura y el INSERT (único parcial): la próxima vuelta la actualiza.
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }

    // La fusión vuelve a pasar por el contrato: dos pedidos chicos podrían, juntos, pasarse del tope de bytes.
    const merged = PortalPendingChanges.safeParse(mergePendingChanges(current.changes, changes));
    if (!merged.success) return { ok: false, reason: "invalid" };
    const { count } = await prisma.patientChangeRequest.updateMany({
      where: { id: current.id, tenantId, patientId, status: "PENDING", updatedAt: current.updatedAt },
      data: { changes: merged.data as Prisma.InputJsonValue, requestedByUserId: userId },
    });
    if (count === 1) return { ok: true, mode: "updated", fields: changedFieldNames(merged.data) };
    // count 0: la decidió el consultorio o la cambió otra pestaña → otra vuelta sobre el estado nuevo.
  }
  return { ok: false, reason: "busy" };
}

/**
 * DTO de «Mis datos» (allowlist del contrato §3.5): cuenta, consultorios vinculados y nombres de los campos con un
 * pedido abierto. null = sin sesión verificada. Staff → sin consultorios (AUDIT §5.22: staff ≠ paciente).
 */
export async function loadPortalProfile(): Promise<PortalProfileDTO | null> {
  const me = await getPortalUser();
  if (!me) return null;
  const refs = me.isStaff ? [] : await listPortalPatients(me.id);
  const bySlug = new Map(refs.map((r) => [r.patientId, r.tenant.slug]));
  const pendingRows = refs.length
    ? await prisma.patientChangeRequest.findMany({
        // Pares (tenantId, patientId) de las fichas vinculadas: nunca solo por patientId.
        where: { status: "PENDING", OR: refs.map((r) => ({ tenantId: r.tenantId, patientId: r.patientId })) },
        select: { patientId: true, changes: true, updatedAt: true },
      })
    : [];

  return {
    email: me.email,
    fullName: me.fullName,
    tenants: refs.map((r) => ({
      slug: r.tenant.slug,
      name: r.tenant.name,
      patientName: `${r.patient.firstName} ${r.patient.lastName}`.trim(),
      // Turnero prendido Y consultorio abierto: con el consultorio suspendido el turnero tampoco toma reservas, y un
      // «Reservar turno» que termina en «no disponible» es peor que no mostrarlo.
      canBook: r.modules.has("turneroPublico") && r.surfacesOpen,
    })),
    pending: pendingRows.flatMap((row) => {
      const slug = bySlug.get(row.patientId);
      const parsed = PortalPendingChanges.safeParse(row.changes);
      if (!slug || !parsed.success) return [];
      return [{ slug, fields: changedFieldNames(parsed.data), updatedAt: row.updatedAt.toISOString() }];
    }),
  };
}
