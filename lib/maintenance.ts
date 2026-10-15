/**
 * BO5-B — modo mantenimiento. Lógica PURA: la importa `middleware.ts` (runtime edge), así que acá no entra nada de
 * Node (ni `server-only`, ni Prisma, ni `lib/env.ts`, que valida todo el entorno al importarse).
 *
 * Cómo se prende: `MAINTENANCE_MODE=on` en Vercel + redeploy (se apaga igual, con `off` o borrando la variable). El
 * redeploy es obligatorio: no se garantiza que el edge vea un cambio de env sin un deploy nuevo.
 *
 * Superadmins NO tienen bypass: en el edge no hay forma barata de saber el rol (la cookie de Supabase dice quién es,
 * no qué es; el rol vive en la base) y abrir la base desde el middleware en cada request es justo lo que no
 * queremos durante un mantenimiento. Si hace falta entrar, se prueba en un Preview.
 */

export type MaintenanceMode = "off" | "on";
export type MaintenanceDecision = "pass" | "page" | "api";

export const MAINTENANCE_PATH = "/mantenimiento";
/** 10 min: lo que tarda un deploy + migración típica. Es una pista para crawlers y clientes, no una promesa. */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 600;
/** Tope del mensaje opcional: es una línea de aviso, no un comunicado. */
const MESSAGE_MAX = 280;

/** Cualquier valor que no sea `on` es `off`: un typo en la consola de Vercel no puede tirar la app abajo. */
export function maintenanceMode(raw: string | undefined): MaintenanceMode {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

/**
 * Mensaje opcional de `MAINTENANCE_MESSAGE`. Es dato PÚBLICO (se muestra a cualquiera que entre): no poner nada
 * interno. Se renderiza como texto de React (escapado), nunca como HTML.
 */
export function maintenanceMessage(raw: string | undefined): string | null {
  const t = raw?.trim();
  return t ? t.slice(0, MESSAGE_MAX) : null;
}

/** `pathname` es `prefix` o está debajo de él como segmento (`/api/cron/x` sí, `/api/cronjob` no). */
function underSegment(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Excepciones con el modo prendido (todas pasan por el middleware normal):
 *   - `/api/health`        el monitor externo tiene que seguir viendo la app (y si la base está viva).
 *   - `/api/webhooks/**`   Mercado Pago NUNCA se corta (AUDIT §5.4: un pago siempre se concilia). El middleware
 *                          ya los deja pasar antes de llegar acá; se repite para que la tabla sea el contrato.
 *   - `/api/cron/**`       el cron decide por su cuenta si corre.
 *   - `/_next/**`, `/favicon.ico`, `/robots.txt`   assets y metadatos (la página de mantenimiento usa los assets).
 *   - `/mantenimiento`     la página misma; si no, el rewrite haría bucle.
 * Lo demás: `/api/**` → "api" (503 JSON) y cualquier otra ruta → "page" (rewrite a /mantenimiento con 503).
 */
export function maintenanceDecision(pathname: string, mode: MaintenanceMode): MaintenanceDecision {
  if (mode !== "on") return "pass";

  if (pathname === "/_next" || pathname.startsWith("/_next/")) return "pass";
  if (pathname === "/favicon.ico" || pathname === "/robots.txt") return "pass";
  if (underSegment(pathname, MAINTENANCE_PATH)) {
    // Solo la página exacta (con o sin barra final): `/mantenimiento/otra` no existe y no es excepción.
    return pathname === MAINTENANCE_PATH || pathname === MAINTENANCE_PATH + "/" ? "pass" : "page";
  }

  if (underSegment(pathname, "/api")) {
    if (pathname === "/api/health" || pathname === "/api/health/") return "pass";
    if (underSegment(pathname, "/api/webhooks")) return "pass";
    if (underSegment(pathname, "/api/cron")) return "pass";
    return "api";
  }

  return "page";
}
