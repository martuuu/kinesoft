import "server-only";
import type { Prisma } from "@prisma/client";
import { auditSecurityEvent } from "@/lib/audit";
import { CLINICAL_NOTE_SELECT, clinicalNoteGateInTx, toClinicalNoteDTO } from "@/lib/clinical-notes-internal";
import { CLINICAL_NOTE_KIND_LABEL, CLINICAL_RECORD_PRINT_MAX, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_PRINT_MAX_ENTRIES, type HcPrintEntryRow } from "@/lib/hc-print-internal";
import { type DbClient, runWithRls } from "@/lib/rls";
import type { Actor } from "@/lib/session";

/**
 * EV2-3d (C-EV2-6, EV2-D11) · «Imprimir historia clínica».
 *
 * Imprimir saca la HC entera del sistema (papel, PDF, mail): es el equivalente clínico de exportar, así que se
 * audita como evento de seguridad (`clinicalRecord.print`, allowlist de `lib/audit.ts`) y **falla cerrado**: si el
 * audit no se escribe, esta función tira y el caller no recibe ni una nota. Por eso el audit va DESPUÉS de leer
 * (para registrar el `count` real) pero ANTES del `return`: no hay camino que devuelva datos sin evento.
 *
 * El gate es el único de evoluciones (`clinicalNoteGateInTx`, C-EV2-3): `canRead` = `clinical.read` + acceso `full`.
 * La Secretaria (acceso `admin` a todos los pacientes), Facturación, soporte, el ADMIN, el Titular que no atiende y
 * un paciente de otro consultorio dan null **sin auditar**: no hubo impresión, y un evento por cada intento sin
 * acceso solo sería ruido (el 404 de la página no distingue «no existe» de «no podés»).
 *
 * El audit va por `auditSecurityEvent` (tx propia del canal service) y no por `auditInTx` dentro de `runWithRls`:
 * leer no tiene write al que atarse (PL-D13) y así funciona también con el consultorio en solo lectura.
 */
export type ClinicalRecordPrint = {
  patient: { firstName: string; lastName: string; documentId: string | null; dateOfBirth: string | null };
  tenantName: string;
  printedAt: string;
  printedBy: string;
  notes: ClinicalNoteDTO[]; // raíces y enmiendas, anuladas incluidas (marcadas), orden cronológico
  truncated: boolean; // > CLINICAL_RECORD_PRINT_MAX
};

/** Gate `canRead`; `auditSecurityEvent({ action: "clinicalRecord.print", entity: "Patient", entityId, payload: { count } })`
 *  ANTES de devolver datos (falla cerrado: sin audit no hay impresión). null sin acceso. */
export async function loadClinicalRecordForPrint(actor: Actor, patientId: string): Promise<ClinicalRecordPrint | null> {
  const now = new Date();
  const loaded = await runWithRls(actor.tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    const patient = await tx.patient.findFirst({
      where: { id: patientId, tenantId: actor.tenantId },
      select: { firstName: true, lastName: true, documentId: true, dateOfBirth: true },
    });
    if (!patient) return null;
    // Con más de CLINICAL_RECORD_PRINT_MAX se imprimen las MÁS RECIENTES (lo que sirve en la consulta o la
    // derivación); la página avisa que el resto sale por el export del consultorio. Se trae una de más para saber
    // si hubo corte sin un `count` aparte. Desempate estable: `createdAt`, después `id`.
    const rows = await tx.clinicalNote.findMany({
      where: { tenantId: actor.tenantId, patientId },
      select: CLINICAL_NOTE_SELECT,
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: CLINICAL_RECORD_PRINT_MAX + 1,
    });
    const truncated = rows.length > CLINICAL_RECORD_PRINT_MAX;
    // `canWrite: false`: la impresión es de solo lectura; los `permissions` del DTO no habilitan nada acá.
    const ctx = { actorUserId: actor.userId, isClinicalOwner: gate.isClinicalOwner, canWrite: false, now };
    const notes = rows
      .slice(0, CLINICAL_RECORD_PRINT_MAX)
      .reverse()
      .map((r) => toClinicalNoteDTO(r, ctx));
    return { patient, notes, truncated };
  });
  if (!loaded) return null;

  // Falla cerrado: si tira, el error sube y los datos leídos se descartan con este stack frame.
  await auditSecurityEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "clinicalRecord.print",
    entity: "Patient",
    entityId: patientId,
    payload: { count: loaded.notes.length },
  });

  return {
    patient: {
      firstName: loaded.patient.firstName,
      lastName: loaded.patient.lastName,
      documentId: loaded.patient.documentId,
      // Fecha calendario sin hora (excepción `dateOfBirth` de AGENTS §4): se guarda a medianoche UTC.
      dateOfBirth: loaded.patient.dateOfBirth ? loaded.patient.dateOfBirth.toISOString().slice(0, 10) : null,
    },
    tenantName: actor.tenantName,
    printedAt: now.toISOString(),
    // `practitionerName` sale de `displayUserName` (lib/session.ts): nunca el email (DIR-0).
    printedBy: actor.practitionerName,
    notes: loaded.notes,
    truncated: loaded.truncated,
  };
}

// ─── FC-2g (T4, C-FC7) · filas para el PDF / Word de las descargas del equipo ─────────────────────────────────────

/**
 * Lo que `loadHcPrintSourceInTx` (FC-2e, neutral) necesita de cada nota. Ese loader no puede nombrar el modelo, así que
 * las filas las lee este módulo, que ya es el de «imprimir» del equipo (molde: `readShareEntryRowsInTx` de FC-2d).
 * `booking.locationId` = la sede del turno, para el membrete de la ficha suelta.
 */
const PRINT_ENTRY_SELECT = {
  id: true,
  amendsNoteId: true,
  revision: true,
  kind: true,
  title: true,
  occurredAt: true,
  createdAt: true,
  body: true,
  bodyDoc: true,
  diagnoses: true,
  authorName: true,
  authorPractitionerId: true,
  authorLicense: true,
  importSource: true,
  voidedAt: true,
  voidReason: true,
  booking: { select: { locationId: true } },
} as const satisfies Prisma.ClinicalNoteSelect;

type PrintEntryNote = Prisma.ClinicalNoteGetPayload<{ select: typeof PRINT_ENTRY_SELECT }>;

/** `label` resuelto acá: el enum del tipo nunca viaja al contenido imprimible (§24.2 hallazgo 2). */
function toPrintRow(n: PrintEntryNote): HcPrintEntryRow {
  return {
    id: n.id,
    parentId: n.amendsNoteId,
    revision: n.revision,
    label: CLINICAL_NOTE_KIND_LABEL[n.kind],
    title: n.title,
    occurredAt: n.occurredAt,
    createdAt: n.createdAt,
    body: n.body,
    bodyDoc: n.bodyDoc,
    diagnoses: n.diagnoses,
    authorName: n.authorName,
    authorPractitionerId: n.authorPractitionerId,
    authorLicense: n.authorLicense,
    importSource: n.importSource,
    voidedAt: n.voidedAt,
    voidReason: n.voidReason,
  };
}

/**
 * Una ficha (raíz + TODAS sus enmiendas, anuladas incluidas: la descarga del equipo las muestra marcadas) del paciente
 * de la URL. 1 sentencia. null = no es una raíz de ESTE paciente en ESTE consultorio: una enmienda, la ficha de otro
 * paciente (otra ficha en la URL) o de otro consultorio dan lo mismo → 404 sin distinguir. `tenantId` y `patientId` a
 * mano en el WHERE: prod es BYPASSRLS. El gate `canRead` lo corre el caller ANTES, en la misma tx.
 */
export async function readFichaPrintRowsInTx(
  tx: DbClient,
  tenantId: string,
  p: { patientId: string; noteId: string },
): Promise<{ rows: HcPrintEntryRow[]; locationId: string | null; root: HcPrintEntryRow } | null> {
  const notes = await tx.clinicalNote.findMany({
    where: {
      tenantId,
      patientId: p.patientId,
      OR: [{ id: p.noteId, amendsNoteId: null }, { amendsNoteId: p.noteId }],
    },
    select: PRINT_ENTRY_SELECT,
  });
  const root = notes.find((n) => n.id === p.noteId);
  if (!root) return null;
  const rows = notes.map(toPrintRow);
  return { rows, locationId: root.booking?.locationId ?? null, root: rows.find((r) => r.id === p.noteId)! };
}

/**
 * HC completa (FC-D31): las `HC_PRINT_MAX_ENTRIES` (300) fichas RAÍZ más recientes y todas sus enmiendas. El tope es
 * de fichas y no de filas: cortar por filas podía dejar una raíz sin parte de sus enmiendas, y el loader descarta las
 * enmiendas sueltas. Se trae una raíz de más para saber si hubo corte sin un `count` aparte (mismo truco que
 * `loadClinicalRecordForPrint`). 2 sentencias; desempate estable `createdAt`, `id`.
 */
export async function readRecordPrintRowsInTx(
  tx: DbClient,
  tenantId: string,
  patientId: string,
): Promise<{ rows: HcPrintEntryRow[]; truncated: boolean; fichaCount: number }> {
  const roots = await tx.clinicalNote.findMany({
    where: { tenantId, patientId, amendsNoteId: null },
    select: PRINT_ENTRY_SELECT,
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: HC_PRINT_MAX_ENTRIES + 1,
  });
  const truncated = roots.length > HC_PRINT_MAX_ENTRIES;
  const kept = roots.slice(0, HC_PRINT_MAX_ENTRIES);
  const amendments = kept.length
    ? await tx.clinicalNote.findMany({
        where: { tenantId, patientId, amendsNoteId: { in: kept.map((r) => r.id) } },
        select: PRINT_ENTRY_SELECT,
      })
    : [];
  return { rows: [...kept, ...amendments].map(toPrintRow), truncated, fichaCount: kept.length };
}
