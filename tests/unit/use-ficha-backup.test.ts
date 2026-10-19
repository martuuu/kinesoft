/**
 * [FC-3g] `save` de `useFichaBackup` (§24.6): el permiso se pide AL PRINCIPIO del gesto, antes de cualquier await; los
 * bytes salen SIEMPRE de la ruta auditada de la raíz; sobrescribe; sin carpeta o sin soporte, descarga común.
 * Se prueba `saveFichaBackup` (el cuerpo real del `save` del hook) con el runtime real de `backup-setup.tsx`
 * (`backupPathFor` + `writeBackupFile`) sobre un handle falso; solo la red (`fetch`) es un doble.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { saveFichaBackup, fichaPdfUrl, type BackupSaveDeps } from "@/components/fichas/use-ficha-backup";
import { backupRuntime } from "@/components/fichas/backup-setup";
import { BACKUP_COPY } from "@/components/fichas/fichas-copy";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";
import type { FichaBackupStatus, FichaBackupTarget } from "@/components/fichas/fichas-ui-types";
import { fakeDir, type FakeDir } from "@/tests/helpers/fs-access-fake";

const target: FichaBackupTarget = {
  patientId: "pat_1",
  noteId: "cmroot000000abc123",
  patient: { lastName: "Gómez", firstName: "Juana", dni: "30123456" },
  occurredAt: "2026-10-17T14:00:00.000Z",
  title: "Evolución",
};

function setup(handle: FakeDir | null, res?: () => Response) {
  const log: string[] = [];
  const statuses: FichaBackupStatus[] = [];
  const fetched: { url: string; init?: RequestInit }[] = [];
  if (handle) {
    const orig = handle.requestPermission;
    handle.requestPermission = (d) => (log.push("permission"), orig(d));
  }
  const deps: BackupSaveDeps = {
    getHandle: () => handle,
    load: async () => (log.push("load"), backupRuntime),
    fetch: (async (url: string, init?: RequestInit) => {
      log.push("fetch");
      fetched.push({ url, init });
      return res ? res() : new Response(new Blob(["%PDF-1.7 v"]), { status: 200 });
    }) as typeof fetch,
    download: () => (log.push("download"), { ok: true, via: "download" }),
    onStatus: (s) => statuses.push(s),
  };
  return { deps, log, statuses, fetched };
}

const fileIn = (root: FakeDir) => {
  const p = backupRuntime.backupPathFor(target);
  return root.dirs.get(p.dirs[0])?.dirs.get(p.dirs[1])?.files.get(p.fileName) ?? null;
};

describe("[FC-3g] useFichaBackup · save", () => {
  it("el permiso se pide ANTES de cualquier await (sincrónico, dentro del gesto); después, red y disco", async () => {
    const root = fakeDir("Respaldo HC", "prompt");
    root.permission = "granted"; // el usuario acepta el prompt
    const { deps, log } = setup(root);
    const pending = saveFichaBackup(target, deps);
    // Sin ceder el turno: lo ÚNICO que pasó es el pedido de permiso.
    expect(log).toEqual(["permission"]);
    const r = await pending;
    expect(log).toEqual(["permission", "load", "fetch"]);
    expect(r).toEqual({ ok: true, via: "folder", path: "Pacientes/Gómez Juana (DNI 30123456)/2026-10-17 Evolución [abc123].pdf" });
    expect(await fileIn(root)?.text()).toBe("%PDF-1.7 v");
  });

  it("los bytes vienen de la ruta AUDITADA de la raíz, mismo origen y sin cache", async () => {
    const { deps, fetched } = setup(fakeDir("R"));
    await saveFichaBackup(target, deps);
    expect(fetched).toEqual([
      { url: "/api/pacientes/pat_1/fichas/cmroot000000abc123/pdf", init: { credentials: "same-origin", cache: "no-store" } },
    ]);
    expect(fichaPdfUrl(target)).toBe("/api/pacientes/pat_1/fichas/cmroot000000abc123/pdf");
  });

  it("guardar de nuevo (editar/enmendar/anular en este dispositivo) sobrescribe el mismo archivo", async () => {
    const root = fakeDir("R");
    let n = 0;
    const { deps } = setup(root, () => new Response(`v${++n}`, { status: 200 }));
    await saveFichaBackup(target, deps);
    await saveFichaBackup(target, deps);
    expect(await fileIn(root)?.text()).toBe("v2");
  });

  it("permiso denegado (o pedido fuera del gesto) → needs-permission, no se baja nada", async () => {
    const denied = setup(fakeDir("R", "denied"));
    expect(await saveFichaBackup(target, denied.deps)).toEqual({ ok: false, error: BACKUP_COPY.permissionDenied });
    expect(denied.statuses).toEqual(["needs-permission"]);
    expect(denied.log).toEqual(["permission"]);

    const outside = fakeDir("R", "prompt");
    outside.requestPermission = () => {
      throw Object.assign(new Error("Must be handling a user gesture"), { name: "SecurityError" });
    };
    const o = setup(null);
    o.deps.getHandle = () => outside;
    expect(await saveFichaBackup(target, o.deps)).toMatchObject({ ok: false });
    expect(o.statuses).toEqual(["needs-permission"]);
    expect(o.log).toEqual([]);
  });

  it("sin carpeta (o fuera de Chromium) → descarga común, sin fetch", async () => {
    const { deps, log } = setup(null);
    expect(await saveFichaBackup(target, deps)).toEqual({ ok: true, via: "download" });
    expect(log).toEqual(["download"]);
  });

  it("errores de la ruta → el mismo copy que la descarga; carpeta borrada → unconfigured", async () => {
    const rl = setup(fakeDir("R"), () => new Response("", { status: 429 }));
    expect(await saveFichaBackup(target, rl.deps)).toEqual({ ok: false, error: HC_EXPORT_COPY.rateLimited });

    const gone = fakeDir("R");
    gone.getDirectoryHandle = async () => {
      throw Object.assign(new Error("gone"), { name: "NotFoundError" });
    };
    const g = setup(gone);
    expect(await saveFichaBackup(target, g.deps)).toEqual({ ok: false, error: BACKUP_COPY.folderMissing });
    expect(g.statuses).toEqual(["ready", "unconfigured"]);
  });

  it("el hook no importa estático el respaldo: un solo import(), al chunk que ya existe de backup-setup", () => {
    const src = readFileSync(resolve(process.cwd(), "components/fichas/use-ficha-backup.ts"), "utf8");
    const dynamicImports = [...src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(dynamicImports).toEqual(["@/components/fichas/backup-setup"]);
    const valueImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(valueImports.filter((s) => s.includes("hc-backup") || s.includes("backup-setup"))).toEqual([]);
  });
});
