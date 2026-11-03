import { expect, test, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { CF2_PRO_NAME, createCf2Tenant, deleteCf2Tenant, type Cf2Tenant } from "./support/cf2";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF2-E2E (§29.3 A; D-CF2-1, D-CF2-2, D-CF2-6, D-CF2-7) · la agenda de la Secretaria en un consultorio con dos
 * profesionales (`support/cf2.ts`):
 *  1. El título dice de QUIÉN es la agenda: «Todos los profesionales (2)»; elegir un chip lo cambia a «Agenda de X», y
 *     la selección se recuerda por usuario (`agendaPrefs.selectedPractitionerIds`, debounce de 800 ms): `/agenda` sin
 *     `?pros=` vuelve con ella.
 *  2. Semana tiene UN encabezado (la tira `columns` con el candado de cada día) y el clic en un día abre el Día.
 *  3. «Mes» muestra la grilla y el clic en un día va al Día.
 */
let fx: Cf2Tenant | null = null;

test.beforeAll(async () => {
  const db = ownerClient();
  try {
    fx = await createCf2Tenant(db);
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = ownerClient();
  try {
    await deleteCf2Tenant(db, fx);
  } finally {
    await db.$disconnect();
  }
});

test.beforeEach(async ({ context }) => {
  await blockExternal(context);
});

const heading = (page: Page) => page.getByRole("heading", { level: 1 });

test("[CF2-E2E] Secretaria: «Todos los profesionales (2)» → elige uno → «Agenda de …» y la selección sobrevive a /agenda", async ({ browser }) => {
  const s = await loginAs(browser, fx!.assistant);
  const db = ownerClient();
  try {
    await s.page.goto(`/agenda?view=timeline&date=${fx!.today}`);
    await expect(heading(s.page)).toHaveText("Todos los profesionales (2)");
    const chips = s.page.getByRole("group", { name: "Profesionales a mostrar" });
    await expect(chips).toBeVisible();
    await chips.getByRole("button", { name: new RegExp(`^${CF2_PRO_NAME},`) }).click();
    await expect(heading(s.page)).toHaveText(`Agenda de ${CF2_PRO_NAME}`);
    await expect(s.page).toHaveURL(new RegExp(`pros=${fx!.pro.practitionerId}`));

    // Se guarda con debounce (800 ms) por clic: se espera la fila antes de recargar sin `?pros=`.
    await expect
      .poll(async () => {
        const row = await db.userPreferences.findUnique({ where: { userId: fx!.assistant.id }, select: { agendaPrefs: true } });
        return (row?.agendaPrefs as { selectedPractitionerIds?: string[] } | null)?.selectedPractitionerIds ?? null;
      })
      .toEqual([fx!.pro.practitionerId]);

    await s.page.goto("/agenda");
    await expect(heading(s.page)).toHaveText(`Agenda de ${CF2_PRO_NAME}`);
    await expect(chips.getByRole("button", { name: new RegExp(`^${CF2_PRO_NAME},`) })).toHaveAttribute("aria-pressed", "true");

    // Volver a «Todos» también se recuerda (`[]` guardado = eligió Todos).
    await chips.getByRole("button", { name: /^Todos los profesionales,/ }).click();
    await expect(heading(s.page)).toHaveText("Todos los profesionales (2)");
    await expect
      .poll(async () => {
        const row = await db.userPreferences.findUnique({ where: { userId: fx!.assistant.id }, select: { agendaPrefs: true } });
        return (row?.agendaPrefs as { selectedPractitionerIds?: string[] } | null)?.selectedPractitionerIds ?? null;
      })
      .toEqual([]);
  } finally {
    await db.$disconnect();
    await s.ctx.close();
  }
});

test("[CF2-E2E] Semana: un solo encabezado, con el candado en la tira; clic en un día abre el Día", async ({ browser }) => {
  const s = await loginAs(browser, fx!.assistant);
  try {
    await s.page.goto(`/agenda?view=week&date=${fx!.today}`);
    const header = s.page.locator("[data-week-header]");
    await expect(header).toHaveCount(1);
    await expect(header).toBeVisible();
    // La tira de afuera (variante `picker`, la de Día/Lista) no está: el único encabezado de días es el de la grilla.
    await expect(s.page.locator("button[data-strip-day]:visible")).not.toHaveCount(0);
    const pickerDays = s.page.locator("button:not([data-strip-day]):visible").filter({ hasText: /^\s*(lun|mar|mié|jue|vie|sáb|dom)\s*\d{1,2}\b/ });
    await expect(pickerDays).toHaveCount(0);
    // Candado (la Secretaria tiene `agenda.manageBlocks`): hermano del botón del día, adentro de la tira (no botón en botón).
    await expect(header.locator("[data-lock-status]").first()).toBeVisible();
    await expect(header.locator("button[data-strip-day] button")).toHaveCount(0);

    const day = header.locator("button[data-strip-day]").first();
    const key = await day.getAttribute("data-day-key");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await day.click();
    await expect(s.page).toHaveURL(new RegExp(`date=${key}`));
    await expect(s.page).not.toHaveURL(/view=week/);
    await expect(s.page.locator("[data-week-header]")).toHaveCount(0);
  } finally {
    await s.ctx.close();
  }
});

test("[CF2-E2E] Mes: el segmento muestra la grilla del mes y el clic en un día va al Día", async ({ browser }) => {
  const s = await loginAs(browser, fx!.assistant);
  try {
    await s.page.goto(`/agenda?view=timeline&date=${fx!.today}`);
    await s.page.getByRole("group", { name: "Vista de la agenda" }).getByRole("button", { name: "Mes", exact: true }).click();
    await expect(s.page).toHaveURL(/view=month/);
    const grid = s.page.locator("[data-month-grid]");
    await expect(grid).toBeVisible({ timeout: 20_000 });
    // Hoy tiene los turnos del fixture (dos de Martín: 09:00 y 10:00) contados en la celda.
    const todayCell = grid.locator(`button[data-day-key="${fx!.today}"]`);
    if ((await todayCell.count()) > 0 && (await todayCell.isVisible())) {
      await expect(todayCell.locator("[data-month-count]")).toHaveAttribute("data-month-count", "2");
    }

    const cell = grid.locator('button[data-in-month="true"]').first();
    const key = await cell.getAttribute("data-day-key");
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await cell.click();
    await expect(s.page).toHaveURL(new RegExp(`date=${key}`));
    await expect(s.page).not.toHaveURL(/view=month/);
    await expect(s.page.locator("[data-month-grid]")).toHaveCount(0);
  } finally {
    await s.ctx.close();
  }
});
