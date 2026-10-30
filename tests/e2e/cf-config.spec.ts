import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { arDay } from "./support/cf";
import { readFixture } from "./support/fixture";

/**
 * CF-E2E (§28, decisiones 1 y 3 de Martin; M20): Configuración → General → «Reglas de la agenda» cambia el paso del
 * selector de horarios del staff, y la ficha del profesional (Profesionales → Horarios) muestra el interruptor
 * «Atiende servicios distintos a la vez», apagado por default.
 *
 * Consultorio de siempre: el paso se restaura en `afterAll` (por la base) para no cambiarle la grilla a los specs que
 * corren después (los E2E van en serie, `workers: 1`). La validación del form y el audit los cubre la integración.
 */
let restoreStep: number | null | undefined;

test.afterAll(async () => {
  if (restoreStep === undefined) return;
  const db = ownerClient();
  try {
    await db.tenant.update({ where: { id: readFixture().tenantId }, data: { agendaSlotStepMin: restoreStep } });
  } finally {
    await db.$disconnect();
  }
});

test("[CF-E2E] «Horarios de la agenda cada» 30 → el modal dice «Horarios cada 30 min»", async ({ page }) => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const before = await db.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { agendaSlotStepMin: true } });
    restoreStep = before.agendaSlotStepMin;
    // El profesional no tiene paso propio: hereda el del consultorio (si lo tuviera, el modal mostraría el suyo).
    const pr = await db.practitioner.findUniqueOrThrow({ where: { id: fx.practitionerId }, select: { agendaSlotStepMin: true } });
    expect(pr.agendaSlotStepMin).toBeNull();

    await page.goto("/configuracion?tab=general");
    const card = page.locator("[data-agenda-rules-card]");
    await expect(card.getByText("Reglas de la agenda", { exact: true })).toBeVisible();
    const step = card.getByLabel("Horarios de la agenda cada");
    await step.selectOption("30");
    await expect(step).toHaveValue("30");
    await card.getByRole("button", { name: "Guardar reglas" }).click();
    await expect(card.getByRole("status")).toHaveText("Reglas guardadas.");
    await expect
      .poll(async () => (await db.tenant.findUniqueOrThrow({ where: { id: fx.tenantId }, select: { agendaSlotStepMin: true } })).agendaSlotStepMin)
      .toBe(30);

    const day = arDay(12);
    await page.goto(`/agenda?view=timeline&date=${day}`);
    await page.getByRole("button", { name: "Nuevo turno", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Nuevo turno" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Profesional").selectOption(fx.practitionerId);
    await dialog.getByLabel("Servicio").selectOption(fx.serviceId);
    await expect(dialog.getByText("Horarios cada 30 min", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByText("Horarios cada 15 min", { exact: true })).toHaveCount(0);
  } finally {
    await db.$disconnect();
  }
});

test("[CF-E2E] Profesionales → Horarios: «Atiende servicios distintos a la vez» está y nace apagado", async ({ page }) => {
  await page.goto("/configuracion?tab=profesionales");
  const editor = page.locator("[data-agenda-rules-editor]");
  await expect(editor).toBeVisible();
  const sw = editor.getByRole("switch", { name: "Atiende servicios distintos a la vez" });
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute("aria-checked", "false");
});
