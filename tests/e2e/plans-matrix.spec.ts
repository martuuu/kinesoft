import { expect, test, type Page } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { SAAS_PLAN_LABEL, minimumPlanFor } from "../../lib/tenant-modules";
import { READ_ONLY_MESSAGE } from "../../lib/tenant-access";
import { readFixture } from "./support/fixture";
import { blockExternal, expectedNavFor, loginAs, readPlansFixture, sidebarHrefs } from "./support/plans";

/**
 * QA-E (T6+T7, X8; brief §26.8) · matriz por plan de punta a punta: menú, muros por URL directa, Secretaría, Clínica, solo
 * lectura y cupo, contra el server del E2E (GoTrue falso, MP y Meta falsos). Los consultorios extra los arma el
 * global-setup (`support/plans.ts`); el Individual · Kinesiología es el de siempre (el Titular del `storageState`).
 *
 * - El menú esperado se DERIVA (`modulesFor` + `capabilitiesForMember` + `shellNavCaps` + `navFor`, desde la fila real
 *   del tenant y de la membresía) y además se fijan literales (§26.8: un oráculo roto no arrastra la fila).
 * - El copy del muro sale de `minimumPlanFor` + `SAAS_PLAN_LABEL` y se fija también el literal «… está en el plan Clínica».
 * - Solo lectura: `start-server.mjs` NO setea `TENANT_ACCESS_ENFORCEMENT` y ningún `.env*` lo trae, así que el server
 *   del E2E corre en el default `banner`: un trial vencido ve la banda «Pronto…» y el modo EFECTIVO es `full` (la escritura
 *   entra). Con `TENANT_ACCESS_ENFORCEMENT=enforce npm run test:e2e -- …` (el server hereda el env de Playwright) la misma
 *   spec afirma la banda de modo lectura y la escritura rechazada con `READ_ONLY_MESSAGE`. Ver el caso.
 * - Todo lo que no sea el server local se aborta (`context.route`).
 */

/** Como `tenantAccessEnforcement()` (lib/env.ts) en el server: el server hereda el env de este proceso. */
const ENFORCEMENT = ((): "off" | "banner" | "enforce" => {
  const v = process.env.TENANT_ACCESS_ENFORCEMENT?.trim();
  return v === "off" || v === "banner" || v === "enforce" ? v : "banner";
})();

test.beforeEach(async ({ context }) => {
  await blockExternal(context);
});

async function expectMenu(page: Page, tenantId: string, userId: string): Promise<string[]> {
  await page.goto("/dashboard");
  const got = await sidebarHrefs(page);
  expect(got).toEqual(await expectedNavFor(tenantId, userId));
  return got;
}

test("[QA-E] menú por plan: Individual Kine sin «Sala de espera»; Consultorio General sin Kine; Clínica Kine con «Sala de espera»", async ({ page, browser }) => {
  const fx = readFixture();
  const pf = readPlansFixture();

  // Individual · Kinesiología (el Titular de la suite).
  const ind = await expectMenu(page, fx.tenantId, fx.owner.id);
  expect(ind).not.toContain("/sala");
  expect(ind).toEqual(expect.arrayContaining(["/agenda", "/pacientes", "/planes", "/diagnostico", "/biblioteca", "/configuracion"]));

  // Consultorio · General (Titular).
  const g = await loginAs(browser, pf.general.owner);
  try {
    const gen = await expectMenu(g.page, pf.general.tenantId, pf.general.owner.id);
    for (const kine of ["/diagnostico", "/planes", "/seguimiento", "/biblioteca", "/terapia-manual", "/sala"]) expect(gen).not.toContain(kine);
    expect(gen).toEqual(expect.arrayContaining(["/agenda", "/pacientes", "/configuracion"]));
    await expect(g.page.getByRole("complementary", { name: "Navegación principal" }).getByRole("link", { name: "Diagnóstico" })).toHaveCount(0);
  } finally {
    await g.ctx.close();
  }

  // Clínica · Kinesiología (Titular).
  const c = await loginAs(browser, pf.clinica.owner);
  try {
    const cli = await expectMenu(c.page, pf.clinica.tenantId, pf.clinica.owner.id);
    expect(cli).toContain("/sala");
    await expect(c.page.getByRole("complementary", { name: "Navegación principal" }).getByRole("link", { name: "Sala de espera" })).toBeVisible();
  } finally {
    await c.ctx.close();
  }
});

test("[QA-E] muros por URL directa: /sala en Individual → muro «… en el plan Clínica»; General sin módulos Kine → /dashboard", async ({ page, browser }) => {
  // Individual · Kine: la Sala de espera es de Clínica/Libre → upsell con «Ver planes» (el Titular puede comprar).
  await page.goto("/sala");
  // Oráculo (`minimumPlanFor` + el formato de `accessWallTitle`) y el literal: el muro no se importa porque es un
  // componente con CSS module (no corre en el proceso de Playwright).
  const min = minimumPlanFor("salaEspera", "KINESIOLOGY");
  expect(min).toBe("CLINICA");
  const title = `Sala de espera está en el plan ${SAAS_PLAN_LABEL[min!]}`;
  expect(title).toBe("Sala de espera está en el plan Clínica");
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver planes" })).toBeVisible();
  await expect(page).toHaveURL(/\/sala$/);

  // Consultorio · General: ningún plan le vende Kine (minimumPlanFor = null) → redirect a /dashboard, sin upsell.
  const pf = readPlansFixture();
  const g = await loginAs(browser, pf.general.owner);
  try {
    for (const seg of ["/diagnostico", "/planes", "/seguimiento", "/biblioteca", "/terapia-manual", "/reportes"]) {
      await g.page.goto(seg);
      await expect(g.page, seg).toHaveURL(/\/dashboard$/);
      await expect(g.page.locator("#access-wall-title")).toHaveCount(0);
    }
    // /sala sí existe en General (desde Clínica): upsell, no redirect.
    await g.page.goto("/sala");
    await expect(g.page.getByRole("heading", { level: 1, name: "Sala de espera está en el plan Clínica" })).toBeVisible();
  } finally {
    await g.ctx.close();
  }
});

test("[QA-E] la Secretaría no ve la HC del paciente (solo Datos, Turnos y Facturación) y cobra un turno con medio de pago", async ({ browser }) => {
  const pf = readPlansFixture();
  const s = await loginAs(browser, pf.general.assistant);
  try {
    await expectMenu(s.page, pf.general.tenantId, pf.general.assistant.id);
    // Por URL directa a la pestaña de la HC: el perfil la ignora y cae en la vista administrativa.
    await s.page.goto(`/pacientes/${pf.general.patient.id}?tab=evoluciones`);
    const tabs = s.page.getByRole("navigation", { name: "Secciones del perfil del paciente" });
    await expect(tabs).toBeVisible();
    const labels = (await tabs.getByRole("button").allTextContents()).map((t) => t.replace(/\d+$/, "").trim());
    // ADMIN_PROFILE_TABS = resumen · turnos · fact; la vista administrativa rotula «Resumen» como «Datos».
    expect(labels).toEqual(["Datos", "Turnos", "Facturación"]);
    await expect(tabs.getByRole("button", { name: /Historia clínica/ })).toHaveCount(0);

    // Cobro con medio (C-AS2): «Cobrar» → «Registrar cobro» → Transferencia → «Marcar pagado».
    await tabs.getByRole("button", { name: /^Facturación/ }).click();
    const row = s.page.locator('[data-testid="fact-row"]').filter({ hasText: /\$\s*50/ });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "Cobrar", exact: true }).click();
    const dialog = s.page.getByRole("dialog", { name: "Registrar cobro" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: /Transferencia/ }).check();
    await dialog.getByRole("button", { name: /Marcar pagado/ }).click();
    await expect(row.getByRole("button", { name: /Pagado · Transferencia/ })).toBeVisible();

    const db = ownerClient();
    try {
      await expect
        .poll(async () => (await db.booking.findUniqueOrThrow({ where: { id: pf.general.payBookingId }, select: { copagoPaidAt: true } })).copagoPaidAt)
        .not.toBeNull();
      const b = await db.booking.findUniqueOrThrow({ where: { id: pf.general.payBookingId }, select: { copagoPaymentMethod: true } });
      expect(b.copagoPaymentMethod).toBe("TRANSFER");
    } finally {
      await db.$disconnect();
    }
  } finally {
    await s.ctx.close();
  }
});

test("[QA-E] Clínica Kine: /sala abre (sin muro) y «Pantallas» está visible y abre su drawer", async ({ browser }) => {
  const pf = readPlansFixture();
  const c = await loginAs(browser, pf.clinica.owner);
  try {
    await c.page.goto("/sala");
    await expect(c.page).toHaveURL(/\/sala/);
    await expect(c.page.locator("#access-wall-title")).toHaveCount(0);
    const btn = c.page.getByRole("button", { name: "Pantallas" }).first();
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(c.page.getByRole("dialog", { name: "Pantallas" })).toBeVisible();
  } finally {
    await c.ctx.close();
  }
});

test(`[QA-E] solo lectura (prueba vencida hace 10 días, TENANT_ACCESS_ENFORCEMENT=${ENFORCEMENT}): banda visible y la escritura según el modo efectivo`, async ({ browser }) => {
  test.skip(ENFORCEMENT === "off", "con `off` no hay banda ni corte (interruptor de emergencia)");
  const pf = readPlansFixture();
  const r = await loginAs(browser, pf.readOnly.owner);
  const lastName = `Lectura E2E ${Date.now() % 100000}`;
  const db = ownerClient();
  try {
    await r.page.goto("/pacientes");
    const band = r.page.locator('[role="status"][data-access-reason="trial_expired"]');
    await expect(band).toBeVisible();
    if (ENFORCEMENT === "enforce") {
      await expect(band).toContainText("Tu consultorio está en modo lectura: podés consultar todo, pero no cargar ni modificar datos.");
    } else {
      await expect(band).toContainText("Tu prueba terminó. Pronto el consultorio va a pasar a modo lectura");
    }

    // Una escritura real por la UI: alta de paciente.
    await r.page.getByRole("button", { name: "Nuevo paciente" }).first().click();
    const drawer = r.page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { name: "Cargar paciente" })).toBeVisible();
    await drawer.getByLabel("Nombre").fill("Tomás");
    await drawer.getByLabel("Apellido").fill(lastName);
    await drawer.getByLabel("DNI").fill(String(40_000_000 + (Date.now() % 9_000_000)));
    // Una corrida en `enforce` quedó con los campos vacíos (fill antes de hidratar el Drawer): se confirma antes de enviar.
    await expect(drawer.getByLabel("Nombre")).toHaveValue("Tomás");
    await expect(drawer.getByLabel("Apellido")).toHaveValue(lastName);
    await drawer.getByRole("button", { name: "Crear paciente" }).click();

    if (ENFORCEMENT === "enforce") {
      // Modo efectivo read_only: la tx en solo lectura rechaza y la action devuelve el copy tal cual (withReadOnlyResult).
      await expect(drawer.getByText(READ_ONLY_MESSAGE)).toBeVisible();
      await expect(r.page).toHaveURL(/\/pacientes$/);
      expect(await db.patient.count({ where: { tenantId: pf.readOnly.tenantId, lastName } })).toBe(0);
    } else {
      // `banner`: el modo efectivo es `full` (effectiveMode, lib/tenant-access.ts): solo se avisa, la escritura entra.
      await expect(r.page).toHaveURL(/\/pacientes\/[^/?]+/);
      expect(await db.patient.count({ where: { tenantId: pf.readOnly.tenantId, lastName } })).toBe(1);
    }
  } finally {
    await db.$disconnect();
    await r.ctx.close();
  }
});

test("[QA-E] invitar por encima del cupo (Individual, 2.º usuario): «Cupo lleno» y el modal avisa sin dejar crear", async ({ page }) => {
  await page.goto("/configuracion?tab=usuarios");
  const seats = page.getByTestId("team-seats");
  await expect(seats).toBeVisible();
  await expect(seats.getByText("Cupo lleno")).toBeVisible();
  await page.getByRole("button", { name: "Invitar usuario" }).click();
  const modal = page.getByRole("dialog", { name: "Invitar usuario" });
  await expect(modal).toBeVisible();
  // Para cualquier rol: Individual es 1 usuario en total.
  for (const role of ["PRACTITIONER", "ASSISTANT"]) {
    await modal.getByLabel("Rol").selectOption(role);
    await expect(modal.getByRole("status")).toContainText("No quedan lugares en el plan para sumar a alguien con este rol.");
    await expect(modal.getByRole("button", { name: "Crear invitación" })).toBeDisabled();
  }
});

test("[QA-E] General sin módulos Kine: el perfil del paciente no muestra Planes, Sesiones ni EVA", async ({ browser }) => {
  const pf = readPlansFixture();
  const g = await loginAs(browser, pf.general.owner);
  try {
    await g.page.goto(`/pacientes/${pf.general.patient.id}`);
    const tabs = g.page.getByRole("navigation", { name: "Secciones del perfil del paciente" });
    await expect(tabs).toBeVisible();
    for (const kine of [/^Planes/, /^Sesiones/, /^EVA/]) await expect(tabs.getByRole("button", { name: kine })).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: /^Historia clínica/ })).toBeVisible();
  } finally {
    await g.ctx.close();
  }
});
