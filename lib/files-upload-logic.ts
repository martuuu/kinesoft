/**
 * Subida firmada desde la pestaña Archivos (T4 FC-4b, contrato C-FC10; brief §24.8). PURO salvo `putWithXhr`, que usa
 * el `XMLHttpRequest` del navegador (inyectable para el test). Lo importa `components/patients/archivos-view.tsx`.
 *
 * Por qué existe: el tope de 25 MB de los archivos del paciente era inalcanzable (el body de una server action corta
 * en 4,5 MB, `next.config.mjs`). Ahora el navegador sube directo a Storage:
 *   `requestPatientFileUpload` → PUT a la URL firmada → `confirmPatientFileUpload(token)`.
 * Con `{ mode: "stub" }` (sin Storage, o interruptor `PATIENT_FILES_SIGNED_UPLOAD` apagado) vuelve a `uploadPatientFile`.
 *
 * Decisiones:
 *  - XHR y no `fetch`: `fetch` no informa progreso de SUBIDA (los streams de request no andan en Safari/Firefox) y la
 *    barra es lo único que le dice a la persona que un video de 20 MB por 4G sigue avanzando.
 *  - Sin supabase-js: `uploadToSignedUrl` arma un multipart y suma el cliente de Storage al bundle de `/pacientes/[id]`;
 *    la URL firmada ya trae el token, alcanza con un PUT del binario.
 *  - `Content-Type` del PUT = MIME declarado al pedir la firma: es con el que Storage guarda y sirve el objeto, y
 *    `confirm` lo compara contra el token (si no coincide, rechaza y borra).
 *  - La validación previa es una cortesía (no gastar 25 MB de datos para que el server diga que no): el server repite
 *    todo y además mira los magic bytes. Por eso la allow-list de acá es copia de `ALLOWED_MIME` (`lib/files.ts`, que
 *    es "use server" y no puede exportar la constante) y el test la fija contra `PATIENT_FILE_MIME_FAMILIES`.
 */
import type { PatientFileCategory } from "@prisma/client";
import type { ActionResult } from "@/lib/validation";
import { PATIENT_FILE_MAX_BYTES, type PatientFileUploadTicket } from "@/lib/files-types";

/** Copia de `ALLOWED_MIME` de `lib/files.ts` (ver cabecera). */
export const PATIENT_FILE_UPLOAD_MIMES: readonly string[] = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const MIME_SET = new Set(PATIENT_FILE_UPLOAD_MIMES);

/**
 * Camino viejo (`uploadPatientFile`): el archivo viaja en el body de la action, que corta en 4,5 MB con los campos del
 * form. Más de 4 MB en modo stub se frena acá en vez de ver un error genérico de Next.
 */
export const STUB_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
/** Mismo tope que `MAX_FILE_NAME` de `lib/files.ts`. */
const MAX_FILE_NAME = 255;

/**
 * Copy del cliente. Los errores del server (bloque «Subida firmada» de `lib/files.ts`: venció, no coincide, llegó
 * vacío, no es lo que dice ser…) llegan en `r.error` y se muestran tal cual; `tooBig` es el mismo texto que el server.
 */
export const UPLOAD_COPY = {
  tooBig: "El archivo no puede superar 25 MB.",
  stubTooBig: "En este entorno los archivos pueden pesar hasta 4 MB.",
  empty: "El archivo está vacío. Elegí otro.",
  badType: "Ese tipo de archivo no se puede subir. Probá con PDF, imagen, video, audio, texto, Word o Excel.",
  badName: "El nombre del archivo no es válido. Renombralo y probá de nuevo.",
  noFile: "Elegí un archivo.",
  putFailed: "No pudimos subir el archivo. Probá de nuevo.",
  network: "Se cortó la conexión. Revisá tu internet y probá de nuevo.",
  cancelled: "Subida cancelada.",
  // T4-Z (pestaña Archivos): un error de la lista se veía igual que «Sin archivos cargados» (y el profesional creía
  // que no había nada); la subida terminaba sin ningún aviso.
  uploaded: "Archivo subido",
  listFailed: "No pudimos cargar los archivos. Probá de nuevo.",
  retry: "Reintentar",
} as const;

/**
 * Extensión → MIME cuando el navegador no manda `file.type` (HEIC en Windows/Chrome, .doc sin Office instalado): sin
 * esto el archivo llegaba como `application/octet-stream` y se rechazaba aunque fuera válido. Los magic bytes del
 * server siguen decidiendo.
 */
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
/** Alias no estándar que mandan algunos navegadores/SO para tipos que sí aceptamos. */
const MIME_ALIAS: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "audio/mp3": "audio/mpeg",
};

/** MIME que se declara al pedir la firma. `null` = no se pudo deducir. */
export function resolveUploadMime(fileName: string, browserType: string): string | null {
  const t = (browserType || "").split(";")[0].trim().toLowerCase();
  if (t && t !== "application/octet-stream") return MIME_ALIAS[t] ?? t;
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  return EXT_MIME[ext] ?? null;
}

export type UploadValidation = { ok: true; mime: string } | { ok: false; error: string };

export function validateUploadFile(f: { name: string; size: number; type: string }): UploadValidation {
  const name = f.name.trim();
  if (!name || name.length > MAX_FILE_NAME) return { ok: false, error: UPLOAD_COPY.badName };
  if (f.size <= 0) return { ok: false, error: UPLOAD_COPY.empty };
  if (f.size > PATIENT_FILE_MAX_BYTES) return { ok: false, error: UPLOAD_COPY.tooBig };
  const mime = resolveUploadMime(name, f.type);
  if (!mime || !MIME_SET.has(mime)) return { ok: false, error: UPLOAD_COPY.badType };
  return { ok: true, mime };
}

export function uploadProgressPercent(loaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

/** `total = 0` en `uploading` = progreso desconocido (camino stub: la action no informa avance). */
export type UploadState =
  | { phase: "requesting" }
  | { phase: "uploading"; loaded: number; total: number }
  | { phase: "confirming" }
  | { phase: "done" };

export type UploadOutcome = { kind: "done"; id: string } | { kind: "error"; message: string } | { kind: "cancelled" };

export type PutResult = { ok: true } | { ok: false; error: string; aborted?: boolean };

export type UploadDeps = {
  request: (input: {
    patientId: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
    category?: PatientFileCategory;
  }) => Promise<ActionResult<PatientFileUploadTicket>>;
  put: (
    url: string,
    file: Blob,
    mime: string,
    onProgress: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ) => Promise<PutResult>;
  confirm: (input: { confirmToken: string; description?: string | null }) => Promise<ActionResult<{ id: string; replayed: boolean }>>;
  uploadStub: (formData: FormData) => Promise<ActionResult<{ id: string }>>;
};

/**
 * request → put → confirm. Nunca tira: una action que rechaza (red caída) termina en `error`, así la UI no queda en
 * «Subiendo…». Cancelar corta antes del PUT o aborta el PUT; durante `confirming` ya no se cancela (el server está
 * moviendo el objeto: cortar ahí dejaría la duda de si quedó guardado). Lo que quede en `pending/` lo barre el cron.
 */
export async function runPatientFileUpload(
  deps: UploadDeps,
  input: { patientId: string; file: File; category: PatientFileCategory; description: string },
  onState: (s: UploadState) => void,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  const { file } = input;
  const v = validateUploadFile(file);
  if (!v.ok) return { kind: "error", message: v.error };
  const description = input.description.trim();

  try {
    onState({ phase: "requesting" });
    const ticket = await deps.request({
      patientId: input.patientId,
      fileName: file.name.trim(),
      mime: v.mime,
      sizeBytes: file.size,
      category: input.category,
    });
    if (signal?.aborted) return { kind: "cancelled" };
    if (!ticket.ok) return { kind: "error", message: ticket.error };

    if (ticket.data.mode === "stub") {
      if (file.size > STUB_UPLOAD_MAX_BYTES) return { kind: "error", message: UPLOAD_COPY.stubTooBig };
      onState({ phase: "uploading", loaded: 0, total: 0 });
      const fd = new FormData();
      fd.set("file", file);
      fd.set("category", input.category);
      if (description) fd.set("description", description);
      const r = await deps.uploadStub(fd);
      if (!r.ok) return { kind: "error", message: r.error };
      onState({ phase: "done" });
      return { kind: "done", id: r.data.id };
    }

    onState({ phase: "uploading", loaded: 0, total: file.size });
    const put = await deps.put(
      ticket.data.uploadUrl,
      file,
      v.mime,
      (loaded, total) => onState({ phase: "uploading", loaded, total }),
      signal,
    );
    if (!put.ok) return put.aborted || signal?.aborted ? { kind: "cancelled" } : { kind: "error", message: put.error };
    if (signal?.aborted) return { kind: "cancelled" };

    onState({ phase: "confirming" });
    const c = await deps.confirm({ confirmToken: ticket.data.confirmToken, description: description || null });
    if (!c.ok) return { kind: "error", message: c.error };
    onState({ phase: "done" });
    return { kind: "done", id: c.data.id };
  } catch {
    return { kind: "error", message: UPLOAD_COPY.network };
  }
}

type XhrLike = {
  open(method: string, url: string): void;
  setRequestHeader(k: string, v: string): void;
  send(body: Blob): void;
  abort(): void;
  status: number;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

/** PUT del binario a la URL firmada de Storage, con progreso y abort. */
export function putWithXhr(
  url: string,
  file: Blob,
  mime: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
  Xhr: new () => XhrLike = XMLHttpRequest as unknown as new () => XhrLike,
): Promise<PutResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: UPLOAD_COPY.cancelled, aborted: true });
  return new Promise((resolve) => {
    const xhr = new Xhr();
    const onAbortSignal = () => xhr.abort();
    const finish = (r: PutResult) => {
      signal?.removeEventListener("abort", onAbortSignal);
      resolve(r);
    };
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mime);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return finish({ ok: true });
      // 413: el bucket tiene un tope menor que 25 MB (config de la consola); el resto (token vencido, CORS) es genérico.
      finish({ ok: false, error: xhr.status === 413 ? UPLOAD_COPY.tooBig : UPLOAD_COPY.putFailed });
    };
    xhr.onerror = () => finish({ ok: false, error: UPLOAD_COPY.network });
    xhr.onabort = () => finish({ ok: false, error: UPLOAD_COPY.cancelled, aborted: true });
    signal?.addEventListener("abort", onAbortSignal);
    xhr.send(file);
  });
}
