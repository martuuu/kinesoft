import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { createCf2Tenant, deleteCf2Tenant, type Cf2Tenant } from "./support/cf2";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF2-E2E (§29.3 T «Mi agenda»; D-CF2-8, D-CF2-11) · el profesional (PRACTITIONER, sin «Configuración» delegada)
 * abre Configuración → «Mi agenda», guarda SU anticipación del turnero (prioridad servicio > profesional > consultorio)
 * y prende/apaga el aviso por mail de los turnos online. El push no se prueba acá: el E2E corre sin claves VAPID (el
 * interruptor ni se dibuja) y el permiso del navegador no se automatiza; lo cubre el QA manual (§29.7).
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

test("[CF2-E2E] profesional: «Mi agenda» guarda su anticipación propia y prende/apaga el aviso por mail", async ({ browser }) => {
  const f = fx!;
  const s = await loginAs(browser, f.pro);
  const db = ownerClient();
  const prac = () =>
    db.practitioner.findUniqueOrThrow({
      where: { id: f.pro.practitionerId },
      select: { publicMinLeadMinutes: true, notifyBookingEmail: true },
    });
  try {
    expect(await prac()).toEqual({ publicMinLeadMinutes: null, notifyBookingEmail: false });

    await s.page.goto("/configuracion");
    const tabs = s.page.getByRole("tablist", { name: "Secciones de Configuración" });
    await tabs.getByRole("tab", { name: "Mi agenda" }).click();
    await expect(s.page.getByRole("heading", { name: "Turnero online" })).toBeVisible();

    // Anticipación propia: 3 horas (180').
    const lead = s.page.getByRole("radiogroup", { name: "Tu anticipación del turnero" });
    await expect(lead).toBeVisible();
    await expect(lead.getByRole("radio", { name: /^Usar la del consultorio/ })).toBeChecked();
    await lead.getByRole("radio", { name: /^Propia/ }).check();
    await s.page.getByLabel("Tu anticipación mínima").fill("3");
    await s.page.getByLabel("Unidad de tu anticipación").selectOption("hours");
    await s.page.getByRole("button", { name: "Guardar anticipación" }).click();
    await expect(s.page.getByText("Guardaste tu anticipación")).toBeVisible();
    await expect.poll(async () => (await prac()).publicMinLeadMinutes).toBe(180);

    // Aviso por mail: nace apagado; se guarda al tocar (sin botón).
    const email = s.page.getByRole("switch", { name: "Avisarme por mail" });
    await expect(email).toHaveAttribute("aria-checked", "false");
    await email.click();
    await expect(email).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await prac()).notifyBookingEmail).toBe(true);

    // Lo guardado es lo que vuelve al recargar.
    await s.page.reload();
    await tabs.getByRole("tab", { name: "Mi agenda" }).click();
    await expect(s.page.getByLabel("Tu anticipación mínima")).toHaveValue("3");
    await expect(email).toHaveAttribute("aria-checked", "true");

    await email.click();
    await expect(email).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await prac()).notifyBookingEmail).toBe(false);
  } finally {
    await db.$disconnect();
    await s.ctx.close();
  }
});
