import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

test("alta de paciente: el Drawer crea la ficha y lleva a /pacientes/[id]", async ({ page }) => {
  const fx = readFixture();
  const dni = String(30_000_000 + (Date.now() % 9_000_000));
  await page.goto("/pacientes");
  await page.getByRole("button", { name: "Nuevo paciente" }).first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("heading", { name: "Crear ficha" })).toBeVisible();
  await drawer.getByLabel("Nombre").fill("Julieta");
  await drawer.getByLabel("Apellido").fill("Alta E2E");
  await drawer.getByLabel("DNI").fill(dni);
  await drawer.getByLabel("Teléfono").fill("1155550123");
  await drawer.getByRole("button", { name: "Crear paciente" }).click();

  await expect(page).toHaveURL(/\/pacientes\/[^/?]+/);
  await expect(page.getByRole("heading", { level: 1, name: "Julieta Alta E2E" })).toBeVisible();

  const db = ownerClient();
  try {
    const p = await db.patient.findFirst({ where: { tenantId: fx.tenantId, lastName: "Alta E2E" }, select: { id: true, documentId: true } });
    expect(p).not.toBeNull();
    expect(p!.documentId).toContain(dni);
    expect(page.url()).toContain(p!.id);
  } finally {
    await db.$disconnect();
  }
});
