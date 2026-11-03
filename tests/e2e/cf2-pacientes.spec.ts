import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { CF2_OWNER_NAME, CF2_PRO_NAME, createCf2Tenant, deleteCf2Tenant, type Cf2Tenant } from "./support/cf2";
import { blockExternal, loginAs } from "./support/plans";

/**
 * CF2-E2E (§29.3 P «Lista»; decisiones 2 y 3 de Martin, D-CF2-14, D-CF2-15) · el directorio de pacientes de la
 * Secretaria en un consultorio Kine con dos profesionales (`support/cf2.ts`):
 *  - columnas Nombre y apellido · Obra social · Próx. turno · Última visita · Kinesiólogo · Estado, sin «Plan activo»
 *    ni las pastillas «Todos / Con plan / Sin plan»;
 *  - la Secretaria ve «Última visita» y «Estado» (salen de los turnos, no de la HC) y los profesionales del paciente: el
 *    a cargo primero, con la marca «a cargo», y el que lo atendió.
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

test("[CF2-E2E] Pacientes (Secretaria): columnas nuevas, sin «Plan activo» ni pastillas, con última visita, estado y kinesiólogos", async ({ browser }) => {
  const f = fx!;
  const s = await loginAs(browser, f.assistant);
  try {
    await s.page.goto("/pacientes");
    const head = s.page.getByText("Nombre y apellido", { exact: true }).locator("xpath=..");
    await expect(head).toBeVisible();
    const cols = (await head.locator(":scope > span").allTextContents()).map((t) => t.trim()).filter(Boolean);
    expect(cols).toEqual(["Nombre y apellido", "Obra social", "Próx. turno", "Última visita", "Kinesiólogo", "Estado"]);

    await expect(s.page.getByText("Plan activo", { exact: true })).toHaveCount(0);
    for (const pill of ["Con plan", "Sin plan"]) {
      await expect(s.page.getByRole("button", { name: pill, exact: true }), pill).toHaveCount(0);
      await expect(s.page.getByRole("tab", { name: pill, exact: true }), pill).toHaveCount(0);
    }

    // Nora: a cargo de Laura, atendida AYER por Martín → los dos, Laura primero con «a cargo»; última visita = ayer; Activo.
    const row = s.page.getByTestId("patients-row").filter({ hasText: f.visited.patient.lastName });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${CF2_OWNER_NAME} (a cargo), ${CF2_PRO_NAME}`);
    await expect(row).toContainText("a cargo");
    await expect(row).toContainText("Activo");
    const yesterday = new Date(Date.now() - 86400_000).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "short",
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const cells = row.locator(":scope > *");
    // Orden de la grilla: checkbox · nombre · OS · próx. · última · kinesiólogo · estado · acciones.
    await expect(cells.nth(4)).toHaveText(yesterday);
    await expect(cells.nth(4)).not.toHaveText("—");
  } finally {
    await s.ctx.close();
  }
});
