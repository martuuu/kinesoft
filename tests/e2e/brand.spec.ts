import { expect, test, type Locator, type Page } from "@playwright/test";
import { BRAND_NAME, BRAND_SHORT_NAME } from "../../lib/brand";

/**
 * PV Q5 · BR-Z: la marca nueva por la UI real (server de E2E = `next build && next start`).
 *  - landing y login: la pestaña dice la marca (una sola vez: el template del root más un título que ya la traía la
 *    duplicaba, ver [BR-6]) y se ve el wordmark;
 *  - `/manifest.webmanifest`: `short_name` corto (lo que el SO pone debajo del ícono);
 *  - el wordmark nuevo es ~2× el viejo: a 360 px la barra móvil y el menú lateral (Drawer «Más», el mismo cuerpo
 *    que el sidebar) no desbordan; en escritorio el sidebar expandido tampoco; la topbar lleva solo la baldosa.
 */

const LOGO_PATH = 'path[d="M30.88 14.17 A12 12 0 1 0 30.88 33.83"]';
const OLD_BRAND = /KineSoft|Kinesoft/;

/** Mide el logo (raíz de `KineLogo` = abuelo del path) contra su contenedor y el viewport. */
async function logoFits(scope: Locator) {
  const path = scope.locator(LOGO_PATH).first();
  await expect(path).toBeVisible();
  return path.evaluate((el) => {
    const logo = el.closest("svg")!.parentElement!.parentElement!;
    const box = logo.parentElement!;
    const r = logo.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      text: (logo.textContent ?? "").trim(),
      boxScroll: box.scrollWidth,
      boxClient: box.clientWidth,
      logoRight: Math.round(r.right),
      boxRight: Math.round(b.right),
      vw: window.innerWidth,
      docScroll: document.documentElement.scrollWidth,
    };
  });
}

function expectNoOverflow(m: Awaited<ReturnType<typeof logoFits>>) {
  expect(m.boxScroll, JSON.stringify(m)).toBeLessThanOrEqual(m.boxClient);
  expect(m.logoRight, JSON.stringify(m)).toBeLessThanOrEqual(m.boxRight + 1);
  expect(m.logoRight, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
  expect(m.docScroll, JSON.stringify(m)).toBeLessThanOrEqual(m.vw);
}

async function setChrome(page: Page, tweaks: Record<string, unknown>) {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("kinesoft:tweaks", JSON.stringify(t));
    } catch {
      /* sin storage: queda el default */
    }
  }, tweaks);
}

test.describe("marca pública", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("landing: pestaña y wordmark con la marca, nada de la vieja", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(new RegExp(`^${BRAND_NAME} — `));
    const logo = page.getByRole("link", { name: `${BRAND_NAME}, inicio` }).first();
    await expect(logo).toBeVisible();
    await expect(logo).toContainText(BRAND_NAME);
    await expect(page.locator("body")).not.toContainText(OLD_BRAND);
  });

  test("login: pestaña «Ingresá a <marca>» (sin la marca repetida) y wordmark en dos palabras", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(`Ingresá a ${BRAND_NAME}`);
    const logo = page.getByRole("link", { name: `${BRAND_NAME}, inicio` }).first();
    await expect(logo).toBeVisible();
    await expect(logo).toHaveText(BRAND_NAME);
    await expect(page.locator("body")).not.toContainText(OLD_BRAND);
  });

  test("una página con template: «Recuperar contraseña · <marca>», una sola vez", async ({ page }) => {
    await page.goto("/forgot");
    await expect(page).toHaveTitle(`Recuperar contraseña · ${BRAND_NAME}`);
  });

  test("manifest: name = marca, short_name corto", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const m = (await res.json()) as { name: string; short_name: string };
    expect(m.name).toBe(BRAND_NAME);
    expect(m.short_name).toBe(BRAND_SHORT_NAME);
    expect(m.short_name.length).toBeLessThanOrEqual(12);
  });
});

test.describe("marca en el workspace", () => {
  test("escritorio, sidebar expandido: wordmark completo y sin desborde", async ({ page }) => {
    await setChrome(page, { dashChrome: "sidebar", sidebarCollapsed: false });
    await page.goto("/dashboard");
    const aside = page.locator('aside[aria-label="Navegación principal"]');
    await expect(aside).toBeVisible();
    // Las preferencias se hidratan en un efecto después del montaje: esperar al ancho expandido.
    await expect(aside).toHaveAttribute("style", /width: 232px/);
    const m = await logoFits(aside);
    expect(m.text).toBe(BRAND_NAME);
    expectNoOverflow(m);
    await expect(page).toHaveTitle(new RegExp(`· ${BRAND_NAME}$`));
    expect((await page.title()).split(BRAND_NAME).length - 1).toBe(1);
  });

  test("escritorio, topbar: solo la baldosa (markOnly, sin texto)", async ({ page }) => {
    await setChrome(page, { dashChrome: "topbar" });
    await page.goto("/dashboard");
    const header = page.locator("header.k-glass").filter({ has: page.locator('nav a[href="/agenda"]') }).first();
    await expect(header).toBeVisible();
    const m = await logoFits(header);
    expect(m.text).toBe("");
  });

  test.describe("a 360 px", () => {
    test.use({ viewport: { width: 360, height: 760 }, hasTouch: true });

    test("MobileBar: wordmark entero y sin overflow horizontal", async ({ page }) => {
      await page.goto("/dashboard");
      const bar = page.locator("header[data-mobile-bar]");
      await expect(bar).toBeVisible();
      const m = await logoFits(bar);
      expect(m.text).toBe(BRAND_NAME);
      expectNoOverflow(m);
      const barBox = await bar.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(barBox.scroll).toBeLessThanOrEqual(barBox.client);
    });

    test("menú «Más» (cuerpo del sidebar): wordmark sin desborde", async ({ page }) => {
      await page.goto("/dashboard");
      await page.locator("nav[data-k-bottom-nav]").getByRole("button", { name: "Más" }).click();
      const dialog = page.getByRole("dialog", { name: "Menú" });
      await expect(dialog).toBeVisible();
      // El Drawer entra deslizándose desde la derecha: se mide cuando terminó de entrar (su borde derecho en pantalla).
      await expect.poll(async () => (await logoFits(dialog)).boxRight).toBeLessThanOrEqual(360);
      const m = await logoFits(dialog);
      expect(m.text).toBe(BRAND_NAME);
      expectNoOverflow(m);
    });
  });
});
