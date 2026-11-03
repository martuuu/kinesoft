import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { createCf2Tenant, deleteCf2Tenant, type Cf2Tenant } from "./support/cf2";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF2-E2E (§29.3 A «Cobro visible» + «Recepción»; D-CF2-3) · el cobro se ve donde trabaja el kine. La Secretaria cobra
 * en Recepción (consultorio Clínica, `support/cf2.ts`) el turno ATENDIDO de Martín con «Efectivo», y Martín, al abrir
 * su agenda, ve «Pagado · Efectivo» en la tarjeta del turno (antes solo figuraba en el drawer). El efecto en la base
 * (`copagoPaidAt`, medio y quién cobró) se afirma también: la etiqueta sola podría venir de un cache.
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

test("[CF2-E2E] la Secretaria cobra en Recepción con «Efectivo» y el profesional ve «Pagado · Efectivo» en su tarjeta", async ({ browser }) => {
  const f = fx!;
  const who = `${f.owed.patient.firstName} ${f.owed.patient.lastName}`;
  const desk = await loginAs(browser, f.assistant);
  const db = ownerClient();
  try {
    await desk.page.goto(`/agenda?view=reception&date=${f.today}`);
    const owedChip = desk.page.getByRole("button", { name: /^Por cobrar: 1 turno,/ });
    await expect(owedChip).toBeVisible();
    // `.rcp-d` = la tabla de escritorio; las secciones de < 640 px (`.rcp-m`) son la otra copia, con `display: none`.
    const row = desk.page.locator(".rcp-d tr.rcp-row").filter({ hasText: f.owed.patient.lastName });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("img", { name: /^Por cobrar/ })).toBeVisible();
    await row.getByRole("button", { name: new RegExp(`^Cobrar .*: ${who}`) }).click();

    const dialog = desk.page.getByRole("dialog", { name: "Registrar cobro" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Efectivo/ }).check();
    await dialog.getByRole("button", { name: /^Marcar pagado/ }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole("img", { name: "Pagado · Efectivo" })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Cobrar / })).toHaveCount(0);
    // [CF2-ZF1] (ZB-7) el chip queda visible y deshabilitado en 0 (antes se ocultaba y la fila de chips saltaba).
    await expect(desk.page.getByRole("button", { name: /^Por cobrar: 0 turnos,/ })).toBeDisabled();

    await expect
      .poll(async () =>
        db.booking.findUniqueOrThrow({
          where: { id: f.owed.bookingId },
          select: { paymentStatus: true, copagoPaymentMethod: true, copagoCollectedById: true },
        })
      )
      .toEqual({ paymentStatus: "PAID", copagoPaymentMethod: "CASH", copagoCollectedById: f.assistant.id });
    const b = await db.booking.findUniqueOrThrow({ where: { id: f.owed.bookingId }, select: { copagoPaidAt: true } });
    expect(b.copagoPaidAt).not.toBeNull();
  } finally {
    await db.$disconnect();
    await desk.ctx.close();
  }

  const pro = await loginAs(browser, f.pro);
  try {
    await pro.page.goto(`/agenda?view=timeline&date=${f.today}`);
    // Un profesional en un consultorio con varios abre SU agenda (D-CF2-1).
    await expect(pro.page.getByRole("heading", { level: 1 })).toHaveText(`Tu agenda · ${f.pro.fullName}`);
    const card = pro.page.locator("button", { hasText: f.owed.patient.lastName }).first();
    await expect(card).toBeVisible();
    await expect(card.getByRole("img", { name: "Pagado · Efectivo" })).toBeVisible();
    // Control: el otro turno del día (cobrado por Transferencia en el fixture) lleva SU medio, no el del cobro de recién.
    const other = pro.page.locator("button", { hasText: f.paid.patient.lastName }).first();
    await expect(other.getByRole("img", { name: "Pagado · Transferencia" })).toBeVisible();
  } finally {
    await pro.ctx.close();
  }
});
