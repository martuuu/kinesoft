import "server-only";
import type { Prisma } from "@prisma/client";
import { capabilitiesForActor } from "@/lib/authz";
import { canReadClinicalNotes, canWriteClinicalNotes, permissionsFor } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import { patientAccessFor, type AccessLevel } from "@/lib/visibility";

/**
 * EV2 (C-EV2-3) · Núcleo server-only de evoluciones: el gate único y la proyección de la nota. Lo usan las escrituras
 * (`lib/clinical-notes.ts`), las lecturas (`lib/clinical-notes-read.ts`) y la impresión (`-print-internal.ts`), para que
 * ninguna superficie decida «quién ve la HC» por su cuenta (el error clásico: una que se olvida de `clinical.read` y le
 * abre la evolución a la Secretaria, que tiene acceso `admin` a todos los pacientes).
 */

export type ClinicalNoteGate = {
  access: AccessLevel;
  canRead: boolean;
  canWrite: boolean;
  /** OWNER con `clinical` (EV2-D15). El ADMIN nunca (§20.17). */
  isClinicalOwner: boolean;
};

const CLOSED_GATE: ClinicalNoteGate = { access: "none", canRead: false, canWrite: false, isClinicalOwner: false };

/**
 * Gate único: módulo `evoluciones` (`modulesFor(actor.entitlements)`), caps de `capabilitiesForActor(actor)` (0
 * queries: sale de `actor.membership`; soporte = SUPPORT_CAPS, sin clínico) y `patientAccessFor(actor, patientId, tx)`.
 * Paciente de otro consultorio → access "none" → todo false.
 *
 * Sin el módulo no se toca la base (mismo orden que los gates de Planes, lib/plan-authz-internal.ts): todo cerrado y
 * access "none". `isClinicalOwner` exige además poder leer: un Titular sin acceso `full` a ESTE paciente no anula.
 */
export async function clinicalNoteGateInTx(tx: DbClient, actor: Actor, patientId: string): Promise<ClinicalNoteGate> {
  if (!modulesFor(actor.entitlements).has("evoluciones")) return CLOSED_GATE;
  const [caps, access] = await Promise.all([capabilitiesForActor(actor), patientAccessFor(actor, patientId, tx)]);
  const canRead = canReadClinicalNotes(caps, access);
  return {
    access,
    canRead,
    canWrite: canWriteClinicalNotes(caps, access, actor.practitionerId),
    // Titular = `account.owner` (solo el OWNER lo tiene; SUPPORT_CAPS nunca `account.*`), sin comparar el rol (guard
    // PL-1b). Clínico = `canRead`: `clinical.read` sale de `isClinicalMember`, que deja afuera al ADMIN (nunca atiende,
    // §20.17) y al Titular que no atiende.
    isClinicalOwner: canRead && caps.has("account.owner"),
  };
}

/** `select` único de la nota + proyección mínima del turno (escalares + booking.service.name). Sin `idempotencyKey`. */
export const CLINICAL_NOTE_SELECT = {
  id: true,
  patientId: true,
  bookingId: true,
  amendsNoteId: true,
  kind: true,
  title: true,
  body: true,
  occurredAt: true,
  authorUserId: true,
  authorPractitionerId: true,
  authorName: true,
  revision: true,
  voidedAt: true,
  voidedByUserId: true,
  voidReason: true,
  createdAt: true,
  updatedAt: true,
  booking: {
    select: { id: true, scheduledFor: true, status: true, service: { select: { name: true } } },
  },
} as const satisfies Prisma.ClinicalNoteSelect;

export type ClinicalNoteSelected = Prisma.ClinicalNoteGetPayload<{ select: typeof CLINICAL_NOTE_SELECT }>;

export function toClinicalNoteDTO(
  row: ClinicalNoteSelected,
  ctx: { actorUserId: string; isClinicalOwner: boolean; canWrite: boolean; now: Date }
): ClinicalNoteDTO {
  // El CHECK de anulación es todo o nada; igual se exige el trío para no inventar un `voided` a medias.
  const voided =
    row.voidedAt && row.voidedByUserId && row.voidReason != null
      ? { at: row.voidedAt.toISOString(), byUserId: row.voidedByUserId, reason: row.voidReason }
      : null;
  return {
    id: row.id,
    patientId: row.patientId,
    bookingId: row.bookingId,
    amendsNoteId: row.amendsNoteId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    occurredAt: row.occurredAt.toISOString(),
    author: { userId: row.authorUserId, practitionerId: row.authorPractitionerId, name: row.authorName },
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    voided,
    booking: row.booking
      ? {
          id: row.booking.id,
          scheduledFor: row.booking.scheduledFor.toISOString(),
          status: row.booking.status,
          serviceName: row.booking.service?.name ?? null,
        }
      : null,
    permissions: permissionsFor(
      { authorUserId: row.authorUserId, createdAt: row.createdAt, voidedAt: row.voidedAt, amendsNoteId: row.amendsNoteId },
      ctx
    ),
  };
}
