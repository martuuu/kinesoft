import { expect, test, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

/** Instante de `day` a las `hh:mm` de Argentina (UTC−3 fijo). */
const arAt = (day: string, hh: number, mm = 0) =>
  new Date(`${day}T${String(hh + 3).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);

async function fillNewBooking(page: Page, o: { serviceId: string; patientQuery: string; patientName: RegExp; day: string; hh: string }) {
  const fx = readFixture();
  await page.goto(`/agenda?view=timeline&date=${o.day}`);
  await page.getByRole("button", { name: "Nuevo turno", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Nuevo turno" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Profesional").selectOption(fx.practitionerId);
  await dialog.getByLabel("Servicio").selectOption(o.serviceId);
  await dialog.getByRole("combobox", { name: "Buscar paciente" }).fill(o.patientQuery);
  await dialog.getByRole("option", { name: o.patientName }).first().click();
  await dialog.locator('input[type="date"]').first().fill(o.day);
  await dialog.getByLabel("Hora", { exact: true }).selectOption(o.hh);
  await dialog.getByLabel("Minutos", { exact: true }).selectOption("00");
  return dialog;
}

test.describe("agenda", () => {
  test("turno nuevo y conflicto de cupo: el segundo turno a la misma hora no entra sin forzar", async ({ page }) => {
    const fx = readFixture();
    const day = fx.moveDay; // mañana (AR)
    const at = arAt(day, 11);

    const first = await fillNewBooking(page, {
      serviceId: fx.cappedService.id,
      patientQuery: fx.patient.lastName,
      patientName: new RegExp(fx.patient.lastName),
      day,
      hh: "11",
    });
    await first.getByRole("button", { name: "Crear turno" }).click();
    await expect(page.getByText("Turno creado")).toBeVisible();
    await expect(first).toBeHidden();

    const second = await fillNewBooking(page, {
      serviceId: fx.cappedService.id,
      patientQuery: fx.conflictPatient.lastName,
      patientName: new RegExp(fx.conflictPatient.lastName),
      day,
      hh: "11",
    });
    await second.getByRole("button", { name: "Crear turno" }).click();
    await expect(second.getByText(/ya tiene un turno en ese horario/)).toBeVisible();
    await expect(second.getByRole("button", { name: "Forzar sobreturno" })).toBeVisible();
    await second.getByRole("button", { name: "Volver atrás" }).click();

    const db = ownerClient();
    try {
      const rows = await db.booking.findMany({
        where: { tenantId: fx.tenantId, scheduledFor: at, serviceId: fx.cappedService.id, status: { not: "CANCELLED" } },
        select: { patientId: true, isOverbooked: true },
      });
      expect(rows).toEqual([{ patientId: fx.patient.id, isOverbooked: false }]);
    } finally {
      await db.$disconnect();
    }
  });

  test("mover turno: «Reprogramar» lo pasa de las 09:00 a las 15:00 del mismo día", async ({ page }) => {
    const fx = readFixture();
    await page.goto(`/agenda?view=timeline&date=${fx.moveDay}`);
    await page.getByRole("button", { name: new RegExp(fx.movePatient.lastName) }).first().click();
    const drawer = page.getByRole("dialog", { name: "Turno" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Reprogramar" }).click();
    await drawer.locator('input[type="date"]').first().fill(fx.moveDay);
    await drawer.getByLabel("Hora", { exact: true }).selectOption("15");
    await drawer.getByLabel("Minutos", { exact: true }).selectOption("00");
    await drawer.getByRole("button", { name: "Guardar nuevo horario" }).click();
    await expect(drawer).toBeHidden();

    const db = ownerClient();
    try {
      await expect
        .poll(async () => (await db.booking.findUniqueOrThrow({ where: { id: fx.moveBookingId }, select: { scheduledFor: true } })).scheduledFor.toISOString())
        .toBe(arAt(fx.moveDay, 15).toISOString());
    } finally {
      await db.$disconnect();
    }
    // La tarjeta se ve a la hora nueva (hora de Argentina en el browser).
    await expect(page.getByRole("button", { name: new RegExp(fx.movePatient.lastName) }).first()).toContainText("15:00");
  });
});
