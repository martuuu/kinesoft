/**
 * FC-3g (T4, §24.6, FC-D13) · Carpeta de respaldo: la RUTA del archivo, la detección del navegador y la escritura sobre
 * un handle ya autorizado. Sin globales del DOM (todo entra por parámetro): el unit lo prueba en node con un handle
 * falso (`tests/unit/hc-backup.test.ts`, TZ=UTC).
 *
 * Diferido: lo carga `use-ficha-backup.ts` por `import()` (a través del chunk de `backup-setup.tsx`) y lo importa
 * estático solo `backup-setup.tsx`. `hc-first-load-guard` frena cualquier import estático desde el first load.
 *
 * Por qué saneamos tanto (y no solo `/`): el respaldo es una carpeta de la computadora del profesional, que en
 * Argentina es casi siempre Windows. Un título con `:` o `?`, un apellido con punto final o un nombre reservado
 * (`CON`, `NUL`, `COM1`…) hace que Chrome tire `TypeError`/`NotAllowedError` al crear la entrada, o (peor) que el
 * archivo quede creado y después el Explorador no lo pueda abrir ni borrar. Los caracteres de control bidi se sacan
 * porque permiten disfrazar la extensión en el Explorador (`…‮fdp.exe` se ve como `…exe.pdf`).
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { hcShortId } from "@/lib/hc-export-logic";

/** Tope por NOMBRE (carpeta del paciente y archivo, cada uno). §24.6 / Anexo C: 120 caracteres. */
export const BACKUP_NAME_MAX = 120;
/** Carpeta raíz dentro de la que eligió el profesional. */
export const BACKUP_ROOT_DIR = "Pacientes";

/** Prohibidos en un nombre de Windows + controles C0/DEL. */
const UNSAFE_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
/** Marcas bidi y de ancho cero (spoofing de la extensión) y el BOM. */
const INVISIBLE_RE = /[​-‏‪-‮⁠-⁩﻿]/g;
/**
 * Nombres reservados de Windows: valen con cualquier extensión (`con.pdf`, `NUL.txt`) y sin distinguir mayúsculas.
 * Incluye los COM/LPT con superíndice (¹²³), que Windows también reserva.
 */
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** Recorta por CODE POINTS (no parte un emoji ni una ñ descompuesta a la mitad). */
function cut(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max)).join("");
}

/** Windows ignora (y después no encuentra) los puntos y espacios del final; un punto inicial lo oculta en Unix. */
function trimEdges(s: string): string {
  return s.replace(/[.\s]+$/u, "").replace(/^[.\s]+/u, "");
}

/**
 * Un nombre de archivo o carpeta seguro en Windows, macOS y Linux:
 *   NFC → sin invisibles → `<>:"/\|?*` y controles = espacio → espacios colapsados → sin puntos/espacios en los
 *   bordes → ≤ `max` → reservado de Windows con `_` al final → vacío = `fallback`.
 * Nunca devuelve `.` ni `..` (se recortan los puntos de los bordes): no hay forma de salir de la carpeta elegida.
 */
export function sanitizeBackupSegment(raw: string | null | undefined, fallback: string, max = BACKUP_NAME_MAX): string {
  return unreserve(cleanPart(raw, fallback, max), max);
}

/** Todo el saneo menos el de reservados: para las PARTES de un nombre (el reservado se mira sobre el nombre final). */
function cleanPart(raw: string | null | undefined, fallback: string, max: number): string {
  const s = (raw ?? "").normalize("NFC").replace(INVISIBLE_RE, "").replace(UNSAFE_RE, " ").replace(/\s+/g, " ");
  return trimEdges(cut(trimEdges(s), max)) || fallback;
}

function unreserve(s: string, max: number): string {
  return RESERVED_RE.test(s) ? `${cut(s, max - 1)}_` : s;
}

/** Lo que `backupPathFor` necesita (subconjunto de `FichaBackupTarget`; acá no se importa la UI). */
export type BackupPathInput = {
  noteId: string;
  patient: { lastName: string; firstName: string; dni: string | null };
  occurredAt: string;
  title: string;
};

export type BackupPath = {
  /** Carpetas desde la elegida: `["Pacientes", "<Apellido Nombre> (DNI n)"]`. */
  dirs: [string, string];
  fileName: string;
  /** Sufijo que identifica la ficha en su carpeta (` [id6].pdf`): con esto se borra la copia vieja al renombrar. */
  idSuffix: string;
  /** Para el toast: `Pacientes/…/….pdf`. */
  display: string;
};

export const BACKUP_PATH_COPY = {
  noDni: "sin DNI",
  noName: "Paciente sin nombre",
  noTitle: "Ficha",
  noDate: "sin fecha",
} as const;

/** `<AAAA-MM-DD>` del día AR (no del host: en Vercel/UTC una ficha de las 23:30 AR caería al día siguiente). */
function arDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? BACKUP_PATH_COPY.noDate : toARDateKey(d);
}

/**
 * `Pacientes/<Apellido Nombre> (DNI n)/<AAAA-MM-DD> <título> [id6].pdf` (§24.6), saneado.
 *
 * - El sufijo (` (DNI n)` / ` [id6].pdf`) nunca se recorta: se recorta el nombre o el título, que es lo que sobra.
 * - `[id6]` = los últimos 6 del id de la RAÍZ (`hcShortId`, el mismo que usa el nombre de la descarga): dos fichas
 *   del mismo día con el mismo título no se pisan, y al editar se reconoce la copia anterior aunque cambie el título.
 */
export function backupPathFor(input: BackupPathInput): BackupPath {
  const dniRaw = cleanPart(input.patient.dni, "", 20);
  const dirTail = dniRaw ? ` (DNI ${dniRaw})` : ` (${BACKUP_PATH_COPY.noDni})`;
  const who = cleanPart(
    `${input.patient.lastName ?? ""} ${input.patient.firstName ?? ""}`,
    BACKUP_PATH_COPY.noName,
    BACKUP_NAME_MAX - Array.from(dirTail).length
  );
  const patientDir = unreserve(`${who}${dirTail}`, BACKUP_NAME_MAX);

  const id6 = cleanPart(hcShortId(input.noteId), "000000", 6);
  const idSuffix = ` [${id6}].pdf`;
  const day = arDay(input.occurredAt);
  const headMax = BACKUP_NAME_MAX - Array.from(idSuffix).length;
  const title = cleanPart(input.title, BACKUP_PATH_COPY.noTitle, headMax);
  const head = trimEdges(cut(`${day} ${title}`, headMax)) || day;
  const fileName = unreserve(`${head}${idSuffix}`, BACKUP_NAME_MAX);

  const dirs: [string, string] = [BACKUP_ROOT_DIR, patientDir];
  return { dirs, fileName, idSuffix, display: [...dirs, fileName].join("/") };
}

// ─── Detección ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que se mira de `window` (inyectable para el test). */
export type BackupEnv = {
  showDirectoryPicker?: unknown;
  isSecureContext?: boolean;
  navigator?: { userAgent?: string; userAgentData?: { mobile?: boolean } | null } | null;
};

/**
 * Chrome/Edge de escritorio o la PWA instalada (FC-D13). En Android Chrome expone parte de la API detrás de flags y
 * el «carpeta de esta computadora» no tiene sentido en un teléfono: mobile → descarga común aunque la función exista.
 * Safari y Firefox no tienen `showDirectoryPicker`. Sin contexto seguro (http en una LAN) la API no está.
 */
export function detectBackupSupport(env: BackupEnv | null | undefined): boolean {
  if (!env || typeof env.showDirectoryPicker !== "function") return false;
  if (env.isSecureContext === false) return false;
  const nav = env.navigator ?? null;
  if (nav?.userAgentData?.mobile === true) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? "")) return false;
  return true;
}

// ─── Escritura ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Forma mínima de los handles de File System Access que usamos. Propia (no `FileSystemDirectoryHandle` de lib.dom):
 * `queryPermission`/`requestPermission`/`entries` no están en el lib de TS, y así el test usa un doble chico.
 */
export type BackupWritable = { write: (data: Blob) => Promise<void>; close: () => Promise<void>; abort?: () => Promise<void> };
export type BackupFileHandle = { kind: "file"; name: string; createWritable: () => Promise<BackupWritable> };
export type BackupDirHandle = {
  kind: "directory";
  name: string;
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<BackupDirHandle>;
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<BackupFileHandle>;
  removeEntry: (name: string) => Promise<void>;
  keys: () => AsyncIterable<string>;
  queryPermission: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission: (d: { mode: "readwrite" }) => Promise<PermissionState>;
};

/**
 * Escribe (o SOBRESCRIBE) el PDF en `<elegida>/Pacientes/<paciente>/<archivo>`. El handle ya tiene que estar
 * autorizado: el permiso se pide en el gesto, en `use-ficha-backup.ts`, antes de cualquier await.
 *
 * - `createWritable()` escribe en un archivo temporal y lo reemplaza recién en `close()`: si el fetch o el disco
 *   fallan a la mitad, queda la copia anterior entera, no un PDF truncado.
 * - Al editar/enmendar cambia el título o la fecha → cambia el nombre. Las copias viejas de la MISMA ficha (mismo
 *   ` [id6].pdf` en la carpeta del paciente) se borran después de escribir la nueva, para que el respaldo no tenga dos
 *   versiones de la misma ficha. Si el paciente se renombró, la copia vieja queda en la carpeta anterior (no se
 *   recorre todo `Pacientes/`: con cientos de pacientes sería un barrido por guardado).
 */
export async function writeBackupFile(root: BackupDirHandle, path: BackupPath, data: Blob): Promise<void> {
  let dir = root;
  for (const seg of path.dirs) dir = await dir.getDirectoryHandle(seg, { create: true });
  const file = await dir.getFileHandle(path.fileName, { create: true });
  const w = await file.createWritable();
  try {
    await w.write(data);
    await w.close();
  } catch (e) {
    await w.abort?.().catch(() => {});
    throw e;
  }
  const stale: string[] = [];
  for await (const name of dir.keys()) {
    if (name !== path.fileName && name.endsWith(path.idSuffix)) stale.push(name);
  }
  for (const name of stale) await dir.removeEntry(name).catch(() => {});
}
