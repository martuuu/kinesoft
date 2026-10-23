/**
 * T6 · [WA-S1] Cuenta de WhatsApp del consultorio (C-WA6 y las actions de conexión de C-WA9, brief §26.5).
 *
 * Símbolos REALES contra Postgres, en los dos roles: las actions de `lib/whatsapp-actions.ts`, el núcleo
 * `lib/whatsapp/account-internal.ts`, `requireStepUp`, el secret-box y la rotación (`resealWaCredentials`). Lo externo
 * se reemplaza:
 *   - Meta: el simulador local (`installFakeGraph`: solo la RED; nada de Meta real ni sandbox, regla de T6). El popup del
 *     Embedded Signup se «clickea» con `fakeGraphSignup` (lo mismo que el botón del simulador: WABA + número nuevos y
 *     un `code` de 30 s y un solo uso).
 *   - La sesión de Supabase con `session_id`/`aal` (molde de tp2o): la cookie del alta y el step-up se atan a la sesión.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { cookies } from "next/headers";
import { randomBytes, randomUUID } from "node:crypto";
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
  startWhatsAppConnect,
  completeWhatsAppConnect,
  resumeWhatsAppSetup,
  disconnectWhatsApp,
  updateWhatsAppSettings,
  sendWhatsAppTest,
  getWhatsAppPanel,
} from "@/lib/whatsapp-actions";
import { getLiveAccountCached, loadCredential, markAccountProblem } from "@/lib/whatsapp/account-internal";
import { WA_SIGNUP_COOKIE } from "@/lib/whatsapp/crypto";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { WA_TEMPLATE_KEYS } from "@/lib/whatsapp/types";
import { WA_TEST_DAILY_LIMIT } from "@/lib/whatsapp/account-types";
import { openSecret, sealedKid, waCredentialAad } from "@/lib/secret-box";
import { prismaWaCredentialStore, resealWaCredentials } from "@/lib/secret-box-rotate-internal";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { StepUpRequiredError } from "@/lib/two-factor-step-up";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { logger } from "@/lib/logger";
import { tags } from "@/lib/cache-tags";
import { ownerClient, createEphemeralTenant, addStaff, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy, usePassthroughUnstableCache, useRealUnstableCache } from "@/tests/helpers/integration-setup";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  fakeGraphSignup,
  fakeGraphWaba,
  fakeGraphMessages,
  FAKE_WA_PHONES,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
/** Forma de los tokens del fake (`FAKEWA-<24>`): nunca tienen que salir de la base sellados. */
const TOKEN_RE = /FAKEWA-[A-Za-z0-9_-]{8,}/;

describe.skipIf(!RUN)("[WA-S1] cuenta de WhatsApp del consultorio", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let T2: EphemeralTenant;
  let admin: string;
  let secretaria: string;
  let fake: InstalledFakeGraph;
  let logged: unknown[][];
  const sess = () => `sess-${uniqueSuffix()}`;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    T2 = await createEphemeralTenant(db);
    // Administrador/a (con «Configuración»): tiene `tenant.sensitive` pero no `account.owner`.
    admin = (await addStaff(db, T, "ADMIN", { grantSettings: true })).userId;
    secretaria = (await addStaff(db, T, "ASSISTANT", { grantSettings: true })).userId;
    await db.userProfile.updateMany({ where: { id: { in: [T.userId, admin] } }, data: { twoFactorTotp: true } });
  });

  afterAll(async () => {
    await db?.userProfile.updateMany({ where: { id: { in: [T?.userId, admin].filter(Boolean) as string[] } }, data: { twoFactorTotp: false } });
    await T?.cleanup();
    await T2?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(async () => {
    fake = installFakeGraph();
    tok.claims = { session_id: sess(), aal: "aal2" };
    for (const c of [WA_SIGNUP_COOKIE, STEP_UP_COOKIE, TWO_FACTOR_COOKIE]) cookies().delete(c);
    cookies().set(ACTIVE_TENANT_COOKIE, T.tenantId);
    // Cada caso arranca sin cuentas vivas (parciales de M15: una viva por consultorio / número / WABA).
    await db.whatsAppAccount.updateMany({
      where: { tenantId: { in: [T.tenantId, T2.tenantId] }, status: { not: "DISCONNECTED" } },
      data: { status: "DISCONNECTED", disconnectedAt: new Date(), disconnectedByUserId: "test-wa-s1" },
    });
    await db.notification.deleteMany({ where: { tenantId: T.tenantId, kind: "WHATSAPP_ACCOUNT" } });
    logged = [];
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(logger, lvl).mockImplementation((...a: unknown[]) => void logged.push(a));
    }
    revalidateTagSpy.mockClear();
  });

  afterEach(() => {
    fake.uninstall();
    usePassthroughUnstableCache();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const stepUp = (userId: string) => setStepUpCookie(userId, tok.claims!.session_id);
  const liveAccounts = (tenantId = T.tenantId) =>
    db.whatsAppAccount.findMany({ where: { tenantId, status: { not: "DISCONNECTED" } } });
  // Las credenciales de cuentas que el `beforeEach` pasó a DISCONNECTED a mano (sin pasar por `disconnect`) quedan en
  // la tabla: se miran solo las de cuentas vivas.
  const credentials = (tenantId = T.tenantId) =>
    db.whatsAppCredential.findMany({ where: { tenantId, account: { status: { not: "DISCONNECTED" } } } });

  /** Start (con step-up) + el «clic» en el popup del simulador. */
  async function begin(grant?: "both" | "management_only" | "messaging_only" | "other_waba") {
    asUser(T.userId);
    stepUp(T.userId);
    const r = await startWhatsAppConnect();
    if (!r.ok) throw new Error(`startWhatsAppConnect: ${r.error}`);
    const s = fakeGraphSignup({ grant });
    return { start: r.data, signup: s };
  }

  async function connectAll() {
    const { start, signup } = await begin();
    const r = await completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, nonce: start.nonce });
    return { start, signup, r };
  }

  // ── Conectar ────────────────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S1] El Titular conecta con el simulador: ACTIVE/DONE por service, credencial sellada, 5 plantillas en revisión.", async () => {
    const { start, signup, r } = await connectAll();
    expect(start).toMatchObject({ mode: "fake", appId: expect.any(String), configId: expect.any(String), graphVersion: expect.stringMatching(/^v\d+\.0$/) });
    expect(start.fakeDialogUrl).toContain("/api/whatsapp/fake/dialog/signup");
    expect(r).toMatchObject({ ok: true, data: { status: "ACTIVE", setupStep: "DONE", done: true } });

    const [acc] = await liveAccounts();
    expect(acc).toMatchObject({ mode: "fake", status: "ACTIVE", setupStep: "DONE", wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, connectedByUserId: T.userId });
    expect(acc.displayPhone).toBe(signup.displayPhone);

    // Credencial: un sobre por campo con la AAD de la cuenta; el PIN es de 6 dígitos y es el que quedó en Meta.
    const [cred] = await credentials();
    expect(cred.accountId).toBe(acc.id);
    expect(sealedKid(cred.tokenBox)).toBe(cred.keyId);
    const token = openSecret(cred.tokenBox, waCredentialAad(acc.id, "token"));
    const pin = openSecret(cred.pinBox, waCredentialAad(acc.id, "pin"));
    expect(token).toMatch(TOKEN_RE);
    expect(pin).toMatch(/^[0-9]{6}$/);
    expect(() => openSecret(cred.tokenBox, waCredentialAad(acc.id, "pin"))).toThrow();

    const w = fakeGraphWaba(signup.wabaId)!;
    expect(w.subscribed).toBe(true);
    expect(w.phones[0]).toMatchObject({ registered: true, pin });
    // Las 5 de TEMPLATE_SPECS dadas de alta en Meta (más `hello_world`, que trae toda WABA) y en la base.
    for (const k of WA_TEMPLATE_KEYS) expect(w.templates.some((t) => t.name === TEMPLATE_SPECS[k].name)).toBe(true);
    const tpl = await db.whatsAppTemplate.findMany({ where: { accountId: acc.id, tenantId: T.tenantId } });
    expect(tpl.map((t) => t.key).sort()).toEqual([...WA_TEMPLATE_KEYS].sort());
    expect(tpl.every((t) => t.status === "PENDING" && t.metaTemplateId && t.submittedAt)).toBe(true);

    // Audit sin token ni PIN; la cookie del alta no se reusa.
    const audits = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, entity: "WhatsAppAccount", entityId: acc.id } });
    expect(audits.map((a) => a.action)).toContain("whatsappAccount.connect");
    const everything = JSON.stringify({ audits, logged, r, panel: await getWhatsAppPanel() });
    expect(everything).not.toMatch(TOKEN_RE);
    expect(everything).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(pin);
    expect(cookies().get(WA_SIGNUP_COOKIE)?.value || null).toBeNull();
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.whatsappAccount(T.tenantId));
  });

  it("[WA-S1] El WABA fuera de los dos scopes → `scopes` y nada escrito (ni cuenta, ni credencial, ni nada en Meta).", async () => {
    for (const grant of ["messaging_only", "management_only", "other_waba"] as const) {
      const { start, signup } = await begin(grant);
      const r = await completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, nonce: start.nonce });
      expect(r).toEqual({ ok: false, error: expect.stringContaining("permisos") });
      expect(await liveAccounts()).toHaveLength(0);
      expect(fakeGraphWaba(signup.wabaId)!.subscribed).toBe(false);
    }
    expect(await db.whatsAppAccount.count({ where: { tenantId: T.tenantId, connectedAt: { gte: new Date(Date.now() - 60_000) }, disconnectedByUserId: null } })).toBe(0);
  });

  it("[WA-S1] El número fuera del WABA → `phone_not_in_waba` y nada escrito.", async () => {
    const { start, signup } = await begin();
    const other = fakeGraphSignup();
    const r = await completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: other.phoneNumberId, nonce: start.nonce });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("no pertenece") });
    expect(await liveAccounts()).toHaveLength(0);
    expect(await credentials()).toHaveLength(0);
    expect(fakeGraphWaba(signup.wabaId)!.phones[0].registered).toBe(false);
  });

  it("[WA-S1] La cookie del alta: nonce de otro intento, otra sesión o sin cookie → `expired`, sin canjear el code.", async () => {
    const { start, signup } = await begin();
    const bad = await completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, nonce: randomBytes(32).toString("base64url") });
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("venció") });
    expect(fake.calls.some((u) => u.includes("/oauth/access_token"))).toBe(false);
    // Otra sesión del mismo usuario (otro dispositivo) con el nonce correcto.
    const s2 = await begin();
    tok.claims = { session_id: sess(), aal: "aal2" };
    stepUp(T.userId);
    const other = await completeWhatsAppConnect({ code: s2.signup.code, wabaId: s2.signup.wabaId, phoneNumberId: s2.signup.phoneNumberId, nonce: s2.start.nonce });
    expect(other).toEqual({ ok: false, error: expect.stringContaining("venció") });
    expect(await liveAccounts()).toHaveLength(0);
    void start;
  });

  it("[WA-S1] Step-up exigido para conectar, completar, retomar y desconectar; un no dueño (Administración) y la Secretaría no pasan.", async () => {
    asUser(T.userId);
    await expect(startWhatsAppConnect()).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(cookies().get(WA_SIGNUP_COOKIE)).toBeUndefined();
    const { start, signup } = await begin();
    cookies().delete(STEP_UP_COOKIE);
    await expect(
      completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, nonce: start.nonce })
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(resumeWhatsAppSetup()).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(disconnectWhatsApp()).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(await liveAccounts()).toHaveLength(0);

    // La cookie del intento del Titular quedó (completar tiró antes de consumirla): se borra para ver que los no
    // dueños no emiten una nueva.
    cookies().delete(WA_SIGNUP_COOKIE);
    for (const u of [admin, secretaria]) {
      asUser(u);
      stepUp(u);
      for (const call of [startWhatsAppConnect, resumeWhatsAppSetup, disconnectWhatsApp]) {
        expect(await call()).toEqual({ ok: false, error: expect.stringContaining("titular") });
      }
    }
    expect(cookies().get(WA_SIGNUP_COOKIE)?.value ?? null).toBeNull();
  });

  it("[WA-S1] Número vivo en otro consultorio → `in_use` y nada escrito en este.", async () => {
    const { start, signup } = await begin();
    // Ese mismo número ya está vivo en T2 (otro consultorio lo conectó antes).
    await db.whatsAppAccount.create({
      data: {
        tenantId: T2.tenantId, mode: "fake", wabaId: `9${signup.wabaId.slice(1)}`, phoneNumberId: signup.phoneNumberId,
        status: "ACTIVE", setupStep: "DONE", connectedByUserId: T2.userId, connectedAt: new Date(),
      },
    });
    const r = await completeWhatsAppConnect({ code: signup.code, wabaId: signup.wabaId, phoneNumberId: signup.phoneNumberId, nonce: start.nonce });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("otro consultorio") });
    expect(await liveAccounts()).toHaveLength(0);
    expect(await credentials()).toHaveLength(0);
  });

  it("[WA-S1] El setup se corta en SUBSCRIBED (Meta no responde al registrar) y se retoma desde ahí hasta ACTIVE.", async () => {
    const realFetch = globalThis.fetch;
    let failRegister = true;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (failRegister && url.includes("/register")) throw new TypeError("fetch failed");
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const { signup, r } = await connectAll();
      expect(r).toMatchObject({ ok: true, data: { status: "SETUP", setupStep: "SUBSCRIBED", done: false, errorCode: "network" } });
      const [acc] = await liveAccounts();
      expect(acc).toMatchObject({ status: "SETUP", setupStep: "SUBSCRIBED", lastErrorCode: "network" });
      expect(await getLiveAccountCached(T.tenantId)).toMatchObject({ status: "SETUP" });

      failRegister = false;
      const subscribeCalls = fake.calls.filter((u) => u.includes("/subscribed_apps")).length;
      stepUp(T.userId);
      const again = await resumeWhatsAppSetup();
      expect(again).toMatchObject({ ok: true, data: { status: "ACTIVE", setupStep: "DONE", done: true } });
      // Retoma desde el paso guardado: no vuelve a suscribir.
      expect(fake.calls.filter((u) => u.includes("/subscribed_apps")).length).toBe(subscribeCalls);
      expect(fakeGraphWaba(signup.wabaId)!.phones[0].registered).toBe(true);
      const [after] = await liveAccounts();
      expect(after).toMatchObject({ status: "ACTIVE", setupStep: "DONE", lastErrorCode: null });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // ── Desconectar ─────────────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S1] Desconectar: cancela TODO lo QUEUED, borra la credencial ya, desuscribe y NO desregistra el número.", async () => {
    const { signup } = await connectAll();
    const [acc] = await liveAccounts();
    const base = {
      // REPLY (sin plantilla) y no TEST: las TEST del día cuentan para el tope de pruebas de otro caso.
      tenantId: T.tenantId, accountId: acc.id, kind: "REPLY" as const, trigger: "INBOUND" as const, templateName: null,
      toHash: "a".repeat(64), toMasked: "+54 9 11 ****-0100", expiresAt: new Date(Date.now() + 3_600_000),
    };
    await db.whatsAppMessage.createMany({
      data: [
        { ...base, idempotencyKey: `test:${randomUUID()}`, status: "QUEUED" },
        { ...base, idempotencyKey: `test:${randomUUID()}`, status: "QUEUED" },
        { ...base, idempotencyKey: `test:${randomUUID()}`, status: "SENT", wamid: `wamid.${randomUUID()}` },
      ],
    });
    stepUp(T.userId);
    const r = await disconnectWhatsApp();
    expect(r).toEqual({ ok: true, data: { cancelledMessages: 2 } });
    const after = await db.whatsAppAccount.findFirstOrThrow({ where: { id: acc.id } });
    expect(after).toMatchObject({ status: "DISCONNECTED", disconnectedByUserId: T.userId });
    expect(after.disconnectedAt).not.toBeNull();
    expect(await db.whatsAppCredential.count({ where: { accountId: acc.id } })).toBe(0);
    const msgs = await db.whatsAppMessage.findMany({ where: { accountId: acc.id }, select: { status: true } });
    expect(msgs.map((m) => m.status).sort()).toEqual(["CANCELLED", "CANCELLED", "SENT"]);
    const w = fakeGraphWaba(signup.wabaId)!;
    expect(w.subscribed).toBe(false);
    expect(w.phones[0].registered).toBe(true);
    expect(await getLiveAccountCached(T.tenantId)).toBeNull();
    expect(await loadCredential(acc.id)).toBeNull();
    // El panel muestra la última desconectada; el token nunca.
    const panel = await getWhatsAppPanel();
    expect(panel?.account).toMatchObject({ status: "DISCONNECTED" });
    expect(JSON.stringify({ panel, logged })).not.toMatch(TOKEN_RE);
  });

  // ── Ajustes, prueba y panel ─────────────────────────────────────────────────────────────────────────────────

  it("[WA-S1] Ajustes: los 3 switches con `tenant.sensitive` (Administración sí, Secretaría no) y el cache se invalida.", async () => {
    await connectFakeWhatsApp(db, T);
    const cache = useRealUnstableCache();
    expect(await getLiveAccountCached(T.tenantId)).toMatchObject({ status: "ACTIVE", autoReminder: true });
    expect(cache.keyParts.length).toBeGreaterThan(0);

    asUser(secretaria);
    expect(await updateWhatsAppSettings({ autoReminder: false })).toMatchObject({ ok: false });
    expect(await getWhatsAppPanel()).toBeNull();
    asUser(admin);
    expect(await updateWhatsAppSettings({ autoReminder: false, autoReplyText: false })).toEqual({ ok: true, data: undefined });
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.whatsappAccount(T.tenantId));
    expect(await getLiveAccountCached(T.tenantId)).toMatchObject({ autoReminder: false, autoReplyText: false, autoBookingNotice: true });
    expect(await updateWhatsAppSettings({ autoReminder: "no" } as never)).toMatchObject({ ok: false });
    const panel = await getWhatsAppPanel();
    expect(panel).toMatchObject({ mode: "fake", canManage: false, canConfigure: true, account: { autoReminder: false } });
  });

  it("[WA-S1] Prueba con `hello_world`: sale por el simulador, queda registrada sin el número en claro y corta a las 5 por día.", async () => {
    await connectFakeWhatsApp(db, T);
    asUser(admin);
    const r = await sendWhatsAppTest({ phone: "11 5555-0100" });
    expect(r).toMatchObject({ ok: true, data: { status: "SENT", testsLeftToday: WA_TEST_DAILY_LIMIT - 1 } });
    const sent = fakeGraphMessages().find((m) => m.templateName === "hello_world");
    expect(sent?.to).toBe(FAKE_WA_PHONES.ok.slice(1));
    const [row] = await db.whatsAppMessage.findMany({ where: { tenantId: T.tenantId, kind: "TEST" } });
    expect(row).toMatchObject({ status: "SENT", trigger: "MANUAL", templateName: "hello_world", createdByUserId: admin });
    expect(row.toHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("5555-0100");
    expect(sent?.callbackData).toBe(row.id);

    expect(await sendWhatsAppTest({ phone: "hola" })).toMatchObject({ ok: false });
    for (let i = 1; i < WA_TEST_DAILY_LIMIT; i++) expect(await sendWhatsAppTest({ phone: FAKE_WA_PHONES.ok })).toMatchObject({ ok: true });
    expect(await sendWhatsAppTest({ phone: FAKE_WA_PHONES.ok })).toEqual({ ok: false, error: expect.stringContaining("5 pruebas") });
    asUser(secretaria);
    expect(await sendWhatsAppTest({ phone: FAKE_WA_PHONES.ok })).toMatchObject({ ok: false });
  });

  it("[WA-S1] Con WHATSAPP_MODE=off las actions rechazan sin tocar Meta ni la base.", async () => {
    vi.stubEnv("WHATSAPP_MODE", "off");
    asUser(T.userId);
    stepUp(T.userId);
    expect(await startWhatsAppConnect()).toEqual({ ok: false, error: expect.stringContaining("WhatsApp") });
    expect(await sendWhatsAppTest({ phone: FAKE_WA_PHONES.ok })).toMatchObject({ ok: false });
    expect(await updateWhatsAppSettings({ autoReminder: false })).toMatchObject({ ok: false });
    expect(fake.calls).toEqual([]);
    expect(cookies().get(WA_SIGNUP_COOKIE)?.value ?? null).toBeNull();
  });

  // ── Problemas de la cuenta ──────────────────────────────────────────────────────────────────────────────────

  it("[WA-S1] markAccountProblem: auth → REAUTH_REQUIRED, payment → paymentIssueAt; a lo sumo 1 aviso por día a los dueños.", async () => {
    const a = await connectFakeWhatsApp(db, T);
    await markAccountProblem(T.tenantId, "payment", "payment:131042");
    let acc = await db.whatsAppAccount.findFirstOrThrow({ where: { id: a.accountId } });
    expect(acc.status).toBe("ACTIVE");
    expect(acc.paymentIssueAt).not.toBeNull();
    expect(acc.lastErrorCode).toBe("payment:131042");
    await markAccountProblem(T.tenantId, "auth", "auth:190");
    acc = await db.whatsAppAccount.findFirstOrThrow({ where: { id: a.accountId } });
    expect(acc).toMatchObject({ status: "REAUTH_REQUIRED", lastErrorCode: "auth:190" });
    expect(acc.reauthRequiredAt).not.toBeNull();
    const notes = await db.notification.findMany({ where: { tenantId: T.tenantId, kind: "WHATSAPP_ACCOUNT" } });
    // Un solo aviso (al Titular) en el día, aunque hubo dos problemas.
    expect(notes.map((n) => n.userId)).toEqual([T.userId]);
    expect(JSON.stringify(notes)).not.toMatch(TOKEN_RE);
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.whatsappAccount(T.tenantId));
  });

  // ── Rotación de SECRET_BOX_KEYS ─────────────────────────────────────────────────────────────────────────────

  it("[WA-S1] La rotación re-sella la credencial de WhatsApp con la clave nueva y la cola la sigue abriendo.", async () => {
    const k1 = `k1:${randomBytes(32).toString("base64")}`;
    const k2 = `k2:${randomBytes(32).toString("base64")}`;
    vi.stubEnv("SECRET_BOX_KEYS", k1);
    const a = await connectFakeWhatsApp(db, T);
    const before = await db.whatsAppCredential.findFirstOrThrow({ where: { accountId: a.accountId } });
    expect(before.keyId).toBe("k1");

    vi.stubEnv("SECRET_BOX_KEYS", `${k2},${k1}`);
    // El store real sobre la tabla real, acotado a las cuentas de ESTE consultorio: re-sellar con una clave aleatoria
    // las credenciales de otros archivos (o de corridas viejas) en la base local las dejaría sin abrir para siempre.
    const real = prismaWaCredentialStore(db);
    const mine = new Set((await db.whatsAppAccount.findMany({ where: { tenantId: T.tenantId }, select: { id: true } })).map((x) => x.id));
    const store: typeof real = {
      listAfter: async (cursor, take) => (await real.listAfter(cursor, take)).filter((row) => mine.has(row.accountId)),
      casUpdate: (e, n) => real.casUpdate(e, n),
    };
    const dry = await resealWaCredentials({ apply: false, store, batchSize: 1000 });
    expect(dry.pending).toBeGreaterThanOrEqual(1);
    expect(dry.failed).toBe(0);
    const r = await resealWaCredentials({ apply: true, store, batchSize: 1000 });
    expect(r.resealed).toBeGreaterThanOrEqual(1);
    const after = await db.whatsAppCredential.findFirstOrThrow({ where: { accountId: a.accountId } });
    expect(after).toMatchObject({ keyId: "k2", version: before.version });
    expect(sealedKid(after.pinBox)).toBe("k2");

    vi.stubEnv("SECRET_BOX_KEYS", k2);
    expect(await loadCredential(a.accountId)).toMatchObject({ token: a.token, pin: a.pin });
    expect((await resealWaCredentials({ apply: false, store, batchSize: 1000 })).pending).toBe(0);
  });
});
