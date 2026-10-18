import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";

/**
 * Cobro manual del copago: en la ficha, pestaña «Facturación», el toggle «Confirmar» de la columna del paciente (la de
 * la OS tiene el mismo botón). Turno confirmado de ayer con $50 de copago (global-setup).
 */
test("cobro manual: «Confirmar» el copago pide el medio, lo deja «Pagado · Efectivo» y estampa copagoPaidAt y el medio", async ({ page }) => {
  const fx = readFixture();
  await page.goto(`/pacientes/${fx.payPatient.id}`);
  await page.getByRole("navigation", { name: "Secciones de la ficha" }).getByRole("button", { name: /^Facturación/ }).click();
  // La fila del turno. Dentro, la columna «OS (prestadora)» va ANTES que «Copago (paciente)» y tiene el mismo botón
  // (con «Particular» la de OS es «—»): `.last()` es siempre el del copago. No se usa `data-label`: entró después
  // (AS-0d) y la suite tiene que andar en los dos.
  const row = page.locator('[data-testid="fact-row"]').filter({ hasText: /\$\s*50/ });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Confirmar", exact: true }).last().click();
  // T3 (C-AS2): «Confirmar» abre «Registrar cobro» con el medio obligatorio y sin preselección.
  const dialog = page.getByRole("dialog", { name: "Registrar cobro" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /Efectivo/ }).check();
  await dialog.getByRole("button", { name: /Marcar pagado/ }).click();
  await expect(row.getByRole("button", { name: /Pagado · Efectivo/ })).toBeVisible();

  const db = ownerClient();
  try {
    await expect
      .poll(async () => (await db.booking.findUniqueOrThrow({ where: { id: fx.payBookingId }, select: { copagoPaidAt: true } })).copagoPaidAt)
      .not.toBeNull();
    const b = await db.booking.findUniqueOrThrow({ where: { id: fx.payBookingId }, select: { copagoPaymentMethod: true } });
    expect(b.copagoPaymentMethod).toBe("CASH");
  } finally {
    await db.$disconnect();
  }
});
