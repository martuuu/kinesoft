import { expect, test } from "@playwright/test";
import { readFixture } from "./support/fixture";
import { cardMenu, insertNote, openHc, uid } from "./support/fichas";

/**
 * FC-E (T4) · descargas de la ficha (C-FC7): PDF y Word de UNA ficha y la HC completa en PDF, con la sesión del
 * profesional. Se afirma el status, los headers (tipo, `attachment`, `no-store`, `nosniff`) y la firma del archivo
 * (`%PDF` / `PK` del zip del .docx), no solo que «bajó algo». Más el menú «⋯» → «PDF» de punta a punta (fetch + blob).
 */

test("PDF y Word de una ficha y la HC completa: 200 con headers de descarga", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  const noteId = await insertNote(fx, fx.chartPatient.id, { title: `Para descargar ${tag}`, body: `Dolor ≤ 3/10 → alta próxima, ñandú ${tag}.` });
  // `page.request` comparte las cookies de la sesión del dueño (storageState del proyecto).
  await page.goto("/dashboard");

  const cases = [
    { url: `/api/pacientes/${fx.chartPatient.id}/fichas/${noteId}/pdf`, type: "application/pdf", ext: ".pdf", magic: "%PDF" },
    {
      url: `/api/pacientes/${fx.chartPatient.id}/fichas/${noteId}/docx`,
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: ".docx",
      magic: "PK",
    },
    { url: `/api/pacientes/${fx.chartPatient.id}/historia-clinica/pdf`, type: "application/pdf", ext: ".pdf", magic: "%PDF" },
  ];
  for (const c of cases) {
    const res = await page.request.get(c.url);
    expect(res.status(), c.url).toBe(200);
    const h = res.headers();
    expect(h["content-type"], c.url).toContain(c.type);
    expect(h["content-disposition"], c.url).toMatch(new RegExp(`^attachment;.*filename.*\\${c.ext}`));
    expect(h["cache-control"], c.url).toContain("no-store");
    expect(h["x-content-type-options"], c.url).toBe("nosniff");
    const body = await res.body();
    expect(body.subarray(0, c.magic.length).toString("latin1"), c.url).toBe(c.magic);
  }

  // Sin sesión: 401, nunca bytes.
  // `storageState` vacío explícito: en el runner, `newContext()` hereda el `use` del proyecto (la sesión del dueño).
  const anon = await page.context().browser()!.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anon.request.get(cases[0].url, { maxRedirects: 0 });
    expect([401, 307, 302]).toContain(res.status());
    expect((await res.body()).subarray(0, 4).toString("latin1")).not.toBe("%PDF");
  } finally {
    await anon.close();
  }
});

test("menú «⋯» → PDF baja el archivo", async ({ page }) => {
  const fx = readFixture();
  const noteId = await insertNote(fx, fx.chartPatient.id, { title: `Menú PDF ${uid()}`, body: "Control." });
  await openHc(page, fx.chartPatient.id);
  const download = page.waitForEvent("download");
  await cardMenu(page, noteId, "PDF");
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/\.pdf$/);
});

/**
 * Carpeta de respaldo (FC-3g) con `showDirectoryPicker` simulado sobre OPFS (el sistema de archivos privado del
 * origen): el picker real abre un diálogo nativo que Playwright no maneja. OPFS da handles REALES de File System Access
 * (getDirectoryHandle/getFileHandle/createWritable, permisos): lo simulado es la elección y UNA cosa más:
 *
 * Chromium de Playwright (headless shell y el headless nuevo, build 1243) se CAE (se desconecta el browser entero) al
 * LEER de IndexedDB un handle de OPFS guardado por structured clone (reproducido aislado, fuera de la app: guardar
 * anda, el `get` mata el proceso). En Chrome real el handle guardado viene del picker nativo, no de OPFS. Por eso el
 * init script cambia el handle por una ficha `{ __e2eHandle }` al `put` y lo devuelve al leer `request.result`: el
 * resto del camino (lib/hc-backup-idb.ts, permisos, escritura) es el real. Persistir el permiso entre sesiones del
 * navegador sigue en el QA manual 9.
 */
test("respaldo: elegir carpeta (OPFS) y «Guardar en la carpeta» escribe el PDF", async ({ page }) => {
  const fx = readFixture();
  const tag = uid();
  await page.addInitScript(() => {
    const w = window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("respaldo-e2e", { create: true });
    const handles = new Map<string, FileSystemHandle>();
    const swap = (v: unknown): unknown => {
      if (v instanceof FileSystemHandle) {
        const id = `h${handles.size + 1}`;
        handles.set(id, v);
        return { __e2eHandle: id };
      }
      if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
      }
      return v;
    };
    const unswap = (v: unknown): unknown => {
      if (v && typeof v === "object" && "__e2eHandle" in v) return handles.get((v as { __e2eHandle: string }).__e2eHandle);
      if (v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype) {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unswap(x)]));
      }
      return v;
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      return put.call(this, swap(value), key);
    };
    const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!;
    Object.defineProperty(IDBRequest.prototype, "result", {
      get(this: IDBRequest) {
        return unswap(result.get!.call(this));
      },
    });
  });
  const noteId = await insertNote(fx, fx.chartPatient.id, { title: `Respaldo ${tag}`, body: `Para la carpeta ${tag}.` });
  await openHc(page, fx.chartPatient.id);

  await page.getByRole("button", { name: "Más acciones de la historia clínica" }).click();
  await page.getByRole("menuitem", { name: "Carpeta de respaldo" }).click();
  const modal = page.getByRole("dialog", { name: "Carpeta de respaldo" });
  await modal.getByLabel("Esta computadora la uso solo yo").check();
  await modal.getByRole("button", { name: "Elegir carpeta" }).click();
  await expect(modal.getByText("Guardando en «respaldo-e2e»")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  await cardMenu(page, noteId, "Guardar en la carpeta");
  await expect(page.getByText(/^Guardada en /)).toBeVisible();

  // El archivo existe en la carpeta elegida y es un PDF.
  const found = await page.evaluate(async () => {
    const out: { path: string; head: string }[] = [];
    type Dir = FileSystemDirectoryHandle & { entries: () => AsyncIterable<[string, FileSystemHandle]> };
    async function walk(dir: Dir, prefix: string) {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === "directory") await walk(h as Dir, `${prefix}${name}/`);
        else {
          const f = await (h as FileSystemFileHandle).getFile();
          out.push({ path: `${prefix}${name}`, head: await f.slice(0, 4).text() });
        }
      }
    }
    await walk((await (await navigator.storage.getDirectory()).getDirectoryHandle("respaldo-e2e")) as Dir, "");
    return out;
  });
  const pdfs = found.filter((f) => f.path.endsWith(".pdf"));
  expect(pdfs.length).toBeGreaterThan(0);
  expect(pdfs.every((f) => f.head === "%PDF")).toBe(true);
});
