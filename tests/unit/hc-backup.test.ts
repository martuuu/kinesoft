/**
 * [FC-3g] Carpeta de respaldo (§24.6, FC-D13): `backupPathFor` (saneo, nombres reservados de Windows, 120 caracteres,
 * «(sin DNI)», fecha AR en UTC), detección y la escritura/sobrescritura sobre un handle falso. Correr con TZ=UTC.
 */
import { describe, expect, it } from "vitest";
import {
  BACKUP_NAME_MAX,
  backupPathFor,
  detectBackupSupport,
  sanitizeBackupSegment,
  writeBackupFile,
  type BackupPathInput,
} from "@/lib/hc-backup";
import { fakeDir } from "@/tests/helpers/fs-access-fake";

const base: BackupPathInput = {
  noteId: "cmabcdefgh0000xyz123",
  patient: { lastName: "Gómez", firstName: "Juana", dni: "30123456" },
  occurredAt: "2026-10-17T14:00:00.000Z",
  title: "Evolución",
};
const len = (s: string) => Array.from(s).length;

describe("[FC-3g] backupPathFor", () => {
  it("arma Pacientes/<Apellido Nombre> (DNI n)/<AAAA-MM-DD> <título> [id6].pdf", () => {
    const p = backupPathFor(base);
    expect(p.dirs).toEqual(["Pacientes", "Gómez Juana (DNI 30123456)"]);
    expect(p.fileName).toBe("2026-10-17 Evolución [xyz123].pdf");
    expect(p.idSuffix).toBe(" [xyz123].pdf");
    expect(p.display).toBe("Pacientes/Gómez Juana (DNI 30123456)/2026-10-17 Evolución [xyz123].pdf");
  });

  it("la fecha es el día AR aunque el host esté en UTC (23:30 AR = 02:30Z del día siguiente)", () => {
    expect(backupPathFor({ ...base, occurredAt: "2026-10-18T02:30:00.000Z" }).fileName.startsWith("2026-10-17 ")).toBe(true);
    expect(backupPathFor({ ...base, occurredAt: "2026-10-18T03:00:00.000Z" }).fileName.startsWith("2026-10-18 ")).toBe(true);
    expect(backupPathFor({ ...base, occurredAt: "no-es-fecha" }).fileName.startsWith("sin fecha ")).toBe(true);
  });

  it("«(sin DNI)» con DNI null, vacío o solo espacios", () => {
    for (const dni of [null, "", "   "]) {
      expect(backupPathFor({ ...base, patient: { ...base.patient, dni } }).dirs[1]).toBe("Gómez Juana (sin DNI)");
    }
  });

  it("sanea los caracteres prohibidos de Windows, los controles y las marcas bidi", () => {
    const p = backupPathFor({
      ...base,
      patient: { lastName: 'Pé/rez\\<Ana>', firstName: 'Lu:z"', dni: "30.123|456" },
      title: "Dolor? lumbar* L4/L5\u0007 | ok‮fdp.exe",
    });
    expect(p.dirs[1]).toBe("Pé rez Ana Lu z (DNI 30.123 456)");
    expect(p.fileName).toBe("2026-10-17 Dolor lumbar L4 L5 okfdp.exe [xyz123].pdf");
    for (const seg of [...p.dirs, p.fileName]) expect(seg).not.toMatch(/[<>:"/\\|?*\u0000-\u001f‪-‮]/);
  });

  it("sin puntos ni espacios al final (Windows los ignora) ni al principio; «.» y «..» no pasan", () => {
    expect(sanitizeBackupSegment("Pérez. . ", "x")).toBe("Pérez");
    expect(sanitizeBackupSegment("  .oculto", "x")).toBe("oculto");
    expect(sanitizeBackupSegment("..", "x")).toBe("x");
    expect(sanitizeBackupSegment(".", "x")).toBe("x");
    expect(sanitizeBackupSegment("../../etc", "x")).toBe("etc");
    const p = backupPathFor({ ...base, title: "Control...  " });
    expect(p.fileName).toBe("2026-10-17 Control [xyz123].pdf");
  });

  it("nombres reservados de Windows (con o sin extensión, sin distinguir mayúsculas) llevan «_»", () => {
    for (const r of ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9", "COM¹", "NUL.txt", "con.pdf"]) {
      expect(sanitizeBackupSegment(r, "x"), r).toBe(`${r}_`);
    }
    for (const ok of ["console", "Conde", "COM10", "LPT", "nulo", "auxiliar"]) expect(sanitizeBackupSegment(ok, "x")).toBe(ok);
    // En la ruta real el reservado se mira sobre el NOMBRE final: el sufijo del DNI y la fecha ya lo impiden.
    expect(backupPathFor({ ...base, patient: { lastName: "Con", firstName: "", dni: null } }).dirs[1]).toBe("Con (sin DNI)");
    expect(backupPathFor({ ...base, title: "NUL" }).fileName).toBe("2026-10-17 NUL [xyz123].pdf");
  });

  it("120 caracteres por nombre: se recorta el título o el nombre, nunca el sufijo (DNI / [id6].pdf)", () => {
    const long = "Á".repeat(300);
    const p = backupPathFor({ ...base, title: long, patient: { lastName: long, firstName: "Ana", dni: "30123456" } });
    expect(len(p.fileName)).toBeLessThanOrEqual(BACKUP_NAME_MAX);
    expect(p.fileName.endsWith(" [xyz123].pdf")).toBe(true);
    expect(p.fileName.startsWith("2026-10-17 ÁÁÁ")).toBe(true);
    expect(len(p.dirs[1])).toBeLessThanOrEqual(BACKUP_NAME_MAX);
    expect(p.dirs[1].endsWith(" (DNI 30123456)")).toBe(true);
    // Emoji (surrogate pair) en el corte: no queda medio carácter.
    const e = backupPathFor({ ...base, title: "😀".repeat(200) });
    expect(e.fileName).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(len(e.fileName)).toBeLessThanOrEqual(BACKUP_NAME_MAX);
  });

  it("título y nombre vacíos → «Ficha» y «Paciente sin nombre»; [id6] = últimos 6 del id de la raíz", () => {
    const p = backupPathFor({ ...base, noteId: "abc", title: "  ", patient: { lastName: "", firstName: "", dni: "1" } });
    expect(p.dirs[1]).toBe("Paciente sin nombre (DNI 1)");
    expect(p.fileName).toBe("2026-10-17 Ficha [abc].pdf");
  });
});

describe("[FC-3g] detección de File System Access", () => {
  const picker = () => Promise.resolve(null);
  it("Chrome/Edge de escritorio y la PWA: sí", () => {
    expect(
      detectBackupSupport({
        showDirectoryPicker: picker,
        isSecureContext: true,
        navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36", userAgentData: { mobile: false } },
      })
    ).toBe(true);
  });
  it("Safari, Firefox, mobile, sin contexto seguro o sin window: no", () => {
    expect(detectBackupSupport({ navigator: { userAgent: "Firefox/140" } })).toBe(false);
    expect(detectBackupSupport({ showDirectoryPicker: picker, navigator: { userAgentData: { mobile: true } } })).toBe(false);
    expect(
      detectBackupSupport({ showDirectoryPicker: picker, navigator: { userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile" } })
    ).toBe(false);
    expect(detectBackupSupport({ showDirectoryPicker: picker, isSecureContext: false })).toBe(false);
    expect(detectBackupSupport({ showDirectoryPicker: "no-es-función" })).toBe(false);
    expect(detectBackupSupport(null)).toBe(false);
  });
});

describe("[FC-3g] writeBackupFile", () => {
  const blob = (s: string) => new Blob([s], { type: "application/pdf" });
  const read = async (b: Blob | undefined) => (b ? await b.text() : null);

  it("crea Pacientes/<paciente>/ y escribe el PDF; guardar de nuevo SOBRESCRIBE el mismo archivo", async () => {
    const root = fakeDir("Respaldo HC");
    const p = backupPathFor(base);
    await writeBackupFile(root, p, blob("v1"));
    await writeBackupFile(root, p, blob("v2"));
    const dir = root.dirs.get("Pacientes")!.dirs.get(p.dirs[1])!;
    expect([...dir.files.keys()]).toEqual([p.fileName]);
    expect(await read(dir.files.get(p.fileName))).toBe("v2");
  });

  it("al editar cambia el título: queda solo la copia nueva de ESA ficha; las de otras fichas no se tocan", async () => {
    const root = fakeDir("Respaldo HC");
    const other = backupPathFor({ ...base, noteId: "cmzzzzzzzz0000aaa999", title: "Evolución" });
    await writeBackupFile(root, backupPathFor(base), blob("v1"));
    await writeBackupFile(root, other, blob("otra"));
    const renamed = backupPathFor({ ...base, title: "Evolución corregida" });
    await writeBackupFile(root, renamed, blob("v2"));
    const dir = root.dirs.get("Pacientes")!.dirs.get(renamed.dirs[1])!;
    expect([...dir.files.keys()].sort()).toEqual([other.fileName, renamed.fileName].sort());
    expect(await read(dir.files.get(renamed.fileName))).toBe("v2");
  });

  it("si la escritura falla, la copia anterior queda entera y el error sube", async () => {
    const root = fakeDir("Respaldo HC");
    const p = backupPathFor(base);
    await writeBackupFile(root, p, blob("v1"));
    const dir = root.dirs.get("Pacientes")!.dirs.get(p.dirs[1])!;
    dir.failWrite = new Error("disco lleno");
    await expect(writeBackupFile(root, p, blob("v2"))).rejects.toThrow("disco lleno");
    expect(await read(dir.files.get(p.fileName))).toBe("v1");
  });
});
