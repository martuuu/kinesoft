/**
 * [FC-3g] Doble en memoria de File System Access (lo que usa `lib/hc-backup.ts`): carpetas, archivos con escritura
 * atómica (`createWritable` → `close`), `keys()`, `removeEntry` y el permiso. Los tests de unit corren en node sin
 * navegador; el E2E (FC-E) usa un `showDirectoryPicker` stub sobre OPFS.
 */
import type { BackupDirHandle, BackupFileHandle } from "@/lib/hc-backup";

export type FakeDir = BackupDirHandle & {
  dirs: Map<string, FakeDir>;
  files: Map<string, Blob>;
  permission: PermissionState;
  /** Si está, `write` tira este error (para probar que la copia anterior queda). */
  failWrite?: Error | null;
  /** Registro de llamadas a `requestPermission` / `queryPermission`. */
  log: string[];
};

export function fakeDir(name: string, permission: PermissionState = "granted"): FakeDir {
  const dir: FakeDir = {
    kind: "directory",
    name,
    dirs: new Map(),
    files: new Map(),
    permission,
    failWrite: null,
    log: [],
    async getDirectoryHandle(n, opts) {
      if (n === "." || n === ".." || n.includes("/") || n.includes("\\") || !n) throw new TypeError(`nombre inválido: ${n}`);
      let d = dir.dirs.get(n);
      if (!d) {
        if (!opts?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
        d = fakeDir(n, dir.permission);
        dir.dirs.set(n, d);
      }
      return d;
    },
    async getFileHandle(n, opts): Promise<BackupFileHandle> {
      if (n === "." || n === ".." || n.includes("/") || n.includes("\\") || !n) throw new TypeError(`nombre inválido: ${n}`);
      if (!dir.files.has(n) && !opts?.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      return {
        kind: "file",
        name: n,
        async createWritable() {
          let pending: Blob | null = null;
          return {
            async write(data: Blob) {
              if (dir.failWrite) throw dir.failWrite;
              pending = data;
            },
            async close() {
              dir.files.set(n, pending ?? new Blob([]));
            },
            async abort() {
              pending = null;
            },
          };
        },
      };
    },
    async removeEntry(n) {
      if (!dir.files.delete(n) && !dir.dirs.delete(n)) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
    },
    keys() {
      const names = [...dir.dirs.keys(), ...dir.files.keys()];
      return (async function* () {
        for (const n of names) yield n;
      })();
    },
    async queryPermission() {
      dir.log.push("query");
      return dir.permission;
    },
    requestPermission() {
      dir.log.push("request");
      return Promise.resolve(dir.permission);
    },
  };
  return dir;
}
