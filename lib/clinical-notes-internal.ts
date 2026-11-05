import "server-only";
import type { Prisma } from "@prisma/client";
import { capabilitiesForActor } from "@/lib/authz";
import { canReadClinicalNotes, canWriteClinicalNotes, permissionsFor } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO, ImportSourceDTO } from "@/lib/clinical-notes-types";
import { isLateEntry } from "@/lib/diagnoses-logic";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { HcDoc } from "@/lib/hc-doc";
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
    // Titular = `account.manage` (el principal y el co-titular; SUPPORT_CAPS nunca `account.*`), sin comparar el rol
    // (guard PL-1b). CT-INT (CF3b, H3): era `account.owner`, que desde CT-K1 es SOLO el principal; anular/corregir
    // evoluciones ajenas (EV2-D15, «el Titular clínico») es de las funciones que comparte con el co-titular.
    // Clínico = `canRead`: `clinical.read` sale de `isClinicalMember`, que deja afuera al ADMIN (nunca atiende,
    // §20.17) y al Titular que no atiende.
    isClinicalOwner: canRead && caps.has("account.manage"),
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
  // FC (M14, C-FC3): contenido (bodyDoc, diagnoses) e identidad (authorLicense, importSource) de la ficha.
  bodyDoc: true,
  diagnoses: true,
  authorLicense: true,
  importSource: true,
  booking: {
    select: { id: true, scheduledFor: true, status: true, service: { select: { name: true } } },
  },
} as const satisfies Prisma.ClinicalNoteSelect;

export type ClinicalNoteSelected = Prisma.ClinicalNoteGetPayload<{ select: typeof CLINICAL_NOTE_SELECT }>;

/**
 * FC · `importSource` guardado (`{v:1, ...ImportSourceInput, importedAt}`, regla 4 de C-FC3) → DTO. Solo lo que la UI
 * muestra («Importada de informe.docx · parte 2 de 3»): `fileSize`, `fileLastModified` y `batchId` quedan en la base
 * (auditoría del import), no viajan al cliente. Forma inesperada → null (mejor sin marca que un 500 en la HC).
 */
function toImportSourceDTO(raw: Prisma.JsonValue | null): ImportSourceDTO | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, Prisma.JsonValue>;
  if (o.kind !== "docx" || typeof o.fileName !== "string" || typeof o.importedAt !== "string") return null;
  const part = typeof o.part === "number" ? o.part : 1;
  const parts = typeof o.parts === "number" ? o.parts : 1;
  return { kind: "docx", fileName: o.fileName, importedAt: o.importedAt, part, parts };
}

/**
 * `bodyDoc` y `diagnoses` se guardan YA re-armados por el server (`validateHcDoc`, `resolveDiagnosesInTx`) y la base
 * los acota con CHECK (M14): acá solo se tipan, no se re-validan en cada lectura (la timeline lee hasta 50 por página).
 */
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
    bodyDoc: (row.bodyDoc as HcDoc | null) ?? null,
    diagnoses: Array.isArray(row.diagnoses) ? (row.diagnoses as unknown as DiagnosisSnapshot[]) : [],
    authorLicense: row.authorLicense,
    importSource: toImportSourceDTO(row.importSource),
    lateEntry: isLateEntry({ importSource: row.importSource, createdAt: row.createdAt, occurredAt: row.occurredAt }),
    // [FC-2b] lo llena la lectura con el LEFT JOIN LATERAL del documento vivo (C-FC3 «Lecturas»); hasta entonces, null.
    sharedDocument: null,
  };
}
