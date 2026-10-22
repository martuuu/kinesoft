/**
 * HF-1a · realtime, lado server (plan §22.2 H-RT1, §22.4 «HF-1a»).
 *
 * H-RT1: la agenda nunca entraba en vivo. Causa: `SUPABASE_JWT_SECRET` se guardó en Vercel con un `\n` final y
 * firmábamos el HS256 con ese byte de más; Supabase verifica con el secreto limpio y rechaza todo `phx_join`. El
 * script local daba 11/11 porque dotenv recorta. Lo que se fija acá, siempre con los símbolos reales:
 *   1. `lib/env.ts` recorta secreto, `kid` y anon key → el token que firma la app verifica con el secreto limpio
 *      (re-verificado con `node:crypto` a mano, no solo con nuestro `verify`).
 *   2. La huella del secreto (sha256 → 8 hex) es la misma en `/plataforma/sistema` y en `scripts/realtime-verify.ts`
 *      (el script corre de verdad, en un subproceso con `tsx`), y en ninguno de los dos sale el valor.
 *   3. «Probar desde el servidor»: con un transporte falso (lo único que se mockea es la red), una firma inválida
 *      devuelve el `reason` del server y la respuesta nunca contiene el token.
 */
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/lib/env";
import {
  realtimeSecretFingerprint,
  signRealtimeToken,
  verifyRealtimeToken,
} from "@/lib/realtime-token-internal";
import { runRealtimeProbe, type ProbeSocketCtor } from "@/lib/platform-realtime-probe-internal";

const CLEAN = "SECRETO-hf1a-jwt-0123456789abcdef0123456789abcdef";
const DIRTY = `${CLEAN}\n`;
const TENANT = "ckz9tenant00000000000001a";

function hs256(signingInput: string, secret: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

describe("[HF-1a] lib/env.ts recorta los secretos de realtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("[HF-1a] SUPABASE_JWT_SECRET con \\n final se recorta y el token verifica con el secreto limpio", async () => {
    // parseEnv (el boot) y el `env` exportado real (lo que lee `mintRealtimeToken`).
    expect(parseEnv({ SUPABASE_JWT_SECRET: DIRTY }).SUPABASE_JWT_SECRET).toBe(CLEAN);
    vi.stubEnv("SUPABASE_JWT_SECRET", DIRTY);
    vi.stubEnv("SUPABASE_JWT_KID", "  kid-1\r\n");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abc\n");
    vi.resetModules();
    const { env } = await import("@/lib/env");
    expect(env.SUPABASE_JWT_SECRET).toBe(CLEAN);
    expect(env.SUPABASE_JWT_KID).toBe("kid-1");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("sb_publishable_abc");

    const { token } = signRealtimeToken({ tenantId: TENANT, now: new Date(), secret: env.SUPABASE_JWT_SECRET! });
    const [h, p, s] = token.split(".");
    // A mano: es lo que hace Supabase con el secreto limpio del proyecto.
    expect(s).toBe(hs256(`${h}.${p}`, CLEAN));
    expect(verifyRealtimeToken(token, CLEAN)?.tenant_id).toBe(TENANT);
    // Control del bug: con el secreto sucio la firma NO coincide (si coincidiera, el test no probaría nada).
    expect(s).not.toBe(hs256(`${h}.${p}`, DIRTY));
  });

  it("[HF-1a] solo espacios = no seteada; los valores sin bordes no cambian", () => {
    const e = parseEnv({ SUPABASE_JWT_SECRET: " \n", SUPABASE_JWT_KID: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJ.a.b" });
    expect(e.SUPABASE_JWT_SECRET).toBeUndefined();
    expect(e.SUPABASE_JWT_KID).toBeUndefined();
    expect(e.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("eyJ.a.b");
  });

  it("[TP-0] TURNERO_CHECKOUT: default off, acepta platform (mayúsculas/espacios), typo frena", () => {
    // TP-3z: `turneroCheckout()` se borró (T5 cobra con la cuenta del profesional); el enum queda para no romper un
    // deploy con el valor ya cargado (C-TP2).
    expect(parseEnv({}).TURNERO_CHECKOUT).toBe("off");
    expect(parseEnv({ TURNERO_CHECKOUT: "" }).TURNERO_CHECKOUT).toBe("off");
    expect(parseEnv({ TURNERO_CHECKOUT: " Platform\n" }).TURNERO_CHECKOUT).toBe("platform");
    expect(() => parseEnv({ TURNERO_CHECKOUT: "on" })).toThrow(/TURNERO_CHECKOUT/);
  });
});

describe("[HF-1a] huella del secreto", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@/lib/platform-actor");
    vi.doUnmock("@/lib/db");
    vi.doUnmock("@/lib/db-ping");
  });

  it("realtimeSecretFingerprint: 8 hex, sha256 con prefijo versionado, recorta, nunca el valor", () => {
    const fp = realtimeSecretFingerprint(CLEAN);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    const manual = createHash("sha256")
      .update(`kinesoft-rt-fp:v1:${CLEAN}`)
      .digest("hex")
      .slice(0, 8);
    expect(fp).toBe(manual);
    expect(realtimeSecretFingerprint(DIRTY)).toBe(fp);
    expect(realtimeSecretFingerprint(`${CLEAN}x`)).not.toBe(fp);
    expect(CLEAN).not.toContain(fp);
  });

  it("[HF-1a] huella igual en Sistema y en el script; nunca el valor", async () => {
    const expected = realtimeSecretFingerprint(CLEAN);

    // ── Sistema: el export real con process.env sucio (se mockean sesión, base y ping; nunca el builder) ──
    vi.resetModules();
    vi.stubEnv("SUPABASE_JWT_SECRET", DIRTY);
    vi.stubEnv("SUPABASE_JWT_KID", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_SECRETO-no-sale");
    vi.stubEnv("REALTIME_DRIVER", "supabase");
    vi.doMock("@/lib/platform-actor", () => ({ requirePlatformAdmin: vi.fn(async () => ({ userId: "u" })) }));
    vi.doMock("@/lib/db", () => ({
      prisma: {},
      prismaService: { $queryRaw: vi.fn(async () => [{ applied: BigInt(1), last: null }]) },
    }));
    vi.doMock("@/lib/db-ping", () => ({ pingDb: vi.fn(async () => ({ up: true, ms: 1 })) }));
    const { getPlatformSystemStatus } = await import("@/lib/platform-system-read");
    const s = await getPlatformSystemStatus();
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/SECRETO/);
    const byKey = Object.fromEntries(s.groups.flatMap((g) => g.checks).map((c) => [c.key, c]));
    expect(byKey.SUPABASE_JWT_SECRET.value).toBe(`huella ${expected}`);
    // Tenía `\n` al borde: «sí», en estado de aviso, sin mostrar nada del valor.
    expect(byKey.SUPABASE_JWT_SECRET.state).toBe("warn");
    expect(byKey.SUPABASE_JWT_SECRET.detail).toMatch(new RegExp(`${CLEAN.length} caracteres`));
    expect(byKey.SUPABASE_JWT_SECRET.detail).toMatch(/al borde: sí/);
    expect(byKey.SUPABASE_JWT_KID.value).toBe("sin kid");
    expect(byKey.NEXT_PUBLIC_SUPABASE_ANON_KEY.value).toBe("publishable");

    // ── Script: corre de verdad (tsx con react-server). Destino localhost → imprime la huella y aborta antes de la red ──
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const r = spawnSync(
      tsx,
      ["--conditions=react-server", "scripts/realtime-verify.ts", "--tenant", "ckz9tenant00000000000001a", "--confirm=x"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 60_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          SUPABASE_JWT_SECRET: DIRTY,
          NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
        },
      }
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out, out).toContain(`huella ${expected}`);
    expect(out).toMatch(/al borde: sí/);
    expect(out).toMatch(/destino es local/);
    expect(out).not.toMatch(/SECRETO/);
    expect(r.status).toBe(1);
  }, 90_000);
});

// ── «Probar desde el servidor» con un WebSocket falso ─────────────────────────────────────────────────────────────

type Sent = Record<string, unknown>;

/** Fake mínimo del WebSocket global: registra lo enviado y responde con `reply(join)`. */
function fakeSocket(reply: (join: Sent, sock: FakeWs) => void, log: { urls: string[]; sent: Sent[] }): ProbeSocketCtor {
  return class implements FakeWs {
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
    readyState = 0;
    constructor(url: string) {
      log.urls.push(url);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
      }, 0);
    }
    send(data: string) {
      const msg = JSON.parse(data) as Sent;
      log.sent.push(msg);
      if (msg.event === "phx_join") setTimeout(() => reply(msg, this), 0);
    }
    close() {
      this.readyState = 3;
    }
    emit(obj: unknown) {
      this.onmessage?.({ data: JSON.stringify(obj) });
    }
  } as unknown as ProbeSocketCtor;
}
interface FakeWs {
  emit(obj: unknown): void;
}

const CFG = { url: "https://ref.supabase.co", anonKey: "sb_publishable_test", secret: CLEAN, kid: undefined };

describe("[HF-1a] probe de realtime desde el servidor", () => {
  it("[HF-1a] probe: firma inválida → reason visible, sin token en la respuesta", async () => {
    const log = { urls: [] as string[], sent: [] as Sent[] };
    let sentToken = "";
    const Ctor = fakeSocket((join, sock) => {
      sentToken = String((join.payload as { access_token?: string }).access_token ?? "");
      // Supabase a veces repite el token en el motivo: no puede volver al navegador.
      sock.emit({
        topic: join.topic,
        event: "phx_reply",
        ref: join.ref,
        payload: { status: "error", response: { reason: `Invalid JWT: signature error (${sentToken})` } },
      });
    }, log);
    const r = await runRealtimeProbe({ ...CFG, WebSocketCtor: Ctor, timeoutMs: 2_000 });
    expect(r).toMatchObject({ ok: false, status: "CHANNEL_ERROR" });
    expect(r.reason).toMatch(/Invalid JWT: signature error/);
    // Se unió de verdad con un token firmado para el tenant sintético, al canal privado.
    expect(verifyRealtimeToken(sentToken, CLEAN)).not.toBeNull();
    const join = log.sent.find((m) => m.event === "phx_join")!;
    expect(join.topic).toMatch(/^realtime:tenant:.+:agenda$/);
    expect((join.payload as { config: { private: boolean } }).config.private).toBe(true);
    expect(log.urls[0]).toMatch(/^wss:\/\/ref\.supabase\.co\/realtime\/v1\/websocket\?/);
    // Nada del token ni del secreto en lo que vuelve.
    const json = JSON.stringify(r);
    expect(sentToken.length).toBeGreaterThan(50);
    expect(json).not.toContain(sentToken);
    expect(json).not.toContain(sentToken.split(".")[2]);
    expect(json).not.toContain(CLEAN);
    expect(json).not.toMatch(/eyJ/);
  });

  it("join ok → SUBSCRIBED con la huella; sin WebSocket global → «no disponible en este runtime»; sin secreto → sin configurar", async () => {
    const log = { urls: [] as string[], sent: [] as Sent[] };
    const Ok = fakeSocket(
      (join, sock) => sock.emit({ topic: join.topic, event: "phx_reply", ref: join.ref, payload: { status: "ok", response: {} } }),
      log
    );
    const ok = await runRealtimeProbe({ ...CFG, WebSocketCtor: Ok, timeoutMs: 2_000 });
    expect(ok).toMatchObject({ ok: true, status: "SUBSCRIBED", reason: null, fingerprint: realtimeSecretFingerprint(CLEAN) });
    expect(log.sent.some((m) => m.event === "phx_leave")).toBe(true);

    const none = await runRealtimeProbe({ ...CFG, WebSocketCtor: undefined });
    expect(none).toMatchObject({ ok: false, status: "UNAVAILABLE" });
    expect(none.reason).toMatch(/no disponible en este runtime/);

    const unconf = await runRealtimeProbe({ ...CFG, secret: undefined, WebSocketCtor: Ok });
    expect(unconf).toMatchObject({ ok: false, status: "UNCONFIGURED" });
  });

  it("sin respuesta → TIMED_OUT al vencer el tope", async () => {
    const Silent = fakeSocket(() => {}, { urls: [], sent: [] });
    const r = await runRealtimeProbe({ ...CFG, WebSocketCtor: Silent, timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, status: "TIMED_OUT" });
  });

  it("la action real pide platform.read y usa el WebSocket global (fake), sin token en la respuesta", async () => {
    vi.resetModules();
    vi.stubEnv("SUPABASE_JWT_SECRET", CLEAN);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_test");
    const requirePlatformAdmin = vi.fn(async () => ({ userId: "u" }));
    vi.doMock("@/lib/platform-actor", () => ({ requirePlatformAdmin }));
    const log = { urls: [] as string[], sent: [] as Sent[] };
    const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = fakeSocket(
      (join, sock) =>
        sock.emit({ topic: join.topic, event: "phx_reply", ref: join.ref, payload: { status: "error", response: { reason: "Unauthorized" } } }),
      log
    );
    try {
      const { probeRealtimeFromServer } = await import("@/lib/platform-realtime-probe");
      const r = await probeRealtimeFromServer();
      expect(requirePlatformAdmin).toHaveBeenCalledWith("platform.read");
      expect(r).toMatchObject({ ok: true, data: { ok: false, status: "CHANNEL_ERROR", reason: "Unauthorized" } });
      const token = String((log.sent[0].payload as { access_token: string }).access_token);
      expect(JSON.stringify(r)).not.toContain(token);
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = prev;
      vi.unstubAllEnvs();
      vi.doUnmock("@/lib/platform-actor");
      vi.resetModules();
    }
  });
});
