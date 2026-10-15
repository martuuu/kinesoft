import "server-only";
import { auditSecurityEvent } from "@/lib/audit";
import { CLINICAL_NOTE_SELECT, clinicalNoteGateInTx, toClinicalNoteDTO } from "@/lib/clinical-notes-internal";
import { CLINICAL_RECORD_PRINT_MAX, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { runWithRls } from "@/lib/rls";
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
