import "server-only";

/**
 * FC-2g (T4, C-FC7, §24.6) · Descargas del equipo: la ficha en PDF o Word y la HC completa en PDF. Lo llaman SOLO las
 * rutas `app/api/pacientes/[id]/fichas/[noteId]/[format]` y `app/api/pacientes/[id]/historia-clinica/[format]`, que
 * ponen antes sesión (401), soporte (403) y rate limit. Acá: gate, lectura, render, tope y audit.
 *
 * Orden y por qué:
 *   1. tx RLS de solo lectura: gate `canRead` de evoluciones (`clinicalNoteGateInTx`, el único: C-EV2-3) → filas
 *      (`lib/clinical-notes-print-internal.ts`) → fuente (`loadHcPrintSourceInTx`). Sin acceso, ajeno, enmienda u
 *      otra ficha en la URL → `not-found` SIN audit: no salió nada y un evento por intento sin acceso sería ruido (mismo
 *      criterio que `loadClinicalRecordForPrint`). La Secretaria cae acá (acceso `admin`, sin `clinical.read`).
 *   2. Fuera de la tx: contenido `download` (conserva lo anulado con su marca: Ley 26.529), assets (falla blanda) y
 *      render. Fuera porque el render de 300 fichas tarda segundos y no se tiene una conexión del pool mientras tanto.
 *   3. Tope: el PDF > `HC_PDF_MAX_BYTES` → `too-large` sin audit (no salen bytes). El render no tira por tamaño.
 *   4. `auditSecurityEvent` (`clinicalNote.download` / `clinicalRecord.download`) DESPUÉS del render y ANTES de
 *      devolver los bytes: se registra lo que efectivamente sale (formato, cantidad, si hubo corte) y no hay camino que
 *      devuelva bytes sin evento. Si el audit tira → `audit-failed` y la ruta responde 503 sin cuerpo (falla cerrado).
 *
 * El audit va con `entity: "Patient"` (y el `noteId` en el payload) para que aparezca en la Actividad del paciente
 * (`getPatientActivity` filtra por entidades del paciente y `ClinicalNote` no es una). Payload sin PHI: ids, formato,
 * conteos. Funciona con el consultorio en solo lectura (descargar es leer) porque el audit va por el canal service.
 */
import { auditSecurityEvent } from "@/lib/audit";
import { clinicalNoteGateInTx } from "@/lib/clinical-notes-internal";
import { readFichaPrintRowsInTx, readRecordPrintRowsInTx } from "@/lib/clinical-notes-print-internal";
import { loadHcAssets, type HcRenderAssets } from "@/lib/hc-assets-internal";
import { renderHcDocx } from "@/lib/hc-docx-internal";
import { HC_EXPORT_CONTENT_TYPE, HC_EXPORT_COPY, attachmentDisposition, hcShortId, type HcFichaFormat } from "@/lib/hc-export-logic";
import { HC_PDF_MAX_BYTES, renderHcPdf } from "@/lib/hc-pdf/render-internal";
import { finalizeHcPrintable, hcAssetRequest, loadHcPrintSourceInTx } from "@/lib/hc-print-internal";
import { buildHcPrintableContent, hcFileBase, type HcPrintSource } from "@/lib/hc-print-model";
import { logger } from "@/lib/logger";
import { runWithRls } from "@/lib/rls";
import type { Actor } from "@/lib/session";

export type HcExportResult =
  | { kind: "ok"; bytes: Uint8Array; contentType: string; disposition: string }
  | { kind: "not-found" }
  | { kind: "too-large" }
  | { kind: "render-failed" }
  | { kind: "audit-failed" };

type Prepared = { source: HcPrintSource; fileBase: string; count: number };

/** Falla blanda (C-FC5): un logo o una firma que no baja no impide la descarga. */
async function loadAssetsSoft(source: HcPrintSource, signatureOwners: Record<string, string>): Promise<HcRenderAssets> {
  try {
    return await loadHcAssets(hcAssetRequest(source, signatureOwners));
  } catch (e) {
    logger.warn("hc.export.assets_failed", { error: e instanceof Error ? e.name : "unknown" });
    return { logo: null, signatures: {} };
  }
}

async function renderAndAudit(
  actor: Actor,
  prepared: Prepared,
  format: HcFichaFormat,
  audit: { action: "clinicalNote.download" | "clinicalRecord.download"; patientId: string; payload: Record<string, unknown> },
): Promise<HcExportResult> {
  const { source } = prepared;
  let bytes: Uint8Array;
  try {
    const built = buildHcPrintableContent(source, "download");
    const { printable } = finalizeHcPrintable(built.content, {
      generatedAt: new Date().toISOString(),
      purpose: "download",
      // `practitionerName` sale de `displayUserName`: nunca el email (DIR-0).
      generatedByName: actor.practitionerName,
      truncated: source.truncated,
    });
    const assets = await loadAssetsSoft(source, built.signatureOwners);
    bytes = format === "pdf" ? await renderHcPdf(printable, assets) : await renderHcDocx(printable, assets);
  } catch (e) {
    // Sin el mensaje: react-pdf puede citar texto del documento (PHI) en sus errores.
    logger.error("hc.export.render_failed", { tenantId: actor.tenantId, format, error: e instanceof Error ? e.name : "unknown" });
    return { kind: "render-failed" };
  }
  if (bytes.byteLength === 0) return { kind: "render-failed" };
  // El body de una función de Vercel corta en 4,5 MB; el Word no tiene otro tope que ese (sin imágenes pesa poco).
  if (bytes.byteLength > HC_PDF_MAX_BYTES) return { kind: "too-large" };

  try {
    await auditSecurityEvent({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: audit.action,
      entity: "Patient",
      entityId: audit.patientId,
      payload: audit.payload,
    });
  } catch (e) {
    logger.error("hc.export.audit_failed", { tenantId: actor.tenantId, action: audit.action, error: e instanceof Error ? e.name : "unknown" });
    return { kind: "audit-failed" };
  }
  return {
    kind: "ok",
    bytes,
    contentType: HC_EXPORT_CONTENT_TYPE[format],
    disposition: attachmentDisposition(prepared.fileBase, format),
  };
}

/** Una ficha (raíz + enmiendas) del paciente de la URL, en PDF o Word. */
export async function exportFichaDocument(
  actor: Actor,
  p: { patientId: string; noteId: string; format: HcFichaFormat },
): Promise<HcExportResult> {
  const prepared = await runWithRls(actor.tenantId, async (tx): Promise<Prepared | null> => {
    const gate = await clinicalNoteGateInTx(tx, actor, p.patientId);
    if (!gate.canRead) return null;
    const read = await readFichaPrintRowsInTx(tx, actor.tenantId, { patientId: p.patientId, noteId: p.noteId });
    if (!read) return null;
    const source = await loadHcPrintSourceInTx(tx, actor, { patientId: p.patientId, rows: read.rows, locationId: read.locationId });
    if (!source || source.entries.length === 0) return null;
    const fileBase = hcFileBase({
      lastName: source.patient.lastName,
      firstName: source.patient.firstName,
      occurredAt: read.root.occurredAt,
      // Sin título, la etiqueta del tipo («Evolución»): «Ficha» a secas no distingue nada en la carpeta de descargas.
      title: read.root.title?.trim() || read.root.label,
      shortId: hcShortId(p.noteId),
    });
    return { source, fileBase, count: read.rows.length };
  });
  if (!prepared) return { kind: "not-found" };
  return renderAndAudit(actor, prepared, p.format, {
    action: "clinicalNote.download",
    patientId: p.patientId,
    payload: { noteId: p.noteId, format: p.format },
  });
}

/** HC completa en PDF (FC-D31): las 300 fichas más recientes; `truncated` en el audit y en el pie del PDF. */
export async function exportClinicalRecordPdf(actor: Actor, patientId: string): Promise<HcExportResult> {
  const prepared = await runWithRls(actor.tenantId, async (tx): Promise<Prepared | null> => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    const read = await readRecordPrintRowsInTx(tx, actor.tenantId, patientId);
    const source = await loadHcPrintSourceInTx(tx, actor, { patientId, rows: read.rows, truncated: read.truncated, locationId: null });
    // Sin fichas igual sale el PDF (membrete + paciente, sin entradas): es la respuesta honesta a «bajame la HC».
    if (!source) return null;
    const fileBase = hcFileBase({
      lastName: source.patient.lastName,
      firstName: source.patient.firstName,
      occurredAt: null,
      title: null,
      shortId: hcShortId(patientId),
    });
    return { source, fileBase, count: read.fichaCount };
  });
  if (!prepared) return { kind: "not-found" };
  return renderAndAudit(actor, prepared, "pdf", {
    action: "clinicalRecord.download",
    patientId,
    payload: { format: "pdf", count: prepared.count, truncated: prepared.source.truncated },
  });
}

// ─── Respuestas HTTP (compartidas por las dos rutas; un route.ts solo puede exportar los handlers) ───────────────

/** Headers de TODA respuesta de estas rutas, también los errores: nada de esto se cachea ni se interpreta. */
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** Respuesta de texto plano (errores) con los headers base. */
export function hcPlain(status: number, text: string | null, extra?: Record<string, string>): Response {
  return new Response(text, {
    status,
    headers: { ...BASE_HEADERS, ...(text !== null ? { "Content-Type": "text/plain; charset=utf-8" } : {}), ...extra },
  });
}

/**
 * Resultado → `Response`. `ok` va con `attachment` + `filename*` y `new Uint8Array(bytes)`: con el lib de TS 5.7+ un
 * `Uint8Array<ArrayBufferLike>` (lo que devuelven Buffer y los renderers) no es `BodyInit` y `next build` falla en el
 * typecheck (hallazgo del spike de FC-1c). `audit-failed` → 503 SIN cuerpo (C-FC7): ni un byte del archivo ni un
 * mensaje que distinga la causa.
 */
export function hcExportResponse(result: HcExportResult, tooLargeCopy: string): Response {
  switch (result.kind) {
    case "ok":
      return new Response(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          ...BASE_HEADERS,
          "Content-Type": result.contentType,
          "Content-Disposition": result.disposition,
          "Content-Length": String(result.bytes.byteLength),
        },
      });
    case "not-found":
      return hcPlain(404, "Not found");
    case "too-large":
      return hcPlain(413, tooLargeCopy);
    case "render-failed":
      return hcPlain(500, HC_EXPORT_COPY.renderFailed);
    case "audit-failed":
      return hcPlain(503, null);
  }
}
