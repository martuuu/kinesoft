import { expect, test, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

/**
 * Turno de HOY (día AR) de Lucía a las 18:00, armado en el global-setup. En un tenant INDIVIDUAL la vista Recepción y
 * /sala no están (módulo `salaEspera`, solo Clínica/Libre: lib/tenant-modules.ts): «Llegó» vive en el drawer del turno.
 */
async function openTodayBooking(page: Page) {
  const fx = readFixture();
  await page.goto(`/agenda?view=timeline&date=${fx.today}`);
  await page.getByRole("button", { name: new RegExp(fx.patient.lastName) }).first().click();
  const drawer = page.getByRole("dialog", { name: "Turno" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("Recepción: «Llegó» marca la llegada del turno de hoy", async ({ page }) => {
  const fx = readFixture();
  const drawer = await openTodayBooking(page);
  await drawer.getByRole("group", { name: "Recepción" }).getByRole("button", { name: "Llegó" }).click();
  await expect(page.getByText(`Marcaste la llegada de ${fx.patient.firstName}`)).toBeVisible();

  const db = ownerClient();
  try {
    await expect
      .poll(async () => (await db.booking.findUniqueOrThrow({ where: { id: fx.todayBookingId }, select: { arrivedAt: true } })).arrivedAt)
      .not.toBeNull();
  } finally {
    await db.$disconnect();
  }
});

test("WhatsApp manual: el link de compartir abre wa.me con el recordatorio del turno", async ({ page }) => {
  const fx = readFixture();
  const drawer = await openTodayBooking(page);
  const link = drawer.getByRole("link", { name: "Compartir por WhatsApp" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("href", /^https:\/\/wa\.me\/\d*\?text=/);
  const url = new URL((await link.getAttribute("href")) ?? "");
  const text = url.searchParams.get("text") ?? "";
  expect(text).toContain(`Hola ${fx.patient.firstName}`);
  expect(text).toContain(fx.serviceName);
  // Hora de Argentina en el texto aunque el server corra en UTC.
  expect(text).toContain("18:00");
});

// WA-0 (§21.6, 279d4a2): el link va al celular del paciente normalizado a E.164 (`getPatientShareContact` +
// `normalizeArMobile`). Antes de WA-0 salía sin destinatario.
test("WhatsApp manual: el link lleva el celular normalizado del paciente", async ({ page }) => {
  const fx = readFixture();
  const drawer = await openTodayBooking(page);
  const link = drawer.getByRole("link", { name: "Compartir por WhatsApp" });
  // El teléfono se busca aparte: mientras tanto el link está aria-disabled.
  await expect(link).toHaveAttribute("href", new RegExp(`^https://wa\\.me/${fx.patient.phone.replace(/\D/g, "")}\\?text=`));
  await expect(link).not.toHaveAttribute("aria-disabled", "true");
});
