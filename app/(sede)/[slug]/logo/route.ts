/**
 * CF3 (SD-S, §30 D-CF3-9): logo público de la sede digital, `GET /<slug>/logo?v=<logoUpdatedAt ms>`.
 *
 * Por qué una ruta y no una URL firmada de Storage: el bucket `practice-assets` es PRIVADO (el logo vive ahí para el
 * membrete del PDF, FC M14) y una URL firmada vence (60 s en Configuración), así que no sirve en una página ISR de
 * 10 min ni en el cache de Google. La ruta baja los bytes por el canal service y los sirve cacheables.
 *
 * Reglas:
 *   • Slug con forma inválida → 404 sin tocar la base ni el cache (`/<slug>` es primer nivel: cae basura).
 *   • Solo si la sede está publicada: `getClinicSite` (snapshot global cacheado de SD-K: `siteEnabled`, superficies
 *     públicas abiertas, slug no reservado) y con logo. Un alias o mayúsculas → 404 (la página redirige; el `<img>`
 *     de la página ya usa el slug vigente). Sede apagada, suspendida o de baja → 404: el logo no queda colgado.
 *   • CF3b PH-S (handoff de PH-U2, opción (b) elegida): O si el TURNERO está abierto (`isPublicTurneroOpen`: switch del
 *     consultorio + acceso no suspendido ni de baja), con slug no reservado. El turnero pinta el logo del consultorio
 *     chico sobre la foto de cada profesional (`PublicClinic.logoUrl`, que arma `getPublicClinic` con la MISMA regla) y
 *     la marca tiene que salir aunque el consultorio no haya publicado su sede. Esa rama lee por slug SIN cache (1
 *     sentencia por el índice único): con cache, cada slug basura de forma válida dejaría una entrada. Turnero cerrado
 *     y sede apagada → el mismo 404.
 *   • La clave del objeto NO está en el snapshot (es un DTO público cerrado, `clinicSiteSchema`): sale de un lookup
 *     propio cacheado por slug con los mismos tags. Solo se llega acá con una sede publicada, así que hay a lo sumo
 *     una entrada por sede (la basura no crea entradas).
 *   • Bytes revalidados al servirlos (`readImageInfo`, tope de `PRACTICE_ASSET_LIMITS.logo`): el `Content-Type` es el
 *     real (PNG o JPEG por magic bytes), no el que dijo la subida. Un objeto reemplazado a mano por otra cosa → 404.
 *   • `?v` igual al `logoUpdatedAt` vigente → `public, max-age=31536000, s-maxage=31536000, immutable` (subir otro logo
 *     cambia la URL). CF3 ZF5 (M): con `s-maxage`. El CDN de Vercel NO guarda la respuesta de una función que solo trae
 *     `max-age` (ese es para el navegador): sin él, cada visitante nuevo de la sede o del turnero llegaba a la función y
 *     bajaba el objeto de Storage. El logo es la marca del consultorio (no el dato de una persona): un año en el edge
 *     está bien aunque después se apague la sede, como ya pasaba en el navegador.
 *   • Sin `v`, con uno viejo o con cualquier otro → 308 a `?v=<vigente>` (5 min de cache, también en el CDN) SIN bajar
 *     el objeto. CF3 ZF2 (M3): antes se servían los bytes con cache corto, y como cada `?v` distinto es otra clave de
 *     CDN, un `?v=<random>` por request bajaba el objeto de Storage cada vez (egress y latencia gratis para cualquiera).
 *     Así hay una sola URL que baja bytes por versión, y esa se cachea un año. El 308 vence en 5 min: al cambiar el
 *     logo, una redirección vieja puede llevar a la versión anterior (que el CDN guarda) a lo sumo esos 5 min; las
 *     páginas no pasan por acá, pintan el `?v` vigente del snapshot.
 *   • 404 con `public, max-age=60, s-maxage=60` (salvo Storage caído o un objeto que no es imagen: `no-store`, se
 *     reintenta). CF3 ZF5: el CDN también lo absorbe, así repetir el mismo slug no consulta la base en cada request; y
 *     un minuto no deja colgado el logo de una sede que se acaba de prender.
 *   • CF3 ZF5 (M): rate limit por IP SOLO en el camino que baja bytes (`?v` vigente), el mismo cupo que la foto pública
 *     (`PUBLIC_PHOTO_BYTES_RATE_LIMIT`, clave propia `site-logo:ip:`). Con el `s-maxage` lo normal es 1 descarga por
 *     versión y por edge; esto es el techo de un bucle que esquive el CDN. El 308 y el 404 no gastan cupo.
 *   • Con sesión de Supabase el middleware pisa el Cache-Control con `private, no-store` (AUDIT §5.3, cookies de
 *     refresh): correcto, esa respuesta no se cachea en el CDN; la de un visitante anónimo sí.
 */
import { unstable_cache } from "next/cache";
// No-Actor surface (sede pública, anónima) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService } from "@/lib/db";
import { CLINIC_SITES_TAG, DIRECTORY_TAG } from "@/lib/cache-tags";
import { getClinicSite } from "@/lib/clinic-site-internal";
import { isSiteSlugShape } from "@/lib/clinic-site-logic";
import { PUBLIC_BOOKING_SWITCH_SELECT, isPublicTurneroOpen } from "@/lib/public-booking-internal";
import { RESERVED_SLUGS } from "@/lib/onboarding-logic";
import { PUBLIC_PHOTO_BYTES_RATE_LIMIT, isCanonicalPhotoQuery } from "@/lib/user-photo-logic";
import { PRACTICE_ASSET_LIMITS, readImageInfo } from "@/lib/file-sniff";
import { storageDownload } from "@/lib/storage-internal";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// `s-maxage` = la vida en el CDN de Vercel (ver la cabecera): sin él, el edge no guarda la respuesta de la función.
const IMMUTABLE = "public, max-age=31536000, s-maxage=31536000, immutable";
const SHORT = "public, max-age=300, s-maxage=300";

function notFound(cache = "public, max-age=60, s-maxage=60"): Response {
  return new Response(null, { status: 404, headers: { "cache-control": cache } });
}

/** Clave y versión del logo de una sede PRENDIDA. Fechas como ms: el data cache serializa a JSON. */
const getSiteLogoRef = unstable_cache(
  async (slug: string): Promise<{ key: string; v: string } | null> => {
    const t = await prismaService.tenant.findFirst({
      where: { slug, siteEnabled: true },
      select: { logoStorageKey: true, logoUpdatedAt: true },
    });
    if (!t?.logoStorageKey || !t.logoUpdatedAt) return null;
    return { key: t.logoStorageKey, v: String(t.logoUpdatedAt.getTime()) };
  },
  ["clinic-site:logo-ref:v1"],
  { tags: [DIRECTORY_TAG, CLINIC_SITES_TAG], revalidate: 600 }
);

/**
 * CF3b PH-S: clave y versión del logo de un consultorio con el TURNERO abierto (sin sede publicada). Sin cache a
 * propósito (ver la cabecera). Slug reservado → null: `getPublicClinic` tampoco le arma la URL.
 */
async function getTurneroLogoRef(slug: string): Promise<{ key: string; v: string } | null> {
  if (RESERVED_SLUGS.has(slug)) return null;
  const t = await prismaService.tenant.findUnique({
    where: { slug },
    select: { logoStorageKey: true, logoUpdatedAt: true, ...PUBLIC_BOOKING_SWITCH_SELECT },
  });
  if (!t?.logoStorageKey || !t.logoUpdatedAt || !isPublicTurneroOpen(t)) return null;
  return { key: t.logoStorageKey, v: String(t.logoUpdatedAt.getTime()) };
}

export async function GET(req: Request, ctx: { params: { slug: string } }): Promise<Response> {
  const slug = ctx.params?.slug;
  if (typeof slug !== "string" || !isSiteSlugShape(slug)) return notFound();

  const site = await getClinicSite(slug);
  if (site && ("redirectTo" in site || !site.logoUrl)) return notFound();

  // Sede publicada → su lookup cacheado; si no, la rama del turnero abierto (CF3b PH-S).
  const ref = site ? await getSiteLogoRef(slug) : await getTurneroLogoRef(slug);
  if (!ref) return notFound();

  // CF3b PH-S (auditoría de paso): EXACTAMENTE `?v=<vigente>`. Antes solo se miraba `v`, y `?v=<vigente>&x=<random>`
  // era otra clave de CDN que bajaba el objeto en cada request (el mismo amplificador que cerró ZF2 M3).
  if (!isCanonicalPhotoQuery(new URL(req.url).searchParams, ref.v)) {
    const to = new URL(req.url);
    to.search = "";
    to.searchParams.set("v", ref.v);
    return new Response(null, { status: 308, headers: { location: to.toString(), "cache-control": SHORT } });
  }

  // Solo este camino toca Storage (ver la cabecera). La IP sale del request (Vercel pisa `x-forwarded-for`).
  const rl = await rateLimit(`site-logo:ip:${clientIp(req.headers)}`, PUBLIC_PHOTO_BYTES_RATE_LIMIT);
  if (!rl.ok) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))), "cache-control": "no-store" },
    });
  }
  const dl = await storageDownload("practice-assets", ref.key, PRACTICE_ASSET_LIMITS.logo.maxBytes);
  if (!dl.ok) {
    // Storage caído o el objeto no está: no se cachea (se reintenta en el próximo request). Nunca la clave en el log.
    logger.warn("site.logo.unavailable", { reason: dl.reason });
    return notFound("no-store");
  }
  const info = readImageInfo(dl.data);
  const { maxPx } = PRACTICE_ASSET_LIMITS.logo;
  if (!info || info.width > maxPx || info.height > maxPx) {
    logger.warn("site.logo.unavailable", { reason: "type" });
    return notFound("no-store");
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
