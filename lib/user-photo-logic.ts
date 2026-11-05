/**
 * CF3b PH-S (M24 `cf3_practitioner_photo`, pedido de Martin del 05-nov): lógica PURA de la foto que cada persona sube.
 * Sin I/O ni `server-only`: la usan las actions (`lib/user-photo.ts`), los lectores (`lib/user-photo-internal.ts`,
 * `getPublicClinic`, la sede, el loader de Configuración), las dos rutas que sirven los bytes y el layout de la app.
 *
 * Qué es la foto (MIG3, contrato FOTO):
 *   - De la PERSONA (`UserProfile.photoStorageKey/photoUpdatedAt`), una para todos sus consultorios: avatar en la app
 *     (sin flag: ahí la ve solo el equipo) y, con `Practitioner.showPhotoPublic` de CADA consultorio (opt-in, default
 *     false), en el turnero y la sede de ese consultorio. Nunca `UserProfile.avatarUrl` (URL de Google/Facebook que el
 *     login pisa): una persona sin foto subida sale con iniciales.
 *   - Objeto del bucket PRIVADO `practice-assets` por el canal service, clave `users/<userId>/photo/<nonce>.<ext>`. La
 *     base (CHECK `UserProfile_photoStorageKey_check`) exige el prefijo del propio id: `isUserPhotoKeyFor` es su espejo
 *     para no armar ni servir algo que la base rechazaría (o que una fila tocada a mano apunte a la firma de alguien).
 *   - URLs con `?v=<photoUpdatedAt ms>`: cambiar o borrar la foto cambia la URL sola (`nextPhotoStamp` garantiza que la
 *     versión nueva sea siempre mayor que la anterior). La PROPIA (`/api/me/photo`) se sirve `private, immutable` por un
 *     año; la PÚBLICA (`/api/public/pro-photo`) se cachea UN DÍA sin `immutable` (CF3 ZF4a: retirar el opt-in o la
 *     foto tiene que dejar de verse, Ley 25.326; ver la cabecera de esa ruta).
 *
 * Qué se valida al subir (`checkUserPhoto`): PNG o JPEG por magic bytes (`readImageInfo`, el mismo lector del logo y la
 * firma), ≤ 1 MB (el límite del bucket) y ≤ 2048 px por lado. El tope de píxeles no es estético: 1 MB de PNG puede
 * declarar 20000 × 20000 y cada visitante del turnero lo decodificaría a 1,6 GB. El cliente ya la reduce a 512 × 512
 * con canvas (PH-U2); 2048 deja margen si ese paso no corrió, sin abrir la bomba.
 *
 * `stripImageMetadata`: la foto se publica, y una foto de teléfono trae EXIF con GPS (la casa de la persona), XMP,
 * comentarios y, a veces, bytes pegados después del final (un polyglot ZIP/HTML). El canvas del cliente ya los saca,
 * pero el server no confía en el cliente: copia solo los segmentos/chunks que hacen a la imagen y corta en el EOI/IEND.
 */
import { readImageInfo } from "@/lib/file-sniff";

/** Bucket privado donde vive la foto (el mismo del logo y la firma; EXTERNAL-CONFIG: 1 MB, png/jpeg). */
export const USER_PHOTO_BUCKET = "practice-assets" as const;

export const USER_PHOTO_LIMITS = { maxBytes: 1_048_576, maxPx: 2048 } as const;

/** Ruta autenticada de la foto propia (avatar en la app). */
export const OWN_PHOTO_PATH = "/api/me/photo";
/** Ruta pública de la foto de un profesional (turnero y sede), por `practitionerId`. */
export const PUBLIC_PRO_PHOTO_PATH = "/api/public/pro-photo";

/** Subidas por usuario: es un formulario de una imagen; corta un script que llene el bucket a fuerza de reemplazos. */
export const USER_PHOTO_UPLOAD_RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;
/** Descargas de bytes de la foto propia por usuario (el navegador la guarda un año: uso normal ≈ 1 por versión). */
export const OWN_PHOTO_BYTES_RATE_LIMIT = { limit: 120, windowMs: 10 * 60_000 } as const;
/**
 * Descargas de bytes de fotos públicas por IP. Solo cuenta el camino que baja de Storage (`?v` vigente y nada más), que
 * el navegador y el CDN cachean un día (CF3 ZF4a): corta un bucle sin cache, no a un turnero con 10 profesionales
 * detrás de un NAT. CF3 ZF5: el logo público de la sede (`/<slug>/logo`) usa el mismo cupo con su propia clave.
 */
export const PUBLIC_PHOTO_BYTES_RATE_LIMIT = { limit: 300, windowMs: 10 * 60_000 } as const;

export const USER_PHOTO_COPY = {
  format: "Subí la foto en PNG o JPG (hasta 1 MB).",
  fake: "El archivo no es lo que dice ser.",
  tooBig: `La foto es demasiado grande (máximo ${USER_PHOTO_LIMITS.maxPx} × ${USER_PHOTO_LIMITS.maxPx} px).`,
  missing: "Elegí una foto.",
  noSession: "Tu sesión venció. Volvé a entrar.",
  disabled: "Tu cuenta está deshabilitada.",
  pending2fa: "Primero terminá de verificar tu acceso.",
  noMembership: "Para subir tu foto tenés que estar en un consultorio.",
  noStorage: "Las imágenes no se pueden guardar en este entorno.",
  saveFailed: "No pudimos guardar la foto. Probá de nuevo.",
  removeFailed: "No pudimos sacar la foto. Probá de nuevo.",
  ownOnly: "La foto en el turnero es solo para profesionales que atienden en el consultorio.",
  supportDenied: "Entraste como soporte: la foto del profesional la cambia solo él.",
  invalid: "Pedido inválido.",
  notFound: "No encontramos tu ficha de profesional en este consultorio.",
} as const;

// ── Versión y URLs ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Versión de la foto para la URL (`photoUpdatedAt` en ms); null = sin foto. */
export function photoVersion(at: Date | null | undefined): string | null {
  if (!at) return null;
  const ms = at.getTime();
  return Number.isFinite(ms) ? String(ms) : null;
}

/** URL relativa de la foto propia (avatar), o null sin foto. Única fuente del formato: la ruta redirige a esta. */
export function ownPhotoUrl(at: Date | null | undefined): string | null {
  const v = photoVersion(at);
  return v ? `${OWN_PHOTO_PATH}?v=${v}` : null;
}

/**
 * Avatar propio desde las columnas de M24. `photoStorageKey` es opcional a propósito: el CHECK `UserProfile_photo_check`
 * ata las dos columnas (las dos o ninguna), así que alcanza con `photoUpdatedAt` si el lector solo trae esa (p. ej. la
 * foto de acceso). Si viene y es null, no hay foto aunque haya fecha (una fila rota no promete una imagen).
 */
export function ownPhotoUrlFor(user: { photoStorageKey?: string | null; photoUpdatedAt: Date | null } | null | undefined): string | null {
  if (!user) return null;
  if (user.photoStorageKey === null) return null;
  return ownPhotoUrl(user.photoUpdatedAt);
}

/**
 * Forma de un id de Practitioner (cuid de Prisma). Fuera de forma → 404 sin tocar la base (no es el id de nadie), y nunca
 * llega a una URL ni a un path: sin «/», «.», «%» ni espacios.
 */
export function isPractitionerIdShape(s: string): boolean {
  return typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);
}

/** URL relativa de la foto pública de un profesional, o null. No mira el opt-in: para eso `publicProPhotoUrlFor`. */
export function publicProPhotoUrl(practitionerId: string, at: Date | null | undefined): string | null {
  const v = photoVersion(at);
  if (!v || !isPractitionerIdShape(practitionerId)) return null;
  return `${PUBLIC_PRO_PHOTO_PATH}/${practitionerId}?v=${v}`;
}

/** Lo que publican el turnero y la sede: SOLO con `showPhotoPublic` (opt-in de ese consultorio) Y una foto subida. */
export function publicProPhotoUrlFor(p: { id: string; showPhotoPublic: boolean; photoUpdatedAt: Date | null | undefined }): string | null {
  return p.showPhotoPublic === true ? publicProPhotoUrl(p.id, p.photoUpdatedAt) : null;
}

/**
 * ¿El pedido es EXACTAMENTE `?v=<vigente>`? Solo esa URL baja bytes de Storage (y se cachea: un año la foto propia y el
 * logo de la sede, un día la foto pública). Cualquier otra
 * (sin `v`, vieja, al azar, o con un parámetro de más) recibe un 308 a la canónica: cada query distinta es otra clave
 * de CDN, y sin este corte `?v=<vigente>&x=<random>` bajaría el objeto en cada request.
 */
export function isCanonicalPhotoQuery(params: URLSearchParams, current: string): boolean {
  const entries = [...params.entries()];
  return entries.length === 1 && entries[0][0] === "v" && entries[0][1] === current;
}

/**
 * Fecha de la foto nueva: ahora, o 1 ms después de la anterior si el reloj de esta instancia quedó atrás. Si la versión
 * nueva coincidiera con la vieja, el navegador y el CDN seguirían sirviendo los bytes viejos (la URL propia es
 * `immutable` por un año y la pública se cachea un día).
 */
export function nextPhotoStamp(prev: Date | null | undefined, now: Date): Date {
  const p = prev?.getTime();
  return p !== undefined && Number.isFinite(p) && p >= now.getTime() ? new Date(p + 1) : now;
}

// ── Clave del objeto (espejo del CHECK de M24) ───────────────────────────────────────────────────────────────────────

const KEY_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const KEY_SHAPE = /^users(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
const KEY_MAX = 200;

/**
 * ¿`key` es una clave de foto de ESTE usuario? Lo mismo que `UserProfile_photoStorageKey_check`: empieza con
 * `users/<userId>/`, mide ≤ 200 y cada segmento es `[A-Za-z0-9._-]` sin empezar con «.» (ni «..», ni vacío, ni barra
 * final). Las rutas lo re-chequean antes de bajar el objeto: defensa en profundidad si una fila se tocó a mano.
 */
export function isUserPhotoKeyFor(userId: string, key: string): boolean {
  if (typeof key !== "string" || typeof userId !== "string" || !KEY_SEGMENT.test(userId)) return false;
  return key.length <= KEY_MAX && key.startsWith(`users/${userId}/`) && KEY_SHAPE.test(key);
}

/**
 * Clave nueva `users/<userId>/photo/<nonce>.<ext>` (nonce hex del server: nunca se pisa un objeto y una URL vieja no
 * apunta a la foto nueva). null si el id no es un segmento seguro o la clave no pasaría el CHECK (se rechaza la subida
 * ANTES de subir nada).
 */
export function userPhotoKey(userId: string, nonceHex: string, ext: "png" | "jpg"): string | null {
  if (typeof userId !== "string" || !KEY_SEGMENT.test(userId)) return null;
  if (!/^[0-9a-f]{16,64}$/.test(nonceHex) || (ext !== "png" && ext !== "jpg")) return null;
  const key = `users/${userId}/photo/${nonceHex}.${ext}`;
  return isUserPhotoKeyFor(userId, key) ? key : null;
}

// ── Validación y limpieza de la imagen ───────────────────────────────────────────────────────────────────────────────

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg"]);

export type UserPhotoCheck =
  | { ok: true; mime: "image/png" | "image/jpeg"; ext: "png" | "jpg"; width: number; height: number }
  | { ok: false; error: string };

/**
 * Valida la foto ANTES de subir nada. Mismo criterio que `checkPracticeAsset` (lib/file-sniff.ts) con los topes de la
 * foto: el MIME declarado tiene que ser PNG/JPEG y coincidir con los bytes; vacío (algunos navegadores no lo mandan) se
 * acepta y mandan los bytes.
 */
export function checkUserPhoto(bytes: Uint8Array, declaredMime: string): UserPhotoCheck {
  if (!bytes || bytes.length === 0 || bytes.length > USER_PHOTO_LIMITS.maxBytes) return { ok: false, error: USER_PHOTO_COPY.format };
  const declared = (declaredMime ?? "").trim().toLowerCase();
  if (declared && !IMAGE_MIMES.has(declared)) return { ok: false, error: USER_PHOTO_COPY.format };
  const info = readImageInfo(bytes);
  if (!info) return { ok: false, error: declared ? USER_PHOTO_COPY.fake : USER_PHOTO_COPY.format };
  if (declared && (declared === "image/png") !== (info.mime === "image/png")) return { ok: false, error: USER_PHOTO_COPY.fake };
  if (info.width > USER_PHOTO_LIMITS.maxPx || info.height > USER_PHOTO_LIMITS.maxPx) {
    return { ok: false, error: USER_PHOTO_COPY.tooBig };
  }
  return { ok: true, mime: info.mime, ext: info.mime === "image/png" ? "png" : "jpg", width: info.width, height: info.height };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function startsWithAscii(b: Uint8Array, at: number, s: string): boolean {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

/**
 * JPEG: de SOI al primer SOS copia los segmentos de la imagen y descarta APP1 (EXIF/XMP), APP3..APP13, APP15, COM y el
 * APP2 que no sea ICC_PROFILE (FlashPix guarda metadatos). Se quedan APP0 (JFIF), APP2 ICC y APP14 (Adobe: dice cómo
 * leer los colores). Del SOS en adelante copia el scan tal cual hasta el EOI (en los datos comprimidos un 0xFF va como
 * FF00, así que el primer FFD9 es el final) y corta lo que siga. Estructura rota → null.
 */
function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    let m = i + 1;
    while (m < b.length && b[m] === 0xff) m++; // relleno entre segmentos
    if (m >= b.length) return null;
    const marker = b[m];
    if (marker === 0xd9) {
      parts.push(new Uint8Array([0xff, 0xd9]));
      return concat(parts);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(new Uint8Array([0xff, marker]));
      i = m + 1;
      continue;
    }
    if (m + 3 > b.length) return null;
    const len = (b[m + 1] << 8) + b[m + 2];
    const end = m + 1 + len;
    if (len < 2 || end > b.length) return null;
    if (marker === 0xda) {
      // Cabecera del SOS + datos comprimidos (con los RST y, en progresivos, más DHT/SOS adentro) hasta el EOI.
      let j = end;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] === 0xd9)) j++;
      if (j + 1 >= b.length) return null; // sin EOI: archivo cortado
      parts.push(new Uint8Array([0xff, 0xda]), b.subarray(m + 1, j + 2));
      return concat(parts);
    }
    const payloadAt = m + 3;
    const drop =
      marker === 0xfe ||
      marker === 0xe1 ||
      (marker >= 0xe3 && marker <= 0xed) ||
      marker === 0xef ||
      (marker === 0xe2 && !startsWithAscii(b, payloadAt, "ICC_PROFILE\0"));
    if (!drop) parts.push(new Uint8Array([0xff, marker]), b.subarray(m + 1, end));
    i = end;
  }
  return null; // sin SOS ni EOI
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks de texto/metadatos (autor, comentarios, XMP, EXIF con GPS, fecha). Todo lo demás hace a la imagen. */
const PNG_DROP = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

/** PNG: copia los chunks enteros (con su CRC) salvo los de metadatos y corta después del IEND. Rota → null. */
function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIGNATURE.some((x, k) => b[k] !== x)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const end = i + 12 + len;
    if (len > b.length || end > b.length) return null;
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (!PNG_DROP.has(type)) parts.push(b.subarray(i, end));
    if (type === "IEND") return concat(parts);
    i = end;
  }
  return null; // sin IEND
}

/** La imagen sin metadatos ni bytes de más (ver la cabecera). null = estructura rota: la subida se rechaza. */
export function stripImageMetadata(bytes: Uint8Array, mime: "image/png" | "image/jpeg"): Uint8Array | null {
  return mime === "image/png" ? stripPng(bytes) : stripJpeg(bytes);
}
