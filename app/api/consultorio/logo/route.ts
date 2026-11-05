/**
 * CF3 (BR-L, pedido de Martin del 05-nov): logo del consultorio DENTRO de la app,
 * `GET /api/consultorio/logo?t=<tenantId>&v=<logoUpdatedAt ms>`. Lo pintan el sidebar, la barra móvil, el selector de
 * consultorio, el menú de cuenta y `/elegir-consultorio` (la URL la arma `tenantLogoUrl`, lib/tenant-logo.ts).
 *
 * Por qué una ruta y no una URL firmada de Storage: el bucket `practice-assets` es PRIVADO y una URL firmada vence
 * (60 s en Configuración), así que el navegador no podría cachearla y cada página bajaría el logo de nuevo. La ruta
 * baja los bytes por el canal service y los sirve con cache privada inmutable por versión. Hermana de la ruta pública
 * de la sede (`app/(sede)/[slug]/logo/route.ts`), que sirve el mismo objeto pero solo con la sede publicada.
 *
 * Quién: sesión verificada (`getAccessSnapshot`, la misma foto del layout) con una membresía USABLE en ese consultorio
 * (`snapshot.usable`: aceptada, no deshabilitada, consultorio no suspendido ni dado de baja, usuario no deshabilitado).
 * No pide Actor: en `/elegir-consultorio` todavía no hay consultorio activo, y el selector muestra los logos de los
 * otros consultorios del usuario. Un superadmin sin membresía (también «como soporte») no lo ve: Plataforma no da
 * acceso al logo. Con la 2FA pendiente, 401 (como el export: sin el segundo factor la sesión no ve ni sus consultorios).
 *
 * Reglas:
 *   • Sin sesión → 401. Consultorio ajeno, id con forma inválida o sin logo → el MISMO 404 (no distingue «no existe»
 *     de «no es tuyo»: no se puede enumerar tenantIds).
 *   • Sin `?t` = el consultorio activo del Actor (308 a su URL con `t`).
 *   • Cualquier query que no sea EXACTAMENTE la canónica (`tenantLogoUrl`: `?t=<id>&v=<vigente>`, en ese orden y nada
 *     más) → 308 a la canónica SIN bajar el objeto (la versión sale de la foto: 0 sentencias y 0 Storage). Así una `v`
 *     al azar por request no baja bytes (lección de CF3 ZF2 M3 en la sede), y tampoco `?t=&v=<vigente>&x=<random>`:
 *     hasta CF3 ZF4a solo se miraba `v`, y cada parámetro de más es otra clave de cache del navegador, así que bajaba
 *     el objeto en cada request (el rate limit era la única red). Mismo criterio que `isCanonicalPhotoQuery`.
 *   • `?v` vigente → 1 sentencia (la clave, por `prismaService`: superficie sin Actor, filtro = el tenant ya verificado
 *     contra la membresía), rate limit por usuario, descarga con tope de bytes y revalidación de los bytes
 *     (`readImageInfo`, PNG o JPEG por magic bytes, tope de dimensiones): el `Content-Type` es el real. Otra cosa → 404.
 *   • 200 con `private, max-age=31536000, immutable`: cambiar o borrar el logo cambia `logoUpdatedAt` y con eso la URL.
 *     `private` porque depende de la sesión (ningún CDN la guarda). Si en ese request el middleware refrescó la sesión,
 *     pisa el header con `private, no-store` (AUDIT §5.3): esa respuesta no se cachea y la próxima sí.
 *   • Todo lo que no es 200 va `private, no-store`: depende de la membresía y tiene que reevaluarse.
 */
// No-Actor surface (sesión verificada + membresía usable de la foto, sin consultorio activo) → service channel. See lib/db.ts#prismaService.
import { prismaService } from "@/lib/db";
import { getAccessSnapshot, tryGetActor } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { PRACTICE_ASSET_LIMITS, readImageInfo } from "@/lib/file-sniff";
import { storageDownload } from "@/lib/storage-internal";
import { logger } from "@/lib/logger";
import { TENANT_LOGO_RATE_LIMIT, isTenantIdShape, tenantLogoUrl, tenantLogoVersion } from "@/lib/tenant-logo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = "private, no-store";
const IMMUTABLE = "private, max-age=31536000, immutable";

function status(code: 401 | 404): Response {
  return new Response(null, { status: code, headers: { "cache-control": NO_STORE } });
}

/**
 * ¿El pedido es EXACTAMENTE la URL que pinta la app? Se compara la query cruda (`search`) contra la de `tenantLogoUrl`,
 * la única fuente del formato: un parámetro de más, repetido, en otro orden, un `&` final o un nombre escapado
 * (`%74=`) no lo son. `isCanonicalPhotoQuery` (lib/user-photo-logic.ts) es el mismo corte para una URL con solo `v`.
 */
function isCanonicalLogoRequest(req: Request, tenantId: string, at: Date): boolean {
  const canonical = tenantLogoUrl(tenantId, at);
  return canonical !== null && new URL(req.url).search === new URL(canonical, req.url).search;
}

function redirectTo(req: Request, tenantId: string, at: Date): Response {
  // `tenantLogoUrl` es la única fuente del formato: la URL a la que redirige es la misma que pinta la app.
  const to = new URL(tenantLogoUrl(tenantId, at)!, req.url);
  return new Response(null, { status: 308, headers: { location: to.toString(), "cache-control": NO_STORE } });
}

export async function GET(req: Request): Promise<Response> {
  const snapshot = await getAccessSnapshot();
  if (!snapshot || !snapshot.profile || snapshot.twoFactor.state === "required") return status(401);

  const params = new URL(req.url).searchParams;
  const rawT = params.get("t");
  let tenantId: string;
  if (rawT === null) {
    // Sin `?t`: el consultorio activo. En soporte el Actor es el destino, que no está entre las membresías → 404 abajo.
    const actor = await tryGetActor();
    if (!actor) return status(401);
    tenantId = actor.tenantId;
  } else {
    if (!isTenantIdShape(rawT)) return status(404);
    tenantId = rawT;
  }

  const membership = snapshot.usable.find((m) => m.tenantId === tenantId);
  const at = membership?.tenant.logoUpdatedAt ?? null;
  const current = tenantLogoVersion(at);
  if (!membership || !at || !current) return status(404);
  if (rawT === null || !isCanonicalLogoRequest(req, tenantId, at)) return redirectTo(req, tenantId, at);

  const rl = await rateLimit(`tenant-logo:user:${snapshot.userId}`, TENANT_LOGO_RATE_LIMIT);
  if (!rl.ok) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))), "cache-control": NO_STORE },
    });
  }

  const row = await prismaService.tenant.findFirst({
    where: { id: tenantId },
    select: { logoStorageKey: true, logoUpdatedAt: true },
  });
  if (!row?.logoStorageKey || !row.logoUpdatedAt) return status(404);
  // Carrera: el logo cambió entre la foto y esta lectura (otra pestaña lo subió recién) → a la versión de la fila.
  if (tenantLogoVersion(row.logoUpdatedAt) !== current) return redirectTo(req, tenantId, row.logoUpdatedAt);

  const { maxBytes, maxPx } = PRACTICE_ASSET_LIMITS.logo;
  const dl = await storageDownload("practice-assets", row.logoStorageKey, maxBytes);
  if (!dl.ok) {
    // Storage caído o el objeto no está: no se cachea (se reintenta en el próximo request). Nunca la clave en el log.
    logger.warn("tenant.logo.unavailable", { reason: dl.reason });
    return status(404);
  }
  const info = readImageInfo(dl.data);
  if (!info || info.width > maxPx || info.height > maxPx) {
    logger.warn("tenant.logo.unavailable", { reason: "type" });
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
