import { expect, type Locator, type Page } from "@playwright/test";
import { ownerClient } from "../../helpers/tenant-factory";
import type { E2EFixture } from "./fixture";

/**
 * FC-E (T4) · ayudas compartidas por los specs de fichas. Los datos de partida (una ficha de hace un rato, de hace
 * 3 días) se insertan con el cliente owner de la factory, como el global-setup: nunca un seed. Cada test arma SU ficha
 * con un texto único, así los dos proyectos (1366 y 390) y los re-intentos no se pisan.
 */

export const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Ancho angosto (FC-UI-D9: abajo de 640 px el composer es barra + Drawer). */
export const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1366) < 640;

/** Una ficha del dueño del tenant (autor = el profesional del fixture), `hoursAgo` atrás. */
export async function insertNote(
  fx: E2EFixture,
  patientId: string,
  opts: { title: string; body: string; hoursAgo?: number }
): Promise<string> {
  const db = ownerClient();
  try {
    const at = new Date(Date.now() - (opts.hoursAgo ?? 1) * 3600_000);
    const note = await db.clinicalNote.create({
      data: {
        tenantId: fx.tenantId,
        patientId,
        kind: "EVOLUTION",
        title: opts.title,
        body: opts.body,
        occurredAt: at,
        createdAt: at,
        authorUserId: fx.owner.id,
        authorPractitionerId: fx.practitionerId,
        authorName: fx.owner.fullName,
        idempotencyKey: `e2e-fc-${uid()}`,
      },
      select: { id: true },
    });
    return note.id;
  } finally {
    await db.$disconnect();
  }
}

/** Perfil del paciente: la HC es la primera pestaña y la que abre (FC-3d), sin clicks. */
export async function openHc(page: Page, patientId: string): Promise<void> {
  await page.goto(`/pacientes/${patientId}`);
  await expect(page.getByRole("navigation", { name: "Secciones de la ficha" }).getByRole("button", { name: /^Historia clínica/ })).toBeVisible();
}

export const card = (page: Page, noteId: string): Locator => page.locator(`article[data-note-id="${noteId}"]`);

/** Menú «⋯» de la tarjeta → un ítem. */
export async function cardMenu(page: Page, noteId: string, item: string): Promise<void> {
  const c = card(page, noteId);
  await expect(c).toBeVisible();
  await c.getByRole("button", { name: "Acciones de la ficha" }).click();
  await page.getByRole("menu", { name: "Acciones de la ficha" }).getByRole("menuitem", { name: item, exact: true }).click();
}
