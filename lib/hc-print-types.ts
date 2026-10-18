/**
 * Modelo imprimible único de la historia clínica, `HcPrintable v1` (T4, contrato C-FC4; brief §24.6). De acá salen el
 * PDF, el Word, la vista web del equipo y el snapshot del documento compartido que lee el portal.
 *
 * NEUTRAL a propósito: lo importa el portal y su guard es una regex sobre el archivo entero, comentarios incluidos
 * (brief §24.2 hallazgo 2). Por eso este archivo no nombra el modelo de notas y el contenido solo lleva texto ya
 * resuelto: sin ids de origen, sin el autor por id, sin el enum del tipo de entrada (va `label`), sin el motivo
 * interno de anulación ni claves de Storage. La firma es un `imageRef` opaco que el server mapea a su dueño.
 * Solo tipos: no arrastra runtime al bundle del portal.
 */
import type { HcDoc } from "@/lib/hc-doc";

export type HcPrintableV1 = { v: 1; content: HcPrintableContentV1; meta: HcPrintableMetaV1 };
export type HcPrintableMetaV1 = { generatedAt: string; purpose: "shared" | "download"; generatedByName: string; verificationCode: string; truncated: boolean };
export type HcPrintableContentV1 = {
  letterhead: { tenantName: string; addressLine: string | null; phone: string | null; hasLogo: boolean };
  patient: { fullName: string; documentId: string | null; dateOfBirth: string | null };
  fichas: { main: HcPrintableEntryV1; amendments: HcPrintableEntryV1[] }[];
  icdAttribution: string | null };
export type HcPrintableEntryV1 = { label: string; title: string | null; occurredAt: string; dateLabel: string; body: HcDoc;
  diagnoses: { code: string | null; title: string; uri: string | null; sourceLabel: string; principal: boolean }[];
  signature: { line: string; imageRef: string | null };
  marks: { lateEntry: string | null; imported: string | null; voided: { at: string; reason: string } | null /* solo download */ };
  revisionLabel: string };
