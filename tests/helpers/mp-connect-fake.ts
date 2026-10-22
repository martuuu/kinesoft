/**
 * [TP-K3] Helper de tests para el Mercado Pago FALSO de T5 (C-TP12, brief §25.9). Molde: `tests/unit/tp-p4-fake-mp.test.ts`.
 *
 * Por qué existe: los tests de T5d (webhook, OAuth, turnero, links, cron) y el E2E prueban el flujo de punta a punta sin
 * tocar Mercado Pago real ni el sandbox (regla de T5: PRODUCCIÓN INADMISIBLE). Lo único que se reemplaza es la RED
 * (`globalThis.fetch`): lo que va a `${APP_URL}/api/mp/fake/*` lo atiende el `fakeMpHandle` real, y lo que el simulador
 * POSTea al webhook entra por el `POST` REAL de `app/api/webhooks/mercadopago/route.ts` que le pase el test. Cualquier
 * otro host tira: un test que se olvidó de algo no sale a internet por accidente.
 *
 * `connectFakeAccount` escribe la cuenta y la credencial por el canal owner/service (`ownerClient()` en los tests): con
 * M18, `MpAccount` es solo SELECT para `kinesoft_app` y `MpCredential` no tiene policy, igual que en prod la escribe el
 * callback OAuth por `prismaService`. Los tokens se sellan con `lib/secret-box.ts` y la MISMA AAD que usa el código
 * (`mpCredentialAad(mpAccountId, campo)`), y salen del fake (`fakeMpIssueTokens`), así que el refresh y el GET del pago
 * contra el fake funcionan con esa credencial.
 *
 * NOT a `.test.ts`: la corrida unit no lo levanta sola.
 */
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  fakeMpForceReauth,
  fakeMpGetPayment,
  fakeMpGetPreference,
  fakeMpIssueTokens,
  resetFakeMp,
  simulateFakePayment,
  type FakeMpMethod,
  type FakeMpOutcome,
  fakeMpHandle,
} from "@/lib/mp-connect/fake-mp";
import { MP_FAKE_PATH } from "@/lib/mp-connect/constants";
import { mpCredentialAad, sealSecret, sealedKid } from "@/lib/secret-box";
import { DEFAULT_PAYMENT_POLICY, type PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import type { MpAccountKind, MpAccountStatus } from "@/lib/online-payments-types";

export { fakeMpForceReauth, fakeMpGetPayment, fakeMpGetPreference, fakeMpIssueTokens, resetFakeMp };

/** Literales de prueba (los mismos que `scripts/dev-mp-fake.mjs` y el E2E): nunca valores de `.env*`. */
export const FAKE_APP_URL = "http://localhost:3000";
export const FAKE_HOOK_SECRET = "secreto-de-prueba-del-webhook";
export const FAKE_CLIENT_ID = "kinesoft-fake-app";
export const FAKE_CLIENT_SECRET = "kinesoft-fake-secret";

export type FakeHook = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  status: number;
  result: string | null;
};

export type InstalledFakeMp = {
  /** Cada POST que el simulador mandó al webhook, con la respuesta de la ruta. */
  hooks: FakeHook[];
  /** URLs que pidió el código bajo test al fake (para afirmar «0 llamadas a MP»). */
  calls: string[];
  uninstall: () => void;
};

/**
 * Prende el modo fake (env de prueba, sin `VERCEL_ENV`/`VERCEL`), vacía el store del fake y enruta la red. `webhook`
 * es el `POST` real de la ruta; sin él, los POST al webhook se registran y responden 200 `{ result: "applied" }` (como el
 * unit de TP-P4). `uninstall()` deshace env y fetch (llamalo en `afterEach`/`finally`).
 */
export function installFakeMp(o: {
  webhook?: (req: Request) => Promise<Response>;
  appUrl?: string;
  signature?: "required" | "fetch-only";
  /**
   * false = no vacía el store del fake (ni al instalar ni al desinstalar): para instalar la red DESPUÉS de
   * `connectFakeAccount` sin perder los tokens que emitió (p. ej. alrededor de una sola action, como en `authz-matrix`).
   */
  reset?: boolean;
  /** Otro secreto (p. ej. para probar una firma que no valida). Sin firma no se puede: el fake cae al de `env`. */
  hookSecret?: string;
} = {}): InstalledFakeMp {
  const app = (o.appUrl ?? FAKE_APP_URL).replace(/\/+$/, "");
  const fake = `${app}${MP_FAKE_PATH}`;
  const hookPrefix = `${app}/api/webhooks/mercadopago`;
  // Env a mano (no `vi.stubEnv`): `uninstall` restaura SOLO estas claves y no pisa los stubs propios del test.
  const ENV: Record<string, string | undefined> = {
    MP_CONNECT_MODE: "fake",
    VERCEL_ENV: undefined,
    VERCEL: undefined,
    NEXT_PUBLIC_APP_URL: app,
    MP_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
    MP_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    MP_CONNECT_WEBHOOK_SIGNATURE: o.signature ?? "required",
    MP_CONNECT_WEBHOOK_SECRET: o.hookSecret ?? FAKE_HOOK_SECRET,
  };
  const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const setEnv = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  setEnv(ENV);
  if (o.reset !== false) resetFakeMp();

  const hooks: FakeHook[] = [];
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(fake)) {
      calls.push(url);
      return fakeMpHandle(input instanceof Request && !init ? input : new Request(url, init));
    }
    if (url.startsWith(hookPrefix)) {
      const req = new Request(url, init);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const res = o.webhook ? await o.webhook(req) : new Response(JSON.stringify({ result: "applied" }), { status: 200 });
      let result: string | null = null;
      try {
        const j = (await res.clone().json()) as { result?: unknown };
        result = typeof j?.result === "string" ? j.result : null;
      } catch {
        result = null;
      }
      hooks.push({ url, headers, body, status: res.status, result });
      return res;
    }
    throw new Error(`[mp-connect-fake] red real bloqueada en el test: ${url}`);
  };
  globalThis.fetch = stub as typeof fetch;

  return {
    hooks,
    calls,
    uninstall: () => {
      setEnv(prevEnv);
      globalThis.fetch = realFetch;
      if (o.reset !== false) resetFakeMp();
    },
  };
}

/** Lo mínimo de `EphemeralTenant` que hace falta (no se importa el factory: este helper sirve también fuera de él). */
type TenantLike = { tenantId: string; practitionerId: string; userId: string };

export type FakeAccount = {
  accountId: string;
  credentialId: string;
  webhookRef: string;
  mpUserId: string;
  nickname: string;
  kind: MpAccountKind;
  practitionerId: string | null;
  /** En claro SOLO en el test (para afirmar que nunca aparecen en logs, audit ni respuestas). */
  accessToken: string;
  refreshToken: string;
};

/**
 * Crea una cuenta conectada con el fake: `MpAccount` + `MpCredential` sellada. Por default, la del profesional
 * principal del consultorio, ACTIVE, sin delegación y con el vendedor de prueba 1.
 */
export async function connectFakeAccount(
  db: PrismaClient,
  t: TenantLike,
  o: {
    seller?: 1 | 2;
    kind?: MpAccountKind;
    /** PRACTITIONER: default `t.practitionerId`. CLINIC: se ignora (null). */
    practitionerId?: string;
    linksDelegated?: boolean;
    status?: MpAccountStatus;
    /** Vencimiento del access token (default +180 días, como MP). Para probar el refresh: algo cercano. */
    accessExpiresAt?: Date;
    purgeAfter?: Date | null;
    liveMode?: boolean;
  } = {}
): Promise<FakeAccount> {
  const kind = o.kind ?? "PRACTITIONER";
  const practitionerId = kind === "CLINIC" ? null : (o.practitionerId ?? t.practitionerId);
  const status = o.status ?? "ACTIVE";
  const tokens = fakeMpIssueTokens(o.seller ?? 1);
  // 128 bits opacos (CHECK `MpAccount_webhookRef_check`: 22 caracteres base64url), como el callback.
  const webhookRef = randomBytes(16).toString("base64url");
  const now = new Date();

  const account = await db.mpAccount.create({
    data: {
      tenantId: t.tenantId,
      practitionerId,
      kind,
      mpUserId: tokens.userId,
      mpNickname: tokens.nickname,
      liveMode: o.liveMode ?? false,
      publicKey: tokens.publicKey,
      webhookRef,
      // CHECK `MpAccount_status_check`: una DISCONNECTED no puede quedar delegada.
      linksDelegated: status === "DISCONNECTED" ? false : (o.linksDelegated ?? false),
      status,
      connectedByUserId: t.userId,
      connectedAt: now,
      reauthRequiredAt: status === "REAUTH_REQUIRED" ? now : null,
      disconnectedAt: status === "DISCONNECTED" ? now : null,
      disconnectedByUserId: status === "DISCONNECTED" ? t.userId : null,
    },
    select: { id: true },
  });

  const accessTokenBox = sealSecret(tokens.accessToken, mpCredentialAad(account.id, "accessToken"));
  const refreshTokenBox = sealSecret(tokens.refreshToken, mpCredentialAad(account.id, "refreshToken"));
  const keyId = sealedKid(accessTokenBox);
  if (!keyId) throw new Error("[mp-connect-fake] el sobre no tiene kid");
  const credential = await db.mpCredential.create({
    data: {
      tenantId: t.tenantId,
      mpAccountId: account.id,
      accessTokenBox,
      refreshTokenBox,
      keyId,
      accessExpiresAt: o.accessExpiresAt ?? new Date(now.getTime() + 180 * 86_400_000),
      purgeAfter: o.purgeAfter ?? (status === "DISCONNECTED" ? new Date(now.getTime() + 7 * 86_400_000) : null),
    },
    select: { id: true },
  });

  return {
    accountId: account.id,
    credentialId: credential.id,
    webhookRef,
    mpUserId: tokens.userId,
    nickname: tokens.nickname,
    kind,
    practitionerId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}

/** Upsert de la política del consultorio (por el owner; los defaults son los de las columnas de M18). */
export async function setPaymentPolicy(db: PrismaClient, tenantId: string, p: Partial<PaymentPolicyInput>): Promise<PaymentPolicyInput> {
  const policy: PaymentPolicyInput = { ...DEFAULT_PAYMENT_POLICY, ...p };
  await db.bookingPaymentPolicy.upsert({
    where: { tenantId },
    create: { tenantId, ...policy },
    update: policy,
  });
  return policy;
}

/**
 * Paga (o rechaza, o reintegra) una preferencia del fake por el simulador: el webhook sale FIRMADO hacia la
 * `notification_url` real de la preferencia (con su `?acct=`). Requiere `installFakeMp` (el modo fake y la red).
 */
export async function payFake(
  preferenceId: string,
  outcome: FakeMpOutcome,
  o: { amountCents?: number; method?: FakeMpMethod } = {}
): Promise<{ paymentId: string; webhookStatus: number; webhookResult?: string }> {
  return simulateFakePayment({ preferenceId, outcome, ...o });
}
