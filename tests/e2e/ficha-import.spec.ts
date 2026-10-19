import { expect, test } from "@playwright/test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { ownerClient } from "../helpers/tenant-factory";
import { readFixture } from "./support/fixture";
import { openHc, uid } from "./support/fichas";

/**
 * FC-E (T4) · importar fichas de Word (FC-3f). El .docx se arma en el test con `docx` (la misma librería del server) y
 * se lee en el NAVEGADOR (mammoth diferido + `generateJSON`, que necesita DOM: por eso este flujo solo lo cubre el e2e
 * y el QA manual 8). Afirma: fecha tomada del nombre, «Revisé las fechas» obligatorio, la ficha importada en la base
 * con `importSource` y el día de la consulta en AR, y que NINGÚN request lleve el .docx (C-FC: «el .docx nunca viaja»).
 */
test("importar un .docx: la ficha queda importada con la fecha del nombre y el archivo no viaja", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  const fileName = `Control ${tag} 15-09-2026.docx`;
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ children: [new TextRun({ text: `Motivo de consulta ${tag}`, bold: true })] }),
          new Paragraph({ children: [new TextRun("Dolor cervical de 2 semanas, irradiado a hombro derecho.")] }),
        ],
      },
    ],
  });
  const buffer = Buffer.from(await Packer.toBuffer(doc));

  // Un zip (.docx) empieza con «PK\x03\x04»: si algún request lo lleva, se ve en el cuerpo.
  const leaked: string[] = [];
  page.on("request", (req) => {
    const body = req.postDataBuffer();
    if (body && body.includes(Buffer.from("PK\x03\x04", "latin1"))) leaked.push(`${req.method()} ${req.url()}`);
  });

  await openHc(page, fx.chartPatient.id);
  await page.getByRole("button", { name: "Más acciones de la historia clínica" }).click();
  await page.getByRole("menuitem", { name: "Importar fichas de Word" }).click();
  const drawer = page.getByRole("dialog", { name: "Importar fichas de Word" });
  await expect(drawer).toBeVisible();
  await drawer.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer,
  });
  await expect(drawer.getByText("Fecha tomada del nombre del archivo")).toBeVisible();
  await expect(drawer.getByText(/\d+ caracteres/)).toBeVisible();

  const confirm = drawer.getByTestId("word-import-confirm");
  await expect(confirm).toBeDisabled();
  await drawer.getByTestId("word-import-reviewed").check();
  await expect(confirm).toHaveText("Importar 1 ficha");
  await confirm.click();
  await expect(page.getByText("Se importó 1 ficha")).toBeVisible();

  const card = page.locator("article[data-note-id]").filter({ hasText: `Motivo de consulta ${tag}` });
  await expect(card).toBeVisible();
  await expect(card.getByText("Importada", { exact: true })).toBeVisible();

  const db = ownerClient();
  try {
    const n = await db.clinicalNote.findFirstOrThrow({
      where: { tenantId: fx.tenantId, patientId: fx.chartPatient.id, body: { contains: `Motivo de consulta ${tag}` } },
      select: { importSource: true, occurredAt: true, bookingId: true, bodyDoc: true },
    });
    expect(n.importSource).toMatchObject({ kind: "docx", fileName });
    expect(n.bookingId).toBeNull();
    // Día de la consulta en Argentina (el server corre en UTC).
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(n.occurredAt)).toBe("2026-09-15");
    // El negrito del Word llega como formato permitido.
    expect(JSON.stringify(n.bodyDoc)).toContain('"bold"');
  } finally {
    await db.$disconnect();
  }
  expect(leaked).toEqual([]);
});
