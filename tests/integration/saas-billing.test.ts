/**
 * [PL-2b] Configuración → Facturación (`lib/saas-billing.ts`) contra Postgres en los dos roles (`kinesoft_app` con
 * RLS y owner BYPASSRLS). Símbolos REALES: `requireAccountBilling`, `requireStepUp` (PL-2a), `withAccountWritable`,
 * el núcleo de cobros y el de cambio de plan. Se mockea solo lo externo:
 *  - la sesión de Supabase (con access token `session_id`/`aal`, molde de pl1e-session, para que la 2FA y el step-up
 *    corran de verdad);
 *  - el admin client de Supabase (Storage): un fake que registra cada llamada, para afirmar que un archivo rechazado
 *    NUNCA llega a Storage.
 *
 * Se fija: sin `account.billing` → 403; sin 2FA → digest de setup; con 2FA y sin step-up → digest de step-up; con
 * step-up cambia el plan; en solo lectura el Titular sube comprobante y cambia plan, el soporte no; > 4 MB, magic
 * bytes que no coinciden o MIME no permitido → rechazo ANTES de Storage; el comprobante bueno queda PENDING_REVIEW
 * con la clave `<tenantId>/<paymentId>.<ext>` y su audit; la URL firmada es de la fila (60 s) y nunca de otro
 * consultorio; `SAAS_BILLING_MODE=off` no deja subir.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";

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

const supa = vi.hoisted(() => ({ calls: [] as { op: string; bucket: string; key: unknown; opts?: unknown }[] }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        upload: async (key: string, _body: unknown, opts: unknown) => {
          supa.calls.push({ op: "upload", bucket, key, opts });
          return { data: { path: key }, error: null };
        },
        createSignedUrl: async (key: string, ttl: number) => {
          supa.calls.push({ op: "sign", bucket, key, opts: ttl });
          return { data: { signedUrl: `https://signed.test/${bucket}/${key}?ttl=${ttl}` }, error: null };
        },
        remove: async (keys: string[]) => {
          supa.calls.push({ op: "remove", bucket, key: keys });
          return { data: [], error: null };
        },
      }),
    },
  }),
}));

import { ForbiddenError, ReadOnlyModeError, assertWritable, getActor } from "@/lib/session";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { setStepUpCookie, STEP_UP_COOKIE, TWO_FACTOR_COOKIE } from "@/lib/two-factor-cookie";
import { applyPlanChange, getBillingOverview, getReceiptUrl, previewPlanChange, submitPaymentReceipt } from "@/lib/saas-billing";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { RECEIPT_MAX_BYTES, dbDateFromKey, periodFor } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d];
const EXE = [0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00];

function form(fields: Record<string, string | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const file = (bytes: number[] | Uint8Array<ArrayBuffer>, type: string, name = "comprobante.pdf") =>
  new File([bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)], name, { type });

describe.skipIf(!RUN)("[PL-2b] Configuración → Facturación", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let assistantId: string;
  let billingUserId: string;
  let chargeId: string;
  const users: string[] = [];

  async function member(t: EphemeralTenant, role: "ASSISTANT" | "BILLING", grantBilling = false) {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Miembro ${role}` } });
    await db.membership.create({ data: { userId: id, tenantId: t.tenantId, role, clinical: false, grantBilling, acceptedAt: new Date() } });
    return id;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    B = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    assistantId = await member(A, "ASSISTANT");
    billingUserId = await member(A, "BILLING", true);
    // Un cargo abierto del período vigente (lo genera el cron en la vida real; acá a mano con el owner).
    const p = periodFor(toARDateKey(new Date()));
    const c = await db.saasCharge.create({
      data: {
        tenantId: A.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents: 1_500_000,
      },
    });
    chargeId = c.id;
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      await db.userProfile.deleteMany({ where: { id: { in: users } } });
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    supa.calls.length = 0;
    tok.claims = null;
    cookies().delete(TWO_FACTOR_COOKIE);
    cookies().delete(STEP_UP_COOKIE);
    cookies().delete(SUPPORT_COOKIE);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    // PL-Z (A2): sin datos para transferir no se ofrece «Informar pago».
    vi.stubEnv("SAAS_BILLING_TRANSFER_INFO", "Alias kinesoft.cobros");
    asUser(A.userId);
  });
  afterEach(() => vi.unstubAllEnvs());

  // ── Barrera ─────────────────────────────────────────────────────────────────────────────────────────────────

  it("sin «Planes y pagos» (Secretaria) → 403 en todo, y nada se escribe ni se sube", async () => {
    asUser(assistantId);
    await expect(getBillingOverview()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(previewPlanChange("CLINICA")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: new Date().toISOString() })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submitPaymentReceipt(form({ file: file(PDF, "application/pdf"), chargeId }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getReceiptUrl("x")).rejects.toBeInstanceOf(ForbiddenError);
    expect(supa.calls).toHaveLength(0);
    expect(await db.saasPayment.count({ where: { tenantId: A.tenantId } })).toBe(0);
  });

  it("con `grantBilling` (Facturación delegada) ve el estado contable del consultorio", async () => {
    asUser(billingUserId);
    const o = await getBillingOverview();
    expect(o).toMatchObject({ tenantId: A.tenantId, plan: "CONSULTORIO", mode: "manual", canSubmitReceipt: true });
    expect(o.charges.map((c) => c.id)).toEqual([chargeId]);
    expect(o.balanceCents).toBe(1_500_000);
  });

  // ── Comprobantes ────────────────────────────────────────────────────────────────────────────────────────────

  it("> 4 MB, magic bytes que no coinciden o tipo no permitido → rechazo ANTES de Storage", async () => {
    const big = new Uint8Array(RECEIPT_MAX_BYTES + 1);
    big.set(PDF);
    const cases: FormData[] = [
      form({ file: file(big, "application/pdf"), chargeId }),
      form({ file: file(EXE, "application/pdf"), chargeId }), // MIME falso: un ejecutable que dice ser PDF
      form({ file: file(PNG, "application/pdf"), chargeId }), // un PNG declarado como PDF
      form({ file: file(EXE, "application/x-msdownload", "c.exe"), chargeId }),
    ];
    for (const fd of cases) {
      const r = await submitPaymentReceipt(fd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fieldErrors?.file?.length).toBe(1);
    }
    const noFile = await submitPaymentReceipt(form({ chargeId }));
    expect(noFile.ok).toBe(false);
    expect(supa.calls).toHaveLength(0);
    expect(await db.saasPayment.count({ where: { tenantId: A.tenantId } })).toBe(0);
  });

  it("comprobante bueno → Storage con la clave del server, fila PENDING_REVIEW por lo que falta, audit en tx", async () => {
    const r = await submitPaymentReceipt(form({ file: file(PDF, "application/pdf"), chargeId, paidOn: toARDateKey(new Date()), note: "Transferencia" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pay = await db.saasPayment.findUniqueOrThrow({ where: { id: r.data.paymentId } });
    expect(pay).toMatchObject({
      tenantId: A.tenantId,
      chargeId,
      source: "MANUAL",
      status: "PENDING_REVIEW",
      amountCents: 1_500_000,
      receiptPath: `${A.tenantId}/${r.data.paymentId}.pdf`,
      receiptMimeType: "application/pdf",
      receiptSizeBytes: PDF.length,
      submittedById: A.userId,
    });
    expect(supa.calls).toEqual([
      { op: "upload", bucket: "billing-receipts", key: `${A.tenantId}/${r.data.paymentId}.pdf`, opts: { contentType: "application/pdf", upsert: false } },
    ]);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "billing.payment.submitted", entityId: r.data.paymentId } });
    expect(audit.actorId).toBe(A.userId);
    // Pendiente de revisión: no imputa ni cambia el estado del cargo.
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: chargeId } })).status).toBe("OPEN");

    // La URL firmada sale de la fila (60 s); un id de OTRO consultorio no existe para A.
    supa.calls.length = 0;
    const url = await getReceiptUrl(r.data.paymentId);
    expect(url).toEqual({ ok: true, data: { url: `https://signed.test/billing-receipts/${A.tenantId}/${r.data.paymentId}.pdf?ttl=60` } });
    asUser(B.userId);
    expect((await getReceiptUrl(r.data.paymentId)).ok).toBe(false);
    expect(supa.calls).toHaveLength(1);
  });

  it("un cargo de otro consultorio → no encontrado, sin subir nada", async () => {
    asUser(B.userId);
    const r = await submitPaymentReceipt(form({ file: file(PDF, "application/pdf"), chargeId }));
    expect(r.ok).toBe(false);
    expect(supa.calls).toHaveLength(0);
    expect(await db.saasPayment.count({ where: { tenantId: B.tenantId } })).toBe(0);
  });

  it("SAAS_BILLING_MODE=off → no se pueden subir comprobantes", async () => {
    vi.stubEnv("SAAS_BILLING_MODE", "off");
    const before = await db.saasPayment.count({ where: { tenantId: A.tenantId } });
    const r = await submitPaymentReceipt(form({ file: file(PDF, "application/pdf"), chargeId }));
    expect(r).toEqual({ ok: false, error: "El cobro de la suscripción todavía no está habilitado." });
    expect(supa.calls).toHaveLength(0);
    expect(await db.saasPayment.count({ where: { tenantId: A.tenantId } })).toBe(before);
    expect((await getBillingOverview()).canSubmitReceipt).toBe(false);
  });

  it("[PL-Z] A2: sin SAAS_BILLING_TRANSFER_INFO no se ofrece «Informar pago»", async () => {
    vi.stubEnv("SAAS_BILLING_TRANSFER_INFO", "");
    expect(await getBillingOverview()).toMatchObject({ mode: "manual", transferInfo: null, canSubmitReceipt: false });
  });

  // ── Cambio de plan + step-up ────────────────────────────────────────────────────────────────────────────────

  describe("cambio de plan", () => {
    afterEach(async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: false, twoFactorEmail: false } });
    });

    const input = async (to: "CLINICA" | "CONSULTORIO" | "LIBRE") => ({
      to,
      disableMembershipIds: [],
      reactivateMembershipIds: [],
      expectedUpdatedAt: (await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).updatedAt.toISOString(),
    });

    it("sin 2FA → digest de setup; con 2FA y sin step-up → digest de step-up; nada cambia", async () => {
      const e1 = await applyPlanChange(await input("CLINICA")).catch((e) => e);
      expect(classifyStepUpError(e1)).toEqual({ kind: "setup" });

      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-billing", aal: "aal2" };
      const e2 = await applyPlanChange(await input("CLINICA")).catch((e) => e);
      expect(classifyStepUpError(e2)).toEqual({ kind: "step_up" });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).saasPlan).toBe("CONSULTORIO");
    });

    it("con step-up fresco → cambia el plan (escritor único, source billing) y Libre no se puede", async () => {
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-billing", aal: "aal2" };
      setStepUpCookie(A.userId, "sess-billing");
      expect(await applyPlanChange(await input("LIBRE"))).toMatchObject({ ok: false, reason: "libre_platform_only" });
      const r = await applyPlanChange(await input("CLINICA"));
      expect(r).toEqual({ ok: true, data: { disabled: 0, reactivated: 0, revokedInvites: 0 } });
      const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
      expect(t).toMatchObject({ saasPlan: "CLINICA", plan: "PRO" });
      const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "tenant.entitlements" }, orderBy: { createdAt: "desc" } });
      expect(ev.payload).toMatchObject({ source: "billing", changed: ["saasPlan"] });
      // CAS: el mismo `expectedUpdatedAt` viejo → stale.
      const stale = await applyPlanChange({ to: "CONSULTORIO", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: new Date(0).toISOString() });
      expect(stale).toMatchObject({ ok: false, reason: "stale" });
      await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "CONSULTORIO", plan: "STARTER" } });
    });

    it("[PL-Z] a3#1: Libre con cupos a medida no cambia de plan desde el consultorio, con el copy propio", async () => {
      asUser(A.userId);
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
      try {
        tok.claims = { session_id: "sess-custom", aal: "aal2" };
        setStepUpCookie(A.userId, "sess-custom");
        await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "LIBRE", plan: "ENTERPRISE", maxUsersOverride: 40 } });
        const t0 = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
        const r = await applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: t0.updatedAt.toISOString() });
        expect(r).toEqual({
          ok: false,
          error: "Tu consultorio tiene cupos a medida: escribinos para cambiar el plan.",
          reason: "invalid_selection",
          detail: "custom_limits",
        });
        expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).saasPlan).toBe("LIBRE");
      } finally {
        await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: false } });
        await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "CONSULTORIO", plan: "STARTER", maxUsersOverride: null } });
      }
    });

    it("[PL-Z] a3#2: con solo «Planes y pagos» no elige a quién deshabilitar/reactivar (pide Configuración)", async () => {
      asUser(billingUserId);
      await db.userProfile.update({ where: { id: billingUserId }, data: { twoFactorTotp: true } });
      try {
        tok.claims = { session_id: "sess-billing-only", aal: "aal2" };
        setStepUpCookie(billingUserId, "sess-billing-only");
        const victim = await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: assistantId } });
        const t0 = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
        const copy = "Para elegir a quién deshabilitar necesitás también permiso de Configuración.";
        for (const lists of [
          { disableMembershipIds: [victim.id], reactivateMembershipIds: [] },
          { disableMembershipIds: [], reactivateMembershipIds: [victim.id] },
        ]) {
          const r = await applyPlanChange({ to: "INDIVIDUAL", ...lists, expectedUpdatedAt: t0.updatedAt.toISOString() });
          expect(r).toEqual({ ok: false, error: copy, reason: "invalid_selection" });
        }
        expect(await db.membership.findUniqueOrThrow({ where: { id: victim.id } })).toMatchObject({ disabledAt: null });
        expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).saasPlan).toBe("CONSULTORIO");
        // Sin elegir a nadie, «Planes y pagos» sí cambia el plan.
        const ok = await applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: t0.updatedAt.toISOString() });
        expect(ok.ok).toBe(true);
      } finally {
        await db.userProfile.update({ where: { id: billingUserId }, data: { twoFactorTotp: false } });
        await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "CONSULTORIO", plan: "STARTER" } });
      }
    });
  });

  // ── Solo lectura ────────────────────────────────────────────────────────────────────────────────────────────

  describe("solo lectura (suscripción cancelada + enforce)", () => {
    let H: EphemeralTenant;
    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    });
    beforeEach(() => vi.stubEnv("TENANT_ACCESS_ENFORCEMENT", "enforce"));
    afterAll(async () => {
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "ACTIVE" } });
      await db.supportSession.deleteMany({ where: { superadminId: H?.userId } });
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: false } });
      await H?.cleanup();
    });

    it("el Titular sube el comprobante y cambia de plan", async () => {
      // Control: el consultorio SÍ está en solo lectura (fuera de las actions de cuenta no escribe).
      const actor = await getActor();
      expect(actor.access.mode).toBe("read_only");
      expect(() => assertWritable(actor)).toThrow(ReadOnlyModeError);
      const r = await submitPaymentReceipt(form({ file: file(PNG, "image/png", "c.png"), amount: "5.000" }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(await db.saasPayment.findUniqueOrThrow({ where: { id: r.data.paymentId } })).toMatchObject({
          chargeId: null,
          amountCents: 500_000,
          receiptMimeType: "image/png",
          status: "PENDING_REVIEW",
        });
      }
      await db.userProfile.update({ where: { id: A.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-ro", aal: "aal2" };
      setStepUpCookie(A.userId, "sess-ro");
      const t0 = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
      const c = await applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: t0.updatedAt.toISOString() });
      expect(c.ok).toBe(true);
      expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).saasPlan).toBe("CLINICA");
      await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "CONSULTORIO", plan: "STARTER" } });
    });

    it("el soporte no: ni sube comprobante ni cambia el plan", async () => {
      asUser(H.userId);
      // PL-Z: abrir soporte es una acción `high` de Plataforma y pide step-up de la 2FA del superadmin.
      await db.userProfile.update({ where: { id: H.userId }, data: { twoFactorTotp: true } });
      tok.claims = { session_id: "sess-support", aal: "aal2" };
      setStepUpCookie(H.userId, "sess-support");
      const s = await startSupport(A.tenantId, "Ayuda con el pago del consultorio");
      if (!s.ok) throw new Error(s.error);
      const before = await db.saasPayment.count({ where: { tenantId: A.tenantId } });
      await expect(submitPaymentReceipt(form({ file: file(PDF, "application/pdf"), chargeId }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: new Date().toISOString() })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await db.saasPayment.count({ where: { tenantId: A.tenantId } })).toBe(before);
      expect(supa.calls).toHaveLength(0);
      cookies().delete(SUPPORT_COOKIE);
    });
  });
});
