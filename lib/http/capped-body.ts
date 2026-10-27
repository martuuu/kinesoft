/**
 * HD-4 (PV §27.E) · lectura del cuerpo de un request con tope de bytes, compartida por los webhooks.
 *
 * Nació en el webhook de WhatsApp (C-WA9, `lib/whatsapp/webhook-internal.ts`) y se movió acá sin cambios cuando el de
 * Mercado Pago necesitó lo mismo: antes leía `req.clone().json()` dos veces sin tope, así que un POST anónimo de varios
 * MB se bajaba entero (dos veces) antes de cualquier filtro. Sin dependencias a propósito (ni `server-only`, ni logger):
 * es un helper de bajo nivel que cualquier route handler de Node puede importar.
 *
 * `Content-Length` declarado de más → corta sin leer. Sin `Content-Length` (chunked) o con uno que miente por abajo →
 * lee hasta pasarse, cancela el stream y corta. Devuelve los bytes tal cual llegaron (la firma de Meta es sobre ellos) o
 * `"too_large"`.
 */
export async function readCappedBody(req: Request, max: number): Promise<Buffer | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return "too_large";
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
