import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

/**
 * Ficha / evolución (EV2, M9). El autor edita su nota durante 24 h; pasada la ventana, solo puede «Agregar enmienda»
 * (la HC no se borra ni se reescribe). La nota vieja la arma el global-setup con `createdAt` de hace 3 días.
 */
async function openEvoluciones(page: import("@playwright/test").Page, patientId: string) {
  await page.goto(`/pacientes/${patientId}`);
  await page.getByRole("navigation", { name: "Secciones de la ficha" }).getByRole("button", { name: /^Evoluciones/ }).click();
}

test("evolución nueva: se guarda y queda en la ficha", async ({ page }) => {
  const fx = readFixture();
  const body = `Sesión E2E ${Date.now()}: mejora de rango en flexión.`;
  await openEvoluciones(page, fx.chartPatient.id);
  await page.getByRole("button", { name: "Nueva evolución" }).click();
  const drawer = page.getByRole("dialog", { name: "Nueva evolución" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("textbox", { name: /Evolución/ }).fill(body);
  await drawer.getByRole("button", { name: "Guardar evolución" }).click();
  await expect(page.getByText("Evolución guardada")).toBeVisible();
  await expect(page.locator("article[data-note-id]").filter({ hasText: body })).toBeVisible();

  const db = ownerClient();
  try {
    const note = await db.clinicalNote.findFirst({ where: { tenantId: fx.tenantId, patientId: fx.chartPatient.id, body } });
    expect(note).not.toBeNull();
    expect(note!.authorPractitionerId).toBe(fx.practitionerId);
  } finally {
    await db.$disconnect();
  }
});

test("enmienda: una evolución fuera de la ventana de edición se enmienda, no se reescribe", async ({ page }) => {
  const fx = readFixture();
  const text = `Enmienda E2E ${Date.now()}: el dolor era 5/10.`;
  await openEvoluciones(page, fx.chartPatient.id);
  const card = page.locator(`article[data-note-id="${fx.oldNoteId}"]`);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Editar" })).toHaveCount(0);
  await card.getByRole("button", { name: "Agregar enmienda" }).click();
  const drawer = page.getByRole("dialog", { name: "Agregar enmienda" });
  await drawer.getByLabel("Enmienda").fill(text);
  await drawer.getByRole("button", { name: "Guardar enmienda" }).click();
  await expect(page.getByText("Enmienda guardada")).toBeVisible();
  await expect(page.getByText(text)).toBeVisible();

  const db = ownerClient();
  try {
    const original = await db.clinicalNote.findUniqueOrThrow({ where: { id: fx.oldNoteId }, select: { body: true, revision: true } });
    expect(original).toEqual({ body: "Dolor lumbar 6/10. Se trabajó movilidad.", revision: 1 });
    const amendment = await db.clinicalNote.findFirst({ where: { amendsNoteId: fx.oldNoteId, body: text } });
    expect(amendment).not.toBeNull();
  } finally {
    await db.$disconnect();
  }
});
