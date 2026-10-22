import { expect, test, type Browser, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { E2E_STATE_DIR } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";
import { connectFakeMpViaUi, setParticularCopago, setPaymentPolicy, simulateOnFakeCheckout } from "./support/mp";

/**
 * [TP-E] Turnero con cobro online contra el Mercado Pago FALSO (`MP_CONNECT_MODE=fake`, start-server.mjs). El paciente
 * reserva a 390 px (superficie pública, mobile-first) y el staff mira la agenda en escritorio, en otro contexto.
 *
 *   - REQUIRED, valor del turno → «Pagar y reservar» → checkout del simulador → aprobado → `/ok` «¡Turno confirmado!» con
 *     comprobante → en el drawer de la agenda, «Pagado por Mercado Pago».
 *   - OPTIONAL con seña del 30 % → «Pagar ahora con Mercado Pago» → aprobado → «Seña pagada» → el staff cobra el resto
 *     en efectivo desde el drawer → «Ingresos del mes» del dashboard sube seña + resto (= el valor del turno, sin doble
 *     conteo, C-TP11).
 *
 * Datos: la cuenta del profesional se conecta por el OAuth del simulador (support/mp.ts) y la política se escribe en la
 * base local; al terminar vuelve a OFF para que `turnero.spec.ts` (reserva sin cobro, corre después) no cambie. El
 * copago de «Particular» se pone en $ 50 (= el precio de «Consulta») mientras corre: con el $ 0 de fábrica el server
 * resuelve copago $ 0 y no cobra (lo cubre el último test: el wizard avisa con el interstitial).
 *
 * `pub:submit` limita a 5 reservas cada 5' por IP (lib/public-booking.ts): este spec hace TRES y `turnero.spec.ts` una.
 * Por eso el 390 va por `test.use` y no por el proyecto `mobile-390` (que repetiría las reservas).
 */
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, hasTouch: true });
test.describe.configure({ mode: "serial" });

/** Contexto del staff (OWNER) en escritorio, con la sesión que guardó `auth.setup.ts`. */
async function staffPage(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({
    storageState: `${E2E_STATE_DIR}/owner.json`,
    viewport: { width: 1366, height: 768 },
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
  });
  return ctx.newPage();
}

/** Día AR (YYYY-MM-DD) de un instante: la agenda se abre por día de Argentina. */
const arDayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);

/** «$ 1.234,56» → 123456. */
function centsOf(text: string): number {
  const [ent, dec = ""] = text.replace(/[^\d,]/g, "").split(",");
  return Number(ent || "0") * 100 + Number((dec + "00").slice(0, 2));
}

/** Servicio → primer horario → datos. Deja el wizard en el paso «Tus datos» completo; devuelve el DNI. */
async function fillWizard(page: Page, who: { firstName: string; lastName: string }): Promise<{ dni: string; slotIso: string }> {
  const fx = readFixture();
  await page.goto(`/c/${fx.slug}/booking`);
  await expect(page.getByRole("heading", { level: 1, name: "Reservá tu turno" })).toBeVisible();
  await page.getByRole("button", { name: /Consulta/ }).click();
  await page.getByRole("button", { name: "Continuar" }).click();
  const slot = page.locator("button[data-slot-iso]").first();
  await expect(slot).toBeVisible({ timeout: 20_000 });
  const slotIso = (await slot.getAttribute("data-slot-iso"))!;
  await slot.click();
  await page.getByRole("button", { name: "Continuar" }).click();
  const dni = `E2E${Date.now().toString().slice(-7)}`;
  await page.locator("#booking-firstName").fill(who.firstName);
  await page.locator("#booking-lastName").fill(who.lastName);
  // Email ASCII: con «Rocío» en el local-part el server responde «Datos inválidos» (zod `email()`).
  await page.locator("#booking-email").fill(`turnero.${dni.toLowerCase()}@example.com`);
  await page.locator("#booking-phone").fill("1155550177");
  await page.locator("#booking-documentId").fill(dni);
  await page.locator("#booking-dateOfBirth").fill("1988-03-12");
  return { dni, slotIso };
}

async function bookingByDni(dni: string) {
  const fx = readFixture();
  const db = ownerClient();
  try {
    return await db.booking.findFirstOrThrow({
      where: { tenantId: fx.tenantId, patient: { documentId: { contains: dni.slice(3) } } },
      select: { id: true, scheduledFor: true, status: true, paymentStatus: true, copagoCents: true, copagoPaidAt: true, copagoPaymentMethod: true, patientId: true },
    });
  } finally {
    await db.$disconnect();
  }
}

/** Abre el drawer del turno en la agenda del staff (vista por profesional del día AR del turno). */
async function openDrawer(staff: Page, scheduledFor: Date, lastName: string) {
  await staff.goto(`/agenda?view=timeline&date=${arDayOf(scheduledFor)}`);
  await staff.getByRole("button", { name: new RegExp(lastName) }).first().click();
  const drawer = staff.getByRole("dialog", { name: "Turno" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.beforeAll(async ({ browser }) => {
  const staff = await staffPage(browser);
  try {
    await connectFakeMpViaUi(staff);
  } finally {
    await staff.context().close();
  }
  await setParticularCopago(5000);
});

test.afterAll(async () => {
  // `turnero.spec.ts` (después en orden alfabético) espera el turnero sin cobro y el resto de la suite, Particular en $ 0.
  await setPaymentPolicy({ mode: "OFF" });
  await setParticularCopago(0);
});

test("[TP-E] REQUIRED: el valor del turno → aprobado → «¡Turno confirmado!» con comprobante → «Pagado por Mercado Pago»", async ({ page, browser }) => {
  await setPaymentPolicy({ mode: "REQUIRED", chargeKind: "COPAGO" });
  const lastName = "Cobro Total E2E";
  const { dni } = await fillWizard(page, { firstName: "Rocío", lastName });

  // REQUIRED: sin opción, solo el aviso con el monto, y el CTA cambia.
  await expect(page.getByText(/Para confirmar el turno se paga con Mercado Pago: \$\s*50/)).toBeVisible();
  await expect(page.getByRole("radio", { name: /Reservar y pagar en el consultorio/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Pagar y reservar" }).click();

  // Checkout del simulador (mismo origen) → aprobado → back_url `/booking/<id>/ok`.
  await page.waitForURL(/\/api\/mp\/fake\/checkout\//);
  await expect(page.getByText(/\$\s*50/).first()).toBeVisible();
  await simulateOnFakeCheckout(page, "Simular pago aprobado");
  await page.waitForURL(/\/booking\/[^/]+\/ok/);
  await expect(page.getByRole("heading", { level: 1, name: "¡Turno confirmado!" })).toBeVisible();
  await expect(page.getByText("Recibimos tu pago. Abajo tenés los detalles y el comprobante.")).toBeVisible();
  await expect(page.getByText("N° de operación")).toBeVisible();
  await expect(page.getByText("Medio de pago")).toBeVisible();

  // Efecto observable: turno PAID y un cobro FULL PAID con comprobante.
  const b = await bookingByDni(dni);
  expect(b.paymentStatus).toBe("PAID");
  expect(b.status).toBe("CONFIRMED");
  const db = ownerClient();
  try {
    const charges = await db.onlineCharge.findMany({
      where: { bookingId: b.id },
      select: { origin: true, kind: true, status: true, amountCents: true, mpPaymentId: true },
    });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ origin: "TURNERO", kind: "FULL", status: "PAID", amountCents: 5000 });
    expect(charges[0].mpPaymentId).toBeTruthy();
  } finally {
    await db.$disconnect();
  }

  // Staff: el drawer del turno dice «Pagado por Mercado Pago» (sin «Cobrar»).
  const staff = await staffPage(browser);
  try {
    const drawer = await openDrawer(staff, b.scheduledFor, lastName);
    await expect(drawer.getByText("Pagado por Mercado Pago").first()).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Cobrar", exact: true })).toHaveCount(0);
  } finally {
    await staff.context().close();
  }
});

test("[TP-E] OPTIONAL con seña: «Pagar ahora» → «Seña pagada» → el resto en efectivo → Ingresos = seña + resto", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await setPaymentPolicy({ mode: "OPTIONAL", chargeKind: "PERCENT", percentBps: 3000 });

  // Ingresos del mes ANTES (el dashboard cachea 60 s con el tag del tenant; el cobro a mano lo invalida).
  const staff = await staffPage(browser);
  const revenue = staff.locator('[aria-labelledby="revenue-card-title"] .k-display');
  const readRevenue = async () => {
    await staff.goto("/dashboard");
    const mes = staff.getByRole("group", { name: "Período de los ingresos" }).getByRole("button", { name: "Mes" });
    if ((await mes.getAttribute("aria-pressed")) !== "true") await mes.click();
    await expect(staff.locator("#revenue-card-title")).toHaveText(/Ingresos del mes/);
    return centsOf((await revenue.textContent()) ?? "");
  };
  try {
    const before = await readRevenue();

    const lastName = "Seña E2E";
    const { dni } = await fillWizard(page, { firstName: "Mateo", lastName });
    // OPTIONAL: dos opciones, ninguna preseleccionada.
    const later = page.getByRole("radio", { name: /Reservar y pagar en el consultorio/ });
    const now = page.getByRole("radio", { name: /Pagar ahora con Mercado Pago/ });
    await expect(later).not.toBeChecked();
    await expect(now).not.toBeChecked();
    await expect(page.getByText(/Seña de \$\s*15/)).toBeVisible();
    await now.check();
    await expect(page.getByText("Seña a pagar ahora")).toBeVisible();
    await expect(page.getByText("Resto en el consultorio")).toBeVisible();
    await page.getByRole("button", { name: "Pagar y reservar" }).click();

    await page.waitForURL(/\/api\/mp\/fake\/checkout\//);
    await simulateOnFakeCheckout(page, "Simular pago aprobado");
    await page.waitForURL(/\/booking\/[^/]+\/ok/);
    await expect(page.getByRole("heading", { level: 1, name: "¡Turno confirmado!" })).toBeVisible();
    await expect(page.getByText("Recibimos tu seña. El resto lo pagás en el consultorio.")).toBeVisible();
    const dl = page.locator("dl");
    await expect(dl.getByText("Seña pagada").first()).toBeVisible();
    await expect(dl.getByText("Resto en el consultorio")).toBeVisible();
    await expect(dl.getByText(/\$\s*35/)).toBeVisible();

    const b = await bookingByDni(dni);
    expect(b.status).toBe("CONFIRMED");
    const db = ownerClient();
    try {
      const deposit = await db.onlineCharge.findFirstOrThrow({ where: { bookingId: b.id }, select: { kind: true, status: true, amountCents: true } });
      expect(deposit).toEqual({ kind: "DEPOSIT", status: "PAID", amountCents: 1500 });
    } finally {
      await db.$disconnect();
    }

    // Staff: drawer con la seña y lo que falta → «Cobrar» → efectivo por $ 35.
    const drawer = await openDrawer(staff, b.scheduledFor, lastName);
    await expect(drawer.getByText(/Seña pagada · \$\s*15/).first()).toBeVisible();
    await drawer.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = staff.getByRole("dialog", { name: "Registrar cobro" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Seña pagada por Mercado Pago · \$\s*15\. Se cobra lo que falta\./)).toBeVisible();
    await dialog.getByRole("radio", { name: /Efectivo/ }).check();
    await dialog.getByRole("button", { name: /Marcar pagado · \$\s*35/ }).click();
    await expect(dialog).toBeHidden();

    const db2 = ownerClient();
    try {
      await expect
        .poll(async () => (await db2.booking.findUniqueOrThrow({ where: { id: b.id }, select: { copagoPaidAt: true } })).copagoPaidAt)
        .not.toBeNull();
      const paid = await db2.booking.findUniqueOrThrow({ where: { id: b.id }, select: { copagoPaymentMethod: true, copagoCents: true } });
      expect(paid).toEqual({ copagoPaymentMethod: "CASH", copagoCents: 5000 });
    } finally {
      await db2.$disconnect();
    }

    // Ingresos del mes = antes + seña ($ 15) + resto ($ 35): el valor del turno una sola vez.
    await expect.poll(readRevenue, { timeout: 90_000, intervals: [1_000, 5_000, 10_000] }).toBe(before + 5000);
  } finally {
    await staff.context().close();
  }
});

/**
 * Hallazgo de TP-E (22-oct): con el «Particular» de fábrica ($ 0, `lib/tenant-bootstrap.ts:228`) el wizard cotiza con el
 * PRECIO del servicio (`wizardOnlinePaymentFor`, lib/public-wizard-state.ts:294) y promete «Para confirmar el turno se
 * paga con Mercado Pago: $ 50», pero el submit resuelve el copago con la precedencia de la agenda
 * (`resolvePublicCopagoCents` → lib/copago.ts:30 → Particular = $ 0), `decideOnlineCharge` no cobra
 * (lib/online-charge-logic.ts:97) y el wizard va directo a `/ok` (el interstitial de monto distinto,
 * components/booking/public-booking-wizard.tsx:329, solo salta cuando SÍ hay cobro): un turno REQUIRED queda «¡Turno
 * reservado!» sin pago. La cotización la decide Martin (cotizar con el copago de Particular, o tratar Particular $ 0 como
 * «sin precio» → precio del servicio). Mientras tanto, TP-ZF2 (A1 de T5-Z): si el wizard cotizó y el server reservó sin
 * cobrar, el wizard ya no va callado a `/ok`: muestra el interstitial «Tu turno quedó reservado» (`amountDiffers`).
 */
test("[TP-E] REQUIRED con «Particular» en $ 0: si el server no cobra lo cotizado, el wizard avisa antes del resultado", async ({ page }) => {
  await setParticularCopago(0);
  await setPaymentPolicy({ mode: "REQUIRED", chargeKind: "COPAGO" });
  await fillWizard(page, { firstName: "Ines", lastName: "Particular Cero E2E" });
  await expect(page.getByText(/Para confirmar el turno se paga con Mercado Pago/)).toBeVisible();
  await page.getByRole("button", { name: "Pagar y reservar" }).click();
  const heading = page.getByRole("heading", { level: 2, name: "Tu turno quedó reservado" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText("No hace falta pagar online: lo arreglás en el consultorio.")).toBeVisible();
  await expect(page).not.toHaveURL(/\/api\/mp\/fake\/checkout\//);
  await page.getByRole("button", { name: /Ver mi turno/ }).click();
  await page.waitForURL(/\/booking\/[^/]+\/ok/);
});
