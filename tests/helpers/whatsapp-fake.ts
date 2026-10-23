/**
 * [WA-P3] Helper de tests para el Meta FALSO (C-WA5, brief §26.5). Molde: `tests/helpers/mp-connect-fake.ts`.
 *
 * Lo único que se reemplaza es la RED (`globalThis.fetch`): lo que va a `${APP_URL}/api/whatsapp/fake/*` lo atiende el
 * `fakeGraphHandle` real, y lo que el simulador POSTea al webhook entra por el handler que le pase el test (`webhook`:
 * el `POST` REAL de `app/api/webhooks/whatsapp/route.ts` cuando WA-S3 lo publique). Sin `webhook`, los POST se
 * registran y responden 200 `{ result: "recorded" }`. Cualquier otro host tira: un test no sale a internet (ni a
 * `graph.facebook.com`) por accidente.
 *
 * Los literales de la app (`WHATSAPP_APP_ID`, secreto, config, verify token) son los de `DEV_WAFAKE_LITERALS`
 * (`scripts/lib/dev-mp-fake-env.mjs`), los mismos que el `next dev` del simulador y el E2E. Nunca de `.env*`.
 *
 * `connectFakeWhatsApp` escribe la cuenta, la credencial sellada y las plantillas por el canal owner/service
 * (`ownerClient()`): con M15, `WhatsAppAccount` es solo lectura para `kinesoft_app` y `WhatsAppCredential` es
 * SERVICE_ONLY, igual que en prod los escribe `completeSignup` por `prismaService`.
 *
 * NOT a `.test.ts`: la corrida unit no lo levanta sola.
 */
import { randomInt } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { DEV_WAFAKE_LITERALS } from "@/scripts/lib/dev-mp-fake-env.mjs";
import {
  configureFakeGraph,
  fakeGraphAdvance,
  fakeGraphDecideTemplates,
  fakeGraphGetMessage,
  fakeGraphHandle,
  fakeGraphHooks,
  fakeGraphInboundText,
  fakeGraphMessageByCallback,
  fakeGraphMessages,
  fakeGraphPartnerRemoved,
  fakeGraphPressButton,
  fakeGraphProvision,
  fakeGraphQuality,
  fakeGraphSignup,
  fakeGraphWaba,
  resetFakeGraph,
  FAKE_WA_MAGIC,
  type FakeGraphConfig,
  type FakeHookResult,
  type FakeTemplateStatus,
} from "@/lib/whatsapp/fake-graph";
import { WA_FAKE_PATH } from "@/lib/whatsapp/graph";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { WA_TEMPLATE_KEYS, type WaAccountStatus } from "@/lib/whatsapp/types";
import { sealSecret, sealedKid, waCredentialAad } from "@/lib/secret-box";

export {
  fakeGraphAdvance,
  fakeGraphGetMessage,
  fakeGraphHooks,
  fakeGraphMessageByCallback,
  fakeGraphMessages,
  fakeGraphPartnerRemoved,
  fakeGraphQuality,
  fakeGraphSignup,
  fakeGraphWaba,
  resetFakeGraph,
  FAKE_WA_MAGIC,
};

export const FAKE_WA_APP_URL = "http://localhost:3000";
export const FAKE_WA = DEV_WAFAKE_LITERALS;

/** Celulares de prueba (E.164): uno normal y los mágicos del simulador (C-WA5). */
export const FAKE_WA_PHONES = {
  ok: "+5491155550100",
  undeliverable: `+54911555${"5"}${FAKE_WA_MAGIC.undeliverable}`,
  payment: `+54911555${"5"}${FAKE_WA_MAGIC.payment}`,
  timeout: `+54911555${"5"}${FAKE_WA_MAGIC.timeout}`,
  rateLimit: `+54911555${"5"}${FAKE_WA_MAGIC.rateLimit}`,
} as const;

export type FakeWaHook = {
  url: string;
  headers: Record<string, string>;
  /** Bytes crudos tal cual salieron (la firma es sobre esto). */
  raw: string;
  body: Record<string, unknown>;
  status: number;
  result: string | null;
};

export type InstalledFakeGraph = {
  hooks: FakeWaHook[];
  /** URLs que pidió el código bajo test al fake (para afirmar «0 llamadas a Meta»). */
  calls: string[];
  /** El webhook que recibe los avisos; se puede cambiar después de instalar (WA-S3 lo inyecta). */
  setWebhook: (h: ((req: Request) => Promise<Response>) | null) => void;
  uninstall: () => void;
};

/**
 * Prende el modo fake (env de prueba, sin `VERCEL_ENV`/`VERCEL`), vacía el store y enruta la red. Por default las
 * plantillas se aprueban a mano (`approveFakeTemplates`) y los estados no avanzan solos (`fakeGraphAdvance`): un test
 * determinista no espera timers. `uninstall()` deshace env, fetch y store (llamalo en `afterEach`/`finally`).
 */
export function installFakeGraph(
  o: {
    webhook?: (req: Request) => Promise<Response>;
    appUrl?: string;
    reset?: boolean;
    config?: Partial<FakeGraphConfig>;
    /** Otro secreto de la app (p. ej. para que la ruta vea una firma que no valida). */
    appSecret?: string;
  } = {}
): InstalledFakeGraph {
  // Un install sin su uninstall (p. ej. una fixture de `authz-matrix` que se arma dos veces en el mismo archivo) guardaba
  // `WHATSAPP_MODE=fake` como «valor anterior»: el modo quedaba prendido para los archivos siguientes del mismo fork
  // (ZG 23-oct: `createBooking` +1 sentencia y la clave `whatsapp:live-account` en el caché del directorio). Un install
  // nuevo deshace el anterior primero, así el env y el fetch siempre vuelven a los del archivo.
  activeFakeGraph?.uninstall();
  const app = (o.appUrl ?? FAKE_WA_APP_URL).replace(/\/+$/, "");
  const fake = `${app}${WA_FAKE_PATH}`;
  const hookPrefix = `${app}/api/webhooks/whatsapp`;
  // Env a mano (no `vi.stubEnv`): `uninstall` restaura SOLO estas claves y no pisa los stubs propios del test.
  const ENV: Record<string, string | undefined> = {
    WHATSAPP_MODE: "fake",
    VERCEL_ENV: undefined,
    VERCEL: undefined,
    NEXT_PUBLIC_APP_URL: app,
    WHATSAPP_APP_ID: FAKE_WA.WHATSAPP_APP_ID,
    WHATSAPP_APP_SECRET: o.appSecret ?? FAKE_WA.WHATSAPP_APP_SECRET,
    WHATSAPP_CONFIG_ID: FAKE_WA.WHATSAPP_CONFIG_ID,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: FAKE_WA.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_GRAPH_VERSION: undefined,
  };
  const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const setEnv = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  setEnv(ENV);
  if (o.reset !== false) resetFakeGraph();
  configureFakeGraph({ templateApproval: "manual", autoStatuses: false, ...(o.config ?? {}) });

  let webhook = o.webhook ?? null;
  const hooks: FakeWaHook[] = [];
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (url.startsWith(fake)) {
      calls.push(url);
      const req = input instanceof Request && !init ? input : new Request(url, init);
      // Como un fetch de verdad: si el caller aborta (timeout), la promesa rechaza aunque el fake siga colgado.
      const res = fakeGraphHandle(req);
      if (!signal) return res;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        res.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    }
    if (url.startsWith(hookPrefix)) {
      const raw = String(init?.body ?? "");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        body = {};
      }
      const req = new Request(url, { method: "POST", headers, body: raw });
      const res = webhook
        ? await webhook(req)
        : new Response(JSON.stringify({ result: "recorded" }), { status: 200, headers: { "content-type": "application/json" } });
      let result: string | null = null;
      try {
        const j = (await res.clone().json()) as { result?: unknown };
        result = typeof j?.result === "string" ? j.result : null;
      } catch {
        result = null;
      }
      hooks.push({ url, headers, raw, body, status: res.status, result });
      return res;
    }
    throw new Error(`[whatsapp-fake] red real bloqueada en el test: ${url}`);
  };
  globalThis.fetch = stub as typeof fetch;

  let installed = true;
  const handle: InstalledFakeGraph = {
    hooks,
    calls,
    setWebhook: (h) => {
      webhook = h;
    },
    // Idempotente: el `afterEach` y el `finally` de una celda pueden llamarlo los dos.
    uninstall: () => {
      if (!installed) return;
      installed = false;
      if (activeFakeGraph === handle) activeFakeGraph = null;
      setEnv(prevEnv);
      globalThis.fetch = realFetch;
      if (o.reset !== false) resetFakeGraph();
    },
  };
  activeFakeGraph = handle;
  return handle;
}

let activeFakeGraph: InstalledFakeGraph | null = null;

/** Lo mínimo de `EphemeralTenant` (no se importa el factory: este helper sirve también fuera de él). */
type TenantLike = { tenantId: string; userId: string };

export type FakeWhatsAppAccount = {
  accountId: string;
  credentialId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhone: string;
  /** En claro SOLO en el test (para afirmar que nunca aparecen en logs, audit ni respuestas). */
  token: string;
  pin: string;
};

/**
 * Cuenta de WhatsApp conectada contra el fake: WABA + número registrados y suscriptos en el simulador, y en la base
 * `WhatsAppAccount` (ACTIVE/DONE por default) + `WhatsAppCredential` sellada con la MISMA AAD que el código
 * (`waCredentialAad(accountId, "token"|"pin")`) + una `WhatsAppTemplate` por clave de `TEMPLATE_SPECS`. Las plantillas
 * quedan en el mismo estado en la base y en el fake (default APPROVED). Requiere `installFakeGraph` antes.
 */
export async function connectFakeWhatsApp(
  db: PrismaClient,
  t: TenantLike,
  o: {
    status?: WaAccountStatus;
    templateStatus?: Exclude<FakeTemplateStatus, "DISABLED"> | "NOT_SUBMITTED";
    autoBookingNotice?: boolean;
    autoReminder?: boolean;
    autoReplyText?: boolean;
  } = {}
): Promise<FakeWhatsAppAccount> {
  const status = o.status ?? "ACTIVE";
  const tplStatus = o.templateStatus ?? "APPROVED";
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const prov = fakeGraphProvision({
    pin,
    templates:
      tplStatus === "NOT_SUBMITTED"
        ? []
        : WA_TEMPLATE_KEYS.map((k) => {
            const s = TEMPLATE_SPECS[k];
            return { name: s.name, language: s.language, body: s.body, header: s.header, buttons: s.buttons.length, status: tplStatus };
          }),
  });
  const now = new Date();
  const account = await db.whatsAppAccount.create({
    data: {
      tenantId: t.tenantId,
      mode: "fake",
      wabaId: prov.wabaId,
      phoneNumberId: prov.phoneNumberId,
      businessId: prov.businessId,
      displayPhone: prov.displayPhone,
      verifiedName: "Consultorio de prueba",
      qualityRating: "GREEN",
      messagingLimit: "TIER_250",
      status,
      // CHECK `WhatsAppAccount_status_check`: ACTIVE exige DONE; DISCONNECTED exige disconnectedAt; REAUTH, reauthRequiredAt.
      setupStep: status === "SETUP" ? "TOKEN" : "DONE",
      autoBookingNotice: o.autoBookingNotice ?? true,
      autoReminder: o.autoReminder ?? true,
      autoReplyText: o.autoReplyText ?? true,
      connectedByUserId: t.userId,
      connectedAt: now,
      reauthRequiredAt: status === "REAUTH_REQUIRED" ? now : null,
      disconnectedAt: status === "DISCONNECTED" ? now : null,
      disconnectedByUserId: status === "DISCONNECTED" ? t.userId : null,
    },
    select: { id: true },
  });
  const tokenBox = sealSecret(prov.token, waCredentialAad(account.id, "token"));
  const pinBox = sealSecret(pin, waCredentialAad(account.id, "pin"));
  const keyId = sealedKid(tokenBox);
  if (!keyId) throw new Error("[whatsapp-fake] el sobre no tiene kid");
  const credential = await db.whatsAppCredential.create({
    data: { tenantId: t.tenantId, accountId: account.id, tokenBox, pinBox, keyId },
    select: { id: true },
  });
  await db.whatsAppTemplate.createMany({
    data: WA_TEMPLATE_KEYS.map((k) => {
      const s = TEMPLATE_SPECS[k];
      return {
        tenantId: t.tenantId,
        accountId: account.id,
        key: k,
        name: s.name,
        language: s.language,
        specVersion: s.specVersion,
        status: tplStatus,
        submittedAt: tplStatus === "NOT_SUBMITTED" ? null : now,
        statusAt: tplStatus === "NOT_SUBMITTED" ? null : now,
      };
    }),
  });
  return {
    accountId: account.id,
    credentialId: credential.id,
    wabaId: prov.wabaId,
    phoneNumberId: prov.phoneNumberId,
    displayPhone: prov.displayPhone,
    token: prov.token,
    pin,
  };
}

/** Aprueba (o rechaza/pausa) las plantillas PENDING del fake, con su webhook firmado. */
export function approveFakeTemplates(
  o: { wabaId?: string; names?: string[]; decision?: "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED"; reason?: string } = {}
): Promise<{ name: string; hook: FakeHookResult }[]> {
  return fakeGraphDecideTemplates(o);
}

/** El paciente aprieta «Confirmo» (`c`) o «No puedo ir» (`x`) en el recordatorio `wamid`. */
export function pressButton(wamid: string, kind: "c" | "x"): Promise<FakeHookResult> {
  return fakeGraphPressButton(wamid, kind);
}

/** El paciente escribe `text` desde `from` (E.164) al número del consultorio (default: el primero del fake). */
export function sendInbound(from: string, text: string, o: { phoneNumberId?: string } = {}): Promise<FakeHookResult> {
  return fakeGraphInboundText({ from, text, phoneNumberId: o.phoneNumberId });
}
