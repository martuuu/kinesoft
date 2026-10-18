import { expect, test as setup } from "@playwright/test";
import { E2E_STATE_DIR } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";

/**
 * Login del OWNER por el form REAL de /login (POST /api/auth/sign-in → `signInWithPassword` contra el GoTrue falso →
 * cookie `sb-127-auth-token`), y la sesión queda guardada para el resto de los specs (`storageState` del proyecto
 * `chromium`). El spec de login prueba aparte el camino de error y el de éxito con un contexto limpio.
 */
setup("login del owner y sesión guardada", async ({ page }) => {
  const fx = readFixture();
  await page.goto("/login");
  await page.getByLabel("Email").fill(fx.owner.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fx.owner.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(/\/dashboard/);
  await expect(page).not.toHaveURL(/\/login/);
  await page.context().storageState({ path: `${E2E_STATE_DIR}/owner.json` });
});
