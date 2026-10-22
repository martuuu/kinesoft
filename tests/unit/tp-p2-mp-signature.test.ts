/**
 * T5 TP-P2 · firmador/verificador puro del `x-signature` de Mercado Pago (lib/mp-connect/signature.ts; brief §25.2
 * hallazgo 8, Anexo B C-TP3). La paridad se mide contra el símbolo legado real `verifyWebhookSignature`
 * (lib/mercadopago.ts, que NO se toca: AUDIT §5.4). Del legado se mockean solo el ENV (su secreto), el cliente de la
 * base y el SDK de MP, que la verificación no usa; el reloj se fija con fake timers porque el legado lee `Date.now()`.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

const { LEGACY_SECRET } = vi.hoisted(() => ({ LEGACY_SECRET: "legacy-webhook-secret" }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k === "MP_WEBHOOK_SECRET" ? LEGACY_SECRET : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});
vi.mock("@/lib/db", () => ({ prismaService: {} }));
vi.mock("@/lib/notifications-internal", () => ({ notifyTenantOwners: vi.fn() }));
vi.mock("mercadopago", () => ({ MercadoPagoConfig: vi.fn(), Preference: vi.fn(), Payment: vi.fn() }));

import { verifyWebhookSignature } from "@/lib/mercadopago";
import { MP_SIGNATURE_MAX_AGE_MS, signMpNotification, verifyMpSignature } from "@/lib/mp-connect/signature";

const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);
const TS = Math.floor(NOW / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function legacyHeader(o: { dataId: string; requestId: string | null; ts: string | number }) {
  const manifest = `id:${o.dataId};request-id:${o.requestId ?? ""};ts:${o.ts};`;
  return `ts=${o.ts},v1=${createHmac("sha256", LEGACY_SECRET).update(manifest).digest("hex")}`;
}

describe("[TP-P2] OAuth y firma · firma del webhook", () => {
  it("signMpNotification → verifyMpSignature ok; manifiesto igual al documentado por MP", () => {
    const h = signMpNotification({ dataId: "123456789", secret: "s3cr3t", ts: TS, requestId: "req-1" });
    expect(h).toBe(
      `ts=${TS},v1=${createHmac("sha256", "s3cr3t").update(`id:123456789;request-id:req-1;ts:${TS};`).digest("hex")}`
    );
    expect(
      verifyMpSignature({ signature: h, requestId: "req-1", dataId: "123456789", secret: "s3cr3t", nowMs: NOW })
    ).toEqual({ ok: true });
  });

  it("otro secreto, otro dataId, otro request-id o sin firma → rechazo tipado", () => {
    const h = signMpNotification({ dataId: "1", secret: "a", ts: TS, requestId: "r" });
    const base = { signature: h, requestId: "r", dataId: "1", secret: "a", nowMs: NOW };
    expect(verifyMpSignature({ ...base, secret: "b" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMpSignature({ ...base, dataId: "2" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMpSignature({ ...base, requestId: "otro" })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyMpSignature({ ...base, secret: "" })).toEqual({ ok: false, reason: "no_secret" });
    expect(verifyMpSignature({ ...base, secret: undefined })).toEqual({ ok: false, reason: "no_secret" });
    expect(verifyMpSignature({ ...base, signature: null })).toEqual({ ok: false, reason: "missing" });
    expect(verifyMpSignature({ ...base, dataId: null })).toEqual({ ok: false, reason: "missing" });
    expect(verifyMpSignature({ ...base, nowMs: NOW + MP_SIGNATURE_MAX_AGE_MS + 1000 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });

  it("verifyMpSignature = verifyWebhookSignature (paridad)", () => {
    const good = legacyHeader({ dataId: "987", requestId: "req-x", ts: TS });
    const cases: { signature: string | null; requestId: string | null; dataId: string | null }[] = [
      { signature: good, requestId: "req-x", dataId: "987" },
      { signature: good, requestId: "req-y", dataId: "987" },
      { signature: good, requestId: "req-x", dataId: "988" },
      { signature: good, requestId: null, dataId: "987" },
      { signature: legacyHeader({ dataId: "987", requestId: null, ts: TS }), requestId: null, dataId: "987" },
      // `ts` en ms en vez de segundos (el legado acepta los dos por magnitud).
      { signature: legacyHeader({ dataId: "987", requestId: "r", ts: NOW }), requestId: "r", dataId: "987" },
      // Viejo: 5 min + 1 s; justo en el borde de 5 min; del futuro.
      { signature: legacyHeader({ dataId: "1", requestId: "r", ts: TS - 301 }), requestId: "r", dataId: "1" },
      { signature: legacyHeader({ dataId: "1", requestId: "r", ts: TS - 300 }), requestId: "r", dataId: "1" },
      { signature: legacyHeader({ dataId: "1", requestId: "r", ts: TS + 400 }), requestId: "r", dataId: "1" },
      // Orden de los pares invertido y con espacios.
      { signature: ` v1 = ${good.split("v1=")[1]} , ts = ${TS} `, requestId: "req-x", dataId: "987" },
      // Formas rotas.
      { signature: null, requestId: "r", dataId: "1" },
      { signature: good, requestId: "r", dataId: null },
      { signature: good, requestId: "r", dataId: "" },
      { signature: "", requestId: "r", dataId: "1" },
      { signature: "basura", requestId: "r", dataId: "1" },
      { signature: `ts=${TS}`, requestId: "r", dataId: "1" },
      { signature: "v1=abc", requestId: "r", dataId: "1" },
      { signature: `ts=nope,v1=abc`, requestId: "r", dataId: "1" },
      { signature: `ts=${TS},v1=abc`, requestId: "r", dataId: "1" },
      { signature: `ts=${TS},v1=${"0".repeat(64)}`, requestId: "r", dataId: "1" },
      // Un v1 en mayúsculas no es el hex que firma MP.
      { signature: good.replace(/v1=(.*)$/, (_, h: string) => `v1=${h.toUpperCase()}`), requestId: "req-x", dataId: "987" },
      // Alfanumérico (MP pide minúsculas en el manifiesto; el legado firma tal cual y la paridad lo conserva).
      { signature: legacyHeader({ dataId: "ABC123", requestId: "r", ts: TS }), requestId: "r", dataId: "ABC123" },
      { signature: legacyHeader({ dataId: "ABC123", requestId: "r", ts: TS }), requestId: "r", dataId: "abc123" },
    ];
    let oks = 0;
    for (const c of cases) {
      const legacy = verifyWebhookSignature(c);
      const nuevo = verifyMpSignature({ ...c, secret: LEGACY_SECRET, nowMs: Date.now() });
      expect({ c, r: nuevo }).toEqual({ c, r: legacy });
      if (legacy.ok) oks++;
    }
    // La tabla ejercita los dos lados: hay aceptados y rechazados por cada motivo.
    expect(oks).toBeGreaterThanOrEqual(4);
    const reasons = new Set(
      cases.map((c) => verifyWebhookSignature(c)).flatMap((r) => (r.ok ? [] : [r.reason]))
    );
    expect([...reasons].sort()).toEqual(["mismatch", "missing", "stale"]);
  });
});
