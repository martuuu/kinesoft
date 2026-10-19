import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";
import { card, cardMenu, insertNote, isNarrow, openHc, uid } from "./support/fichas";

/**
 * FC-E (T4) · fichas clínicas: reemplaza a `evoluciones.spec.ts` (EV2). Crear con formato (editor Tiptap diferido) y un
 * diagnóstico de texto libre, editar dentro de las 24 h, enmendar fuera de la ventana y anular. Corre también en el
 * proyecto `mobile-390` (los tests con @390): abajo de 640 px el composer es la barra «Nueva ficha» + Drawer.
 * Se afirma la fila en la base, no solo el toast (anti-false-green).
 */

test("@390 ficha nueva con formato y diagnóstico de texto libre", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  const diagnosis = `Lumbalgia mecánica ${tag}`;
  await openHc(page, fx.chartPatient.id);

  // Desde 640 px el formulario está inline en la HC; abajo, la barra abre el MISMO formulario en un Drawer.
  let form = page.locator('[data-hc-composer="inline"]');
  if (isNarrow(page)) {
    await page.getByRole("button", { name: "Nueva ficha" }).click();
    form = page.getByRole("dialog", { name: "Nueva ficha" });
  }
  await expect(form).toBeVisible();

  // El textarea del SSR se cambia por el editor con formato al enfocarlo (FC-3a): se escribe recién con la barra.
  await form.getByRole("textbox", { name: "Ficha", exact: true }).click();
  const toolbar = form.getByRole("toolbar", { name: "Formato de la ficha" });
  await expect(toolbar).toBeVisible();
  const editor = form.locator('[contenteditable="true"][role="textbox"]');
  await editor.click();
  await page.keyboard.type(`Sesión ${tag}: dolor `);
  await toolbar.getByRole("button", { name: "Negrita" }).click();
  await page.keyboard.type("lumbar");
  await toolbar.getByRole("button", { name: "Negrita" }).click();
  await page.keyboard.type(" 6/10.");

  // T4-Z ZF3: en el composer inline (≥ 640 px) título y diagnósticos arrancan plegados detrás de «Agregar título y
  // diagnósticos» para que el composer no tape la primera tarjeta a 768 px de alto; el Drawer (390) los trae abiertos.
  if (!isNarrow(page)) {
    const addExtras = form.getByRole("button", { name: "Agregar título y diagnósticos" });
    await addExtras.click();
    await expect(addExtras).toHaveCount(0);
  } else {
    await expect(form.getByRole("button", { name: "Agregar título y diagnósticos" })).toHaveCount(0);
  }

  // El input estático (textbox) se cambia por el combobox del picker diferido al enfocarlo (FC-3b).
  await form.getByRole("textbox", { name: "Diagnósticos" }).or(form.getByRole("combobox", { name: "Diagnósticos" })).click();
  const dx = form.getByRole("combobox", { name: "Diagnósticos" });
  await expect(dx).toBeVisible();
  await dx.fill(diagnosis);
  await page.getByRole("option", { name: `Usar "${diagnosis}" como texto libre` }).click();
  await expect(form.getByText(diagnosis)).toBeVisible();

  await form.getByRole("button", { name: "Guardar ficha" }).click();
  await expect(page.getByText("Ficha guardada")).toBeVisible();
  await expect(page.locator("article[data-note-id]").filter({ hasText: `Sesión ${tag}` }).locator("strong", { hasText: "lumbar" })).toBeVisible();

  const db = ownerClient();
  try {
    const note = await db.clinicalNote.findFirstOrThrow({
      where: { tenantId: fx.tenantId, patientId: fx.chartPatient.id, body: { contains: `Sesión ${tag}` } },
      select: { body: true, bodyDoc: true, diagnoses: true, authorPractitionerId: true },
    });
    expect(note.authorPractitionerId).toBe(fx.practitionerId);
    expect(note.body).toContain("dolor lumbar 6/10.");
    // El negrito viaja como mark del documento (el body plano es para búsqueda y el portal).
    type Node = { type: string; text?: string; marks?: { type: string }[]; content?: Node[] };
    const texts = (n: Node): Node[] => (n.type === "text" ? [n] : (n.content ?? []).flatMap(texts));
    const bold = texts(note.bodyDoc as Node).find((t) => t.text === "lumbar");
    expect(bold?.marks).toEqual([{ type: "bold" }]);
    expect(JSON.stringify(note.diagnoses)).toContain(diagnosis);
  } finally {
    await db.$disconnect();
  }
});

test("editar dentro de las 24 h: se guarda como nueva revisión", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  const noteId = await insertNote(fx, fx.chartPatient.id, { title: `Editable ${tag}`, body: `Texto original ${tag}.` });
  await openHc(page, fx.chartPatient.id);

  await card(page, noteId).getByRole("button", { name: "Editar", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "Editar ficha" });
  await expect(drawer).toBeVisible();
  const box = drawer.getByRole("textbox", { name: "Ficha", exact: true });
  await box.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Agregado al editar.");
  await drawer.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados")).toBeVisible();
  await expect(card(page, noteId)).toContainText("Agregado al editar.");

  const db = ownerClient();
  try {
    const n = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId }, select: { body: true, revision: true } });
    expect(n.revision).toBe(2);
    expect(n.body).toContain(`Texto original ${tag}.`);
    expect(n.body).toContain("Agregado al editar.");
  } finally {
    await db.$disconnect();
  }
});

test("enmienda: una ficha fuera de la ventana de edición se enmienda, no se reescribe", async ({ page }) => {
  const fx = readFixture();
  const text = `Enmienda E2E ${uid()}: el dolor era 5/10.`;
  await openHc(page, fx.chartPatient.id);
  const c = card(page, fx.oldNoteId);
  await expect(c).toBeVisible();
  await expect(c.getByRole("button", { name: "Editar", exact: true })).toHaveCount(0);
  await cardMenu(page, fx.oldNoteId, "Enmendar");
  const drawer = page.getByRole("dialog", { name: "Enmendar" });
  await drawer.getByRole("textbox", { name: "Enmienda", exact: true }).click();
  await page.keyboard.type(text);
  await drawer.getByRole("button", { name: "Guardar enmienda" }).click();
  await expect(page.getByText("Enmienda guardada")).toBeVisible();
  await expect(page.getByText(text)).toBeVisible();

  const db = ownerClient();
  try {
    const original = await db.clinicalNote.findUniqueOrThrow({ where: { id: fx.oldNoteId }, select: { body: true, revision: true } });
    expect(original).toEqual({ body: "Dolor lumbar 6/10. Se trabajó movilidad.", revision: 1 });
    expect(await db.clinicalNote.findFirst({ where: { amendsNoteId: fx.oldNoteId, body: text } })).not.toBeNull();
  } finally {
    await db.$disconnect();
  }
});

test("anular: la ficha queda anulada con su motivo (no se borra)", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  const noteId = await insertNote(fx, fx.chartPatient.id, { title: `A anular ${tag}`, body: `Cargada en el paciente equivocado ${tag}.` });
  await openHc(page, fx.chartPatient.id);

  await cardMenu(page, noteId, "Anular");
  const dialog = page.getByRole("dialog", { name: "Anular ficha" });
  await dialog.getByLabel("Motivo").fill("Paciente equivocado");
  await dialog.getByRole("button", { name: "Anular ficha" }).click();
  await expect(page.locator(`article[data-note-id="${noteId}"][data-voided]`)).toBeVisible();

  const db = ownerClient();
  try {
    const n = await db.clinicalNote.findUniqueOrThrow({ where: { id: noteId }, select: { voidedAt: true, voidReason: true, body: true } });
    expect(n.voidedAt).not.toBeNull();
    expect(n.voidReason).toBe("Paciente equivocado");
    expect(n.body).toBe(`Cargada en el paciente equivocado ${tag}.`);
  } finally {
    await db.$disconnect();
  }
});

test("@390 el perfil con la HC hidrata sin errores (ni #425 ni #422)", async ({ page }) => {
  // FC-E: la fecha «Última actualización» del hero salía distinta en Node y en Chrome (espacio del «p. m.») y React
  // descartaba el SSR de TODA la página en cada carga. Se afirma que no haya ningún error de página al abrir la HC.
  const fx = readFixture();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openHc(page, fx.chartPatient.id);
  await expect(card(page, fx.oldNoteId)).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(errors).toEqual([]);
});
