"use server";

/**
 * ES4 S24r · pedidos de cambio de «Mis datos» del portal, lado consultorio (brief ES4 §3.6, PLANES §12).
 *
 * El paciente pide desde el portal (S24d: `PatientChangeRequest`, nunca escribe Patient); acá el consultorio lo ve en
 * el perfil y lo aprueba o lo rechaza. Patrón de toda action: `getActor()` → `writableError` → zod → `where:{tenantId}`
 * a mano (en prod la conexión tiene BYPASSRLS) → `runWithRls`.
 *
 * - Gate: `patientAccessFor` ∈ {`admin`, `full`}. PD-13: la Secretaria es `admin` y aprueba contacto y cobertura (dato
 *   administrativo); el banner nunca muestra HC. `basic` → sin acceso. Soporte es `admin` (lee) pero `writableError`
 *   lo frena al decidir.
 * - CAS: `updateMany({id, tenantId, status:"PENDING", updatedAt: expected})` con count 1. El pedido lo puede reescribir
 *   el paciente mientras el consultorio lo mira (S24d hace UPDATE de la PENDING): aprobar con el `updatedAt` viejo
 *   aplicaría valores que nadie vio.
 * - Aprobar es UNA tx: CAS + ficha + contacto + cobertura + audit. Un P2002 de email/teléfono revierte todo (el pedido
 *   queda PENDING) y vuelve como «ya está en otra ficha».
 * - Audit con nombres de campo (`changedFieldNames`), nunca valores (son datos personales).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor, writableError } from "@/lib/session";
import { patientAccessFor } from "@/lib/visibility";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { readOnlyFailure } from "@/lib/read-only-result";
import { changedFieldNames } from "@/lib/portal-pending-changes";
import type { ActionResult } from "@/lib/validation";
import {
  applyPortalRequestInTx,
  coverageChangesOsInTx,
  coverageImpactInTx,
  countUnpaidCopagoBookingsInTx,
  emailApplies,
  parseStoredChanges,
  portalRequestUniqueError,
  PortalRequestInvalid,
  type PortalRequestRow,
} from "@/lib/patient-portal-requests-internal";

const COPY = {
  invalid: "Datos inválidos.",
  notFound: "Pedido no encontrado.",
  patientNotFound: "Paciente no encontrado.",
  forbidden: "No tenés acceso a los pedidos de este paciente.",
  stale: "El pedido cambió o ya lo resolvió otra persona. Recargá la ficha para ver la versión actual.",
  badChanges: "El pedido tiene datos que ya no son válidos: rechazalo y pedile al paciente que lo vuelva a enviar.",
} as const;

const Id = z.string().trim().min(1).max(64);

const ListInput = z.object({ patientId: Id }).strict();
const PreviewInput = z.object({ id: Id }).strict();
const DecideInput = z
  .object({
    id: Id,
    expectedUpdatedAt: z.string().datetime(),
    decision: z.enum(["APPROVE", "REJECT"]),
  })
  .strict();

const canDecide = (level: string) => level === "admin" || level === "full";

/** Pedidos PENDING de la ficha (a lo sumo uno: único parcial `PatientChangeRequest_patient_pending_key`). */
export async function listPatientPortalRequests(input: { patientId: string }): Promise<ActionResult<PortalRequestRow[]>> {
  const actor = await getActor();
  const parsed = ListInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { patientId } = parsed.data;

  type Outcome = { kind: "notfound" } | { kind: "forbidden" } | { kind: "ok"; rows: PortalRequestRow[] };
  const out = await runWithRls(actor.tenantId, async (tx): Promise<Outcome> => {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, tenantId: actor.tenantId },
      select: {
        id: true,
        userId: true,
        phone: true,
        email: true,
        emergency: { orderBy: { id: "asc" }, take: 1, select: { name: true, relation: true, phone: true } },
        coverages: { orderBy: { id: "desc" }, take: 1, select: { insurer: true, planName: true, memberId: true } },
      },
    });
    if (!patient) return { kind: "notfound" };
    if (!canDecide(await patientAccessFor(actor, patientId, tx))) return { kind: "forbidden" };

    const requests = await tx.patientChangeRequest.findMany({
      where: { tenantId: actor.tenantId, patientId, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true, changes: true, requestedByUserId: true, createdAt: true, updatedAt: true },
    });
    const cov = patient.coverages[0] ?? null;
    const rows: PortalRequestRow[] = [];
    for (const r of requests) {
      const changes = parseStoredChanges(r.changes);
      rows.push({
        id: r.id,
        updatedAt: r.updatedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        fields: changes ? changedFieldNames(changes) : [],
        changes,
        current: {
          phone: patient.phone,
          email: patient.email,
          emergencyContact: patient.emergency[0] ?? null,
          coverage: cov ? { insurerName: cov.insurer, planName: cov.planName, memberId: cov.memberId } : null,
        },
        emailApplies: emailApplies(patient.userId, r.requestedByUserId),
        osChanges: changes?.coverage
          ? await coverageChangesOsInTx(tx, actor.tenantId, patientId, changes.coverage)
          : false,
      });
    }
    return { kind: "ok", rows };
  });
  if (out.kind === "notfound") return { ok: false, error: COPY.patientNotFound };
  if (out.kind === "forbidden") return { ok: false, error: COPY.forbidden };
  return { ok: true, data: out.rows };
}

/**
 * Impacto de aprobar: si cambia la OS, cuántos turnos impagos cobran el copago de la cobertura y si se borra un copago
 * propio cargado (`ownCopagoCents`, ES4-Z M2: antes se borraba sin preguntar cuando no había turnos impagos). La UI lo
 * pide con `useConfirm`. Solo lectura. `decidePatientPortalRequest` lo recalcula en su tx.
 */
export async function previewPortalRequestImpact(input: {
  id: string;
}): Promise<ActionResult<{ osChanges: boolean; unpaidCopagoBookings: number; ownCopagoCents: number | null }>> {
  const actor = await getActor();
  const parsed = PreviewInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { id } = parsed.data;

  type Outcome =
    | { kind: "notfound" }
    | { kind: "forbidden" }
    | { kind: "ok"; osChanges: boolean; unpaidCopagoBookings: number; ownCopagoCents: number | null };
  const out = await runWithRls(actor.tenantId, async (tx): Promise<Outcome> => {
    const req = await tx.patientChangeRequest.findFirst({
      where: { id, tenantId: actor.tenantId, status: "PENDING" },
      select: { patientId: true, changes: true },
    });
    if (!req) return { kind: "notfound" };
    if (!canDecide(await patientAccessFor(actor, req.patientId, tx))) return { kind: "forbidden" };
    const changes = parseStoredChanges(req.changes);
    const { osChanges, ownCopagoCents } = await coverageImpactInTx(
      tx,
      actor.tenantId,
      req.patientId,
      changes?.coverage
    );
    const unpaidCopagoBookings = osChanges
      ? await countUnpaidCopagoBookingsInTx(tx, actor.tenantId, req.patientId)
      : 0;
    return { kind: "ok", osChanges, unpaidCopagoBookings, ownCopagoCents };
  });
  if (out.kind === "notfound") return { ok: false, error: COPY.notFound };
  if (out.kind === "forbidden") return { ok: false, error: COPY.forbidden };
  return {
    ok: true,
    data: { osChanges: out.osChanges, unpaidCopagoBookings: out.unpaidCopagoBookings, ownCopagoCents: out.ownCopagoCents },
  };
}

/** Aprobar o rechazar un pedido (brief ES4 §3.6). */
export async function decidePatientPortalRequest(input: {
  id: string;
  expectedUpdatedAt: string;
  decision: "APPROVE" | "REJECT";
}): Promise<ActionResult<{ unpaidCopagoBookings: number }>> {
  const actor = await getActor();
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const parsed = DecideInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { id, expectedUpdatedAt, decision } = parsed.data;
  const expected = new Date(expectedUpdatedAt);

  type Outcome =
    | { kind: "notfound" }
    | { kind: "forbidden" }
    | { kind: "stale" }
    | { kind: "invalid"; error: string }
    | { kind: "ok"; patientId: string; unpaidCopagoBookings: number };

  let out: Outcome;
  try {
    out = await runWithRls(actor.tenantId, async (tx): Promise<Outcome> => {
      const req = await tx.patientChangeRequest.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { patientId: true, status: true, updatedAt: true, changes: true, requestedByUserId: true },
      });
      if (!req) return { kind: "notfound" };
      if (!canDecide(await patientAccessFor(actor, req.patientId, tx))) return { kind: "forbidden" };
      if (req.status !== "PENDING" || +req.updatedAt !== +expected) return { kind: "stale" };

      const changes = parseStoredChanges(req.changes);
      if (decision === "APPROVE" && !changes) return { kind: "invalid", error: COPY.badChanges };

      // CAS: el `updatedAt` que vio el consultorio en el WHERE (READ COMMITTED: si el portal reescribió el pedido entre
      // el SELECT y acá, count = 0 → stale en vez de aprobar valores que nadie vio).
      const cas = await tx.patientChangeRequest.updateMany({
        where: { id, tenantId: actor.tenantId, status: "PENDING", updatedAt: expected },
        data: {
          status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
          decidedById: actor.userId,
          decidedAt: new Date(),
        },
      });
      if (cas.count !== 1) return { kind: "stale" };

      const fields = changes ? changedFieldNames(changes) : [];
      if (decision === "REJECT") {
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "patient.portalRequest.reject",
          entity: "Patient",
          entityId: req.patientId,
          payload: { requestId: id, fields },
        });
        return { kind: "ok", patientId: req.patientId, unpaidCopagoBookings: 0 };
      }

      const patient = await tx.patient.findFirst({
        where: { id: req.patientId, tenantId: actor.tenantId },
        select: { userId: true },
      });
      if (!patient) return { kind: "notfound" };
      const applied = await applyPortalRequestInTx(
        tx,
        { tenantId: actor.tenantId, patientId: req.patientId },
        changes!,
        { emailApplies: emailApplies(patient.userId, req.requestedByUserId) }
      );
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "patient.portalRequest.approve",
        entity: "Patient",
        entityId: req.patientId,
        payload: {
          requestId: id,
          fields: applied.fields,
          applied: applied.applied,
          ...(applied.skipped.length ? { skipped: applied.skipped } : {}),
          osChanged: applied.osChanged,
          copagoReset: applied.copagoReset,
          unpaidCopagoBookings: applied.unpaidCopagoBookings,
        },
      });
      return { kind: "ok", patientId: req.patientId, unpaidCopagoBookings: applied.unpaidCopagoBookings };
    });
  } catch (e) {
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    const dup = portalRequestUniqueError(e);
    if (dup) return { ok: false, error: dup };
    if (e instanceof PortalRequestInvalid) return { ok: false, error: e.message };
    // ES4-Z (B5): sin `e.message` — un error de Prisma o de validación puede traer valores del pedido (teléfono,
    // email). Alcanza con el nombre y el código para encontrarlo.
    logger.error("patient.portalRequest.decide.failed", {
      name: e instanceof Error ? e.name : typeof e,
      code: e instanceof Prisma.PrismaClientKnownRequestError ? e.code : undefined,
    });
    throw e;
  }

  if (out.kind === "notfound") return { ok: false, error: COPY.notFound };
  if (out.kind === "forbidden") return { ok: false, error: COPY.forbidden };
  if (out.kind === "stale") return { ok: false, error: COPY.stale };
  if (out.kind === "invalid") return { ok: false, error: out.error };
  revalidatePath(`/pacientes/${out.patientId}`);
  revalidatePath("/pacientes");
  if (decision === "APPROVE") revalidatePath("/agenda");
  return { ok: true, data: { unpaidCopagoBookings: out.unpaidCopagoBookings } };
}
