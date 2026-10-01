/**
 * Server-internal helpers for the public booking flow. Not "use server" —
 * these must NEVER be exposed as RPC endpoints, only invoked from server
 * components / server actions that have already validated the caller.
 *
 * Importantly, `findPatientByEmailForPrefill` returns PII and must only
 * be called from a context where the email has already been validated
 * against a verified Supabase session (`user.email_confirmed_at`).
 */
import "server-only";
// Cross-tenant prefill lookup, no single-tenant Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { isHoldingCapacity } from "@/lib/booking-capacity";
import {
  normalizeDocumentId,
  normalizePhoneForCompare,
  type PrefillPatient,
} from "@/lib/public-booking-types";

/**
 * Look up a Patient row across tenants by email and return the prefill
 * shape used by the booking wizard. The caller is responsible for proving
 * the email belongs to the requester (typically: a verified Supabase
 * session whose `email` matches).
 */
export async function findPatientByEmailForPrefill(
  email: string,
  opts: { tenantId?: string } = {}
): Promise<PrefillPatient | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  const row = await prisma.patient.findFirst({
    where: {
      email: { equals: trimmed, mode: "insensitive" },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    include: { coverages: { orderBy: { id: "desc" } }, emergency: true },
  });
  if (!row) return null;
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? trimmed,
    phone: row.phone ?? "",
    documentId: row.documentId ?? "",
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : "",
    coverageInsurer: row.coverages[0]?.insurer ?? "",
    coveragePlan: row.coverages[0]?.planName ?? "",
    emergencyName: row.emergency[0]?.name ?? "",
    emergencyPhone: row.emergency[0]?.phone ?? "",
    notes: "",
  };
}

// ──────────────────────────────────────────────────────────────────────
// Resolución de la ficha en la reserva pública (H4, A2b-S-pub)
// ──────────────────────────────────────────────────────────────────────

/** Nota que ve el kine en el turno cuando el contacto tipeado no es el de la ficha. */
export const PUBLIC_CONTACT_MISMATCH_NOTE =
  "Reserva online · datos de contacto distintos a la ficha";
/** Nota cuando la ficha nueva no pudo llevar el email/teléfono porque ya es de otra ficha. */
export const PUBLIC_SHARED_CONTACT_NOTE =
  "Reserva online · email o teléfono ya usado por otra ficha (¿familiar?): el contacto quedó en el turno";

export type PublicPatientInput = {
  firstName: string;
  lastName: string;
  email: string; // ya normalizado (trim + minúsculas) por el schema
  phone: string;
  documentId: string;
  dateOfBirth: Date;
  coverageInsurer?: string;
  coveragePlan?: string;
  emergencyName?: string;
  emergencyPhone?: string;
};

export type PublicPatientResolution = {
  patientId: string;
  created: boolean;
  /**
   * Contacto tipeado que NO quedó en la ficha: va al snapshot
   * `guestName/guestEmail/guestPhone` del turno para que el kine lo revise.
   */
  contactSnapshot: { guestName: string; guestEmail: string; guestPhone: string } | null;
  /** Líneas para la nota del turno (revisión del kine). */
  reviewNotes: string[];
};

function isP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Encuentra o crea la ficha de quien reserva online. Reglas (H4):
 *
 *   - **Match SOLO por DNI normalizado** (ya no por email): antes un
 *     `OR [email, documentId]` hacía que alguien que tipeara el email de un
 *     familiar reservara a nombre de la ficha del familiar.
 *   - **Nunca se parchea una ficha existente** (ni email, ni teléfono, ni
 *     "solo si estaba vacío"). Antes se completaban los campos nulos: un
 *     anónimo con el DNI de otro dejaba SU email en esa ficha y, al loguearse
 *     con Google, `/portal` y el prefill le mostraban la HC ajena (takeover).
 *     Si el contacto tipeado difiere, va al snapshot del turno + nota.
 *     Obra social y contacto de emergencia de una ficha existente tampoco se
 *     escriben (la cobertura cambia el copago): van a la nota.
 *   - **Ficha nueva con email/teléfono de otra ficha** (familia que comparte
 *     celular o mail; índices únicos `(tenantId, email|phone)`): se crea SIN el
 *     campo que choca y el contacto queda en el snapshot. Antes el P2002
 *     reventaba el submit (error boundary, datos perdidos).
 *   - Un P2002 por carrera (dos submits con el mismo DNI/contacto a la vez) se
 *     reintenta desde cero: la segunda vuelta ve la fila que ganó.
 *
 * Corre en el canal de servicio (sin Actor): el `tenantId` lo resolvió el
 * caller por slug y todas las queries lo filtran a mano.
 */
export async function resolvePublicPatient(
  tenantId: string,
  input: PublicPatientInput,
  opts: { practitionerId: string }
): Promise<PublicPatientResolution> {
  const dni = normalizeDocumentId(input.documentId);
  const fullName = `${input.firstName} ${input.lastName}`.trim();
  const snapshot = { guestName: fullName, guestEmail: input.email, guestPhone: input.phone };

  for (let attempt = 0; ; attempt++) {
    try {
      // Comparación contra la columna normalizada: una ficha cargada a mano
      // como "30.123.456" matchea "30123456". Primero las no archivadas.
      const hits = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Patient"
        WHERE "tenantId" = ${tenantId}
          AND upper(regexp_replace(coalesce("documentId", ''), '[^0-9A-Za-z]', '', 'g')) = ${dni}
        ORDER BY ("archivedAt" IS NOT NULL), "createdAt" ASC
        LIMIT 1`;

      if (hits.length > 0) {
        const p = await prisma.patient.findFirstOrThrow({
          where: { id: hits[0].id, tenantId },
          include: { coverages: true, emergency: true },
        });
        const reviewNotes: string[] = [];
        const contactDiffers =
          !sameText(p.email, input.email) ||
          normalizePhoneForCompare(p.phone) !== normalizePhoneForCompare(input.phone) ||
          !sameText(p.firstName, input.firstName) ||
          !sameText(p.lastName, input.lastName);
        if (contactDiffers) reviewNotes.push(PUBLIC_CONTACT_MISMATCH_NOTE);
        if (input.coverageInsurer) {
          const declared = [input.coverageInsurer, input.coveragePlan].filter(Boolean).join(" · ");
          const onFile = p.coverages.some((c) => sameText(c.insurer, input.coverageInsurer));
          if (!onFile) reviewNotes.push(`Obra social declarada online: ${declared}`);
        }
        if (input.emergencyName && input.emergencyPhone) {
          const onFile = p.emergency.some(
            (e) => normalizePhoneForCompare(e.phone) === normalizePhoneForCompare(input.emergencyPhone)
          );
          if (!onFile) {
            reviewNotes.push(`Contacto de emergencia declarado online: ${input.emergencyName} · ${input.emergencyPhone}`);
          }
        }
        return {
          patientId: p.id,
          created: false,
          contactSnapshot: contactDiffers ? snapshot : null,
          reviewNotes,
        };
      }

      // Ficha nueva: el email/teléfono que ya usa otra ficha del tenant no se
      // guarda en esta (quedan en el snapshot del turno).
      const [emailOwner, phoneOwner] = await Promise.all([
        prisma.patient.findFirst({
          where: { tenantId, email: { equals: input.email, mode: "insensitive" } },
          select: { id: true },
        }),
        prisma.patient.findFirst({ where: { tenantId, phone: input.phone }, select: { id: true } }),
      ]);
      const dropped = !!emailOwner || !!phoneOwner;

      const created = await prisma.$transaction(async (tx) => {
        const p = await tx.patient.create({
          data: {
            tenantId,
            firstName: input.firstName,
            lastName: input.lastName,
            email: emailOwner ? null : input.email,
            phone: phoneOwner ? null : input.phone,
            documentId: input.documentId.trim(),
            dateOfBirth: input.dateOfBirth,
            // Dueño = el profesional elegido. Sin esto la ficha quedaba sin
            // dueño y, con la regla "acceso básico = solo ver" (A2), el propio
            // kine del turno no podía confirmarlo ni cobrarlo.
            assignedPractitionerId: opts.practitionerId,
          },
          select: { id: true },
        });
        if (input.coverageInsurer) {
          await tx.coverage.create({
            data: {
              patientId: p.id,
              insurer: input.coverageInsurer.trim().replace(/\s+/g, " "),
              planName: input.coveragePlan || null,
            },
          });
        }
        if (input.emergencyName && input.emergencyPhone) {
          await tx.emergencyContact.create({
            data: { patientId: p.id, name: input.emergencyName, phone: input.emergencyPhone },
          });
        }
        return p;
      });

      return {
        patientId: created.id,
        created: true,
        contactSnapshot: dropped ? snapshot : null,
        reviewNotes: dropped ? [PUBLIC_SHARED_CONTACT_NOTE] : [],
      };
    } catch (e) {
      // Carrera con otro submit (mismo DNI, o el email/teléfono se ocupó entre
      // el chequeo y el INSERT): la vuelta siguiente ve la fila ganadora.
      if (isP2002(e) && attempt < 2) continue;
      throw e;
    }
  }
}

/**
 * El mismo paciente vuelve a reservar online el horario de SU reserva pública
 * vencida (revisión A2): abandonó Mercado Pago, volvió a los 40 min y el wizard
 * le ofrece el slot, porque la reserva vencida ya no retiene cupo. Pero la fila
 * PENDING/UNPAID vieja sigue ocupando el índice único parcial
 * `(tenantId, patientId, scheduledFor)` y el create chocaba (P2002) → "Ya tenés
 * un turno reservado en ese horario." sin salida (la key del wizard es nueva).
 *
 * Decisión: la vieja pasa a CANCELLED y el caller crea la nueva en la MISMA tx
 * (si el create falla, se deshace también la cancelación). Descartado:
 *   - reusar la fila vieja: puede ser de otro servicio/profesional (el índice
 *     es solo paciente + instante) y "renovar" la retención exigía pisar
 *     `createdAt`, que es el alta real del turno;
 *   - resolverlo en el catch del P2002: la tx ya quedó abortada.
 * Un pago tardío sobre la preferencia vieja llega al turno CANCELLED y el
 * webhook NO lo reactiva: registra el pago y avisa "Pago de un turno cancelado
 * · revisá el reembolso" (contrato de A2b-S-pub). Es el mismo camino que el de
 * cualquier reserva cancelada, auditable, y nunca deja dos turnos vivos.
 *
 * Solo toca una fila que (a) es de este tenant y paciente en ese instante, (b)
 * es reserva pública (`isPublicReservation`, por la key) y (c) ya no retiene
 * cupo. El `updateMany` repite las condiciones + `updatedAt`: si un webhook la
 * pagó en el medio, no la cancela (count 0) y el create choca como antes.
 * Devuelve el id cancelado, o null si no había nada que liberar.
 */
export async function releaseOwnExpiredPublicHold(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; patientId: string; scheduledFor: Date; now: Date }
): Promise<string | null> {
  const own = await tx.booking.findFirst({
    where: {
      tenantId: o.tenantId,
      patientId: o.patientId,
      scheduledFor: o.scheduledFor,
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      createdAt: true,
      patientId: true,
      idempotencyKey: true,
      updatedAt: true,
    },
  });
  if (!own || isHoldingCapacity(own, o.now)) return null;
  const res = await tx.booking.updateMany({
    where: {
      id: own.id,
      tenantId: o.tenantId,
      updatedAt: own.updatedAt,
      status: "PENDING",
      paymentStatus: { in: ["UNPAID", "FAILED"] },
    },
    data: { status: "CANCELLED" },
  });
  return res.count === 1 ? own.id : null;
}
