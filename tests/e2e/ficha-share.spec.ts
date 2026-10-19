import { expect, test, type Browser, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture, type E2EFixture } from "./support/fixture";
import { card, cardMenu, insertNote, openHc, uid } from "./support/fichas";

/**
 * FC-E (T4) · compartir una ficha con el paciente (C-FC5/C-FC8) de punta a punta: el profesional la comparte, la
 * paciente (con portal, `Patient.userId`) la ve en «Documentos» y baja el PDF guardado; al dejar de compartir,
 * desaparece. El PDF lo sube la app al Storage en memoria del server de la suite (support/start-server.mjs).
 * Corre también a 390 (@390): el portal es mobile-first (QA manual 14).
 */

async function portalSession(browser: Browser, fx: E2EFixture, viewport: { width: number; height: number } | null): Promise<Page> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: viewport ?? undefined, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires" });
  const page = await ctx.newPage();
  // El link del mail lleva a /portal/c/<slug>/documentos: sin sesión manda a entrar y recuerda la sección (FC-4i).
  await page.goto(`/portal/c/${fx.slug}/documentos`);
  await expect(page).toHaveURL(new RegExp(`/portal\\?c=${fx.slug}&n=documentos$`));
  await expect(page.locator('input[type="hidden"][name="n"][value="documentos"]')).toHaveCount(1);
  // El GoTrue falso no manda mails: la sesión sale del form de /login (misma cookie que `/auth/confirm`).
  await page.goto(`/login?next=${encodeURIComponent(`/portal/c/${fx.slug}/documentos`)}`);
  await page.getByLabel("Email").fill(fx.portal.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(fx.portal.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await page.waitForURL(new RegExp(`/portal/c/${fx.slug}/documentos$`));
  return page;
}

test("@390 compartir → la paciente la ve en «Documentos» → dejar de compartir → desaparece", async ({ page, browser }) => {
  const fx = readFixture();
  const title = `Compartida ${uid()}`;
  const noteId = await insertNote(fx, fx.portal.patientId, { title, body: `Indicaciones para casa: hielo 15 min. ${title}.` });

  await openHc(page, fx.portal.patientId);
  await cardMenu(page, noteId, "Compartir con el paciente");
  const dialog = page.getByRole("dialog", { name: "Compartir con el paciente" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Compartir", exact: true }).click();
  await expect(page.getByText("Ficha compartida")).toBeVisible();
  await expect(card(page, noteId).getByText("Compartida", { exact: true })).toBeVisible();

  const db = ownerClient();
  try {
    const live = await db.patientDocument.findFirst({ where: { tenantId: fx.tenantId, noteId, revokedAt: null } });
    expect(live).not.toBeNull();
  } finally {
    await db.$disconnect();
  }

  // La paciente.
  const portal = await portalSession(browser, fx, page.viewportSize());
  try {
    const list = portal.getByRole("list", { name: "Documentos compartidos" });
    const item = list.getByRole("link", { name: new RegExp(title) });
    await expect(item).toBeVisible();
    await item.click();
    await expect(portal.getByText("Indicaciones para casa")).toBeVisible();
    // «Descargar PDF»: la ruta del portal audita y manda los bytes guardados (sha256 verificado contra la fila).
    const href = await portal.getByRole("link", { name: "Descargar PDF" }).getAttribute("href");
    expect(href).toBeTruthy();
    const pdf = await portal.request.get(href!);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toContain("application/pdf");
    expect((await pdf.body()).subarray(0, 4).toString("latin1")).toBe("%PDF");

    // El profesional deja de compartir.
    await cardMenu(page, noteId, "Dejar de compartir");
    // `useConfirm`: diálogo con el título y el botón «Dejar de compartir».
    await page.getByRole("dialog", { name: "Dejar de compartir" }).getByRole("button", { name: "Dejar de compartir" }).click();
    await expect(page.getByText("La ficha ya no se comparte")).toBeVisible();
    await expect(card(page, noteId).getByText("Compartida", { exact: true })).toHaveCount(0);

    // Para la paciente ya no está: ni en la lista ni por su URL (404) ni el PDF.
    await portal.goto(`/portal/c/${fx.slug}/documentos`);
    await expect(portal.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
    expect((await portal.request.get(href!)).status()).toBe(404);
  } finally {
    await portal.context().close();
  }
});
