/**
 * CF3b PH-S (M24, contrato FOTO): foto PÚBLICA de un profesional, `GET /api/public/pro-photo/<practitionerId>?v=<ms>`.
 * La pintan la selección de profesional del turnero (`PublicClinic.practitioners[].photoUrl`) y las tarjetas de la sede
 * (`ClinicSite.practitioners[].photoUrl`); la URL la arma `publicProPhotoUrlFor` (lib/user-photo-logic.ts).
 *
 * Sin sesión. Publica SOLO con todo esto (`loadPublicProPhotoRef`, lib/user-photo-internal.ts): consultorio con una
 * superficie pública abierta (turnero prendido o sede publicada, y acceso no suspendido ni de baja), profesional
 * reservable en ese consultorio con la regla del turnero, `showPhotoPublic` (opt-in de ESE consultorio, Ley 25.326: es
 * la imagen de una persona en una página pública) y una foto subida. Nunca `avatarUrl` (Google/Facebook).
 *
 * Reglas:
 *   • Id con forma inválida → 404 sin tocar la base. Cualquier «no» (no existe, sin opt-in, sin foto, consultorio
 *     cerrado, miembro suspendido) → el MISMO 404 (`public, max-age=60, s-maxage=60`): no se puede averiguar quién tiene
 *     foto.
 *   • La query tiene que ser EXACTAMENTE `?v=<vigente>`; si no → 308 a la canónica (`public, max-age=300, s-maxage=300`)
 *     SIN bajar el objeto. Un parámetro de más también: es otra clave de CDN y bajaría los bytes en cada request.
 *   • CF3 ZF5 (B): el 308 y el 404 llevan `s-maxage` (antes solo `max-age`, que el CDN de Vercel no usa para guardar la
 *     respuesta de una función): repetir la misma URL ya no llega a la base (2 sentencias por request). Un minuto de 404
 *     en el edge no demora mucho la foto de quien recién prende el opt-in. Ids inventados distintos siguen llegando a
 *     la base (1 sentencia por el índice, como cualquier página pública); no se suma un rate limit antes de la base
 *     porque costaría lo mismo que esa sentencia (una llamada a Upstash) en cada request legítimo.
 *   • `v` vigente → rate limit por IP (solo este camino toca Storage), clave re-chequeada contra la persona
 *     (`isUserPhotoKeyFor`), descarga con tope y bytes revalidados (`readImageInfo`, tope de píxeles): el
 *     `Content-Type` es el real. 200 con `public, max-age=86400` + `nosniff` (ver «Cache de un día», abajo).
 *   • Con sesión de Supabase el middleware pisa el Cache-Control con `private, no-store` cuando refresca (AUDIT §5.3).
 *   • 2 sentencias en los caminos con id bien formado (1 si el consultorio no existe o está cerrado).
 *
 * Cache de un día (CF3 ZF4a, M de la auditoría de PH-S): hasta ZF4a el 200 iba `immutable` por un año, y apagar
 * `showPhotoPublic` o borrar la foto cortaba la URL para requests NUEVOS pero un navegador o un CDN que ya la tenía la
 * seguía mostrando un año a quien tuviera la URL exacta (es la imagen de una persona en una página pública, Ley 25.326:
 * retirar el consentimiento tiene que surtir efecto). Con `max-age=86400` deja de verse en un día como máximo. No hace
 * falta más corto: la URL cambia sola con cada foto nueva (`?v=`), así que un día de cache no muestra una foto vieja
 * después de reemplazarla, y el turnero y la sede piden la misma URL todo el día (el costo es 1 descarga por día y por
 * cache, con el rate limit de abajo como techo).
 */
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { readImageInfo } from "@/lib/file-sniff";
import { storageDownload } from "@/lib/storage-internal";
import { logger } from "@/lib/logger";
import { loadPublicProPhotoRef } from "@/lib/user-photo-internal";
import {
  PUBLIC_PHOTO_BYTES_RATE_LIMIT,
  USER_PHOTO_BUCKET,
  USER_PHOTO_LIMITS,
  isCanonicalPhotoQuery,
  isPractitionerIdShape,
  isUserPhotoKeyFor,
  photoVersion,
  publicProPhotoUrl,
} from "@/lib/user-photo-logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Un día, sin `immutable` (ver la cabecera): retirar el opt-in o la foto deja de verse en ≤ 24 h. */
// `s-maxage`: el CDN de Vercel cachea en el edge con la misma vida; sin él, cada request llegaba a la función.
const ONE_DAY = "public, max-age=86400, s-maxage=86400";
const REDIRECT = "public, max-age=300, s-maxage=300";

function notFound(cache = "public, max-age=60, s-maxage=60"): Response {
  return new Response(null, { status: 404, headers: { "cache-control": cache, "x-content-type-options": "nosniff" } });
}

export async function GET(req: Request, ctx: { params: { practitionerId: string } }): Promise<Response> {
  const id = ctx.params?.practitionerId;
  if (typeof id !== "string" || !isPractitionerIdShape(id)) return notFound();

  const ref = await loadPublicProPhotoRef(id);
  const current = photoVersion(ref?.at);
  if (!ref || !current) return notFound();
  if (!isCanonicalPhotoQuery(new URL(req.url).searchParams, current)) {
    const to = new URL(publicProPhotoUrl(id, ref.at)!, req.url);
    return new Response(null, { status: 308, headers: { location: to.toString(), "cache-control": REDIRECT } });
  }

  // CF3 ZF5: la IP del request (antes `headers()` de next/headers: el mismo dato, pero el test no podía fijarla).
  const rl = await rateLimit(`pro-photo:ip:${clientIp(req.headers)}`, PUBLIC_PHOTO_BYTES_RATE_LIMIT);
  if (!rl.ok) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))), "cache-control": "no-store" },
    });
  }
  // Defensa en profundidad (la base ya exige el prefijo del propio id, CHECK de M24). Nunca la clave en el log.
  if (!isUserPhotoKeyFor(ref.userId, ref.key)) {
    logger.warn("pro_photo.unavailable", { reason: "key" });
    return notFound("no-store");
  }
  const { maxBytes, maxPx } = USER_PHOTO_LIMITS;
  const dl = await storageDownload(USER_PHOTO_BUCKET, ref.key, maxBytes);
  if (!dl.ok) {
    // Storage caído o el objeto no está: no se cachea (se reintenta en el próximo request).
    logger.warn("pro_photo.unavailable", { reason: dl.reason });
    return notFound("no-store");
  }
  const info = readImageInfo(dl.data);
  if (!info || info.width > maxPx || info.height > maxPx) {
    logger.warn("pro_photo.unavailable", { reason: "type" });
    return notFound("no-store");
  }
  return new Response(new Uint8Array(dl.data), {
    status: 200,
    headers: {
      "content-type": info.mime,
      "content-length": String(dl.data.byteLength),
      "cache-control": ONE_DAY,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
