import { getAccessSnapshot, tryGetActor } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { loadExportTenant, streamTenantExport } from "@/lib/tenant-export-internal";
import { TENANT_EXPORT_RATE_LIMIT, chooseExportTenant, exportFilename } from "@/lib/tenant-export-logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Sin `maxDuration` acá a propósito: el límite vive en UN solo lugar, vercel.json, con una clave propia para esta
// ruta (60 s) ANTES de `app/**/*` (30 s): el orden de las claves importa cuando un archivo matchea dos globs. 60 s
// entra en Hobby; en Pro se puede subir a 300. El export es streaming, así que el límite es el TIEMPO total de
// armarlo, no la memoria; si se corta, el archivo queda como JSON inválido (el manifest va al final) y el audit dice
// `completed: false` o solo `tenant.export.started`.

/**
 * GET /api/consultorio/export[?tenant=<id>] — export completo del consultorio en un único JSON (BO5-C, plan §19.5).
 *
 * Quién: SOLO el OWNER (aceptado y habilitado), también con el consultorio suspendido, en solo lectura o dado de
 * baja (BO-D4; la lectura nunca se bloquea). ADMIN y el resto de los roles → 403. Soporte → 403 (BO2-E: soporte
 * nunca baja datos del consultorio, y el superadmin desde Plataforma solo PIDE el export: lib/platform-export-request.ts).
 *
 * Por qué no alcanza con `getActor()`: con el consultorio suspendido o dado de baja `buildActor` no entra ahí
 * (`accessView` lo marca como membresía no usable y el layout manda a /suspendido), así que un OWNER bloqueado no
 * tiene Actor. Esta ruta decide con la foto de acceso de la sesión (`getAccessSnapshot`: las membresías crudas,
 * incluidas las de consultorios bloqueados) y usa el Actor solo para dos cosas: detectar soporte y saber cuál es
 * el consultorio activo cuando hay uno.
 *
 * Rate limit: 3 por hora POR CONSULTORIO (no por usuario: dos titulares no suman cupo).
 */
export async function GET(req: Request) {
  const snapshot = await getAccessSnapshot();
  if (!snapshot || !snapshot.profile) return new Response("Unauthorized", { status: 401 });
  // PL-Z (a2#2, ALTO): la 2FA del usuario pendiente corta acá también. Esta ruta no pasa por `getActor` (donde se
  // corta en el resto de la app) y `tryGetActor` devuelve null con la 2FA pendiente sin cortar: con solo la
  // contraseña robada del Titular se bajaba el consultorio entero (pacientes e historia clínica).
  if (snapshot.twoFactor.state === "required") return new Response("Unauthorized", { status: 401 });
  const actor = await tryGetActor();
  if (actor?.support) return new Response("Forbidden", { status: 403 });

  const requested = new URL(req.url).searchParams.get("tenant")?.trim().slice(0, 64) || null;
  const choice = chooseExportTenant({
    memberships: snapshot.memberships,
    userDisabled: !!snapshot.profile.disabledAt,
    activeTenantId: actor?.tenantId ?? null,
    requestedTenantId: requested,
  });
  if (!choice.ok) {
    return new Response(
      choice.reason === "choose_tenant"
        ? "Sos titular de más de un consultorio: elegí cuál exportar."
        : "Solo el titular del consultorio puede descargar el export completo.",
      { status: choice.status }
    );
  }

  const rl = await rateLimit(`export:tenant:${choice.tenantId}`, TENANT_EXPORT_RATE_LIMIT);
  if (!rl.ok) {
    return new Response("Ya descargaste el export varias veces en la última hora. Probá más tarde.", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const tenant = await loadExportTenant(choice.tenantId);
  if (!tenant) return new Response("Not found", { status: 404 });

  const now = new Date();
  const body = streamTenantExport({ tenant, actorUserId: snapshot.userId, now });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(tenant.slug, now)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
