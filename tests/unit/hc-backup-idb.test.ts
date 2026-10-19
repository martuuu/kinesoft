/**
 * [FC-3g] IndexedDB del respaldo (§24.6): base `hc-backup`, clave `{tenant}:{user}`, registro con las claves en
 * allow-list (nada del paciente), y el selector abierto PRIMERO dentro del gesto con un `showDirectoryPicker` stub.
 *
 * El IndexedDB es un doble en memoria con la misma secuencia de eventos (open → upgradeneeded → success,
 * request.onsuccess → tx.oncomplete); no hay `fake-indexeddb` en el repo y no se suman librerías.
 */
import { describe, expect, it } from "vitest";
import {
  BACKUP_IDB_NAME,
  BACKUP_IDB_STORE,
  BACKUP_RECORD_FIELDS,
  backupIdbKey,
  chooseBackupFolder,
  clearBackup,
  readBackup,
  toBackupRecord,
  writeBackup,
  type IdbFactoryLike,
} from "@/lib/hc-backup-idb";
import { fakeDir } from "@/tests/helpers/fs-access-fake";

function fakeIdb() {
  const stores = new Map<string, Map<string, unknown>>();
  const opened: string[] = [];
  const later = (fn: () => void) => setTimeout(fn, 0);
  const factory = {
    open(name: string) {
      opened.push(name);
      const r: Record<string, unknown> & { result?: unknown } = {};
      later(() => {
        const db = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => stores.set(n, new Map()),
          close: () => {},
          transaction(n: string) {
            const store = stores.get(n);
            if (!store) throw new Error(`sin store ${n}`);
            const tx: Record<string, unknown> = {};
            const mk = (fn: () => unknown) => {
              const rq: Record<string, unknown> = {};
              later(() => {
                rq.result = fn();
                (rq.onsuccess as (() => void) | undefined)?.();
                later(() => (tx.oncomplete as (() => void) | undefined)?.());
              });
              return rq;
            };
            tx.objectStore = () => ({
              get: (k: string) => mk(() => store.get(k)),
              put: (v: unknown, k: string) => mk(() => (store.set(k, v), k)),
              delete: (k: string) => mk(() => void store.delete(k)),
            });
            return tx;
          },
        };
        r.result = db;
        if (!stores.has(BACKUP_IDB_STORE)) (r.onupgradeneeded as (() => void) | undefined)?.();
        (r.onsuccess as (() => void) | undefined)?.();
      });
      return r;
    },
  } as unknown as IdbFactoryLike;
  return { factory, stores, opened };
}

const scope = { tenantId: "tenA", userId: "userA" };

describe("[FC-3g] IndexedDB del respaldo", () => {
  it("base `hc-backup`, clave `{tenant}:{user}`; el registro tiene EXACTAMENTE las claves de la allow-list", async () => {
    const idb = fakeIdb();
    const handle = fakeDir("Respaldo HC");
    await writeBackup(scope, { handle, folderName: "Respaldo HC", confirmedAt: "2026-10-18T12:00:00.000Z" }, idb.factory);
    expect(idb.opened).toEqual([BACKUP_IDB_NAME]);
    expect(BACKUP_IDB_NAME).toBe("hc-backup");
    const store = idb.stores.get(BACKUP_IDB_STORE)!;
    expect([...store.keys()]).toEqual(["tenA:userA"]);
    const saved = store.get("tenA:userA") as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([...BACKUP_RECORD_FIELDS].sort());
    expect(saved.handle).toBe(handle);
  });

  it("campos de más (p. ej. datos del paciente) no se persisten ni se leen", async () => {
    const idb = fakeIdb();
    const handle = fakeDir("R");
    const dirty = { handle, folderName: "R", confirmedAt: "x", patientName: "Gómez Juana", lastPath: "Pacientes/…" };
    await writeBackup(scope, dirty as never, idb.factory);
    const saved = idb.stores.get(BACKUP_IDB_STORE)!.get("tenA:userA") as Record<string, unknown>;
    expect(Object.keys(saved).sort()).toEqual([...BACKUP_RECORD_FIELDS].sort());
    // Un registro tocado a mano con campos de más se lee recortado.
    idb.stores.get(BACKUP_IDB_STORE)!.set("tenA:userA", dirty);
    const read = await readBackup(scope, idb.factory);
    expect(Object.keys(read ?? {}).sort()).toEqual([...BACKUP_RECORD_FIELDS].sort());
  });

  it("cada usuario y cada consultorio tiene la suya: otro usuario en la misma PC no ve la carpeta", async () => {
    const idb = fakeIdb();
    await writeBackup(scope, { handle: fakeDir("A"), folderName: "A", confirmedAt: "x" }, idb.factory);
    expect(await readBackup({ tenantId: "tenA", userId: "userB" }, idb.factory)).toBeNull();
    expect(await readBackup({ tenantId: "tenB", userId: "userA" }, idb.factory)).toBeNull();
    expect((await readBackup(scope, idb.factory))?.folderName).toBe("A");
    await clearBackup(scope, idb.factory);
    expect(await readBackup(scope, idb.factory)).toBeNull();
  });

  it("claves ambiguas se rechazan; registros sin handle de carpeta = sin carpeta", () => {
    expect(backupIdbKey(scope)).toBe("tenA:userA");
    expect(() => backupIdbKey({ tenantId: "a:b", userId: "c" })).toThrow();
    expect(() => backupIdbKey({ tenantId: "", userId: "c" })).toThrow();
    expect(toBackupRecord(null)).toBeNull();
    expect(toBackupRecord({ handle: { kind: "file" }, folderName: "x", confirmedAt: "x" })).toBeNull();
    expect(toBackupRecord({ folderName: "x", confirmedAt: "x" })).toBeNull();
  });
});

describe("[FC-3g] chooseBackupFolder con un showDirectoryPicker stub", () => {
  it("abre el selector SINCRÓNICAMENTE (dentro del gesto, antes de cualquier await) y guarda el handle", async () => {
    const idb = fakeIdb();
    const handle = fakeDir("Respaldo HC");
    const calls: unknown[] = [];
    let inGesture = true;
    const host = {
      showDirectoryPicker: (opts?: unknown) => {
        if (!inGesture) return Promise.reject(Object.assign(new Error("Must be handling a user gesture"), { name: "SecurityError" }));
        calls.push(opts);
        return Promise.resolve(handle);
      },
    };
    const pending = chooseBackupFolder(scope, true, host, { idb: idb.factory, now: () => new Date("2026-10-18T12:00:00.000Z") });
    inGesture = false; // termina el gesto: cualquier await antes del selector lo habría hecho fallar
    expect(calls).toEqual([{ id: "hc-backup", mode: "readwrite", startIn: "documents" }]);
    const r = await pending;
    expect(r).toMatchObject({ ok: true, record: { folderName: "Respaldo HC", confirmedAt: "2026-10-18T12:00:00.000Z" } });
    expect((await readBackup(scope, idb.factory))?.handle).toBe(handle);
  });

  it("sin la casilla «Esta computadora la uso solo yo» no abre nada", async () => {
    let called = false;
    const r = await chooseBackupFolder(scope, false, { showDirectoryPicker: () => ((called = true), Promise.resolve(fakeDir("x"))) });
    expect(called).toBe(false);
    expect(r).toMatchObject({ ok: false, cancelled: false });
  });

  it("cerrar el selector (AbortError) es «cancelado», no un error; sin la API, error", async () => {
    const idb = fakeIdb();
    const abort = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
    expect(await chooseBackupFolder(scope, true, { showDirectoryPicker: () => Promise.reject(abort) }, { idb: idb.factory })).toEqual({
      ok: false,
      cancelled: true,
    });
    expect(await chooseBackupFolder(scope, true, {}, { idb: idb.factory })).toMatchObject({ ok: false, cancelled: false });
    expect(idb.stores.get(BACKUP_IDB_STORE)?.size ?? 0).toBe(0);
  });
});
