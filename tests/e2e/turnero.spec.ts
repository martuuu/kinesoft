import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

// Superficie pública: sin sesión del staff.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * TP-0 + TP-1s/TP-1u: el turnero reserva SIN cobro (`TURNERO_CHECKOUT=off`, lo fija start-server.mjs) y muestra los
 * horarios en una ventana de 5 días. Con un solo profesional el paso «Profesional» se saltea.
 *
 * Ojo: `pub:submit` es 5 reservas cada 5' por IP (lib/public-booking.ts): este spec hace UNA sola reserva a propósito.
 */
test("turnero público: ventana de 5 días, reserva sin cobro y «¡Turno reservado!»", async ({ page }) => {
  const fx = readFixture();
  await page.goto(`/c/${fx.slug}/booking`);
  await expect(page.getByRole("heading", { level: 1, name: "Reservá tu turno" })).toBeVisible();

  // Servicio
  await expect(page.getByRole("heading", { name: "¿Qué servicio necesitás?" })).toBeVisible();
  await page.getByRole("button", { name: /Consulta/ }).click();
  await page.getByRole("button", { name: "Continuar" }).click();

  // Fecha y hora: ventana de 5 días (un <section> con h3 por día).
  await expect(page.getByRole("heading", { name: "Elegí día y horario" })).toBeVisible();
  const slots = page.locator("button[data-slot-iso]");
  await expect(slots.first()).toBeVisible({ timeout: 20_000 });
  const dayHeadings = page.getByRole("heading", { level: 3 }).filter({ hasText: / · (\d+ horarios?|Completo)$/ });
  await expect(dayHeadings).toHaveCount(5);
  const firstRange = await dayHeadings.first().textContent();
  // «Siguientes ›» corre la ventana; «‹ Anteriores» vuelve a la primera.
  await page.getByRole("button", { name: "Siguientes ›" }).click();
  await expect(dayHeadings.first()).not.toHaveText(firstRange ?? "");
  await expect(dayHeadings).toHaveCount(5);
  await page.getByRole("button", { name: "‹ Anteriores" }).click();
  await expect(dayHeadings.first()).toHaveText(firstRange ?? "");

  const slot = slots.first();
  const slotIso = await slot.getAttribute("data-slot-iso");
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continuar" }).click();

  // Tus datos
  const dni = `E2E${Date.now().toString().slice(-7)}`;
  await page.locator("#booking-firstName").fill("Paula");
  await page.locator("#booking-lastName").fill("Turnero E2E");
  await page.locator("#booking-email").fill(`paula.${dni.toLowerCase()}@example.com`);
  await page.locator("#booking-phone").fill("1155550199");
  await page.locator("#booking-documentId").fill(dni);
  await page.locator("#booking-dateOfBirth").fill("1990-05-04");
  // CF-FORM: el «diagnóstico» es obligatorio según la vertical (Kine #booking-title; General #booking-notes).
  if (await page.locator("#booking-title").count()) await page.locator("#booking-title").fill("Lumbalgia");
  else await page.locator("#booking-notes").fill("Control");
  await page.getByRole("button", { name: "Confirmar turno" }).click();

  await page.waitForURL(/\/booking\/[^/]+\/ok/);
  await expect(page.getByRole("heading", { level: 1, name: "¡Turno reservado!" })).toBeVisible();
  await expect(page.getByText("Te esperamos. El pago lo hacés en el consultorio.")).toBeVisible();

  // Efecto observable: el turno quedó en la base, en el horario elegido y sin pago.
  const db = ownerClient();
  try {
    const booking = await db.booking.findFirst({
      where: { tenantId: fx.tenantId, scheduledFor: new Date(slotIso!), patient: { documentId: { contains: dni.slice(3) } } },
      select: { status: true, paymentStatus: true, practitionerId: true },
    });
    expect(booking).not.toBeNull();
    expect(booking!.practitionerId).toBe(fx.practitionerId);
    expect(booking!.paymentStatus).toBe("UNPAID");
    expect(booking!.status).not.toBe("CANCELLED");
  } finally {
    await db.$disconnect();
  }
});
