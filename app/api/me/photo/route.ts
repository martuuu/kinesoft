/**
 * CF3b PH-S (M24, contrato FOTO): la foto PROPIA, `GET /api/me/photo?v=<photoUpdatedAt ms>`. Es el avatar del shell de
 * la app (`AppShell userPhotoUrl`, la URL la arma `ownPhotoUrl`/`ownPhotoUrlFor` de lib/user-photo-logic.ts) y la vista
 * previa de «Mi agenda».
 *
 * Por qué una ruta y no una URL firmada de Storage: el bucket `practice-assets` es PRIVADO y una URL firmada vence, así
 * que el navegador no la podría cachear y cada página bajaría la foto de nuevo. La ruta baja los bytes por el canal
 * service y los sirve con cache PRIVADA inmutable por versión (molde de app/api/consultorio/logo/route.ts).
 *
 * Quién: sesión verificada (`getAccessSnapshot`) con perfil, no deshabilitada y sin la 2FA pendiente. No pide Actor ni
 * membresía: la foto es de la persona (la ve también en `/elegir-consultorio`). Solo la propia: no recibe ningún id.
 *
 * Reglas:
 *   • Sin sesión → 401. Sin foto → 404. Todo lo que no es 200 va `private, no-store`.
 *   • La query tiene que ser EXACTAMENTE `?v=<vigente>` (`isCanonicalPhotoQuery`); sin `v`, vieja, al azar o con un
 *     parámetro de más → 308 a la vigente SIN bajar el objeto (lección de CF3 ZF2 M3: una `v` al azar por request no
 *     baja bytes).
 *   • `v` vigente → rate limit por usuario, la clave se re-chequea contra el usuario (`isUserPhotoKeyFor`, espejo del
 *     CHECK de M24), descarga con tope y los bytes se revalidan (`readImageInfo`): el `Content-Type` es el real.
 *   • 200 con `private, max-age=31536000, immutable` + `nosniff`. Si el middleware refrescó la sesión en ese request,
 *     pisa el header con `private, no-store` (AUDIT §5.3): esa respuesta no se cachea y la próxima sí.
 *   • 1 sentencia (clave y fecha) en todos los caminos con sesión; Storage solo en el 200.
 */
import { getAccessSnapshot } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { readImageInfo } from "@/lib/file-sniff";
import { storageDownload } from "@/lib/storage-internal";
import { logger } from "@/lib/logger";
import { ownPhotoRefFor } from "@/lib/user-photo-internal";
import {
  OWN_PHOTO_BYTES_RATE_LIMIT,
  USER_PHOTO_BUCKET,
  USER_PHOTO_LIMITS,
  isCanonicalPhotoQuery,
  isUserPhotoKeyFor,
  ownPhotoUrl,
  photoVersion,
} from "@/lib/user-photo-logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";
const IMMUTABLE = "private, max-age=31536000, immutable";

function status(code: 401 | 404): Response {
  return new Response(null, { status: code, headers: { "cache-control": NO_STORE } });
}

export async function GET(req: Request): Promise<Response> {
  const s = await getAccessSnapshot();
  if (!s || !s.profile || s.profile.disabledAt || s.twoFactor.state === "required") return status(401);

  const ref = await ownPhotoRefFor(s.userId);
  const current = photoVersion(ref?.at);
  if (!ref || !current) return status(404);
  if (!isCanonicalPhotoQuery(new URL(req.url).searchParams, current)) {
    const to = new URL(ownPhotoUrl(ref.at)!, req.url);
    return new Response(null, { status: 308, headers: { location: to.toString(), "cache-control": NO_STORE } });
  }

  const rl = await rateLimit(`user-photo:own:${s.userId}`, OWN_PHOTO_BYTES_RATE_LIMIT);
  if (!rl.ok) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))), "cache-control": NO_STORE },
    });
  }
  // Defensa en profundidad: la base ya exige el prefijo del propio id (CHECK de M24). Nunca la clave en el log.
  if (!isUserPhotoKeyFor(s.userId, ref.key)) {
    logger.warn("user_photo.unavailable", { reason: "key" });
    return status(404);
  }
  const { maxBytes, maxPx } = USER_PHOTO_LIMITS;
  const dl = await storageDownload(USER_PHOTO_BUCKET, ref.key, maxBytes);
  if (!dl.ok) {
    logger.warn("user_photo.unavailable", { reason: dl.reason });
    return status(404);
  }
  const info = readImageInfo(dl.data);
  if (!info || info.width > maxPx || info.height > maxPx) {
    logger.warn("user_photo.unavailable", { reason: "type" });
    return status(404);
  }
  return new Response(new Uint8Array(dl.data), {
    status: 200,
    headers: {
      "content-type": info.mime,
      "content-length": String(dl.data.byteLength),
      "cache-control": IMMUTABLE,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
