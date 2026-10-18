import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

/** Plan de tratamiento desde la ficha (pestaña «Planes»): editor → «Ver turnos» (preview) → «Crear plan y N turnos». */
test("plan: 2 sesiones los lunes a las 10:00 crean el plan y sus turnos", async ({ page }) => {
  const fx = readFixture();
  await page.goto(`/pacientes/${fx.planPatient.id}`);
  await page.getByRole("navigation", { name: "Secciones de la ficha" }).getByRole("button", { name: /^Planes/ }).click();
  await page.getByRole("button", { name: "Plan nuevo" }).click();
  const drawer = page.getByRole("dialog", { name: "Nuevo plan" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("radio", { name: "Kinesiología" }).check();
  await drawer.getByLabel("Servicio", { exact: true }).selectOption(fx.serviceId);
  await drawer.getByLabel("Profesional responsable", { exact: true }).selectOption(fx.practitionerId);
  await drawer.getByLabel("Inicio", { exact: true }).fill(fx.moveDay);
  await drawer.getByLabel("Cantidad de sesiones", { exact: true }).fill("2");
  await drawer.getByRole("button", { name: "Lunes", exact: true }).click();
  await drawer.getByLabel("Lunes: hora", { exact: true }).selectOption("10");
  await drawer.getByLabel("Lunes: minutos", { exact: true }).selectOption("00");
  await drawer.getByRole("button", { name: "Ver turnos" }).click();
  await expect(drawer.getByText("Revisá los turnos")).toBeVisible();
  await drawer.getByRole("button", { name: /^Crear plan/ }).click();
  await expect(page.getByText("Plan creado")).toBeVisible();

  const db = ownerClient();
  try {
    const programs = await db.treatmentProgram.findMany({
      where: { tenantId: fx.tenantId, patientId: fx.planPatient.id },
      select: { id: true, _count: { select: { bookings: true } } },
    });
    expect(programs).toHaveLength(1);
    expect(programs[0]._count.bookings).toBe(2);
  } finally {
    await db.$disconnect();
  }
});
