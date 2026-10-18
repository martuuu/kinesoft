import { expect, test } from "@playwright/test";
import { readFixture } from "./support/fixture";

// Contexto LIMPIO: este spec prueba el login, no reusa la sesión guardada por auth.setup.ts.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("login", () => {
  test("contraseña mala: vuelve al login con el error traducido y sin sesión", async ({ page }) => {
    const fx = readFixture();
    await page.goto("/login");
    await page.getByLabel("Email").fill(fx.owner.email);
    await page.getByLabel("Contraseña", { exact: true }).fill("no-es-la-clave");
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page).toHaveURL(/\/login\?error=invalid_credentials/);
    await expect(page.getByText("Email o contraseña incorrectos.")).toBeVisible();
    // Sin sesión: el workspace sigue cerrado.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("credenciales buenas: entra al workspace y la sesión sobrevive a una recarga", async ({ page }) => {
    const fx = readFixture();
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Ingresá a tu consultorio" })).toBeVisible();
    await page.getByLabel("Email").fill(fx.owner.email);
    await page.getByLabel("Contraseña", { exact: true }).fill(fx.owner.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await page.waitForURL(/\/dashboard/);
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
    // La cookie de sesión es la de supabase-js (`sb-<host>-auth-token`), puesta por el server en el POST del form.
    const cookies = await page.context().cookies();
    expect(cookies.some((c) => /^sb-.*-auth-token/.test(c.name))).toBe(true);
  });
});
