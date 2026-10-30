import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { arAt, arDay } from "./support/cf";
import { readFixture } from "./support/fixture";

/**
 * CF-E2E (§28, CF-LOCK): «Bloquear días» con «Hasta el día» bloquea un rango (vacaciones, licencias). Del día 20 al 22
 * desde hoy en el consultorio de siempre: lejos de los turnos y de la ventana del turnero que miran los otros specs.
 * Los bordes (31 días, domingos, reuso, turnos afectados) los cubre la integración; acá, el camino de pantalla y que
 * la agenda muestre los TRES días bloqueados (y el siguiente abierto).
 */
test("[CF-E2E] «Bloquear días» con «Hasta el día» a 3 días: los 3 quedan bloqueados en la agenda", async ({ page }) => {
  const fx = readFixture();
  const days = [arDay(20), arDay(21), arDay(22)];
  const after = arDay(23);
  const db = ownerClient();
  const blocksInRange = () =>
    db.timeBlock.findMany({
      where: { tenantId: fx.tenantId, deletedAt: null, allDay: true, startsAt: { gte: arAt(days[0], 0), lt: arAt(after, 0) } },
      select: { startsAt: true, groupId: true },
    });
  try {
    expect(await blocksInRange()).toEqual([]);

    await page.goto(`/agenda?view=timeline&date=${days[0]}`);
    await page.getByRole("button", { name: "Bloquear días" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Bloquear el día" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Todo el día" })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByLabel("Hasta el día (opcional)").fill(days[2]);
    await dialog.getByRole("button", { name: "Bloquear 3 días" }).click();
    // Sin turnos debajo se aplica directo (sin el paso «Hay turnos en ese horario»). La confirmación la afirma el caso de
    // abajo; acá se espera «Listo» y se cierra con Escape: lo que se afirma es el efecto. El título del diálogo cambia
    // con el paso (`dayLockTitle`): después de aplicar ya no se llama «Bloquear el día», por eso sin nombre.
    const done = page.getByRole("dialog");
    await expect(done.getByRole("button", { name: "Listo" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(done).toBeHidden();

    // Efecto en la base: una fila de día entero por cada día del rango, con el mismo grupo (CF-LOCK D1).
    const rows = await blocksInRange();
    const dayKeys = [...new Set(rows.map((r) => new Date(r.startsAt.getTime() - 3 * 3600_000).toISOString().slice(0, 10)))].sort();
    expect(dayKeys).toEqual(days);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(rows[0].groupId).not.toBeNull();

    // Efecto en la agenda: el candado de cada día del rango dice «Día bloqueado…»; el siguiente sigue abierto.
    for (const d of days) {
      await page.goto(`/agenda?view=timeline&date=${d}`);
      await expect(page.locator("[data-lock-status]").first(), d).toHaveAttribute("data-lock-status", "locked");
      await expect(page.getByRole("button", { name: /^Día bloqueado/ }).first(), d).toBeVisible();
    }
    await page.goto(`/agenda?view=timeline&date=${after}`);
    await expect(page.getByRole("button", { name: "Bloquear días" }).first()).toBeVisible();
  } finally {
    await db.$disconnect();
  }
});

/**
 * BUG previo a CF (en `026f937`), arreglado en ZF2: después de aplicar, el diálogo volvía al paso «form» y nunca se
 * veía la confirmación («Se bloquearon 3 días…» + «Listo»). `applyDayLock` hace `revalidatePath`, el AgendaClient
 * re-renderizaba con `practitioners={ordered.map(…)}` (array nuevo) → `ctx` → `initial` nuevos → el efecto «Reset en
 * cada apertura» ponía `step = "form"`. Ahora el padre lo memoiza y el reset depende del form inicial por valor.
 */
test("[CF-E2E] tras «Bloquear 3 días» el diálogo muestra la confirmación con «Listo»", async ({ page }) => {
  const fx = readFixture();
  const days = [arDay(25), arDay(26), arDay(27)];
  await page.goto(`/agenda?view=timeline&date=${days[0]}`);
  await page.getByRole("button", { name: "Bloquear días" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hasta el día (opcional)").fill(days[2]);
  await dialog.getByRole("button", { name: "Bloquear 3 días" }).click();
  const db = ownerClient();
  try {
    // El bloqueo se aplicó (no es el bug): 3 días.
    await expect
      .poll(async () => db.timeBlock.count({ where: { tenantId: fx.tenantId, deletedAt: null, allDay: true, startsAt: { gte: arAt(days[0], 0), lt: arAt(arDay(28), 0) } } }))
      .toBeGreaterThanOrEqual(3);
  } finally {
    await db.$disconnect();
  }
  await expect(dialog.getByRole("button", { name: "Listo" })).toBeVisible({ timeout: 5_000 });
});
