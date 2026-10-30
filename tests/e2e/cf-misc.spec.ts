import { expect, test } from "@playwright/test";

/**
 * CF-E2E (§28): sueltos de pantalla de la tanda CF, con el Titular del consultorio de siempre (Individual · Kine).
 *  - `/diagnostico` muestra «Próximamente» (decisión 8 de Martin) en vez del asistente.
 *  - [CF-F] la campana vive en la barra lateral (Apariencia «Barra lateral», el default): se ve fuera del dashboard
 *    (antes solo estaba en el dashboard) y en el dashboard no aparece dos veces.
 *  - `/favicon.ico` responde 200 (antes 404: el manifest y los navegadores lo piden igual).
 */
test("[CF-E2E] /diagnostico muestra «Próximamente»", async ({ page }) => {
  await page.goto("/diagnostico");
  await expect(page).toHaveURL(/\/diagnostico$/);
  await expect(page.getByRole("heading", { level: 1, name: "Próximamente" })).toBeVisible();
  await expect(page.getByText("Estamos terminando la guía de diagnóstico.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Volver al inicio" })).toHaveAttribute("href", "/dashboard");
});

test("[CF-E2E] la campana de notificaciones está en la barra lateral, también fuera del dashboard", async ({ page }) => {
  const aside = page.getByRole("complementary", { name: "Navegación principal" });
  for (const path of ["/agenda", "/pacientes", "/dashboard"]) {
    await page.goto(path);
    await expect(aside, path).toBeVisible();
    await expect(aside.getByRole("button", { name: "Notificaciones" }), path).toBeVisible();
    // Una sola campana en la página (el dashboard tenía la suya: CF-NOT la sacó).
    await expect(page.getByRole("button", { name: "Notificaciones" }), path).toHaveCount(1);
  }
  // Abre su panel.
  await aside.getByRole("button", { name: "Notificaciones" }).click();
  await expect(page.getByRole("dialog", { name: "Notificaciones" })).toBeVisible();
});

test("[CF-E2E] /favicon.ico responde 200", async ({ request }) => {
  const r = await request.get("/favicon.ico");
  expect(r.status()).toBe(200);
  expect((await r.body()).length).toBeGreaterThan(0);
});
