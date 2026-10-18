/**
 * Magic bytes de lo que se sube (T4 FC-2f, contratos C-FC9 y C-FC10; brief §24.2 hallazgo 6). PURO: sin I/O, sin
 * server-only, lo usan `lib/files.ts` (archivos del paciente), `lib/practice-assets.ts` (logo y firma) y el render de
 * FC-2e (`readImageInfo` al embeber).
 *
 * Por qué: hasta T4 el tipo de un archivo del paciente era el `file.type` que manda el navegador, o sea lo que el
 * cliente quiera. Un HTML o un SVG renombrado a `.pdf` con `type: "application/pdf"` pasaba la allow-list y quedaba en
 * el bucket. Con la subida firmada (25 MB, el navegador sube directo a Storage) el server ni siquiera ve los bytes:
 * al confirmar lee los primeros 64 (`storageReadHead`) y los compara contra lo que se declaró. 64 alcanza para todas
 * las firmas de acá (la más lejana es la marca de ISO BMFF en 8..12).
 *
 * No es un antivirus ni un parser: solo garantiza que la FAMILIA del contenido coincide con el MIME declarado, que es
 * lo que decide cómo lo sirve Storage (Content-Type) y cómo lo abre el navegador.
 */

export type FileFamily = "pdf"|"jpeg"|"png"|"webp"|"gif"|"heif"|"mp4"|"mov"|"mp3"|"ole2"|"zip"|"text";

/**
 * Qué familias acepta cada MIME de `ALLOWED_MIME` (`lib/files.ts`). Las claves son EXACTAMENTE esa allow-list (lo fija
 * el test): un MIME sin entrada acá no se puede confirmar.
 *  - mp4 ↔ mov cruzados: es el mismo contenedor (ISO BMFF / QuickTime) y los teléfonos etiquetan uno por el otro
 *    (un .mov de iPhone llega como `video/mp4` en algunos Android y al revés). Los dos son video: no hay riesgo de que
 *    el navegador lo renderice como documento.
 *  - Office viejo (.doc/.xls) es OLE2 y el nuevo (.docx/.xlsx) es ZIP; no se mira adentro del ZIP (un .xlsx renombrado
 *    a .docx pasa, que es inofensivo).
 */
export const PATIENT_FILE_MIME_FAMILIES: Record<string, readonly FileFamily[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/heic": ["heif"],
  "image/heif": ["heif"],
  "video/mp4": ["mp4", "mov"],
  "video/quicktime": ["mov", "mp4"],
  "audio/mpeg": ["mp3"],
  "text/plain": ["text"],
  "application/msword": ["ole2"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["zip"],
  "application/vnd.ms-excel": ["ole2"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["zip"],
};

function startsWith(h: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (h.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (h[at + i] !== sig[i]) return false;
  return true;
}

function ascii(h: Uint8Array, from: number, to: number): string {
  if (h.length < to) return "";
  return String.fromCharCode(...h.subarray(from, to));
}

// Marcas (`ftyp` major brand) de ISO BMFF. HEIF: las de la especificación (fotos de iPhone = `heic`; `mif1`/`msf1`
// son las genéricas de imagen/secuencia). QuickTime = `qt  `. El resto de las que usan cámaras y teléfonos = mp4.
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
const MP4_BRANDS = new Set([
  "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "mp71", "avc1", "M4V ", "M4VP", "dash", "3gp4",
  "3gp5", "3gp6", "3g2a", "MSNV", "XAVC", "f4v ", "mmp4",
]);
// QuickTime viejo sin `ftyp`: el archivo arranca directo con uno de estos átomos.
const MOV_LEADING_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/**
 * Texto plano: sin NUL ni controles (salvo tab, salto de línea, form feed y retorno de carro), UTF-8 válido
 * (tolerando una secuencia multibyte cortada al final de la cabeza, que es lo esperable al leer 64 bytes).
 * Además NO puede arrancar como markup: un `<!doctype html>`/`<svg>` guardado como `text/plain` es justo lo que la
 * allow-list quiere frenar (si algún día cambia el Content-Type con que se sirve, se renderiza).
 */
const MARKUP_RE = /^\s*<(?:!doctype|html|head|body|svg|script|iframe|object|embed|\?xml)/i;

function isPlainText(h: Uint8Array): boolean {
  let i = startsWith(h, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  const start = i;
  scan: while (i < h.length) {
    const b = h[i];
    if (b < 0x80) {
      if (b === 0x7f) return false;
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return false;
      i++;
      continue;
    }
    const n = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1;
    if (n < 0) return false;
    for (let k = 1; k <= n; k++) {
      if (i + k >= h.length) break scan; // cortada al final de la cabeza: no se puede saber, se acepta
      if ((h[i + k] & 0xc0) !== 0x80) return false;
    }
    i += n + 1;
  }
  if (i === start) return false;
  return !MARKUP_RE.test(new TextDecoder("utf-8", { fatal: false }).decode(h.subarray(start)));
}

/** MPEG audio layer III: frame sync de 11 bits, versión ≠ reservada, capa = III. */
function isMp3Frame(h: Uint8Array): boolean {
  if (h.length < 2 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return false;
  const version = (h[1] >> 3) & 0b11;
  const layer = (h[1] >> 1) & 0b11;
  return version !== 0b01 && layer === 0b01;
}

/** Familia del contenido por sus primeros bytes; `null` = vacío o desconocido (se rechaza). */
export function sniffFileFamily(head: Uint8Array): FileFamily | null {
  if (!head || head.length === 0) return null;
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "webp";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "gif";
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12);
    if (HEIF_BRANDS.has(brand)) return "heif";
    if (brand === "qt  ") return "mov";
    if (MP4_BRANDS.has(brand)) return "mp4";
    return null;
  }
  if (MOV_LEADING_ATOMS.has(ascii(head, 4, 8))) return "mov";
  if (ascii(head, 0, 3) === "ID3" || isMp3Frame(head)) return "mp3";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole2";
  // Solo el header de un archivo local: `PK\x05\x06` es un ZIP vacío (un Office real nunca lo es).
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (isPlainText(head)) return "text";
  return null;
}

/** ¿Los bytes son de una familia que el MIME declarado acepta? MIME fuera de la tabla → false. */
export function headMatchesMime(mime: string, head: Uint8Array): boolean {
  const families = PATIENT_FILE_MIME_FAMILIES[mime.toLowerCase()];
  if (!families) return false;
  const fam = sniffFileFamily(head);
  return fam !== null && families.includes(fam);
}

// ─── Logo y firma (C-FC9) ───────────────────────────────────────────────────────────────────────────────────────────
// Viven acá y no en `lib/practice-assets.ts` porque ese archivo es `"use server"` (solo exporta funciones async) y
// el render de FC-2e también los necesita para validar lo que baja de Storage antes de embeberlo.

export const PRACTICE_ASSET_LIMITS = { logo: { maxBytes: 1_048_576, maxPx: 3000 }, signature: { maxBytes: 524_288, maxPx: 2000 } };
export type PracticeAssetKind = keyof typeof PRACTICE_ASSET_LIMITS;

function u32be(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}
function u16be(b: Uint8Array, at: number): number {
  return (b[at] << 8) + b[at + 1];
}

/**
 * PNG o JPEG con sus dimensiones; `null` si no es ninguno de los dos o está roto. Solo PNG/JPEG porque son los únicos
 * que embebe react-pdf y que `docx` acepta sin convertir; WEBP, GIF, HEIC y SVG (que además es markup) quedan afuera.
 *  - PNG: el primer chunk tiene que ser IHDR (ancho y alto en 16..24).
 *  - JPEG: se recorren los segmentos hasta el primer SOFn (C0..CF menos C4 DHT, C8 JPG y CC DAC); si aparece SOS o EOI
 *    antes, no hay dimensiones y es null.
 */
export function readImageInfo(bytes: Uint8Array): { mime: "image/png" | "image/jpeg"; width: number; height: number } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return null;
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width > 0 && height > 0 ? { mime: "image/png", width, height } : null;
  }
  if (!startsWith(bytes, [0xff, 0xd8])) return null;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    while (i < bytes.length && bytes[i] === 0xff) i++; // bytes de relleno
    if (i >= bytes.length) return null;
    const marker = bytes[i++];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // sin largo
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS antes de un SOF
    if (i + 2 > bytes.length) return null;
    const len = u16be(bytes, i);
    if (len < 2 || i + len > bytes.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) return null;
      const height = u16be(bytes, i + 3);
      const width = u16be(bytes, i + 5);
      return width > 0 && height > 0 ? { mime: "image/jpeg", width, height } : null;
    }
    i += len;
  }
  return null;
}

export const PRACTICE_ASSET_COPY = {
  logoFormat: "Subí el logo en PNG o JPG (hasta 1 MB).",
  signatureFormat: "La firma tiene que ser PNG o JPG (hasta 512 KB). Mejor en PNG con fondo transparente.",
  fake: "El archivo no es lo que dice ser.",
  tooBig: (n: number) => `La imagen es demasiado grande (máximo ${n} × ${n} px).`,
} as const;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg"]);

/**
 * Valida un logo o una firma ANTES de subir nada (C-FC9: «escribible → chequeo → upload»). El MIME declarado tiene que
 * ser PNG/JPEG y coincidir con los bytes; un `type` que dice PNG con bytes de JPEG (o al revés) es «no es lo que dice
 * ser», igual que un SVG o un HEIC disfrazado. `declaredMime` vacío (algunos navegadores no lo mandan) se acepta y
 * manda lo que digan los bytes.
 */
export function checkPracticeAsset(
  kind: PracticeAssetKind,
  bytes: Uint8Array,
  declaredMime: string,
): { ok: true; mime: "image/png" | "image/jpeg"; ext: "png" | "jpg"; width: number; height: number } | { ok: false; error: string } {
  const limits = PRACTICE_ASSET_LIMITS[kind];
  const formatCopy = kind === "logo" ? PRACTICE_ASSET_COPY.logoFormat : PRACTICE_ASSET_COPY.signatureFormat;
  if (bytes.length === 0 || bytes.length > limits.maxBytes) return { ok: false, error: formatCopy };
  const declared = declaredMime.trim().toLowerCase();
  if (declared && !IMAGE_MIMES.has(declared)) return { ok: false, error: formatCopy };
  const info = readImageInfo(bytes);
  if (!info) return { ok: false, error: declared ? PRACTICE_ASSET_COPY.fake : formatCopy };
  const declaredPng = declared === "image/png";
  if (declared && declaredPng !== (info.mime === "image/png")) return { ok: false, error: PRACTICE_ASSET_COPY.fake };
  if (info.width > limits.maxPx || info.height > limits.maxPx) {
    return { ok: false, error: PRACTICE_ASSET_COPY.tooBig(limits.maxPx) };
  }
  return { ok: true, mime: info.mime, ext: info.mime === "image/png" ? "png" : "jpg", width: info.width, height: info.height };
}
