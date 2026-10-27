/**
 * HD-4 · `readCappedBody` (lib/http/capped-body.ts), el lector con tope que comparten los webhooks de WhatsApp y de
 * Mercado Pago. Símbolo real, requests reales de undici.
 */
import { describe, expect, it } from "vitest";
import { readCappedBody } from "@/lib/http/capped-body";

function streamOf(sizes: number[]) {
  const pending = [...sizes];
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      const n = pending.shift();
      if (n === undefined) return ctrl.close();
      ctrl.enqueue(new Uint8Array(n).fill(0x61));
    },
  });
}

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/hook", {
    method: "POST",
    headers,
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

describe("[HD-4] readCappedBody", () => {
  it("devuelve los bytes tal cual hasta el tope inclusive", async () => {
    const out = await readCappedBody(req("a".repeat(100)), 100);
    expect(out).toBeInstanceOf(Buffer);
    expect((out as Buffer).toString("utf8")).toBe("a".repeat(100));
  });

  it("Content-Length declarado de más → too_large sin leer", async () => {
    const r = req("chico", { "content-length": "101" });
    expect(await readCappedBody(r, 100)).toBe("too_large");
    expect(r.bodyUsed).toBe(false);
  });

  it("chunked que se pasa → too_large", async () => {
    expect(await readCappedBody(req(streamOf([60, 60, 60])), 100)).toBe("too_large");
  });

  it("chunked dentro del tope → todo concatenado", async () => {
    const out = await readCappedBody(req(streamOf([40, 40])), 100);
    expect((out as Buffer).byteLength).toBe(80);
  });

  it("sin cuerpo → Buffer vacío", async () => {
    const out = await readCappedBody(new Request("http://localhost/hook", { method: "POST" }), 100);
    expect((out as Buffer).byteLength).toBe(0);
  });
});
