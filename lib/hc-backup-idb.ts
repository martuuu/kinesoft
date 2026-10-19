/**
 * FC-3g (T4, §24.6, FC-D13) · Dónde se recuerda la carpeta de respaldo: IndexedDB CRUDO (sin librerías), base
 * `hc-backup`, un registro por `{tenant}:{user}`.
 *
 * Por qué IndexedDB y no localStorage: el `FileSystemDirectoryHandle` es structured-clonable pero no serializable a
 * texto; IndexedDB es el único lugar donde sobrevive a un cierre del navegador (el permiso no: Chrome lo vuelve a
 * pedir, y se pide dentro del gesto de «Guardar»).
 *
 * Por qué la clave lleva el usuario Y el consultorio: en una PC de recepción entran varios profesionales. Si la clave
 * fuera por navegador, el segundo usuario escribiría las fichas de SUS pacientes en la carpeta del primero (y el
 * primero las vería). Con `{tenant}:{user}` cada uno tiene la suya o ninguna; la casilla «Esta computadora la uso solo
 * yo» es obligatoria igual (la clave no protege de alguien que se sienta en la misma sesión del SO).
 *
 * PHI: acá NO se guarda nada del paciente. El registro tiene exactamente `BACKUP_RECORD_FIELDS` (allow-list con
 * test): el handle, el nombre de la carpeta que eligió el profesional (para «Guardando en …») y cuándo confirmó la
 * casilla. Las rutas con nombres y DNI se arman en el momento y viven solo en el disco que eligió.
 */
import type { BackupDirHandle } from "@/lib/hc-backup";

export const BACKUP_IDB_NAME = "hc-backup";
export const BACKUP_IDB_STORE = "folders";
const BACKUP_IDB_VERSION = 1;

/** Allow-list EXACTA de lo que se persiste (test: `tests/unit/hc-backup-idb.test.ts`). */
export const BACKUP_RECORD_FIELDS = ["handle", "folderName", "confirmedAt"] as const;

export type StoredBackup = {
  handle: BackupDirHandle;
  /** `handle.name` al elegirla (la carpeta del profesional, no del paciente). */
  folderName: string;
  /** ISO del momento en que tildó «Esta computadora la uso solo yo». */
  confirmedAt: string;
};

export type BackupScopeKey = { tenantId: string; userId: string };

/** `{tenant}:{user}`. Ids vacíos o con `:` se rechazan: una clave ambigua podría cruzar usuarios. */
export function backupIdbKey(scope: BackupScopeKey): string {
  const ok = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= 128 && !s.includes(":");
  if (!ok(scope.tenantId) || !ok(scope.userId)) throw new Error("hc-backup: scope inválido");
  return `${scope.tenantId}:${scope.userId}`;
}

/**
 * Arma el registro SOLO con los campos permitidos. Se usa al escribir y al leer: un registro viejo o tocado a mano
 * con campos de más se lee recortado, y uno sin handle se trata como «sin carpeta».
 */
export function toBackupRecord(raw: unknown): StoredBackup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const handle = r.handle as BackupDirHandle | undefined;
  if (!handle || typeof handle !== "object" || (handle as { kind?: unknown }).kind !== "directory") return null;
  if (typeof r.folderName !== "string" || typeof r.confirmedAt !== "string") return null;
  return { handle, folderName: r.folderName.slice(0, 255), confirmedAt: r.confirmedAt };
}

/** El `indexedDB` del navegador (inyectable para el test). */
export type IdbFactoryLike = Pick<IDBFactory, "open">;

function defaultIdb(): IdbFactoryLike {
  if (typeof indexedDB === "undefined") throw new Error("hc-backup: sin IndexedDB");
  return indexedDB;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(idb: IdbFactoryLike): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(BACKUP_IDB_NAME, BACKUP_IDB_VERSION);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains(BACKUP_IDB_STORE)) r.result.createObjectStore(BACKUP_IDB_STORE);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    // Otra pestaña con una versión vieja abierta: no colgarse esperando.
    r.onblocked = () => reject(new Error("hc-backup: base bloqueada"));
  });
}

async function withStore<T>(
  idb: IdbFactoryLike,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb(idb);
  try {
    const tx = db.transaction(BACKUP_IDB_STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const out = await req(fn(tx.objectStore(BACKUP_IDB_STORE)));
    await done;
    return out;
  } finally {
    db.close();
  }
}

export async function readBackup(scope: BackupScopeKey, idb: IdbFactoryLike = defaultIdb()): Promise<StoredBackup | null> {
  const key = backupIdbKey(scope);
  return toBackupRecord(await withStore(idb, "readonly", (s) => s.get(key)));
}

export async function writeBackup(
  scope: BackupScopeKey,
  record: StoredBackup,
  idb: IdbFactoryLike = defaultIdb()
): Promise<void> {
  const key = backupIdbKey(scope);
  const clean = toBackupRecord(record);
  if (!clean) throw new Error("hc-backup: registro inválido");
  await withStore(idb, "readwrite", (s) => s.put(clean, key));
}

export async function clearBackup(scope: BackupScopeKey, idb: IdbFactoryLike = defaultIdb()): Promise<void> {
  const key = backupIdbKey(scope);
  await withStore(idb, "readwrite", (s) => s.delete(key));
}

/** Lo que se mira para abrir el selector (inyectable). */
export type DirectoryPickerHost = {
  showDirectoryPicker?: (opts?: { id?: string; mode?: "readwrite"; startIn?: string }) => Promise<BackupDirHandle>;
};

export type ChooseFolderResult =
  | { ok: true; record: StoredBackup }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: unknown };

/**
 * Abre el selector y guarda el handle. `showDirectoryPicker` es la PRIMERA llamada (sincrónica, dentro del click):
 * Chrome exige activación transitoria del usuario y un await antes (aunque sea del IndexedDB) la consume y tira
 * `SecurityError`. `mode: "readwrite"` pide el permiso de escritura en el mismo diálogo. El `id` hace que Chrome
 * recuerde dónde estaba la última vez.
 *
 * `confirmedSoloUser` es la casilla: sin ella no se abre nada (la UI ya deshabilita el botón; esto es la barrera).
 */
export function chooseBackupFolder(
  scope: BackupScopeKey,
  confirmedSoloUser: boolean,
  host: DirectoryPickerHost,
  deps: { idb?: IdbFactoryLike; now?: () => Date } = {}
): Promise<ChooseFolderResult> {
  if (!confirmedSoloUser) return Promise.resolve({ ok: false, cancelled: false, error: new Error("hc-backup: falta la casilla") });
  let picked: Promise<BackupDirHandle>;
  try {
    if (typeof host.showDirectoryPicker !== "function") throw new Error("hc-backup: sin showDirectoryPicker");
    picked = host.showDirectoryPicker({ id: "hc-backup", mode: "readwrite", startIn: "documents" });
  } catch (error) {
    return Promise.resolve({ ok: false, cancelled: false, error });
  }
  return (async (): Promise<ChooseFolderResult> => {
    let handle: BackupDirHandle;
    try {
      handle = await picked;
    } catch (error) {
      // El usuario cerró el selector: no es un error que haya que mostrar.
      if ((error as { name?: string } | null)?.name === "AbortError") return { ok: false, cancelled: true };
      return { ok: false, cancelled: false, error };
    }
    const record: StoredBackup = {
      handle,
      folderName: handle.name,
      confirmedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    try {
      await writeBackup(scope, record, deps.idb ?? defaultIdb());
    } catch (error) {
      return { ok: false, cancelled: false, error };
    }
    return { ok: true, record };
  })();
}
