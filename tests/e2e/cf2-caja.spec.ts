import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { arsRe, CF2_OWNER_NAME, CF2_PRO_NAME, createCf2Tenant, deleteCf2Tenant, type Cf2Tenant } from "./support/cf2";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF2-E2E (§29.3 P «Caja»; D-CF2-16, D-CF2-17, D-CF2-18) · la Secretaria ve «Caja» en el menú (con cobros online
 * apagados también: `navFor` ya no lo esconde) y `/caja` con lo cobrado HOY por profesional, sin obra social ni Mes. El
 * Inicio le muestra la tarjeta «Cobrado hoy». Fixture (`support/cf2.ts`): Martín cobró $70 hoy (Transferencia) y
 * destina el 50 % de copagos y online a Laura → Destina $35 / Recibe $35.
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

test("[CF2-E2E] Secretaria: «Caja» en el menú, «Cobrado hoy» en el Inicio y /caja con el total del día", async ({ browser }) => {
  const f = fx!;
  const s = await loginAs(browser, f.assistant);
  try {
    await s.page.goto("/dashboard");
    const nav = s.page.getByRole("complementary", { name: "Navegación principal" }).getByRole("navigation", { name: "Secciones" });
    const cajaLink = nav.getByRole("link", { name: "Caja" });
    await expect(cajaLink).toBeVisible();
    await expect(cajaLink).toHaveAttribute("href", "/caja");

    // Inicio: tarjeta «Cobrado hoy» (copagos + online, sin OS) con la fila de Martín y el reparto.
    // `Card` es un div (sin rol de región): se ubica por su título.
    const card = s.page.locator('[aria-labelledby="dash-cash-today-title"]');
    await expect(card.getByRole("heading", { name: "Cobrado hoy" })).toBeVisible();
    const proItem = card.getByRole("listitem").filter({ hasText: CF2_PRO_NAME });
    await expect(proItem).toContainText(arsRe(f.paid.copagoCents));
    await expect(proItem).toContainText(/Destina\s*\$\s*35 a Laura Pérez/);
    await expect(card).toContainText(/Total del día\s*\$\s*70/);

    await cajaLink.click();
    await expect(s.page).toHaveURL(/\/caja(\?|$)/);
    await expect(s.page.getByRole("heading", { level: 1, name: "Caja" })).toBeVisible();
    // La Secretaria siempre ve HOY y sin navegación de período (D-CF2-16).
    await expect(s.page.getByRole("heading", { level: 2, name: /^Hoy, / })).toBeVisible();
    await expect(s.page.getByRole("link", { name: /^(Día|Mes) (anterior|siguiente)$/ })).toHaveCount(0);

    const table = s.page.getByRole("table", { name: "Cobrado por profesional" });
    await expect(table).toBeVisible();
    // Sin columna de obra social para la Secretaria.
    const heads = (await table.locator("thead th").allTextContents()).map((t) => t.trim());
    expect(heads[0]).toBe("Profesional");
    expect(heads).toEqual(expect.arrayContaining(["Total", "Destina", "Recibe", "Neto"]));
    expect(heads.some((h) => /obra social|^OS$/i.test(h))).toBe(false);

    // Por el encabezado de fila: la de Laura también nombra a Martín («Recibe … de Martín Gómez»).
    const rowOf = (name: string) => table.locator("tbody tr").filter({ has: s.page.getByRole("rowheader", { name: new RegExp(`^${name}`) }) });
    const proRow = rowOf(CF2_PRO_NAME);
    await expect(proRow.locator('td[data-label="Total"]')).toHaveText(arsRe(f.paid.copagoCents));
    await expect(proRow.locator('td[data-label="Destina"]')).toContainText(/\$\s*35/);
    await expect(proRow.locator('td[data-label="Neto"]')).toHaveText(/\$\s*35/);
    const ownerRow = rowOf(CF2_OWNER_NAME);
    await expect(ownerRow.locator('td[data-label="Recibe"]')).toContainText(/\$\s*35/);
    await expect(table.locator("tfoot")).toContainText(arsRe(f.paid.copagoCents));

    // `?vista=mes` no le abre el Mes a la Secretaria: sigue en hoy.
    await s.page.goto("/caja?vista=mes");
    await expect(s.page.getByRole("heading", { level: 2, name: /^Hoy, / })).toBeVisible();
  } finally {
    await s.ctx.close();
  }
});
