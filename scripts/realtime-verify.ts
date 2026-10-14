/**
 * SV04b · Verificación V1-V7 del canal realtime en STAGING (plan §18.11).
 *
 * Qué comprueba, contra el proyecto Supabase de `NEXT_PUBLIC_SUPABASE_URL`, con el
 * token REAL que firma `signRealtimeToken` (el mismo código que la action):
 *   V1  token propio → el canal privado `tenant:<id>:agenda` queda SUBSCRIBED.
 *   V2  token de otro tenant / sin token / `exp` vencido → CHANNEL_ERROR (nunca SUBSCRIBED).
 *   V3  `channel.send` desde un cliente con token propio NO llega a otro suscriptor
 *       (M5 no tiene policy INSERT: ningún cliente publica).
 *   V4  el token no sirve fuera del canal: PostgREST, GoTrue (`/auth/v1/user`) y
 *       Storage lo rechazan (o, Storage, devuelve la lista vacía porque RLS no deja ver nada).
 *   V5  publish REST con la service key → 202, y el suscriptor de V1 lo recibe.
 *   V6  20 publicaciones → p95 de recepción < 1 s.
 *   V7  «Allow public access» OFF (R4, FX1b): un join PÚBLICO (`config.private:false`) y
 *       SIN token a `tenant:<id>:agenda` no queda SUBSCRIBED; si el proyecto lo deja
 *       suscribir (public access ON), un `send` por ese canal público NO tiene que llegar
 *       al listener privado de V1. PASS si se rechaza el join, o si suscribe pero el
 *       mensaje no cruza (en ese caso el detalle avisa: hay que apagar «Allow public
 *       access»). Por qué: con public access ON cualquiera con la anon key (que viaja en
 *       el bundle) abre canales públicos; si uno con el mismo topic llegara a los
 *       suscriptores privados, se podrían inyectar avisos falsos.
 *
 * SOLO LECTURA sobre datos: no toca la base ni Storage. Lo único que "escribe" son
 * mensajes Broadcast efímeros `kind:"availability"` al topic del tenant de prueba (V5/V6):
 * un cliente abierto en ese tenant hace un `router.refresh()` y nada más.
 *
 * Seguridad:
 *  - Lee el env del proceso (nunca `lib/env`, nunca un archivo) y NO imprime valores:
 *    ni el secreto JWT, ni la service key, ni la anon key, ni los tokens. Solo el host
 *    y el project ref, para que se vea contra qué corre.
 *  - Rechaza localhost (el Docker local no tiene Realtime: un PASS/FAIL ahí no dice
 *    nada) y exige `--confirm=<project ref>` igual al ref de la URL: no corre contra un
 *    proyecto "por las dudas". `assertSafeTarget` no aplica: es para DATABASE_URL y
 *    acá no hay conexión a la base.
 *  - Pensado para staging. Contra prod solo si Martin lo decide (V5/V6 publican en el
 *    topic del tenant que se le pase).
 *
 * `lib/realtime-token-internal.ts` es `server-only`: tsx tiene que correr con la
 * condición `react-server` (molde `plans-dedupe-session-index.ts`).
 * Necesita `ws` (devDependency) porque Node 20 no tiene `WebSocket` global.
 *
 * Uso (lo corre Martin, con REALTIME_DRIVER=supabase en staging):
 *   npx dotenv -e .env.staging.local -- npx tsx --conditions=react-server \
 *     scripts/realtime-verify.ts --tenant <tenantId> --confirm=<project ref>
 * Variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET, SUPABASE_JWT_KID (opcional).
 * Sale con código 1 si algún chequeo da FAIL.
 */
import type {
  RealtimeChannel,
  RealtimeClient as RealtimeClientT,
  WebSocketLikeConstructor,
} from "@supabase/realtime-js";
import { signRealtimeToken } from "../lib/realtime-token-internal";
import { REALTIME_EVENT, topicFor } from "../lib/realtime-constants";
import { availabilityMessage } from "../lib/realtime-events";
import { toARDateKey } from "../lib/datetime-ar";

const NAME = "realtime-verify";
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const DELIVERY_WAIT_MS = 3_000;
// Un tenant id con forma de cuid que no existe: alcanza para V2 (la policy solo mira
// el topic contra el claim, no la tabla Tenant).
const FOREIGN_TENANT = "ckverifyforeigntenant0001";

type Row = { id: string; check: string; ok: boolean; detail: string };
const rows: Row[] = [];
const record = (id: string, check: string, ok: boolean, detail: string) => rows.push({ id, check, ok, detail });

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[${NAME}] falta la variable ${key} (no se imprime su valor).`);
  return v;
}

/** Host y project ref de la URL pública; aborta con localhost o sin confirmación. */
function checkTarget(url: string, confirm: string | undefined): { host: string; ref: string | null } {
  const host = new URL(url).hostname;
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$|host\.docker\.internal$)/.test(host)) {
    throw new Error(`[${NAME}] el destino es local (${host}): el Docker local no tiene Realtime. Es para staging.`);
  }
  const ref = host.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1] ?? null;
  console.log(`[${NAME}] destino: ${host}${ref ? ` (ref ${ref})` : ""}`);
  const expected = ref ?? host;
  if (confirm !== expected) {
    throw new Error(
      `[${NAME}] pasá --confirm=${expected} para confirmar que este es el proyecto de STAGING. Abortado.`
    );
  }
  return { host, ref };
}

/**
 * `ws` es devDependency (handoff a package.json) y el script tiene que compilar aunque
 * no esté instalado: el especificador va en una variable para que `tsc` no lo resuelva
 * (queda `any`) y se tipa con la interfaz mínima de realtime-js. Node 22+ ya trae
 * `WebSocket` global y no lo necesita.
 */
async function wsTransport(): Promise<WebSocketLikeConstructor> {
  const g = globalThis as { WebSocket?: WebSocketLikeConstructor };
  if (g.WebSocket) return g.WebSocket;
  const specifier = "ws";
  try {
    const mod = (await import(specifier)) as { default?: unknown; WebSocket?: unknown };
    return (mod.WebSocket ?? mod.default) as WebSocketLikeConstructor;
  } catch {
    throw new Error(`[${NAME}] falta \`ws\` (npm i -D ws @types/ws) y este Node no tiene WebSocket global.`);
  }
}

type Ctx = {
  url: string;
  anonKey: string;
  serviceKey: string;
  secret: string;
  kid: string | undefined;
  tenantId: string;
  topic: string;
  RealtimeClient: typeof RealtimeClientT;
  transport: WebSocketLikeConstructor;
};

function makeClient(ctx: Ctx, token: string | null): RealtimeClientT {
  return new ctx.RealtimeClient(`${ctx.url}/realtime/v1`, {
    params: { apikey: ctx.anonKey },
    accessToken: async () => token,
    transport: ctx.transport,
    // Sin ruido de realtime-js en la salida (podría loguear el access_token del join).
    logger: () => {},
  });
}

function tokenFor(ctx: Ctx, tenantId: string, now = new Date()): string {
  return signRealtimeToken({ tenantId, now, secret: ctx.secret, kid: ctx.kid }).token;
}

/** Se suscribe y resuelve con el primer estado terminal (o TIMED_OUT). */
async function subscribe(
  client: RealtimeClientT,
  topic: string,
  onAgenda?: (payload: unknown) => void,
  // V7: `false` = canal público (sin RLS de realtime.messages). Todo lo demás es privado.
  isPrivate = true
): Promise<{ channel: RealtimeChannel; status: string; error?: string }> {
  await client.setAuth();
  const channel = client.channel(topic, { config: { private: isPrivate, broadcast: { self: false } } });
  if (onAgenda) channel.on("broadcast", { event: REALTIME_EVENT }, (m) => onAgenda(m.payload));
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: string, err?: Error) => {
      if (done) return;
      done = true;
      // Solo el mensaje del error de realtime (motivo del rechazo), nunca el token.
      resolve({ channel, status, error: err?.message?.slice(0, 160) });
    };
    const t = setTimeout(() => finish("TIMED_OUT"), SUBSCRIBE_TIMEOUT_MS + 1_000);
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(t);
        finish(status, err);
      }
    }, SUBSCRIBE_TIMEOUT_MS);
  });
}

async function publishRest(ctx: Ctx, payload: unknown): Promise<number> {
  const res = await fetch(`${ctx.url}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: {
      apikey: ctx.serviceKey,
      Authorization: `Bearer ${ctx.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [{ topic: ctx.topic, event: REALTIME_EVENT, payload, private: true }] }),
  });
  await res.text().catch(() => "");
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const tenantId = arg("tenant");
  if (!tenantId || !/^[A-Za-z0-9]{16,40}$/.test(tenantId)) {
    throw new Error(`[${NAME}] uso: --tenant <tenantId> --confirm=<project ref>`);
  }
  const url = need("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  checkTarget(url, arg("confirm"));
  const kidRaw = process.env.SUPABASE_JWT_KID?.trim();
  const { RealtimeClient } = await import("@supabase/realtime-js");
  const ctx: Ctx = {
    url,
    anonKey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    serviceKey: need("SUPABASE_SERVICE_ROLE_KEY"),
    secret: need("SUPABASE_JWT_SECRET"),
    kid: kidRaw ? kidRaw : undefined,
    tenantId,
    topic: topicFor(tenantId),
    RealtimeClient,
    transport: await wsTransport(),
  };
  console.log(`[${NAME}] tenant ${tenantId} · kid ${ctx.kid ? "sí" : "no"} · topic ${ctx.topic}`);

  const clients: RealtimeClientT[] = [];
  const track = (c: RealtimeClientT) => (clients.push(c), c);
  try {
    // ── V1 · listener con token propio (queda abierto para V3/V5/V6) ──────────
    const received: { at: string; t: number }[] = [];
    const listener = track(makeClient(ctx, tokenFor(ctx, tenantId)));
    const v1 = await subscribe(listener, ctx.topic, (p) => {
      const at = (p as { at?: unknown } | null)?.at;
      if (typeof at === "string") received.push({ at, t: Date.now() });
    });
    record("V1", "token propio → SUBSCRIBED", v1.status === "SUBSCRIBED", v1.status + (v1.error ? ` · ${v1.error}` : ""));

    // ── V2 · tres tokens que NO deben entrar ──────────────────────────────────
    const v2Cases: { label: string; token: string | null }[] = [
      { label: "token de otro tenant", token: tokenFor(ctx, FOREIGN_TENANT) },
      { label: "sin token (solo anon key)", token: null },
      // Firmado hace 11 min: `exp` quedó 1 min en el pasado.
      { label: "token vencido", token: tokenFor(ctx, tenantId, new Date(Date.now() - 660_000)) },
    ];
    for (const c of v2Cases) {
      const r = await subscribe(track(makeClient(ctx, c.token)), ctx.topic);
      // CHANNEL_ERROR es el esperado; CLOSED (el server corta el socket) también es
      // rechazo. TIMED_OUT no prueba nada: FAIL para que se mire.
      record(
        "V2",
        `${c.label} → rechazado`,
        r.status === "CHANNEL_ERROR" || r.status === "CLOSED",
        r.status + (r.error ? ` · ${r.error}` : "")
      );
    }

    // ── V3 · un cliente no puede publicar ─────────────────────────────────────
    if (v1.status === "SUBSCRIBED") {
      const sender = track(makeClient(ctx, tokenFor(ctx, tenantId)));
      const s = await subscribe(sender, ctx.topic);
      const probeAt = `v3-probe-${Date.now()}`;
      let sendResp = "no enviado";
      if (s.status === "SUBSCRIBED") {
        sendResp = await s.channel
          .send({ type: "broadcast", event: REALTIME_EVENT, payload: { v: 1, kind: "availability", at: probeAt } })
          .catch((e: unknown) => `throw: ${e instanceof Error ? e.message : String(e)}`);
      }
      await sleep(DELIVERY_WAIT_MS);
      const leaked = received.some((r) => r.at === probeAt);
      record("V3", "channel.send de un cliente no llega", s.status === "SUBSCRIBED" && !leaked,
        `sender ${s.status} · send=${sendResp} · ${leaked ? "LLEGÓ al listener" : "no llegó"}`);
    } else {
      record("V3", "channel.send de un cliente no llega", false, "sin V1 no se puede probar");
    }

    // ── V7 · «Allow public access» OFF: un canal público no entra ni cruza ────
    {
      const pub = await subscribe(track(makeClient(ctx, null)), ctx.topic, undefined, false);
      if (pub.status !== "SUBSCRIBED") {
        // Rechazado en el join: es lo esperado con public access OFF. TIMED_OUT no
        // prueba nada (red): FAIL para que se mire, igual que V2.
        record(
          "V7",
          "join público sin token → rechazado",
          pub.status === "CHANNEL_ERROR" || pub.status === "CLOSED",
          pub.status + (pub.error ? ` · ${pub.error}` : "")
        );
      } else if (v1.status !== "SUBSCRIBED") {
        record("V7", "join público sin token → rechazado", false, "SUBSCRIBED (public access ON) y sin V1 para probar el cruce");
      } else {
        const probeAt = `v7-probe-${Date.now()}`;
        const sendResp = await pub.channel
          .send({ type: "broadcast", event: REALTIME_EVENT, payload: { v: 1, kind: "availability", at: probeAt } })
          .catch((e: unknown) => `throw: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(DELIVERY_WAIT_MS);
        const leaked = received.some((r) => r.at === probeAt);
        record(
          "V7",
          "canal público no llega al listener privado",
          !leaked,
          `público SUBSCRIBED (apagá «Allow public access») · send=${sendResp} · ${leaked ? "LLEGÓ al privado" : "no cruzó"}`
        );
      }
    }

    // ── V4 · el token no sirve fuera del canal ────────────────────────────────
    const token = tokenFor(ctx, tenantId);
    const authH = { apikey: ctx.anonKey, Authorization: `Bearer ${token}` };
    {
      const r = await fetch(`${url}/rest/v1/Tenant?select=id&limit=1`, { headers: authH });
      const body = await r.text().catch(() => "");
      const ok = [401, 403, 404].includes(r.status) || body.includes("42501");
      record("V4", "PostgREST rechaza el token", ok, `HTTP ${r.status}${body.includes("42501") ? " · 42501" : ""}`);
    }
    {
      const r = await fetch(`${url}/auth/v1/user`, { headers: authH });
      await r.text().catch(() => "");
      record("V4", "GoTrue /auth/v1/user rechaza el token", r.status === 401 || r.status === 403, `HTTP ${r.status}`);
    }
    {
      // El listado de Storage es un POST con prefijo (la API no tiene GET para listar).
      const r = await fetch(`${url}/storage/v1/object/list/patient-files`, {
        method: "POST",
        headers: { ...authH, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "", limit: 1 }),
      });
      const body = await r.text().catch(() => "");
      const empty = r.status === 200 && body.trim() === "[]";
      const ok = [400, 401, 403, 404].includes(r.status) || empty;
      record("V4", "Storage no lista patient-files", ok, `HTTP ${r.status}${empty ? " · lista vacía (RLS)" : ""}`);
    }

    // ── V5 · publish REST con la service key ──────────────────────────────────
    const msg5 = availabilityMessage({ practitionerId: null, day: toARDateKey(new Date()) }, new Date());
    const st5 = await publishRest(ctx, msg5);
    await sleep(DELIVERY_WAIT_MS);
    const got5 = received.some((r) => r.at === msg5.at);
    record("V5", "publish REST → 202 y llega al listener", st5 === 202 && (v1.status !== "SUBSCRIBED" || got5),
      `HTTP ${st5} · ${v1.status === "SUBSCRIBED" ? (got5 ? "recibido" : "NO recibido") : "sin listener"}`);

    // ── V6 · 20 publicaciones, p95 < 1 s ──────────────────────────────────────
    if (v1.status === "SUBSCRIBED") {
      const sent: { at: string; t0: number }[] = [];
      for (let i = 0; i < 20; i++) {
        // `at` único por mensaje (+i ms) para emparejar envío y recepción.
        const m = availabilityMessage(
          { practitionerId: null, day: toARDateKey(new Date()) },
          new Date(Date.now() + i)
        );
        const t0 = Date.now();
        await publishRest(ctx, m);
        sent.push({ at: m.at, t0 });
        await sleep(100);
      }
      await sleep(DELIVERY_WAIT_MS);
      const lat = sent
        .map((s) => {
          const r = received.find((x) => x.at === s.at);
          return r ? r.t - s.t0 : Number.POSITIVE_INFINITY;
        })
        .sort((a, b) => a - b);
      const p95 = lat[Math.ceil(lat.length * 0.95) - 1];
      const lost = lat.filter((x) => !Number.isFinite(x)).length;
      record("V6", "20 publicaciones → p95 < 1 s", Number.isFinite(p95) && p95 < 1000,
        `p95 ${Number.isFinite(p95) ? `${p95} ms` : "∞"} · perdidos ${lost}/20`);
    } else {
      record("V6", "20 publicaciones → p95 < 1 s", false, "sin V1 no se puede medir");
    }
  } finally {
    for (const c of clients) {
      try {
        c.removeAllChannels();
        c.disconnect();
      } catch {
        /* cierre best-effort */
      }
    }
  }

  const w = Math.max(...rows.map((r) => r.check.length));
  console.log("");
  for (const r of rows) console.log(`${r.id}  ${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(w)}  ${r.detail}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n[${NAME}] ${rows.length - failed}/${rows.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
