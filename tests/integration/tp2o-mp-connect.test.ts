/**
 * T5 · [TP-2o] Cuentas de Mercado Pago y política de cobro (plan §25.4, contratos C-TP4 y C-TP5).
 *
 * Nació en TP-K2 con el camino feliz como `it.fails`; TP-2b lo implementa y lo da vuelta, y suma los rechazos
 * (Secretaria, soporte, sin step-up, `in_use`, state ajeno, consultorio cambiado, `live_mode`).
 *
 * Símbolos REALES contra Postgres, en los dos roles: las actions de `lib/mp-connect-actions.ts` y
 * `lib/booking-payment-policy.ts`, el `GET` de `app/api/mp/oauth/callback/route.ts`, `requireStepUp`, el secret-box y
 * el cliente de cuenta (`withAccountToken`). Lo externo se reemplaza:
 *   - Mercado Pago: el MP FALSO local (`installFakeMp`: solo la RED; nada de MP real ni sandbox, regla de T5). La
 *     pantalla de autorización se «clickea» con un POST al fake, como el navegador.
 *   - La sesión de Supabase con `session_id`/`aal` (molde de saas-billing): el state del OAuth y el step-up se atan a
 *     la sesión, así que sin `session_id` no hay nada que probar.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";

const tok = vi.hoisted(() => ({ claims: null as null | { session_id: string; aal: string } }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("@/tests/helpers/actor");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (): string | null => {
    const u = currentTestUser();
    if (!u || !tok.claims) return null;
    const payload = { sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...tok.claims };
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma-que-verifica-gotrue`;
  };
  return {
    getSupabaseServerClient: () => ({
      auth: {
        getSession: async () => {
          const t = token();
          if (!t) throw new Error("sin getSession");
          return { data: { session: { access_token: t } }, error: null };
        },
        getUser: async () => ({ data: { user: currentTestUser() }, error: null }),
        getClaims: async () => ({ data: null, error: { message: "sin JWKS" } }),
      },
    }),
  };
});

import {
  startMpConnect,
  disconnectMpAccount,
  setMpLinksDelegated,
  getMyMpAccount,
  getOnlinePaymentsSettings,
} from "@/lib/mp-connect-actions";
import { savePaymentPolicy } from "@/lib/booking-payment-policy";
import { GET as oauthCallback } from "@/app/api/mp/oauth/callback/route";
import { withAccountToken, mpCreatePreference, type MpAccountRef } from "@/lib/mp-connect/account-client";
import { MP_OAUTH_COOKIE, makeOAuthState, mpOAuthStateExp, newOAuthNonce } from "@/lib/mp-connect/oauth-state";
import { MP_FAKE_PATH } from "@/lib/mp-connect/constants";
import { FAKE_MP_SELLERS } from "@/lib/mp-connect/fake-mp";
import { mpCredentialAad, openSecret } from "@/lib/secret-box";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { StepUpRequiredError } from "@/lib/two-factor-step-up";
import { ForbiddenError, getActor } from "@/lib/session";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { logger } from "@/lib/logger";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import {
  installFakeMp,
  connectFakeAccount,
  fakeMpForceReauth,
  fakeMpGetPreference,
  FAKE_APP_URL,
  type InstalledFakeMp,
} from "@/tests/helpers/mp-connect-fake";
import { randomBytes, randomUUID } from "node:crypto";

const RUN = process.env.INTEGRATION === "1";
const SELLER = { 1: FAKE_MP_SELLERS[0].userId, 2: FAKE_MP_SELLERS[1].userId } as const;
const DAY_MS = 86_400_000;
/** Forma de los tokens del fake (`FAKE-<user>-…` / `FAKE-TG-<user>-…`): nunca tienen que aparecer fuera de la base. */
const TOKEN_RE = /FAKE-(TG-)?9000000\d{2}-/;

describe.skipIf(!RUN)("[TP-2o] OAuth y cuentas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let T2: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let kine2: { userId: string; practitionerId: string };
  let secretaria: string;
  let facturacion: string;
  let admin: string;
  let fake: InstalledFakeMp;
  const sess = () => `sess-${uniqueSuffix()}`;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    T2 = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    kine2 = await addPractitioner(db, T, "PRACTITIONER");
    // La Secretaria y Facturación CON «Configuración»: igual no llegan a lo delicado (corte de staff de T3).
    secretaria = (await addStaff(db, T, "ASSISTANT", { grantSettings: true })).userId;
    facturacion = (await addStaff(db, T, "BILLING", { grantSettings: true })).userId;
    // Administrador/a de hoy (no atiende, con «Configuración»): tiene `tenant.sensitive` pero no `account.owner`.
    admin = (await addStaff(db, T, "ADMIN", { grantSettings: true })).userId;
    // El kine también es miembro de otro consultorio (para «cambió el consultorio activo»).
    await db.practitioner.create({ data: { tenantId: T2.tenantId, userId: kine.userId, specialty: "Test" } });
    await db.membership.create({ data: { userId: kine.userId, tenantId: T2.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
  });

  afterAll(async () => {
    await db?.userProfile.updateMany({ where: { id: T?.userId }, data: { twoFactorTotp: false } });
    await T?.cleanup();
    await T2?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    fake = installFakeMp();
    tok.claims = { session_id: sess(), aal: "aal2" };
    for (const c of [MP_OAUTH_COOKIE, STEP_UP_COOKIE, TWO_FACTOR_COOKIE, SUPPORT_COOKIE]) cookies().delete(c);
    // El kine es miembro de T y de T2: el consultorio activo se fija explícito (sin cookie elegiría uno solo).
    cookies().set(ACTIVE_TENANT_COOKIE, T.tenantId);
    // Las cuentas vivas de la corrida anterior se desconectan a mano (owner): el fake tiene dos vendedores y una cuenta
    // viva por profesional/consultorio (parciales de M18); cada caso arranca sin cuentas vivas.
    await db.mpAccount.updateMany({
      where: { tenantId: { in: [T.tenantId, T2.tenantId] }, status: { not: "DISCONNECTED" } },
      data: { status: "DISCONNECTED", disconnectedAt: new Date(), disconnectedByUserId: "test-tp2o", linksDelegated: false },
    });
  });

  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** «Clickea» la pantalla de autorización del fake (POST como el form) y devuelve la URL de vuelta al callback. */
  async function authorize(authUrl: string, seller: 1 | 2 | "cancel"): Promise<string> {
    const u = new URL(authUrl);
    const form = new URLSearchParams({
      client_id: u.searchParams.get("client_id") ?? "",
      redirect_uri: u.searchParams.get("redirect_uri") ?? "",
      state: u.searchParams.get("state") ?? "",
      code_challenge: u.searchParams.get("code_challenge") ?? "",
      seller: seller === "cancel" ? "cancel" : SELLER[seller],
    });
    const res = await fetch(`${FAKE_APP_URL}${MP_FAKE_PATH}/authorization`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.status).toBe(303);
    return res.headers.get("location") as string;
  }

  async function callback(url: string): Promise<{ res: Response; dest: URL }> {
    const res = await oauthCallback(new Request(url));
    expect(res.status).toBe(303);
    return { res, dest: new URL(res.headers.get("location") as string) };
  }

  /** Flujo completo: action → autorización en el fake → callback. */
  async function connect(target: "own" | "clinic", seller: 1 | 2 = 1) {
    const r = await startMpConnect({ target });
    if (!r.ok) throw new Error(`startMpConnect: ${r.error}`);
    const back = await authorize(r.data.url, seller);
    return { start: r, back, ...(await callback(back)) };
  }

  const liveAccounts = (where: { practitionerId?: string | null }) =>
    db.mpAccount.findMany({ where: { tenantId: T.tenantId, ...where, status: { not: "DISCONNECTED" } } });
  const tokenCalls = () => fake.calls.filter((u) => u.includes("/oauth/token")).length;

  async function enable2fa(userId: string, withStepUp: boolean) {
    await db.userProfile.update({ where: { id: userId }, data: { twoFactorTotp: true } });
    if (withStepUp) setStepUpCookie(userId, tok.claims!.session_id);
  }

  // ── Conectar ────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2o] El profesional conecta: ACTIVE por service + credencial sellada + audit sin tokens.", async () => {
    asUser(kine.userId);
    expect(await getMyMpAccount()).toMatchObject({ status: "NONE", nickname: null, linksDelegated: false });
    const { start, dest } = await connect("own", 1);
    const u = new URL(start.data.url);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(Object.fromEntries(dest.searchParams)).toEqual({ tab: "mercado-pago", mp: "ok" });

    const [acc] = await liveAccounts({ practitionerId: kine.practitionerId });
    expect(acc).toMatchObject({
      kind: "PRACTITIONER",
      status: "ACTIVE",
      mpUserId: SELLER[1],
      mpNickname: FAKE_MP_SELLERS[0].nickname,
      liveMode: false,
      linksDelegated: false,
      connectedByUserId: kine.userId,
    });
    expect(acc.webhookRef).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const cred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.id } });
    expect(cred.tenantId).toBe(T.tenantId);
    expect(cred.accessTokenBox).toMatch(/^v1\./);
    expect(cred.accessTokenBox).not.toMatch(TOKEN_RE);
    // Abre SOLO con la AAD de esta cuenta y campo.
    expect(openSecret(cred.accessTokenBox, mpCredentialAad(acc.id, "accessToken"))).toMatch(TOKEN_RE);
    expect(() => openSecret(cred.accessTokenBox, mpCredentialAad(acc.id, "refreshToken"))).toThrow();

    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: "mpAccount.connect", entityId: acc.id } });
    expect(ev.actorId).toBe(kine.userId);
    expect(ev.payload).toMatchObject({ target: "own", sameMpAccount: false, replacedAccountId: null });
    expect(JSON.stringify(ev.payload)).not.toMatch(TOKEN_RE);

    expect(await getMyMpAccount()).toMatchObject({ status: "ACTIVE", nickname: FAKE_MP_SELLERS[0].nickname, badge: "fake" });
  });

  it("[TP-2o] Mismo code dos veces → la segunda no escribe.", async () => {
    asUser(kine.userId);
    const { back } = await connect("own", 1);
    const [acc] = await liveAccounts({ practitionerId: kine.practitionerId });
    const before = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.id } });
    const audits = await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "mpAccount.connect" } });
    // El mock de cookies no aplica el Set-Cookie del borrado: la cookie sigue, y lo que frena es el código de un uso.
    const again = await callback(back);
    expect(again.dest.searchParams.get("mp")).toBe("expired");
    const after = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.id } });
    expect(after.version).toBe(before.version);
    expect(after.accessTokenBox).toBe(before.accessTokenBox);
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "mpAccount.connect" } })).toBe(audits);
    // Y el callback siempre borra la cookie con su path.
    expect(again.res.headers.get("set-cookie")).toMatch(/kine_mp_oauth=;.*Path=\/api\/mp\/oauth/i);
  });

  it("[TP-2o] Cookie ajena o state cambiado → 0 canjes.", async () => {
    asUser(kine.userId);
    const r = await startMpConnect({ target: "own" });
    if (!r.ok) throw new Error(r.error);
    const back = await authorize(r.data.url, 1);

    // State cambiado.
    const tampered = new URL(back);
    tampered.searchParams.set("state", "x".repeat(43));
    expect((await callback(tampered.toString())).dest.searchParams.get("mp")).toBe("error");

    // Cookie de otro usuario (firmada por nosotros, para otro) con el state que le corresponde.
    const other = makeOAuthState({
      userId: kine2.userId,
      sessionId: tok.claims!.session_id,
      tenantId: T.tenantId,
      target: "own",
      practitionerId: kine2.practitionerId,
      nonce: newOAuthNonce(),
      exp: mpOAuthStateExp(),
    });
    cookies().set(MP_OAUTH_COOKIE, other.cookie);
    const forged = new URL(back);
    forged.searchParams.set("state", other.state);
    expect((await callback(forged.toString())).dest.searchParams.get("mp")).toBe("error");

    // Otra sesión del mismo usuario (la cookie vuelve a ser la del inicio).
    const r2 = await startMpConnect({ target: "own" });
    if (!r2.ok) throw new Error(r2.error);
    const back2 = await authorize(r2.data.url, 1);
    tok.claims = { session_id: sess(), aal: "aal2" };
    expect((await callback(back2)).dest.searchParams.get("mp")).toBe("error");

    // Sin cookie: venció o es otro navegador.
    cookies().delete(MP_OAUTH_COOKIE);
    expect((await callback(back2)).dest.searchParams.get("mp")).toBe("expired");

    expect(tokenCalls()).toBe(0);
    expect(await liveAccounts({ practitionerId: kine.practitionerId })).toHaveLength(0);
  });

  it("[TP-2o] Cancelar en Mercado Pago → `?mp=denied` sin canje.", async () => {
    asUser(kine.userId);
    const r = await startMpConnect({ target: "own" });
    if (!r.ok) throw new Error(r.error);
    const back = await authorize(r.data.url, "cancel");
    expect(new URL(back).searchParams.get("error")).toBe("access_denied");
    expect((await callback(back)).dest.searchParams.get("mp")).toBe("denied");
    expect(tokenCalls()).toBe(0);
  });

  it("[TP-2o] Consultorio: Titular con step-up ok; sin step-up → StepUpRequiredError; Admin, Secretaria y profesional → rechazo.", async () => {
    try {
      asUser(T.userId);
      await enable2fa(T.userId, false);
      await expect(startMpConnect({ target: "clinic" })).rejects.toBeInstanceOf(StepUpRequiredError);
      expect(cookies().get(MP_OAUTH_COOKIE)).toBeUndefined();

      setStepUpCookie(T.userId, tok.claims!.session_id);
      // La del consultorio puede ser la misma cuenta de MP que la de un profesional (no es `in_use`).
      asUser(kine.userId);
      await connect("own", 1);
      asUser(T.userId);
      const { dest } = await connect("clinic", 1);
      expect(Object.fromEntries(dest.searchParams)).toEqual({ tab: "cobros-online", mp: "ok" });
      const [clinic] = await liveAccounts({ practitionerId: null });
      expect(clinic).toMatchObject({ kind: "CLINIC", status: "ACTIVE", mpUserId: SELLER[1], connectedByUserId: T.userId });

      cookies().delete(MP_OAUTH_COOKIE);
      for (const userId of [admin, secretaria, kine.userId]) {
        asUser(userId);
        const r = await startMpConnect({ target: "clinic" });
        expect(r.ok, userId).toBe(false);
        expect(cookies().get(MP_OAUTH_COOKIE)).toBeUndefined();
      }

      // Un state del Titular no lo usa otro: el callback vuelve a mirar `account.owner` (aunque fuera la misma sesión).
      asUser(admin);
      const forged = makeOAuthState({
        userId: admin,
        sessionId: tok.claims!.session_id,
        tenantId: T.tenantId,
        target: "clinic",
        practitionerId: null,
        nonce: newOAuthNonce(),
        exp: mpOAuthStateExp(),
      });
      cookies().set(MP_OAUTH_COOKIE, forged.cookie);
      const cb = `${FAKE_APP_URL}/api/mp/oauth/callback?state=${forged.state}&code=FAKE-CODE-x`;
      expect((await callback(cb)).dest.searchParams.get("mp")).toBe("error");
      expect(tokenCalls()).toBe(2);
    } finally {
      await db.userProfile.update({ where: { id: T.userId }, data: { twoFactorTotp: false } });
    }
  });

  it("[TP-2o] Secretaria no conecta `own`; soporte nunca.", async () => {
    asUser(secretaria);
    const r = await startMpConnect({ target: "own" });
    expect(r).toEqual({ ok: false, error: "Solo un profesional conecta su Mercado Pago." });
    expect(await getMyMpAccount()).toBeNull();
    asUser(facturacion);
    expect((await startMpConnect({ target: "own" })).ok).toBe(false);

    // Soporte: superadmin con 2FA y step-up (abrir soporte es `high`), «como soporte» en T.
    const H = await createEphemeralTenant(db);
    try {
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true, twoFactorTotp: true } });
      asUser(H.userId);
      setStepUpCookie(H.userId, tok.claims!.session_id);
      const s = await startSupport(T.tenantId, "Ayuda con Mercado Pago del consultorio");
      if (!s.ok) throw new Error(s.error);
      expect((await getActor()).support).not.toBeNull();
      for (const target of ["own", "clinic"] as const) {
        expect((await startMpConnect({ target })).ok).toBe(false);
        expect((await disconnectMpAccount({ target })).ok).toBe(false);
        expect((await setMpLinksDelegated({ target, delegated: true })).ok).toBe(false);
      }
      expect(cookies().get(MP_OAUTH_COOKIE)).toBeUndefined();
      expect(await getMyMpAccount()).toBeNull();
      // Ve la configuración (tiene `tenant.sensitive`) pero no la maneja ni la guarda.
      expect(await getOnlinePaymentsSettings()).toMatchObject({ canManageClinicAccount: false });
      const p = await savePaymentPolicy({ mode: "OPTIONAL", chargeKind: "COPAGO", fixedCents: null, percentBps: null, useClinicAccount: false, cancellationNote: null }, null);
      expect(p.ok).toBe(false);
      expect(await db.bookingPaymentPolicy.findUnique({ where: { tenantId: T.tenantId } })).toBeNull();
    } finally {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
      await H.cleanup();
    }
  });

  it("[TP-2o] Reconectar la misma cuenta MP conserva `webhookRef`; otra cuenta deja la vieja DISCONNECTED con +7 d.", async () => {
    asUser(kine.userId);
    await connect("own", 1);
    const [first] = await liveAccounts({ practitionerId: kine.practitionerId });
    const cred1 = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: first.id } });

    await connect("own", 1);
    const [same] = await liveAccounts({ practitionerId: kine.practitionerId });
    expect(same.id).toBe(first.id);
    expect(same.webhookRef).toBe(first.webhookRef);
    const cred2 = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: first.id } });
    expect(cred2.version).toBe(cred1.version + 1);
    expect(cred2.accessTokenBox).not.toBe(cred1.accessTokenBox);

    const t0 = Date.now();
    await connect("own", 2);
    const [other] = await liveAccounts({ practitionerId: kine.practitionerId });
    expect(other.id).not.toBe(first.id);
    expect(other.webhookRef).not.toBe(first.webhookRef);
    expect(other.mpUserId).toBe(SELLER[2]);
    const old = await db.mpAccount.findUniqueOrThrow({ where: { id: first.id } });
    expect(old).toMatchObject({ status: "DISCONNECTED", disconnectedByUserId: kine.userId, linksDelegated: false });
    const oldCred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: first.id } });
    const purge = oldCred.purgeAfter!.getTime();
    expect(purge).toBeGreaterThanOrEqual(t0 + 7 * DAY_MS - 60_000);
    expect(purge).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 60_000);
    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: "mpAccount.connect", entityId: other.id } });
    expect(ev.payload).toMatchObject({ replacedAccountId: first.id, sameMpAccount: false });

    // Volver a la primera cuenta reactiva SU fila: misma `webhookRef` (las preferencias viejas siguen notificando).
    await connect("own", 1);
    const [back] = await liveAccounts({ practitionerId: kine.practitionerId });
    expect(back.id).toBe(first.id);
    expect(back.webhookRef).toBe(first.webhookRef);
    expect((await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: first.id } })).purgeAfter).toBeNull();
  });

  it("[TP-2o] Cambió el consultorio activo → rechazo.", async () => {
    asUser(kine.userId);
    cookies().set(ACTIVE_TENANT_COOKIE, T.tenantId);
    expect((await getActor()).tenantId).toBe(T.tenantId);
    const r = await startMpConnect({ target: "own" });
    if (!r.ok) throw new Error(r.error);
    const back = await authorize(r.data.url, 1);
    cookies().set(ACTIVE_TENANT_COOKIE, T2.tenantId);
    expect((await getActor()).tenantId).toBe(T2.tenantId);
    expect((await callback(back)).dest.searchParams.get("mp")).toBe("error");
    expect(tokenCalls()).toBe(0);
    expect(await db.mpAccount.count({ where: { tenantId: { in: [T.tenantId, T2.tenantId] }, status: "ACTIVE" } })).toBe(0);
  });

  it("[TP-2o] `live_mode` distinto → rechazo.", async () => {
    asUser(kine.userId);
    // MP devuelve una cuenta REAL estando en modo de prueba: se intercepta la respuesta del canje del fake.
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await inner(input as string, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/oauth/token") || !res.ok) return res;
      const j = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...j, live_mode: true }), { status: res.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const { dest } = await connect("own", 1);
    expect(dest.searchParams.get("mp")).toBe("error");
    expect(tokenCalls()).toBe(1);
    expect(await liveAccounts({ practitionerId: kine.practitionerId })).toHaveLength(0);
  });

  it("[TP-2o] `in_use` con otro profesional.", async () => {
    asUser(kine.userId);
    await connect("own", 1);
    asUser(kine2.userId);
    const { dest } = await connect("own", 1);
    expect(Object.fromEntries(dest.searchParams)).toEqual({ tab: "mercado-pago", mp: "in_use" });
    expect(await liveAccounts({ practitionerId: kine2.practitionerId })).toHaveLength(0);
    // Con OTRA cuenta de MP sí puede.
    expect((await connect("own", 2)).dest.searchParams.get("mp")).toBe("ok");
  });

  it("[TP-2o] Tokens nunca en logs, audit, body ni redirect.", async () => {
    const seen: string[] = [];
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((msg: string, ctx?: unknown) => void seen.push(`${msg} ${JSON.stringify(ctx ?? {})}`));
    }
    const out = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => (seen.push(String(chunk)), true)) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => (seen.push(String(chunk)), true)) as never);
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void seen.push(a.map((x) => JSON.stringify(x)).join(" ")));
    }
    asUser(kine.userId);
    const { start, res, dest } = await connect("own", 1);
    // Una segunda vuelta con error (código usado) también loguea: tampoco con tokens.
    await callback((await connect("own", 1)).back);
    out.mockRestore();
    err.mockRestore();

    const [acc] = await liveAccounts({ practitionerId: kine.practitionerId });
    const cred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.id } });
    const access = openSecret(cred.accessTokenBox, mpCredentialAad(acc.id, "accessToken"));
    const refresh = openSecret(cred.refreshTokenBox, mpCredentialAad(acc.id, "refreshToken"));
    const audits = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, entityId: acc.id } });
    const surfaces = [
      ...seen,
      JSON.stringify(start),
      dest.toString(),
      await res.text(),
      JSON.stringify([...res.headers.entries()]),
      JSON.stringify(audits.map((a) => a.payload)),
      JSON.stringify(await getMyMpAccount()),
    ].join("\n");
    expect(seen.length).toBeGreaterThan(0);
    expect(surfaces).not.toContain(access);
    expect(surfaces).not.toContain(refresh);
    expect(surfaces).not.toMatch(TOKEN_RE);
    expect(dest.searchParams.has("code")).toBe(false);
    expect(dest.searchParams.has("state")).toBe(false);
  });

  // ── Desconectar y delegar ────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2o] Desconectar anula los links ACTIVE y vence la preferencia.", async () => {
    asUser(kine.userId);
    await connect("own", 1);
    const [acc] = await liveAccounts({ practitionerId: kine.practitionerId });
    const patientId = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    const charge = await db.onlineCharge.create({
      data: {
        tenantId: T.tenantId,
        origin: "LINK",
        kind: "FREE",
        mpAccountId: acc.id,
        practitionerId: kine.practitionerId,
        patientId,
        amountCents: 150_000,
        concept: "Sesión de prueba",
        publicToken: randomBytes(16).toString("base64url"),
        createdByUserId: kine.userId,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
        idempotencyKey: `link:${randomUUID()}`,
      },
    });
    const ref: MpAccountRef = { id: acc.id, tenantId: T.tenantId, kind: acc.kind, status: acc.status, mpUserId: acc.mpUserId, webhookRef: acc.webhookRef };
    const pref = await mpCreatePreference(ref, {
      items: [{ id: charge.id, title: "Link de pago", quantity: 1, unit_price: 1500, currency_id: "ARS" }],
      external_reference: `oc:${charge.id}`,
    });
    if (!pref.ok) throw new Error(pref.error);
    await db.onlineCharge.update({ where: { id: charge.id }, data: { preferenceId: pref.preferenceId, checkoutUrl: pref.initPoint } });
    expect(fakeMpGetPreference(pref.preferenceId)?.expired).toBe(false);

    const r = await disconnectMpAccount({ target: "own" });
    expect(r).toEqual({ ok: true, data: { cancelledLinks: 1 } });
    expect(await db.onlineCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({
      status: "CANCELLED",
      cancelReason: "account_disconnected",
      cancelledByUserId: kine.userId,
    });
    expect(fakeMpGetPreference(pref.preferenceId)?.expired).toBe(true);
    expect(await db.mpAccount.findUniqueOrThrow({ where: { id: acc.id } })).toMatchObject({ status: "DISCONNECTED", linksDelegated: false });
    expect((await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.id } })).purgeAfter).not.toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "mpAccount.disconnect", entityId: acc.id } })).toBe(1);
    expect(await getMyMpAccount()).toMatchObject({ status: "DISCONNECTED" });
    // Sin cuenta viva no hay nada que desconectar.
    expect((await disconnectMpAccount({ target: "own" })).ok).toBe(false);
  });

  it("[TP-2o] Desconectar la del consultorio pide step-up.", async () => {
    try {
      await connectFakeAccount(db, T, { kind: "CLINIC" });
      asUser(T.userId);
      await enable2fa(T.userId, false);
      await expect(disconnectMpAccount({ target: "clinic" })).rejects.toBeInstanceOf(StepUpRequiredError);
      expect(await liveAccounts({ practitionerId: null })).toHaveLength(1);
      setStepUpCookie(T.userId, tok.claims!.session_id);
      expect(await disconnectMpAccount({ target: "clinic" })).toEqual({ ok: true, data: { cancelledLinks: 0 } });
      expect(await liveAccounts({ practitionerId: null })).toHaveLength(0);
    } finally {
      await db.userProfile.update({ where: { id: T.userId }, data: { twoFactorTotp: false } });
    }
  });

  it("[TP-2o] Delegación solo el dueño.", async () => {
    const own = await connectFakeAccount(db, T, { practitionerId: kine.practitionerId });
    const clinic = await connectFakeAccount(db, T, { kind: "CLINIC", seller: 2 });

    asUser(kine.userId);
    expect(await setMpLinksDelegated({ target: "own", delegated: true })).toEqual({ ok: true, data: undefined });
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: own.accountId } })).linksDelegated).toBe(true);
    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: "mpAccount.delegation", entityId: own.accountId } });
    expect(ev.payload).toEqual({ from: false, to: true });
    // El profesional no toca la del consultorio; la Secretaria y el Admin no tocan ninguna.
    expect((await setMpLinksDelegated({ target: "clinic", delegated: true })).ok).toBe(false);
    for (const userId of [secretaria, admin]) {
      asUser(userId);
      expect((await setMpLinksDelegated({ target: "own", delegated: false })).ok).toBe(false);
      expect((await setMpLinksDelegated({ target: "clinic", delegated: true })).ok).toBe(false);
    }
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: own.accountId } })).linksDelegated).toBe(true);
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: clinic.accountId } })).linksDelegated).toBe(false);
    // El Titular delega la del consultorio (sin step-up: la plata va igual a la misma cuenta).
    asUser(T.userId);
    expect((await setMpLinksDelegated({ target: "clinic", delegated: true })).ok).toBe(true);
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: clinic.accountId } })).linksDelegated).toBe(true);
  });

  // ── Token de la cuenta (refresh rotativo con CAS) ───────────────────────────────────────────────────────────

  it("[TP-2o] withAccountToken refresca cerca del vencimiento (CAS sobre version) y `invalid_grant` → REAUTH_REQUIRED.", async () => {
    const acc = await connectFakeAccount(db, T, { practitionerId: kine.practitionerId, accessExpiresAt: new Date(Date.now() + 60_000) });
    const row = await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId } });
    const ref: MpAccountRef = { id: row.id, tenantId: T.tenantId, kind: row.kind, status: row.status, mpUserId: row.mpUserId, webhookRef: row.webhookRef };

    // Dos requests a la vez: uno rota el refresh token; el otro recibe invalid_grant, ve la versión nueva y NO marca.
    const [a, b] = await Promise.all([withAccountToken(ref, async (t) => t), withAccountToken(ref, async (t) => t)]);
    for (const t of [a, b]) {
      expect(typeof t).toBe("string");
      expect(t).not.toBe(acc.accessToken);
    }
    const cred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: acc.accountId } });
    expect(cred.version).toBe(2);
    expect(cred.lastRefreshedAt).not.toBeNull();
    expect(cred.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 100 * DAY_MS);
    expect((await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId } })).status).toBe("ACTIVE");

    // Revocado en MP: el refresh da invalid_grant sin que nadie más haya rotado → REAUTH_REQUIRED + audit.
    await db.mpCredential.update({ where: { mpAccountId: acc.accountId }, data: { accessExpiresAt: new Date(Date.now() + 60_000) } });
    fakeMpForceReauth(acc.mpUserId);
    expect(await withAccountToken(ref, async (t) => t)).toEqual({ error: "reauth" });
    expect(await db.mpAccount.findUniqueOrThrow({ where: { id: acc.accountId } })).toMatchObject({ status: "REAUTH_REQUIRED" });
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "mpAccount.reauth_required", entityId: acc.accountId } })).toBe(1);
    asUser(kine.userId);
    expect(await getMyMpAccount()).toMatchObject({ status: "REAUTH_REQUIRED" });
  });

  // ── Política ────────────────────────────────────────────────────────────────────────────────────────────────

  it("[TP-2o] Política: `tenant.sensitive` sí; Secretaria con Configuración y Facturación no; zod espejo; stale.", async () => {
    await db.bookingPaymentPolicy.deleteMany({ where: { tenantId: T.tenantId } });
    const P = { mode: "OPTIONAL", chargeKind: "PERCENT", fixedCents: null, percentBps: 3_000, useClinicAccount: false, cancellationNote: null } as const;

    for (const userId of [secretaria, facturacion]) {
      asUser(userId);
      expect(await getOnlinePaymentsSettings()).toBeNull();
      await expect(savePaymentPolicy({ ...P }, null)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.bookingPaymentPolicy.findUnique({ where: { tenantId: T.tenantId } })).toBeNull();

    asUser(T.userId);
    const settings = await getOnlinePaymentsSettings();
    expect(settings).toMatchObject({
      policy: { mode: "OFF", chargeKind: "COPAGO" },
      policyUpdatedAt: null,
      connectMode: "fake",
      canManageClinicAccount: true,
    });
    // Los casos anteriores dejaron la del consultorio desconectada (o nunca existió): ninguna viva.
    expect(["NONE", "DISCONNECTED"]).toContain(settings!.clinicAccount.status);
    expect(settings!.withoutMpCount).toBe(settings!.practitioners.length);

    const r = await savePaymentPolicy({ ...P }, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data.updatedAt).toBe("string");
    expect(await db.bookingPaymentPolicy.findUniqueOrThrow({ where: { tenantId: T.tenantId } })).toMatchObject({ ...P, updatedByUserId: T.userId });
    const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: T.tenantId, action: "bookingPaymentPolicy.update" }, orderBy: { createdAt: "desc" } });
    expect(ev.payload).toMatchObject({ from: { mode: "OFF" }, to: { mode: "OPTIONAL", percentBps: 3_000 } });

    // Stale: otro guardado con la versión vieja (null = «no había fila») o con una fecha que no es la vigente.
    expect(await savePaymentPolicy({ ...P, mode: "REQUIRED" }, null)).toMatchObject({ ok: false });
    expect(await savePaymentPolicy({ ...P, mode: "REQUIRED" }, new Date(0).toISOString())).toMatchObject({ ok: false });
    expect((await db.bookingPaymentPolicy.findUniqueOrThrow({ where: { tenantId: T.tenantId } })).mode).toBe("OPTIONAL");

    // zod espejo de los CHECK: nada de esto llega a la base.
    for (const bad of [
      { ...P, percentBps: 10_001 },
      { ...P, percentBps: 0 },
      { ...P, fixedCents: 50_000 },
      { ...P, chargeKind: "FIXED" as const, percentBps: null, fixedCents: 99 },
      { ...P, chargeKind: "FIXED" as const, percentBps: null, fixedCents: null },
      { ...P, cancellationNote: "x".repeat(281) },
    ]) {
      expect(await savePaymentPolicy(bad, r.data.updatedAt), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    // La cuenta del consultorio solo si está conectada.
    expect(await savePaymentPolicy({ ...P, useClinicAccount: true }, r.data.updatedAt)).toMatchObject({ ok: false });

    // El Admin con «Configuración» (tenant.sensitive) guarda con la versión vigente; no maneja la cuenta.
    await connectFakeAccount(db, T, { kind: "CLINIC" });
    asUser(admin);
    const s2 = await getOnlinePaymentsSettings();
    expect(s2).toMatchObject({ canManageClinicAccount: false, clinicAccount: { status: "ACTIVE", badge: "fake" }, policyUpdatedAt: r.data.updatedAt });
    const r2 = await savePaymentPolicy({ ...P, mode: "REQUIRED", useClinicAccount: true, cancellationNote: "  Avisá 24 h antes.  " }, r.data.updatedAt);
    expect(r2.ok).toBe(true);
    expect(await db.bookingPaymentPolicy.findUniqueOrThrow({ where: { tenantId: T.tenantId } })).toMatchObject({
      mode: "REQUIRED",
      useClinicAccount: true,
      cancellationNote: "Avisá 24 h antes.",
      updatedByUserId: admin,
    });
  });
});
