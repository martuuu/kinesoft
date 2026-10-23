import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { toARDateKey } from "../../lib/datetime-ar";
import { addMonthsKey, arMidnight, dbDateFromKey, periodFor, periodStartOnOrBefore, prorate } from "../../lib/saas-billing-logic";
import { periodStartForDebit } from "../../lib/saas-mp-logic";
import { SUBSCRIPTION_COPY, dayMonthKey, planChangeBillingCopy } from "../../lib/saas-billing-view";
import { E2E_BASE_URL, E2E_STATE_DIR } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";
import { simulateOnFakeCheckout } from "./support/mp";
import {
  RECOVERY_CODES,
  enableRecoveryOnlyTwoFactor,
  expectChargeStatus,
  passTwoFactorWithRecovery,
  restoreTwoFactor,
  snapshotTenant,
  wipeSubscription,
} from "./support/subscription";

/**
 * MPS-E (T6, X8; brief §26.6 C-MPS4/C-MPS10 y la UI de Configuración → Facturación) · la suscripción del consultorio
 * contra el MP FALSO de la plataforma, de punta a punta por la UI real:
 *   1. «Cómo pagás» → «Débito automático con Mercado Pago» → email → autorizar en la página del simulador → vuelta con
 *      `debito=1` → «Débito activo»;
 *   2. «Simular débito aprobado» en el panel del simulador → el cargo del período figura «Pagado» (webhook
 *      `subscription_authorized_payment` firmado con `MP_WEBHOOK_SECRET`);
 *   3. «Pagar con Mercado Pago» de un cargo impago → aprobar en el checkout → «Recibimos tu pago…» → «Pagado»;
 *   4. «Dar de baja la suscripción» (useConfirm) → banda → «Deshacer baja»;
 *   5. subida de plan con la vista previa del proporcional («En el cargo del … se suman $…»).
 *
 * Datos (canal owner del Docker local, restaurados en `afterAll`): suscripción anclada al 4 con PRECIO A MEDIDA
 * atado a Individual (MPS-D14; los planes del Docker están en «Consultá») y el cargo OPEN del período de hoy. El cargo
 * impago del paso 3 (período anterior, vencido) se crea recién en ese paso: si existiera desde el principio, el
 * recálculo de estado del paso 2 dejaría el consultorio en PAST_DUE. El cargo del paso 2 se crea por la base y no con
 * el cron diario: el cron solo genera cargos el día 4. En el paso 5, Plataforma «acordó» un precio para Consultorio
 * (mismo efecto que `setCustomPrice(tenantId, cents, "CONSULTORIO")`): sin precio del plan destino no hay proporcional.
 * El step-up se pasa con un código de recuperación (ver `support/subscription.ts`).
 *
 * Todo lo que no sea el server local se aborta (`context.route`); el simulador vive en el mismo origen.
 */
const BASE_CENTS = 20_000_00;
const CONSULTORIO_CENTS = 35_000_00;

const today = toARDateKey(new Date());
const current = periodFor(periodStartOnOrBefore(4, today));
const previous = periodFor(addMonthsKey(current.periodStart, -1));

let ctx: BrowserContext;
let page: Page;
let chargeA = "";
let chargeB = "";
let tenantBefore: Awaited<ReturnType<typeof snapshotTenant>>;
let twoFactorBefore: { twoFactorEmail: boolean; twoFactorTotp: boolean } | null = null;
const payerEmail = `titular-e2e-${Date.now().toString(36)}@example.com`;

test.describe.configure({ mode: "serial" });
// Los días 2 y 3 un débito se imputa al período que arranca el 4 de ESE mes (débito adelantado, `periodStartForDebit`),
// no al de hoy: el paso 2 no tendría cargo al que imputarse. Fuera de esos dos días del mes la spec corre siempre.
test.skip(periodStartForDebit(today) !== current.periodStart, "días 2-3 del mes: el débito va al período siguiente");

test.beforeAll(async ({ browser }) => {
  const fx = readFixture();
  tenantBefore = await snapshotTenant();
  await wipeSubscription();
  const db = ownerClient();
  try {
    await db.tenant.update({ where: { id: fx.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    await db.saasSubscription.create({
      data: {
        tenantId: fx.tenantId,
        anchorDay: 4,
        nextChargeAt: arMidnight(current.periodEnd),
        billableFrom: dbDateFromKey(previous.periodStart),
        customPriceCents: BASE_CENTS,
        customPricePlan: "INDIVIDUAL",
      },
    });
    const a = await db.saasCharge.create({
      data: {
        tenantId: fx.tenantId,
        plan: "INDIVIDUAL",
        periodStart: dbDateFromKey(current.periodStart),
        periodEnd: dbDateFromKey(current.periodEnd),
        dueDate: dbDateFromKey(current.dueDate),
        amountCents: BASE_CENTS,
        baseAmountCents: BASE_CENTS,
      },
      select: { id: true },
    });
    chargeA = a.id;
  } finally {
    await db.$disconnect();
  }
  twoFactorBefore = await enableRecoveryOnlyTwoFactor();

  ctx = await browser.newContext({
    baseURL: E2E_BASE_URL,
    storageState: `${E2E_STATE_DIR}/owner.json`,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
    viewport: { width: 1366, height: 900 },
  });
  await ctx.route(
    (url) => url.origin !== new URL(E2E_BASE_URL).origin,
    (route) => route.abort()
  );
  page = await ctx.newPage();
});

test.afterAll(async () => {
  await ctx?.close();
  if (twoFactorBefore) await restoreTwoFactor(twoFactorBefore);
  if (tenantBefore) await wipeSubscription(tenantBefore);
});

async function openBilling() {
  await page.goto("/configuracion?tab=facturacion");
  await expect(page.getByText("Suscripción", { exact: true })).toBeVisible();
}

test("suscripción 1: débito automático autorizado en Mercado Pago → «Débito activo»", async () => {
  await page.goto("/configuracion?tab=facturacion");
  // 2FA prendida por la spec: la app pide verificar al entrar (código de recuperación → cookies de sesión y step-up).
  await passTwoFactorWithRecovery(page, RECOVERY_CODES[0]);
  await expect(page).toHaveURL(/tab=facturacion/);

  await expect(page.getByRole("heading", { name: SUBSCRIPTION_COPY.methodTitle })).toBeVisible();
  // Sin preselección (§26.6): ninguna forma de pago marcada.
  await expect(page.locator('[data-collection-method][aria-checked="true"]')).toHaveCount(0);
  await page.getByRole("radio", { name: /Débito automático con Mercado Pago/ }).click();

  const drawer = page.getByRole("dialog", { name: SUBSCRIPTION_COPY.debitDrawerTitle });
  await expect(drawer).toBeVisible();
  await drawer.getByLabel(SUBSCRIPTION_COPY.emailLabel).fill(payerEmail);
  await drawer.getByRole("button", { name: SUBSCRIPTION_COPY.continueMp }).click();

  // Página de autorización del simulador (mismo origen): «Autorizar débito (tarjeta de prueba)».
  await page.waitForURL(/\/api\/mp\/fake\/subscriptions\/checkout\?preapproval_id=/);
  await page.getByRole("button", { name: "Autorizar débito (tarjeta de prueba)" }).click();

  // Vuelta: `?tab=facturacion&debito=1&preapproval_id=…` → `refreshAutoDebit`.
  await page.waitForURL(/\/configuracion\?tab=facturacion/);
  await expect(page.locator("[data-billing-notice]")).toHaveText(SUBSCRIPTION_COPY.debitAuthorized);
  // Hallazgo MPS-E: la sección borra `debito`/`cargo`/`payment_id` con `history.replaceState`, pero la action
  // revalida y el router de Next vuelve a poner su URL (la query queda). Ver el reporte; no se afirma acá.
  const band = page.locator('[data-auto-debit="active"]');
  await expect(band).toContainText("Débito activo");
  await expect(band).toContainText(`próximo débito ${dayMonthKey(current.periodEnd)}`);
  await expect(band).not.toContainText(payerEmail); // enmascarado: el email completo no viaja al cliente

  const fx = readFixture();
  const db = ownerClient();
  try {
    const sub = await db.saasSubscription.findUniqueOrThrow({
      where: { tenantId: fx.tenantId },
      select: { collectionMethod: true, autoDebitEnabled: true, mpPreapprovalId: true, mpPreapprovalStatus: true, mpPendingPreapprovalId: true },
    });
    expect(sub).toMatchObject({ collectionMethod: "AUTO_DEBIT", autoDebitEnabled: true, mpPreapprovalStatus: "authorized", mpPendingPreapprovalId: null });
    expect(sub.mpPreapprovalId).toMatch(/^[0-9a-f]{32}$/);
  } finally {
    await db.$disconnect();
  }
});

test("suscripción 2: «Simular débito aprobado» en el simulador → el cargo del período queda Pagado", async () => {
  await openBilling();
  // Pasado el 9 el cargo del período ya figura vencido (sin pasar a PAST_DUE: el estado lo recalcula el cobro).
  await expectChargeStatus(page, chargeA, today > current.dueDate ? "Vencido" : "Pendiente");

  await page.goto("/api/mp/fake/panel");
  const card = page.locator(".card").filter({ hasText: payerEmail });
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "Simular débito aprobado" }).click();
  // El panel muestra cómo respondió el webhook de la app (firmado con el secreto de la plataforma).
  await expect(page.getByRole("status")).toContainText("respuesta 200");

  await openBilling();
  await expectChargeStatus(page, chargeA, "Pagado");

  const fx = readFixture();
  const db = ownerClient();
  try {
    const pays = await db.saasPayment.findMany({ where: { tenantId: fx.tenantId, chargeId: chargeA }, select: { status: true, amountCents: true, mpPreapprovalId: true } });
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ status: "APPROVED", amountCents: BASE_CENTS });
    expect(pays[0].mpPreapprovalId).toMatch(/^[0-9a-f]{32}$/);
  } finally {
    await db.$disconnect();
  }
});

test("suscripción 3: «Pagar con Mercado Pago» de un cargo impago → «Recibimos tu pago…» → Pagado", async () => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const b = await db.saasCharge.create({
      data: {
        tenantId: fx.tenantId,
        plan: "INDIVIDUAL",
        periodStart: dbDateFromKey(previous.periodStart),
        periodEnd: dbDateFromKey(previous.periodEnd),
        dueDate: dbDateFromKey(previous.dueDate),
        amountCents: BASE_CENTS,
        baseAmountCents: BASE_CENTS,
      },
      select: { id: true },
    });
    chargeB = b.id;
  } finally {
    await db.$disconnect();
  }

  await openBilling();
  await expectChargeStatus(page, chargeB, "Vencido");
  await page.locator(`[data-pay-mp="${chargeB}"]`).click();
  await simulateOnFakeCheckout(page, "Simular pago aprobado");

  // Vuelta `?tab=facturacion&cargo=<id>&payment_id=…` → `confirmCheckoutReturn` (re-pide el pago a MP).
  await page.waitForURL(/\/configuracion\?tab=facturacion/);
  await expect(page.locator("[data-billing-notice]")).toHaveText(SUBSCRIPTION_COPY.paymentReceived);
  await expectChargeStatus(page, chargeB, "Pagado");

  const db2 = ownerClient();
  try {
    const t = await db2.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { subscriptionStatus: true } });
    expect(t.subscriptionStatus).toBe("ACTIVE");
    const pays = await db2.saasPayment.findMany({ where: { tenantId: fx.tenantId, chargeId: chargeB }, select: { status: true, amountCents: true } });
    expect(pays).toEqual([{ status: "APPROVED", amountCents: BASE_CENTS }]);
  } finally {
    await db2.$disconnect();
  }
});

test("suscripción 4: «Dar de baja la suscripción» → banda con la fecha → «Deshacer baja»", async () => {
  await openBilling();
  await page.locator("[data-cancel-subscription]").click();
  const dialog = page.getByRole("dialog", { name: SUBSCRIPTION_COPY.cancelTitle });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: SUBSCRIPTION_COPY.cancelButton }).click();

  const band = page.locator("[data-cancel-pending]");
  await expect(band).toContainText(`tenés acceso completo hasta el ${dayMonthKey(current.periodEnd)}`);
  await expect(page.locator("[data-cancel-subscription]")).toHaveCount(0);

  const fx = readFixture();
  const read = async () => {
    const db = ownerClient();
    try {
      return await db.saasSubscription.findUniqueOrThrow({ where: { tenantId: fx.tenantId }, select: { cancelAtPeriodEnd: true, cancelEffectiveOn: true } });
    } finally {
      await db.$disconnect();
    }
  };
  expect(await read()).toEqual({ cancelAtPeriodEnd: true, cancelEffectiveOn: dbDateFromKey(current.periodEnd) });

  await band.getByRole("button", { name: SUBSCRIPTION_COPY.undoCancel }).click();
  await expect(page.getByText("Listo: deshiciste la baja.")).toBeVisible();
  await expect(band).toHaveCount(0);
  await expect(page.locator("[data-cancel-subscription]")).toBeVisible();
  expect(await read()).toEqual({ cancelAtPeriodEnd: false, cancelEffectiveOn: null });
});

test("suscripción 5: subida de plan con el proporcional en la vista previa", async () => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    await db.saasSubscription.update({ where: { tenantId: fx.tenantId }, data: { customPriceCents: CONSULTORIO_CENTS, customPricePlan: "CONSULTORIO" } });
  } finally {
    await db.$disconnect();
  }
  // Cuenta independiente (lógica pura): base del cargo de hoy (Individual) → precio de Consultorio, días AR que quedan.
  const pr = prorate({ diffCents: CONSULTORIO_CENTS - BASE_CENTS, fromKey: today, periodStart: current.periodStart, periodEnd: current.periodEnd });
  expect(pr).not.toBeNull();
  const expected = planChangeBillingCopy(
    { kind: "upgrade_prorated", effectiveOn: today, prorationCents: pr!.amountCents, days: pr!.days, periodDays: pr!.periodDays },
    { toLabel: "Consultorio", fromLabel: "Individual", trialing: false }
  );
  expect(expected).toContain(`En el cargo del ${dayMonthKey(current.periodEnd)} se suman`);

  await page.goto("/configuracion?tab=plan");
  await page.locator("[data-plan-change]").click();
  const drawer = page.getByRole("dialog", { name: "Cambiar de plan" });
  await expect(drawer).toBeVisible();
  await drawer.locator('[data-plan="CONSULTORIO"]').click();
  await expect(drawer.getByText(expected!)).toBeVisible();
  await drawer.getByRole("button", { name: "Pasar a Consultorio" }).click();
  await expect(page.getByText("Listo: ahora tenés el plan Consultorio")).toBeVisible();

  const db2 = ownerClient();
  try {
    const t = await db2.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { saasPlan: true } });
    expect(t.saasPlan).toBe("CONSULTORIO");
    const adj = await db2.saasAdjustment.findMany({ where: { tenantId: fx.tenantId, kind: "PRORATION" }, select: { amountCents: true } });
    expect(adj).toEqual([{ amountCents: pr!.amountCents }]);
  } finally {
    await db2.$disconnect();
  }
});
