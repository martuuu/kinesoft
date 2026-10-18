/**
 * Documentos compartidos con el paciente (T4, contrato C-FC6; brief §24.5). Lado del EQUIPO: `SharedDocumentDTO`
 * lleva el id de la ficha de origen porque la tarjeta de la HC lo necesita. El portal NO importa este módulo: lee
 * `lib/portal-documents-internal.ts` con `select` explícito y sin ese id (brief §24.2 hallazgo 2).
 */

export type SharedDocumentDTO = { id: string; noteId: string; noteRevision: number; title: string; sharedAt: string; verificationCode: string };
export const PATIENT_DOCUMENT_COPY = {
  forbidden: "No tenés acceso para compartir la historia clínica de este paciente.", notFound: "No encontramos la ficha.",
  notRoot: "Se comparte la ficha original; las enmiendas van incluidas.", voided: "La ficha está anulada: no se puede compartir.",
  changed: "La ficha cambió mientras la compartías. Probá de nuevo.", raced: "Alguien compartió esta ficha recién. Recargá para ver el estado.",
  keyReused: "Ese envío ya se usó. Cerrá y volvé a abrir «Compartir».", pdfFailed: "No pudimos generar el PDF. Probá de nuevo en un rato.",
  storageFailed: "No pudimos guardar el documento. Probá de nuevo.", tooLarge: "El documento quedó demasiado pesado para compartirlo. Probá sin logo o sin firma.",
  shared: "Listo: el paciente ya lo ve en su portal.", sharedNoPortal: "Listo. El paciente todavía no tiene portal: invitalo para que lo vea.",
  emailFailed: "Se compartió, pero no pudimos mandarle el aviso por mail.", revoked: "Dejaste de compartir el documento.",
  docNotFound: "No encontramos el documento.",
} as const;

/**
 * Canal y resultado del aviso al paciente. El contrato los ubica en `lib/patient-documents-delivery-internal.ts`
 * (server-only, costura de WhatsApp en T6), pero `shareClinicalNoteWithPatient` los devuelve al cliente: viven acá
 * para que el diálogo de compartir no tenga que importar un módulo server-only. El `-internal` los re-exporta.
 */
export type DocumentDeliveryChannel = "email";
export type DocumentDeliveryOutcome = { channel: DocumentDeliveryChannel; status: "sent" | "skipped" | "failed" | "no-portal-user" };
