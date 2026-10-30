import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { createCfTenant, deleteCfTenant, type CfTenant } from "./support/cf";
import { readFixture } from "./support/fixture";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF-E2E (§28, decisiones 4 y 7 de Martin; CF-NAV y CF-EVA):
 *  - La Secretaría (ASSISTANT, sin `clinical.read`) de un consultorio KINESIOLOGÍA no ve en el menú nada clínico
 *    (Diagnóstico, Planes, Ejercicios, Seguimiento, Terapia Manual) y por URL directa rebota a /dashboard. Tiene que ser
 *    Kine: en General esas secciones ya no estaban por módulo (`plans-matrix.spec.ts`) y el caso no probaría la
 *    capability. Consultorio propio (`support/cf.ts`): el Individual de siempre tiene cupo de 1 usuario.
 *  - La EVA salió de la app: ni la Secretaría ni el profesional ven la pestaña «EVA» del perfil, y `?tab=evol` (URL
 *    vieja) cae en la pestaña inicial.
 */
let fx: CfTenant | null = null;

test.beforeAll(async () => {
  const db = ownerClient();
  try {
    fx = await createCfTenant(db, {
      saasPlan: "CONSULTORIO",
      vertical: "KINESIOLOGY",
      withAssistant: true,
      patients: [{ firstName: "Teo", lastName: "Secretaría CF E2E" }],
    });
  } finally {
    await db.$disconnect();
  }
});

test.afterAll(async () => {
  const db = ownerClient();
  try {
    await deleteCfTenant(db, fx);
  } finally {
    await db.$disconnect();
  }
});

test.beforeEach(async ({ context }) => {
  await blockExternal(context);
});

const CLINICAL = [
  { label: "Diagnóstico", href: "/diagnostico" },
  { label: "Planes", href: "/planes" },
  { label: "Ejercicios", href: "/biblioteca" },
  { label: "Seguimiento", href: "/seguimiento" },
  { label: "Terapia Manual", href: "/terapia-manual" },
] as const;

test("[CF-E2E] Secretaría de un consultorio Kine: sin secciones clínicas en el menú, rebote a /dashboard por URL y sin pestaña EVA", async ({ browser }) => {
  const s = await loginAs(browser, fx!.assistant!);
  try {
    await s.page.goto("/dashboard");
    const aside = s.page.getByRole("complementary", { name: "Navegación principal" });
    const nav = aside.getByRole("navigation", { name: "Secciones" });
    await expect(nav).toBeVisible();
    // Control: el menú sí tiene lo administrativo.
    await expect(nav.locator('a[href="/agenda"]')).toBeVisible();
    await expect(nav.locator('a[href="/pacientes"]')).toBeVisible();
    for (const c of CLINICAL) {
      await expect(nav.getByRole("link", { name: c.label }), c.label).toHaveCount(0);
      await expect(aside.locator(`a[href="${c.href}"]`), c.href).toHaveCount(0);
    }

    for (const c of CLINICAL) {
      await s.page.goto(c.href);
      await expect(s.page, c.href).toHaveURL(/\/dashboard$/);
    }

    // Perfil del paciente: vista administrativa, sin «EVA» (tampoco por la URL vieja `?tab=evol`).
    await s.page.goto(`/pacientes/${fx!.patients[0].id}?tab=evol`);
    const tabs = s.page.getByRole("navigation", { name: "Secciones del perfil del paciente" });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole("button", { name: /^EVA/ })).toHaveCount(0);
    await expect(tabs.locator('[data-profile-tab="evol"]')).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: /^Datos/ })).toBeVisible();
  } finally {
    await s.ctx.close();
  }
});

test("[CF-E2E] profesional (Titular Kine): el perfil del paciente ya no tiene la pestaña EVA", async ({ page }) => {
  const main = readFixture();
  await page.goto(`/pacientes/${main.chartPatient.id}?tab=evol`);
  const tabs = page.getByRole("navigation", { name: "Secciones del perfil del paciente" });
  await expect(tabs).toBeVisible();
  // Control: el profesional ve la HC (si no, el caso no distinguiría «sin EVA» de «vista administrativa»).
  await expect(tabs.getByRole("button", { name: /^Historia clínica/ })).toBeVisible();
  await expect(tabs.getByRole("button", { name: /^EVA/ })).toHaveCount(0);
  await expect(tabs.locator('[data-profile-tab="evol"]')).toHaveCount(0);
  // `?tab=evol` cae en la pestaña inicial: alguna queda activa y no es `evol`.
  await expect(tabs.locator('[aria-current="true"]')).toHaveCount(1);
});
