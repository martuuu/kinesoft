/**
 * [HD-11] (PV, §27 E · HD) Mail propio «Se canceló el débito automático» cuando el titular cancela el débito desde
 * Mercado Pago.
 *
 * El bug: el consumidor del preapproval (`lib/saas-billing-mp-internal.ts`, rama `cancelled_by_mp`) mandaba
 * `billing_debit_failed` sin `effectiveOn`; `buildMail` lo descartaba («mejor no mandar que mandar a medias») y el
 * consultorio no se enteraba de que el débito se apagó (y si hubiera salido, decía «No pudimos debitar», que es falso).
 *
 * De punta a punta por la RUTA REAL (`POST` de `app/api/webhooks/mercadopago/route.ts` → `handleSaasWebhook` →
 * consumidor → `sendSaasBillingMpMail` → `sendEmail` → sink de `EmailLog`) contra Postgres y el MP FALSO local
 * (`installSaasFakeMp`). Se reemplaza solo lo externo: la red (fake), el transporte de mails, el rate limit in-memory
 * y la sesión de Supabase (para la action del consultorio, molde de `mps-3a-actions.test.ts`). Nunca MP real.
 *
 * `tests/integration/mp-webhook.test.ts` (rama legada, AUDIT §5.4) no se toca.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  // Igual que mps-2b-webhook: la ruta legada congela `env.MP_WEBHOOK_SECRET` al importar; es el mismo literal con que
  // firma el fake lo de la plataforma.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token-hd11";
  process.env.MP_WEBHOOK_SECRET = "secreto-de-prueba-del-webhook-de-la-plataforma";
});

const tok = vi.hoisted(() => ({ claims: null as null | { session_id: string; aal: string } }));
vi.mock("@/lib/supabase/server", async () => {
  const { currentTestUser } = await import("@/tests/helpers/actor");
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (): string | null => {
    const u = currentTestUser();
    if (!u || !tok.claims) return null;
    const payload = {
      sub: u.id,
      email: u.email,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...tok.claims,
    };
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
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { POST } from "@/app/api/webhooks/mercadopago/route";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __resetSaasMpMemoForTests, createPreapproval } from "@/lib/mercadopago-saas";
import { cancelFakePreapprovalFromMp } from "@/lib/mp-connect/fake-mp-saas";
import { signMpNotification } from "@/lib/mp-connect/signature";
import { setCollectionMethod } from "@/lib/saas-billing-mp";
import { sendSaasBillingMpMail } from "@/lib/saas-billing-mail-internal";
import { addMonthsKey, arMidnight, dbDateFromKey, periodFor, periodStartOnOrBefore } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { BRAND_NAME } from "@/lib/brand";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { asUser } from "@/tests/helpers/actor";
import { FAKE_APP_URL } from "@/tests/helpers/mp-connect-fake";
import { FAKE_SAAS_HOOK_SECRET, authorizeFakePreapproval, fakeMpGetPreapproval, installSaasFakeMp, type InstalledSaasFakeMp } from "@/tests/helpers/mp-saas-fake";
import { createEphemeralTenant, ownerClient, sweepOrphanTestTenants, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const HOOK_URL = `${FAKE_APP_URL}/api/webhooks/mercadopago`;
const KIND = "billing_debit_cancelled";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

/** Reenvía tal cual una notificación que ya mandó el fake (MP reintenta con la misma firma). */
function replayHook(h: { url: string; headers: Record<string, string>; body: Record<string, unknown> }) {
  return POST(new Request(h.url, { method: "POST", headers: h.headers, body: JSON.stringify(h.body) }));
}

/**
 * Aviso `subscription_preapproval` firmado como lo manda MP. El fake no notifica cuando la sync cancela por PUT (solo
 * cuando el titular cancela desde su cuenta), pero MP sí avisa de cualquier cambio de estado: este es ese aviso.
 */
function preapprovalHook(id: string) {
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
    "x-signature": signMpNotification({ dataId: id, secret: FAKE_SAAS_HOOK_SECRET, ts: Math.floor(Date.now() / 1000), requestId }),
  };
  const body = { action: "updated", type: "subscription_preapproval", entity: "preapproval", data: { id } };
  return POST(new Request(`${HOOK_URL}?data.id=${id}&type=subscription_preapproval`, { method: "POST", headers, body: JSON.stringify(body) }));
}

describe.skipIf(!RUN)("[HD-11] mail «débito cancelado desde Mercado Pago»", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledSaasFakeMp | null = null;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
  });
  afterAll(async () => {
    __setEmailTransportForTests(null);
    await db?.$disconnect();
  });
  beforeEach(async () => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __resetSaasMpMemoForTests();
    tok.claims = null;
    cookies().delete(TWO_FACTOR_COOKIE);
    cookies().delete(STEP_UP_COOKIE);
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { subscriptionStatus: "ACTIVE", trialEndsAt: null, subscriptionStatusChangedAt: new Date() },
    });
    // Precio a medida = monto del preapproval: sin él la sync posterior pausaría el débito (CONSULTORIO no tiene precio).
    const p = periodFor(periodStartOnOrBefore(4, toARDateKey(new Date())));
    await db.saasSubscription.create({
      data: {
        tenantId: T.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(p.periodEnd),
        billableFrom: dbDateFromKey(addMonthsKey(p.periodStart, -1)),
        customPriceCents: 2_500_000,
        customPricePlan: "CONSULTORIO",
      },
    });
    fake = installSaasFakeMp({ webhook: POST });
  });
  afterEach(async () => {
    fake?.uninstall();
    fake = null;
    await T?.cleanup();
  });

  /** Preapproval creado por el puerto real, autorizado en el fake y promovido por el webhook real (AUTO_DEBIT). */
  async function activeDebit() {
    const r = await createPreapproval({
      reason: "Suscripción · Consultorio",
      externalReference: `saas:${T.tenantId}`,
      payerEmail: "titular@example.com",
      amountCents: 2_500_000,
      startDate: new Date(Date.now() + 10 * 86_400_000),
      backUrl: `${FAKE_APP_URL}/configuracion?tab=plan`,
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) throw new Error(`preapproval: ${r.kind}`);
    await db.saasSubscription.update({
      where: { tenantId: T.tenantId },
      data: { mpPendingPreapprovalId: r.data.id, mpPendingInitPoint: r.data.initPoint, mpPendingCreatedAt: new Date() },
    });
    const hook = await authorizeFakePreapproval(r.data.id);
    expect(hook).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    expect(await sub()).toMatchObject({ collectionMethod: "AUTO_DEBIT", autoDebitEnabled: true, mpPreapprovalId: r.data.id });
    return r.data.id;
  }

  const sub = () => db.saasSubscription.findUniqueOrThrow({ where: { tenantId: T.tenantId } });
  const logs = () => db.emailLog.findMany({ where: { tenantId: T.tenantId, kind: KIND } });
  const recipients = () =>
    db.membership.count({ where: { tenantId: T.tenantId, acceptedAt: { not: null }, disabledAt: null, OR: [{ role: "OWNER" }, { grantBilling: true }] } });

  it("[HD-11] cancelado desde Mercado Pago → un EmailLog billing_debit_cancelled por destinatario; el replay no duplica", async () => {
    const id = await activeDebit();
    expect(await recipients()).toBe(1);

    const r = await cancelFakePreapprovalFromMp(id);
    expect(r).toMatchObject({ webhookStatus: 200, webhookResult: "applied" });
    expect(await sub()).toMatchObject({ mpPreapprovalStatus: "cancelled", autoDebitEnabled: false, collectionMethod: null });

    const rows = await logs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: "SaasSubscription", entityId: id, status: "sent" });
    const sentMail = mail.sent.filter((m) => m.kind === KIND);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].subject).toBe(`Se canceló el débito automático de ${BRAND_NAME}`);
    // Ya no sale (ni se intenta) el «No pudimos debitar» del cancelado.
    expect(await db.emailLog.count({ where: { tenantId: T.tenantId, kind: "billing_debit_failed" } })).toBe(0);
    // Una sola reserva de idempotencia, con la clave del contrato.
    expect(await db.platformAuditEvent.count({ where: { idempotencyKey: `billing_debit_cancelled:${id}` } })).toBe(1);

    // MP reintenta el mismo aviso: replay, sin mail nuevo.
    const again = await replayHook(fake!.hooks.at(-1)!);
    expect(await again.json()).toMatchObject({ result: "replay" });
    // Aunque el consumidor volviera a disparar el envío (otro camino, otro día), la clave por autorización lo frena.
    expect(await sendSaasBillingMpMail(KIND, T.tenantId, { entity: "SaasSubscription", entityId: id })).toEqual({ sent: 0, notSent: 0 });
    expect(await logs()).toHaveLength(1);
    expect(mail.sent.filter((m) => m.kind === KIND)).toHaveLength(1);
  });

  it("[HD-11] cancelación propia (el consultorio pasa a transferencia desde la app) → el aviso de MP no manda billing_debit_cancelled", async () => {
    const id = await activeDebit();
    asUser(T.userId);
    await db.userProfile.update({ where: { id: T.userId }, data: { twoFactorTotp: true } });
    tok.claims = { session_id: `sess-${T.userId}`, aal: "aal2" };
    setStepUpCookie(T.userId, `sess-${T.userId}`);

    expect(await setCollectionMethod({ method: "TRANSFER" })).toEqual({ ok: true, data: { collectionMethod: "TRANSFER" } });
    // La sync lo canceló en MP y ya guardó la foto «cancelled»: el aviso de MP que llega después es un replay.
    expect(fakeMpGetPreapproval(id)?.status).toBe("cancelled");
    const r1 = await preapprovalHook(id);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ result: "replay" });

    // Carrera: el aviso de MP llega ANTES de que la sync guarde la foto. El consumidor ve «cancelled» nuevo, pero el
    // método ya no es AUTO_DEBIT: lo cancelamos nosotros (rama `ours`), solo se refleja y no hay mail.
    await db.saasSubscription.update({ where: { tenantId: T.tenantId }, data: { mpPreapprovalStatus: "authorized" } });
    const r2 = await preapprovalHook(id);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ result: "applied" });
    expect(await sub()).toMatchObject({ mpPreapprovalStatus: "cancelled", autoDebitEnabled: false, collectionMethod: "TRANSFER" });

    expect(await logs()).toHaveLength(0);
    expect(mail.sent.filter((m) => m.kind === KIND)).toHaveLength(0);
    expect(await db.platformAuditEvent.count({ where: { idempotencyKey: `billing_debit_cancelled:${id}` } })).toBe(0);
  });
});
