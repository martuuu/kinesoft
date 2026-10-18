import "server-only";
import { renderSpikeDocx, renderSpikePdf, spikeNotes, SPIKE_PDF_MAX_BYTES } from "./spike-render";

/**
 * FC-1c · `GET /api/hc-spike?format=pdf|docx&n=30` — spike LOCAL de react-pdf/docx en el App Router (§24.10 T4a).
 * **Temporal**: lo borra FC-2g (T4c-2) cuando existan las rutas reales de C-FC7.
 *
 * Gate: responde 404 salvo con `HC_SPIKE=1` en el entorno del server, y SIEMPRE 404 en Vercel (`VERCEL_ENV` seteado:
 * Preview usa variables de prod, hallazgo 9 de §24.2) aunque alguien prenda la variable por error. Sin sesión a
 * propósito: los datos son sintéticos y la ruta solo existe para medir en `next start` local.
 *
 * La respuesta lleva `x-hc-render-ms` (tiempo de render del server, sin red) y `x-hc-cold` (1 = primera llamada del
 * proceso: incluye la carga de react-pdf/yoga/fontkit y el parseo de las fuentes) para la tabla del spike.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let warmed = false;

export async function GET(req: Request): Promise<Response> {
  if (process.env.HC_SPIKE !== "1" || process.env.VERCEL_ENV) {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "docx" ? "docx" : "pdf";
  const n = Math.min(300, Math.max(1, Number.parseInt(url.searchParams.get("n") ?? "30", 10) || 30));
  const cold = !warmed;
  warmed = true;

  const t0 = performance.now();
  const notes = spikeNotes(n);
  const bytes = format === "pdf" ? await renderSpikePdf(notes) : await renderSpikeDocx(notes);
  const ms = performance.now() - t0;

  if (format === "pdf" && bytes.byteLength > SPIKE_PDF_MAX_BYTES) {
    return new Response("PDF demasiado pesado", { status: 413 });
  }
  // `new Uint8Array(…)` copia a un `Uint8Array<ArrayBuffer>`: con el lib de TS 5.7+ un `Uint8Array<ArrayBufferLike>`
  // (lo que devuelven Buffer y C-FC5) no es `BodyInit` y `next build` falla en el typecheck. Lo mismo va a pasar en
  // las rutas de FC-2g.
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type":
        format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "content-disposition": `attachment; filename="hc-spike.${format}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-hc-render-ms": ms.toFixed(1),
      "x-hc-cold": cold ? "1" : "0",
      "x-hc-bytes": String(bytes.byteLength),
    },
  });
}
