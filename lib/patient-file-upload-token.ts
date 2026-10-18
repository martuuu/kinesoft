import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { PATIENT_FILE_MAX_BYTES, PATIENT_FILE_UPLOAD_TTL_S, type PatientFileUploadClaims } from "@/lib/files-types";

/**
 * Token de confirmación de la subida firmada de archivos del paciente (T4 FC-2f, C-FC10; FC-D29). Molde
 * `lib/portal-invite-token.ts`.
 *
 * Por qué hace falta: con la subida firmada el navegador sube directo a Storage (`pending/{tenant}/{fileId}`) y después
 * llama a `confirmPatientFileUpload`. Entre las dos cosas el server no guarda estado (no hay tabla de «subidas en
 * curso»): TODO lo que `confirm` necesita (consultorio, paciente, id del archivo, MIME y tamaño declarados, quién subió)
 * viaja en este token firmado. Sin la firma, el cliente podría confirmar con el `fileId` de OTRO consultorio y mover su
 * objeto a una ficha propia, o declarar `text/plain` y subir un HTML. Las claves de Storage se derivan del token, nunca
 * de lo que mande el cliente al confirmar.
 *
 * Valor: `base64url(JSON) + "." + HMAC-SHA256` en base64url.
 *  - Clave derivada de `SUPABASE_SERVICE_ROLE_KEY` con etiqueta propia `kinesoft:patient-file-upload:v1` (sin variable
 *    nueva, FC-D29): un token de invitación al portal, de recovery o de 2FA nunca valida acá (lo cubre el test).
 *  - Comparación del MAC en tiempo constante; tope de 2048 caracteres antes de decodificar.
 *  - `exp` = emisión + `PATIENT_FILE_UPLOAD_TTL_S` (15 min). La URL firmada de Supabase vale 2 h y no se puede acortar:
 *    el vencimiento real lo pone este token (confirm después de 15 min → se rechaza y el objeto lo barre el cron).
 *  - Los ids que terminan en la clave de Storage se validan con un charset sin `/` ni `.`: aunque la firma ya impide
 *    fabricarlos, un id raro no puede armar una ruta fuera de `{tenant}/{patient}/`.
 *  - Nadie loguea el token.
 *
 * Sin service key (dev sin Supabase) se usa una clave aleatoria por proceso: en ese entorno tampoco hay subida firmada
 * (`requestPatientFileUpload` devuelve `{ mode: "stub" }`).
 */
const LABEL = "kinesoft:patient-file-upload:v1";
const MAX_TOKEN_LEN = 2048;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_ID_RE = /^[0-9a-f]{24}$/;
const MAX_NAME_LEN = 255;
const MAX_MIME_LEN = 127;
const CATEGORIES = new Set(["REPORT", "DERIVATION", "CONSENT", "IMAGE", "RECEIPT", "OTHER"]);

let devKey: Buffer | null = null;
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update(LABEL).digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(payload: string): string {
  return createHmac("sha256", hmacKey()).update(payload).digest("base64url");
}

function validClaims(c: Record<string, unknown>): c is PatientFileUploadClaims {
  return (
    typeof c.tenantId === "string" && ID_RE.test(c.tenantId) &&
    typeof c.patientId === "string" && ID_RE.test(c.patientId) &&
    typeof c.userId === "string" && c.userId.length > 0 && c.userId.length <= 128 &&
    typeof c.fileId === "string" && FILE_ID_RE.test(c.fileId) &&
    typeof c.mime === "string" && c.mime.length > 0 && c.mime.length <= MAX_MIME_LEN &&
    typeof c.fileName === "string" && c.fileName.length > 0 && c.fileName.length <= MAX_NAME_LEN &&
    typeof c.category === "string" && CATEGORIES.has(c.category) &&
    typeof c.sizeBytes === "number" && Number.isInteger(c.sizeBytes) && c.sizeBytes > 0 &&
    c.sizeBytes <= PATIENT_FILE_MAX_BYTES &&
    typeof c.exp === "number" && Number.isInteger(c.exp)
  );
}

export function makePatientFileUploadToken(c: Omit<PatientFileUploadClaims, "exp">, nowMs = Date.now()): string {
  const claims = { ...c, exp: Math.floor(nowMs / 1000) + PATIENT_FILE_UPLOAD_TTL_S };
  if (!validClaims(claims)) throw new Error("[patient-file-upload-token] claims inválidos");
  const payload = Buffer.from(
    JSON.stringify({
      t: claims.tenantId,
      p: claims.patientId,
      f: claims.fileId,
      m: claims.mime,
      s: claims.sizeBytes,
      c: claims.category,
      n: claims.fileName,
      u: claims.userId,
      x: claims.exp,
    }),
  ).toString("base64url");
  const token = `${payload}.${sign(payload)}`;
  // Un nombre de 255 caracteres multibyte puede pasar el tope: mejor fallar al emitir que emitir algo que no valida.
  if (token.length > MAX_TOKEN_LEN) throw new Error("[patient-file-upload-token] token demasiado largo");
  return token;
}

/** null si la firma no valida, venció, el `exp` es más lejano que el TTL o está mal formado. No mira la base. */
export function readPatientFileUploadToken(token: string | null | undefined, nowMs = Date.now()): PatientFileUploadClaims | null {
  if (!token || typeof token !== "string" || token.length > MAX_TOKEN_LEN) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  if (!payload || !mac) return null;

  // Firma primero: no se parsea nada que no hayamos firmado nosotros.
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const claims: Record<string, unknown> = {
    tenantId: r.t,
    patientId: r.p,
    fileId: r.f,
    mime: r.m,
    sizeBytes: r.s,
    category: r.c,
    fileName: r.n,
    userId: r.u,
    exp: r.x,
  };
  if (!validClaims(claims)) return null;
  if (claims.exp * 1000 <= nowMs) return null;
  if (claims.exp * 1000 > nowMs + PATIENT_FILE_UPLOAD_TTL_S * 1000 + 5_000) return null;
  return claims;
}
