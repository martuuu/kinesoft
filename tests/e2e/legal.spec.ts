import { expect, test, type Page } from "@playwright/test";
import { ownerClient, uniqueSuffix } from "../helpers/tenant-factory";
import { LEGAL_ACCEPT_ERROR, LEGAL_VERSION_LABEL } from "../../lib/legal";
import { readFixture } from "./support/fixture";
import { readPvFixture } from "./support/pv";

// Superficies públicas: sin la sesión del staff.
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * PV (§27, bloque LG, ola Q4) · legales por la UI real:
 *  - `/terminos` y `/privacidad` cargan con la versión vigente, los dos textos de la Disp. AAIP 10/2008 y los
 *    subencargados;
 *  - links a los dos documentos en el login, el turnero y el pie de la landing;
 *  - alta por email: sin la casilla el navegador no envía (`required`) y, si se fuerza el POST, el server responde
 *    `LEGAL_ACCEPT_ERROR` al lado de la casilla y no crea nada; con la casilla, el alta sigue (con el GoTrue falso el
 *    alta no llega a crear la cuenta: lo que se afirma es que la casilla ya no frena);
 *  - la activación de una invitación muestra la casilla (sin tildar, obligatoria).
 */

async function expectLegalLinks(page: Page, scope = page.locator("body")) {
  const terms = scope.locator('a[href="/terminos"]').first();
  const privacy = scope.locator('a[href="/privacidad"]').first();
  await expect(terms).toBeVisible();
  await expect(privacy).toBeVisible();
}

test.describe("legales", () => {
  test("/terminos y /privacidad: versión, textos de la AAIP y subencargados", async ({ page }) => {
    await page.goto("/terminos");
    await expect(page.getByRole("heading", { level: 1, name: /Términos y condiciones/ })).toBeVisible();
    await expect(page.getByText(LEGAL_VERSION_LABEL).first()).toBeVisible();
    await expect(page.locator("main")).toContainText("Ciudad Autónoma de Buenos Aires");

    await page.goto("/privacidad");
    await expect(page.getByRole("heading", { level: 1, name: /Política de privacidad/ })).toBeVisible();
    await expect(page.getByText(LEGAL_VERSION_LABEL).first()).toBeVisible();
    const body = page.locator("main");
    await expect(body).toContainText(
      "El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses"
    );
    await expect(body).toContainText(
      "La AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326"
    );
    for (const p of ["Supabase", "Vercel", "Upstash", "Resend", "Mercado Pago", "Sentry"]) await expect(body).toContainText(p);
    await expect(body).toContainText("kine_idle");
    // ARCO por ticket (nunca un mailto).
    await expect(body.locator('a[href="/contacto?motivo=privacidad"]').first()).toBeVisible();
    expect(await page.locator('a[href^="mailto:"]').count()).toBe(0);
  });

  test("links legales en el login, el turnero y el pie de la landing", async ({ page }) => {
    await page.goto("/login");
    await expectLegalLinks(page);

    const fx = readFixture();
    await page.goto(`/c/${fx.slug}/booking`);
    await expect(page.getByRole("heading", { level: 1, name: "Reservá tu turno" })).toBeVisible();
    await expectLegalLinks(page, page.getByRole("navigation", { name: "Legales" }));

    await page.goto("/");
    await expectLegalLinks(page, page.locator("footer").last());
  });

  test("alta por email: sin la casilla no se crea nada; con la casilla sigue", async ({ page }) => {
    const email = `pv-signup-${uniqueSuffix()}@test.local`;
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Creá tu consultorio" })).toBeVisible();
    await page.getByLabel("Nombre y apellido").fill("Alta Legal E2E");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Contraseña", { exact: true }).fill("e2e-Clave-123");
    const box = page.getByRole("checkbox", { name: /Acepto los Términos y condiciones y la Política de privacidad/ });
    await expect(box).not.toBeChecked();

    // 1) El navegador frena el envío (`required`): no hay POST y la casilla queda inválida.
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/signup") posted++;
    });
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    expect(await box.evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    await page.waitForTimeout(500);
    expect(posted).toBe(0);

    // 2) Forzando el POST sin la casilla (sin `required`, como un cliente viejo o un script): el server la exige.
    await box.evaluate((el) => (el as HTMLInputElement).removeAttribute("required"));
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    await expect(page.getByText(LEGAL_ACCEPT_ERROR)).toBeVisible();
    const box2 = page.getByRole("checkbox", { name: /Acepto los Términos/ });
    await expect(box2).toHaveAttribute("aria-invalid", "true");
    // Lo tipeado sigue (el form se vuelve a montar con los valores).
    await expect(page.getByLabel("Email")).toHaveValue(email);

    const db = ownerClient();
    try {
      expect(await db.userProfile.count({ where: { email } })).toBe(0);
    } finally {
      await db.$disconnect();
    }

    // 3) Con la casilla: el error de la casilla no vuelve (el GoTrue falso no crea cuentas: el alta termina en el
    //    «te mandamos un email» o en el error genérico del servicio de cuentas, nunca en el de la casilla).
    await page.getByLabel("Contraseña", { exact: true }).fill("e2e-Clave-123");
    await box2.check();
    await page.getByRole("button", { name: "Crear cuenta" }).click();
    await expect(page.getByText("Creando tu cuenta…")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(LEGAL_ACCEPT_ERROR)).toHaveCount(0);
  });

  test("activación de una invitación: muestra la casilla sin tildar y obligatoria", async ({ page }) => {
    const pv = readPvFixture();
    await page.goto(`/invite/${pv.idle.invite.token}`);
    await expect(page.getByRole("heading", { name: `Hola, ${pv.idle.invite.firstName}` })).toBeVisible();
    const box = page.getByRole("checkbox", { name: /Acepto los Términos y condiciones y la Política de privacidad/ });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(box).toHaveAttribute("required", "");
    // Los links de la casilla abren en pestaña nueva (no se pierde lo tipeado).
    const label = page.locator('label[for="invite-legal"]');
    await expect(label.locator('a[href="/terminos"]')).toHaveAttribute("target", "_blank");
    await expect(label.locator('a[href="/privacidad"]')).toHaveAttribute("target", "_blank");
  });
});
