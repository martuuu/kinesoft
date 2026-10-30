import { expect, test } from "@playwright/test";
import { addPatient, ownerClient, type EphemeralTenant } from "../helpers/tenant-factory";
import { arAt, arDay } from "./support/cf";
import { readFixture } from "./support/fixture";

/**
 * CF-E2E (§28, decisión 1 de Martin; M20 `allowParallelServices`): con el interruptor «Atiende servicios distintos a la
 * vez» APAGADO (el default de la base, sin backfill), el alta de un turno de OTRO servicio que se pisa con uno ya dado
 * del mismo profesional avisa «… está atendiendo «A» en ese horario.» y solo entra forzado como sobreturno.
 *
 * Consultorio de siempre (Titular del `storageState`): «Consulta» (ilimitado) es A y «Kinesio 1 a 1» es B, a 10 días
 * para no cruzarse con los turnos de mañana de `agenda.spec.ts`/`portal.spec.ts`. Las reglas de cupo por servicio y la
 * carrera las cubre la integración (`cf-*` en tests/integration); acá va el camino de pantalla: aviso, «Elegir otro
 * horario» que no crea nada y «Cargar como sobreturno» que crea y la agenda lo marca.
 */
test("[CF-E2E] otro servicio a la misma hora: aviso, «Elegir otro horario» no crea y «Cargar como sobreturno» crea un sobreturno", async ({ page }) => {
  const fx = readFixture();
  const day = arDay(10);
  const at = arAt(day, 10);
  const sfx = String(Date.now() % 1_000_000);
  const db = ownerClient();
  try {
    // Precondición: el interruptor nace apagado (si alguien lo prende en el fixture, este caso no prueba nada).
    const pr = await db.practitioner.findUniqueOrThrow({ where: { id: fx.practitionerId }, select: { allowParallelServices: true } });
    expect(pr.allowParallelServices).toBe(false);

    const t = { tenantId: fx.tenantId, practitionerId: fx.practitionerId } as EphemeralTenant;
    const holder = { firstName: "Irene", lastName: `Servicio A ${sfx}` };
    const holderId = await addPatient(db, t, holder);
    const newcomer = { firstName: "Gael", lastName: `Servicio B ${sfx}` };
    const newcomerId = await addPatient(db, t, newcomer);
    await db.booking.create({
      data: {
        tenantId: fx.tenantId,
        patientId: holderId,
        practitionerId: fx.practitionerId,
        serviceId: fx.serviceId,
        locationId: fx.locationId,
        scheduledFor: at,
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `e2e-cf-a-${sfx}-${fx.tenantId}`,
      },
    });

    await page.goto(`/agenda?view=timeline&date=${day}`);
    await page.getByRole("button", { name: "Nuevo turno", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Nuevo turno" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Profesional").selectOption(fx.practitionerId);
    await dialog.getByLabel("Servicio").selectOption(fx.cappedService.id);
    await dialog.getByRole("combobox", { name: "Buscar paciente" }).fill(newcomer.lastName);
    await dialog.getByRole("option", { name: new RegExp(newcomer.lastName) }).first().click();
    await dialog.locator('input[type="date"]').first().fill(day);
    await dialog.getByLabel("Hora", { exact: true }).selectOption("10");
    await dialog.getByLabel("Minutos", { exact: true }).selectOption("00");

    await dialog.getByRole("button", { name: "Crear turno" }).click();
    const prompt = dialog.getByRole("alert").filter({ hasText: /está atendiendo/ });
    await expect(prompt).toContainText(`está atendiendo «${fx.serviceName}» en ese horario.`);
    await expect(prompt).toContainText(`Ese turno de ${fx.serviceName} empieza a las 10:00.`);

    // «Elegir otro horario»: cierra el aviso, el modal sigue abierto y no se escribió nada.
    await prompt.getByRole("button", { name: "Elegir otro horario" }).click();
    await expect(prompt).toBeHidden();
    await expect(dialog).toBeVisible();
    const ofNewcomer = () =>
      db.booking.findMany({ where: { tenantId: fx.tenantId, patientId: newcomerId, status: { not: "CANCELLED" } }, select: { scheduledFor: true, isOverbooked: true, serviceId: true } });
    expect(await ofNewcomer()).toEqual([]);

    // Segundo intento → «Cargar como sobreturno».
    await dialog.getByRole("button", { name: "Crear turno" }).click();
    await expect(prompt).toBeVisible();
    await prompt.getByRole("button", { name: "Cargar como sobreturno" }).click();
    await expect(page.getByText("Turno creado")).toBeVisible();
    await expect(dialog).toBeHidden();

    await expect.poll(async () => (await ofNewcomer()).length).toBe(1);
    expect(await ofNewcomer()).toEqual([{ scheduledFor: at, isOverbooked: true, serviceId: fx.cappedService.id }]);

    // La agenda lo marca: badge «Sobreturno» en la tarjeta del turno nuevo, no en la del que ya estaba.
    const card = page.getByRole("button", { name: new RegExp(newcomer.lastName) }).first();
    await expect(card.locator('[data-badge="sobreturno"]')).toHaveText("Sobreturno");
    await expect(page.getByRole("button", { name: new RegExp(holder.lastName) }).first().locator('[data-badge="sobreturno"]')).toHaveCount(0);
  } finally {
    await db.$disconnect();
  }
});
