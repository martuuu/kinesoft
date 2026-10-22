import { expect, test, type Page } from "@playwright/test";
import { addPatient, ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";
import { connectFakeMpViaUi, simulateOnFakeCheckout } from "./support/mp";

/**
 * [TP-E] Link de pago sin turno contra el Mercado Pago FALSO (`MP_CONNECT_MODE=fake`, start-server.mjs):
 * perfil del paciente → Facturación → «Nuevo link de pago» $ 5.000 → el paciente lo abre en un contexto ANÓNIMO a 390 px
 * (`/pagar/<token>`, sin sesión y sin datos del paciente en el HTML) → checkout del simulador → aprobado → «¡Pago
 * recibido!» → /cobros «Pagado» → reintegro desde el simulador → «Reintegrado».
 *
 * La cuenta del profesional la conectó `mp-connect.spec.ts` (corre antes); si este spec corre solo, la conecta
 * `connectFakeMpViaUi`. Paciente propio (creado acá con la factory), para no cambiarle la Facturación a otra spec.
 */
test.describe.configure({ mode: "serial" });

test("[TP-E] link de pago: «Nuevo link de pago» $ 5.000 → /pagar a 390 → aprobado → /cobros «Pagado» → reintegro", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const fx = readFixture();
  await connectFakeMpViaUi(page);

  const person = { firstName: "Valentina", lastName: "Link E2E" };
  const db = ownerClient();
  let patientId: string;
  try {
    patientId = await addPatient(db, { tenantId: fx.tenantId, practitionerId: fx.practitionerId } as Parameters<typeof addPatient>[1], {
      ...person,
      email: "valentina.link.e2e@example.com",
    });
  } finally {
    await db.$disconnect();
  }

  // Staff: Facturación → card «Links de pago» → «Nuevo link de pago» (sin turno).
  await page.goto(`/pacientes/${patientId}`);
  await page.getByRole("navigation", { name: "Secciones del perfil del paciente" }).getByRole("button", { name: /^Facturación/ }).click();
  await page.getByRole("button", { name: "Nuevo link de pago" }).click();
  const drawer = page.getByRole("dialog", { name: "Generar link de pago" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("concept-warning")).toHaveText("No pongas datos clínicos en el concepto: lo ven el paciente y Mercado Pago.");
  await drawer.getByLabel("Profesional").selectOption(fx.practitionerId);
  await drawer.getByLabel("Monto").fill("5000");
  await drawer.getByLabel("Concepto").fill("Sesiones de octubre");
  await drawer.getByTestId("payment-link-form").getByRole("button", { name: "Generar link de pago" }).click();
  const ready = drawer.getByTestId("payment-link-ready");
  await expect(ready.getByText("Link listo")).toBeVisible();
  await expect(ready.getByText(/\$\s*5\.000 · vence el/)).toBeVisible();
  const url = await ready.getByRole("textbox", { name: "Link listo" }).inputValue();
  expect(url).toMatch(/\/pagar\/[A-Za-z0-9_-]+$/);
  await ready.getByRole("button", { name: "Listo" }).click();

  // Efecto observable: un cobro LINK FREE ACTIVE por $ 5.000 con preferencia en el simulador.
  const db2 = ownerClient();
  const charge = await db2.onlineCharge
    .findFirstOrThrow({
      where: { tenantId: fx.tenantId, patientId, origin: "LINK" },
      select: { id: true, kind: true, status: true, amountCents: true, publicToken: true, checkoutUrl: true, bookingId: true },
    })
    .finally(() => db2.$disconnect());
  expect(charge).toMatchObject({ kind: "FREE", status: "ACTIVE", amountCents: 500_000, bookingId: null });
  expect(url.endsWith(`/pagar/${charge.publicToken}`)).toBe(true);
  expect(new URL(charge.checkoutUrl!).pathname).toMatch(/^\/api\/mp\/fake\/checkout\//);

  // Paciente: contexto anónimo a 390, sin la sesión del staff.
  const anon = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
  });
  try {
    const payer: Page = await anon.newPage();
    const res = await payer.goto(new URL(url).pathname);
    expect(res?.status()).toBe(200);
    await expect(payer.getByRole("heading", { level: 1, name: "Link de pago" })).toBeVisible();
    await expect(payer.getByText(/\$\s*5\.000/).first()).toBeVisible();
    // El HTML de /pagar no trae el nombre del paciente (C-TP9: el link puede reenviarse).
    const html = await payer.content();
    expect(html).not.toContain(person.lastName);
    expect(html).not.toContain(person.firstName);
    await payer.getByRole("link", { name: /Pagar con Mercado Pago/ }).click();

    await simulateOnFakeCheckout(payer, "Simular pago aprobado");
    await payer.waitForURL(/\/pagar\/[^/?]+/);
    await expect(payer.getByRole("heading", { level: 1, name: "¡Pago recibido!" })).toBeVisible({ timeout: 30_000 });

    // Staff: /cobros dice «Pagado» en la fila del link.
    await page.goto("/cobros");
    const row = page.locator(`tr[data-charge="${charge.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("Pagado");
    await expect(row).toContainText(/\$\s*5\.000/);

    // Reintegro desde el simulador (el mismo checkout): el webhook entra por la ruta real.
    await payer.goto(charge.checkoutUrl!);
    await simulateOnFakeCheckout(payer, "Simular reintegro");
    await expect(payer.getByRole("heading", { level: 1, name: /Webhook enviado · respuesta 200/ })).toBeVisible();

    await expect
      .poll(async () => {
        const d = ownerClient();
        try {
          return (await d.onlineCharge.findUniqueOrThrow({ where: { id: charge.id }, select: { status: true } })).status;
        } finally {
          await d.$disconnect();
        }
      })
      .toBe("REFUNDED");
    await page.reload();
    await expect(page.locator(`tr[data-charge="${charge.id}"]`)).toContainText("Reintegrado");

    // Y el paciente ve el reintegro en el mismo link.
    await payer.goto(new URL(url).pathname);
    await expect(payer.getByRole("heading", { level: 1, name: "Pago reintegrado" })).toBeVisible();
  } finally {
    await anon.close();
  }
});
