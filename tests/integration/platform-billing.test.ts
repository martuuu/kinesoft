/**
 * [PL-2b] /plataforma → Facturación y Precios (`lib/platform-billing.ts`) contra Postgres en los dos roles. Símbolos
 * REALES (`requirePlatformAdmin`, núcleo de cobros, núcleo de cambio de plan, escritor único, audit doble). Se mockea
 * lo externo: Storage (fake que registra) y el despacho del mail (`__setEmailTransportForTests`, el sink a EmailLog
 * sigue corriendo).
 *
 * Se fija: sin superadmin → 403; imputar con recibo aprueba, salda el cargo y pasa PAST_DUE → ACTIVE (con
 * `subscriptionStatusChangedAt` nuevo) con audit doble y mail; un recibo inválido no llega a Storage; aprobar imputa
 * y es una sola vez; rechazar exige motivo y avisa con el motivo; anular con pagos no, condonar sí; precio a medida
 * con audit; precio de lista inmediato escribe historial + revalida el catálogo; cambio de plan a Libre desde
 * Plataforma.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const supa = vi.hoisted(() => ({ calls: [] as { op: string; key: unknown }[] }));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    storage: {
      from: () => ({
        upload: async (key: string) => {
          supa.calls.push({ op: "upload", key });
          return { data: { path: key }, error: null };
        },
        createSignedUrl: async (key: string, ttl: number) => {
          supa.calls.push({ op: "sign", key });
          return { data: { signedUrl: `https://signed.test/${key}?ttl=${ttl}` }, error: null };
        },
        remove: async (keys: string[]) => {
          supa.calls.push({ op: "remove", key: keys });
          return { data: [], error: null };
        },
      }),
    },
  }),
}));

import { ForbiddenError } from "@/lib/session";
import {
  getPlatformReceiptUrl,
  getTenantLedger,
  listAccounts,
  listPriceHistory,
  platformApplyPlanChange,
  recordManualPayment,
  reviewPayment,
  setCustomPrice,
  updatePlanPrice,
  voidCharge,
  waiveCharge,
} from "@/lib/platform-billing";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { SAAS_PLANS_TAG } from "@/lib/cache-tags";
import { addDaysKey, dbDateFromKey, periodFor } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
const DAY = 86_400_000;

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

function receiptForm(fields: Record<string, string>, bytes: Uint8Array<ArrayBuffer> = PDF, type = "application/pdf"): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.set("file", new File([bytes], "recibo.pdf", { type }));
  return fd;
}

describe.skipIf(!RUN)("[PL-2b] Plataforma → Facturación", () => {
  let db: PrismaClient;
  let S: EphemeralTenant; // home del superadmin
  let A: EphemeralTenant;
  let ownerEmail: string;
  const priceChangeIds: string[] = [];

  /** Cargo vencido (inicio hace 10 días AR, venció hace 5). */
  async function overdueCharge(t: EphemeralTenant, amountCents = 1_000_000, offsetDays = -10) {
    const p = periodFor(addDaysKey(toARDateKey(new Date()), offsetDays));
    return db.saasCharge.create({
      data: {
        tenantId: t.tenantId,
        plan: "CONSULTORIO",
        periodStart: dbDateFromKey(p.periodStart),
        periodEnd: dbDateFromKey(p.periodEnd),
        dueDate: dbDateFromKey(p.dueDate),
        amountCents,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    ownerEmail = (await db.userProfile.findUniqueOrThrow({ where: { id: A.userId } })).email;
  });

  afterAll(async () => {
    __setEmailTransportForTests(null);
    if (db) {
      if (priceChangeIds.length) {
        await db.$transaction([
          db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
          db.$executeRaw`DELETE FROM "SaasPlanPriceChange" WHERE "id" = ANY(${priceChangeIds})`,
          db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "entityId" = ANY(${priceChangeIds})`,
        ]);
      }
    }
    await A?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    supa.calls.length = 0;
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    revalidateTagSpy.mockClear();
    asUser(S.userId);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sin superadmin → 403 en lecturas y escrituras", async () => {
    asUser(A.userId);
    await expect(listAccounts()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getTenantLedger(A.tenantId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordManualPayment(receiptForm({ tenantId: A.tenantId, amount: "100" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCustomPrice(A.tenantId, 100)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updatePlanPrice({ plan: "LIBRE", priceCents: 1, effectiveFrom: "2030-01-01" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(supa.calls).toHaveLength(0);
  });

  it("imputar con recibo: aprueba, salda el cargo, PAST_DUE → ACTIVE, audit doble y mail", async () => {
    const charge = await overdueCharge(A);
    const changedBefore = new Date(Date.now() - 3 * DAY);
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "PAST_DUE", subscriptionStatusChangedAt: changedBefore } });

    // Recibo inválido: ni Storage ni fila.
    const bad = await recordManualPayment(receiptForm({ tenantId: A.tenantId, amount: "10.000", method: "TRANSFER" }, EXE));
    expect(bad.ok).toBe(false);
    expect(supa.calls).toHaveLength(0);

    const r = await recordManualPayment(receiptForm({ tenantId: A.tenantId, amount: "10.000", chargeId: charge.id, method: "TRANSFER", note: "Transferencia" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(supa.calls).toEqual([{ op: "upload", key: `${A.tenantId}/${r.data.paymentId}.pdf` }]);
    expect(await db.saasPayment.findUniqueOrThrow({ where: { id: r.data.paymentId } })).toMatchObject({
      status: "APPROVED",
      source: "MANUAL",
      chargeId: charge.id,
      amountCents: 1_000_000,
      reviewedById: S.userId,
    });
    expect(await db.saasCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ status: "PAID" });
    const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect(t.subscriptionStatus).toBe("ACTIVE");
    expect(t.subscriptionStatusChangedAt!.getTime()).toBeGreaterThan(changedBefore.getTime());

    const global = await db.platformAuditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "platform.billing.payment.recorded" } });
    expect(global).toMatchObject({ actorId: S.userId, entity: "SaasPayment", entityId: r.data.paymentId });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "platform.billing.payment.recorded" } })).toBe(1);
    const ent = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "tenant.entitlements" }, orderBy: { createdAt: "desc" } });
    expect(ent.payload).toMatchObject({ source: "billing", after: { subscriptionStatus: "ACTIVE" } });

    const m = mail.sent.filter((x) => x.to === ownerEmail && x.kind === "billing_payment_received");
    expect(m).toHaveLength(1);
    expect(m[0].subject).toContain("10.000");

    // Comprobante: URL firmada de la fila.
    supa.calls.length = 0;
    expect(await getPlatformReceiptUrl(r.data.paymentId)).toEqual({
      ok: true,
      data: { url: `https://signed.test/${A.tenantId}/${r.data.paymentId}.pdf?ttl=60` },
    });
  });

  it("revisar: aprobar imputa una sola vez; rechazar exige motivo y avisa con el motivo", async () => {
    const charge = await overdueCharge(A, 300_000, -40);
    const mk = (amountCents: number) =>
      db.saasPayment.create({
        data: {
          tenantId: A.tenantId,
          chargeId: charge.id,
          source: "MANUAL",
          status: "PENDING_REVIEW",
          amountCents,
          receiptPath: `${A.tenantId}/x-${amountCents}.pdf`,
          receiptMimeType: "application/pdf",
          receiptSizeBytes: 10,
          submittedById: A.userId,
        },
      });
    const p1 = await mk(300_000);
    const p2 = await mk(300_001);

    expect(await reviewPayment({ paymentId: p2.id, decision: "reject" })).toMatchObject({ ok: false });
    expect(await reviewPayment({ paymentId: p2.id, decision: "reject", reason: "No coincide el monto" })).toEqual({ ok: true, data: { chargePaid: false } });
    expect(await db.saasPayment.findUniqueOrThrow({ where: { id: p2.id } })).toMatchObject({ status: "REJECTED", reviewNote: "No coincide el monto", reviewedById: S.userId });
    const rej = mail.sent.filter((x) => x.kind === "billing_payment_rejected");
    expect(rej).toHaveLength(1);
    expect(rej[0].text).toContain("Motivo: No coincide el monto");

    expect(await reviewPayment({ paymentId: p1.id, decision: "approve" })).toEqual({ ok: true, data: { chargePaid: true } });
    expect(await db.saasCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ status: "PAID" });
    expect(await reviewPayment({ paymentId: p1.id, decision: "approve" })).toEqual({ ok: false, error: "Ese comprobante ya se revisó." });
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.billing.payment.approved", entityId: p1.id } })).toBe(1);
  });

  it("[PL-F1a] medio de pago: registrar lo guarda en la columna (nota sin prefijo), el excedente lo hereda y aprobar lo conserva", async () => {
    const C = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    try {
      const charge = await overdueCharge(C, 100_000);
      // Faltante o inválido: ni Storage ni fila.
      for (const bad of [{}, { method: "CHEQUE" }] as Record<string, string>[]) {
        const r = await recordManualPayment(receiptForm({ tenantId: C.tenantId, amount: "1.500", chargeId: charge.id, ...bad }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.fieldErrors?.method?.length).toBe(1);
      }
      expect(supa.calls).toHaveLength(0);
      expect(await db.saasPayment.count({ where: { tenantId: C.tenantId } })).toBe(0);

      // $ 1.500 contra un cargo de $ 1.000: el pago queda por $ 1.000 y el hermano a cuenta por $ 500, mismo medio.
      const r = await recordManualPayment(receiptForm({ tenantId: C.tenantId, amount: "1.500", chargeId: charge.id, method: "WALLET", note: "op 123" }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const rows = await db.saasPayment.findMany({ where: { tenantId: C.tenantId }, orderBy: { amountCents: "desc" } });
      expect(rows.map((p) => ({ chargeId: p.chargeId, amountCents: p.amountCents, method: p.method }))).toEqual([
        { chargeId: charge.id, amountCents: 100_000, method: "WALLET" },
        { chargeId: null, amountCents: 50_000, method: "WALLET" },
      ]);
      expect(rows[0].note).toBe("op 123");
      const global = await db.platformAuditEvent.findFirstOrThrow({ where: { tenantId: C.tenantId, action: "platform.billing.payment.recorded" } });
      expect(global.payload).toMatchObject({ method: "WALLET" });

      // Aprobar un comprobante del consultorio conserva el medio que informó.
      const charge2 = await overdueCharge(C, 300_000, -40);
      const pending = await db.saasPayment.create({
        data: { tenantId: C.tenantId, chargeId: charge2.id, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 250_000, method: "CARD", submittedById: C.userId },
      });
      expect((await reviewPayment({ paymentId: pending.id, decision: "approve" })).ok).toBe(true);
      expect(await db.saasPayment.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "APPROVED", method: "CARD" });

      // El ledger de Plataforma devuelve el medio de cada pago.
      const ledger = await getTenantLedger(C.tenantId);
      expect(new Set(ledger!.payments.map((p) => p.method))).toEqual(new Set(["WALLET", "CARD"]));
    } finally {
      await C.cleanup();
    }
  });

  it("anular con pagos aprobados no; condonar sí; un cargo cerrado no se toca de nuevo", async () => {
    const c1 = await overdueCharge(A, 200_000, -70);
    await db.saasPayment.create({
      data: { tenantId: A.tenantId, chargeId: c1.id, source: "MANUAL", status: "APPROVED", amountCents: 50_000, paidAt: new Date() },
    });
    expect(await voidCharge({ chargeId: c1.id })).toEqual({ ok: false, error: "El cargo tiene pagos aprobados: condonalo en vez de anularlo." });
    expect(await waiveCharge({ chargeId: c1.id, note: "Bonificado" })).toEqual({ ok: true, data: undefined });
    expect(await db.saasCharge.findUniqueOrThrow({ where: { id: c1.id } })).toMatchObject({ status: "WAIVED", statusChangedById: S.userId, note: "Bonificado" });
    expect((await voidCharge({ chargeId: c1.id })).ok).toBe(false);

    const c2 = await overdueCharge(A, 200_000, -100);
    expect((await voidCharge({ chargeId: c2.id })).ok).toBe(true);
    expect((await db.saasCharge.findUniqueOrThrow({ where: { id: c2.id } })).status).toBe("VOID");
  });

  it("[PL-Z] a1#6: montos por encima de un INTEGER se rechazan antes de Storage y de la base", async () => {
    const before = await db.saasPayment.count({ where: { tenantId: A.tenantId } });
    // 21.474.836,48 = 2_147_483_648 centavos: uno más que el máximo de la columna.
    const r = await recordManualPayment(receiptForm({ tenantId: A.tenantId, amount: "21.474.836,48", method: "TRANSFER" }));
    expect(r).toMatchObject({ ok: false, fieldErrors: { amount: ["Revisá el monto: es demasiado alto."] } });
    expect(supa.calls).toHaveLength(0);
    expect(await db.saasPayment.count({ where: { tenantId: A.tenantId } })).toBe(before);
    expect(await setCustomPrice(A.tenantId, 2_147_483_648)).toEqual({ ok: false, error: "Datos inválidos" });
    expect((await updatePlanPrice({ plan: "LIBRE", priceCents: 2_147_483_648, effectiveFrom: "2030-01-01" })).ok).toBe(false);
  });

  it("precio a medida: suscripción + audit doble; listado y ledger lo muestran", async () => {
    expect(await setCustomPrice(A.tenantId, 777_700)).toEqual({ ok: true, data: undefined });
    expect((await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: A.tenantId } })).customPriceCents).toBe(777_700);
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.billing.custom_price" } })).toBe(1);
    const ledger = await getTenantLedger(A.tenantId);
    expect(ledger).toMatchObject({ tenantId: A.tenantId, customPriceCents: 777_700, effectivePriceCents: 777_700 });
    const page = await listAccounts({ q: A.slug });
    expect(page.rows.map((r) => r.tenantId)).toEqual([A.tenantId]);
    expect(page.rows[0]).toMatchObject({ customPriceCents: 777_700, effectivePriceCents: 777_700 });
  });

  it("precio de lista con vigencia hoy: historial + config + revalida el catálogo; uno futuro queda pendiente", async () => {
    const before = await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } });
    try {
      const now = await updatePlanPrice({ plan: "LIBRE", priceCents: 9_900_000, effectiveFrom: toARDateKey(new Date()), note: "Lista nueva" });
      expect(now.ok).toBe(true);
      if (!now.ok) return;
      priceChangeIds.push(now.data.changeId);
      expect(now.data.appliedNow).toBe(true);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(9_900_000);
      expect(revalidateTagSpy).toHaveBeenCalledWith(SAAS_PLANS_TAG);
      const h = await db.saasPlanPriceChange.findUniqueOrThrow({ where: { id: now.data.changeId } });
      expect(h).toMatchObject({ plan: "LIBRE", priceCents: 9_900_000, previousPriceCents: before.priceCents, createdById: S.userId, note: "Lista nueva" });
      expect(h.appliedAt).not.toBeNull();

      revalidateTagSpy.mockClear();
      const later = await updatePlanPrice({ plan: "LIBRE", priceCents: 12_000_000, effectiveFrom: addDaysKey(toARDateKey(new Date()), 30) });
      expect(later.ok).toBe(true);
      if (!later.ok) return;
      priceChangeIds.push(later.data.changeId);
      expect(later.data.appliedNow).toBe(false);
      expect((await db.saasPlanConfig.findUniqueOrThrow({ where: { plan: "LIBRE" } })).priceCents).toBe(9_900_000);
      expect(revalidateTagSpy).not.toHaveBeenCalledWith(SAAS_PLANS_TAG);
      const hist = await listPriceHistory("LIBRE");
      expect(hist.slice(0, 2).map((x) => x.id)).toEqual([later.data.changeId, now.data.changeId]);
      expect(hist[0].createdByEmail).toContain("@test.local");
    } finally {
      await db.saasPlanConfig.update({ where: { plan: "LIBRE" }, data: { priceCents: before.priceCents, updatedById: before.updatedById } });
    }
  });

  it("cambio de plan desde Plataforma: Libre permitido, source platform con audit doble", async () => {
    const t0 = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    const r = await platformApplyPlanChange({
      tenantId: A.tenantId,
      to: "LIBRE",
      disableMembershipIds: [],
      reactivateMembershipIds: [],
      expectedUpdatedAt: t0.updatedAt.toISOString(),
    });
    expect(r).toEqual({ ok: true, data: { disabled: 0, reactivated: 0, revokedInvites: 0 } });
    expect(await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).toMatchObject({ saasPlan: "LIBRE", plan: "ENTERPRISE" });
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.tenant.entitlements" } })).toBeGreaterThanOrEqual(1);
    const stale = await platformApplyPlanChange({
      tenantId: A.tenantId,
      to: "CLINICA",
      disableMembershipIds: [],
      reactivateMembershipIds: [],
      expectedUpdatedAt: t0.updatedAt.toISOString(),
    });
    expect(stale).toMatchObject({ ok: false, reason: "stale" });
  });

  it("listado: «a revisar» y «con deuda» filtran por la base", async () => {
    const c = await overdueCharge(A, 100_000, -130);
    await db.saasPayment.create({
      data: { tenantId: A.tenantId, chargeId: c.id, source: "MANUAL", status: "PENDING_REVIEW", amountCents: 100_000 },
    });
    const toReview = await listAccounts({ view: "to_review", q: A.slug });
    expect(toReview.rows.map((r) => r.tenantId)).toEqual([A.tenantId]);
    expect(toReview.rows[0].pendingReviews).toBe(1);
    const debt = await listAccounts({ view: "debt", q: A.slug });
    expect(debt.rows[0]).toMatchObject({ tenantId: A.tenantId, openCharges: 1, overdueCharges: 1, balanceCents: 100_000 });
    expect((await listAccounts({ view: "debt", q: S.slug })).rows).toEqual([]);
  });

  it("[PL-3] listado: plan y estado de la suscripción filtran en el server; «vencidas» pisa el estado", async () => {
    await db.tenant.update({ where: { id: A.tenantId }, data: { saasPlan: "CLINICA", subscriptionStatus: "ACTIVE" } });
    const ids = async (f: Parameters<typeof listAccounts>[0]) => (await listAccounts(f)).rows.map((r) => r.tenantId);
    expect(await ids({ q: A.slug, plan: "CLINICA" })).toEqual([A.tenantId]);
    expect(await ids({ q: A.slug, plan: "INDIVIDUAL" })).toEqual([]);
    expect(await ids({ q: A.slug, subscriptionStatus: "ACTIVE" })).toEqual([A.tenantId]);
    expect(await ids({ q: A.slug, subscriptionStatus: "TRIALING" })).toEqual([]);
    expect(await ids({ q: A.slug, plan: "CLINICA", subscriptionStatus: "ACTIVE" })).toEqual([A.tenantId]);
    // La vista «vencidas» manda sobre el estado elegido: ACTIVE no es PAST_DUE.
    expect(await ids({ q: A.slug, view: "past_due", subscriptionStatus: "ACTIVE" })).toEqual([]);
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "PAST_DUE" } });
    expect(await ids({ q: A.slug, view: "past_due", subscriptionStatus: "ACTIVE" })).toEqual([A.tenantId]);
    // Sin filtros, el otro consultorio (S) también aparece: el filtro no es un efecto de la búsqueda.
    expect(await ids({ q: S.slug })).toEqual([S.tenantId]);
  });
});
