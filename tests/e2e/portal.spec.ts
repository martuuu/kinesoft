import { expect, test } from "@playwright/test";
import { readFixture } from "./support/fixture";

// La paciente entra con su propia sesión, no con la del staff.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Portal del paciente. En prod se entra con magic link (o Google); el GoTrue falso no manda mails, así que la sesión se
 * consigue por el form de /login con `next=/portal` (la misma cookie `sb-…` que deja `/auth/confirm`). Lo que se prueba
 * es el portal: identidad por `Patient.userId`, sin Membership, y sus próximos turnos.
 */
test("portal: la paciente ve su consultorio y su turno de mañana", async ({ page }) => {
  const fx = readFixture();

  // Sin sesión, /portal es la pantalla de entrada (link por email).
  await page.goto("/portal");
  await expect(page.getByRole("button", { name: "Mandame un link para entrar" })).toBeVisible();

  await page.goto("/login?next=/portal");
  await page.getByLabel("Email").fill(fx.portal.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fx.portal.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(/\/portal/);

  await expect(page.getByText("Hola, Ana")).toBeVisible();
  await expect(page.getByText("Tenés 1 consultorio vinculado a tu cuenta.")).toBeVisible();
  await expect(page.getByText("Próximos turnos")).toBeVisible();
  await expect(page.getByText(/Consulta · .* · 45 min/)).toBeVisible();
  await expect(page.getByText("No tenés turnos próximos.")).toHaveCount(0);
});
