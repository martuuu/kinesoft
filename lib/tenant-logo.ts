/**
 * CF3 (BR-L, pedido de Martin del 05-nov): el logo del consultorio DENTRO de la app (sidebar, barra móvil, selector,
 * menú de cuenta y `/elegir-consultorio`). Motivo: un profesional con el mismo email en varios consultorios no tenía
 * cómo saber de un vistazo en cuál estaba (el logo solo salía en los PDF).
 *
 * El logo vive en el bucket PRIVADO `practice-assets` (`Tenant.logoStorageKey`, lib/practice-assets.ts). Lo sirve la
 * ruta autenticada `GET /api/consultorio/logo?t=<tenantId>&v=<logoUpdatedAt ms>` (app/api/consultorio/logo/route.ts):
 * sesión + membresía usable en ESE consultorio, bytes por el canal service, cache privada inmutable por versión.
 *
 * Por qué `v` = `logoUpdatedAt` en ms: subir o borrar el logo lo cambia (las dos escrituras de practice-assets.ts lo
 * estampan o lo ponen en null), así que la URL cambia sola y no hace falta invalidar nada del navegador. La URL viaja
 * ARMADA al cliente (la arma el server desde la foto de acceso): este módulo no lo importa ningún componente cliente.
 *
 * Puro (sin `server-only`): lo usan el layout `(app)`, `getTenantChoiceState` y la ruta, y tiene su unit test.
 */
export const TENANT_LOGO_PATH = "/api/consultorio/logo";

/**
 * Tope de descargas de bytes por usuario. Solo cuenta el camino que baja de Storage (la `v` vigente): el navegador lo
 * guarda un año, así que un uso normal es una descarga por consultorio y por versión del logo. Generoso a propósito
 * (varios consultorios × varios dispositivos); corta un bucle o un script que pida la misma URL sin cache.
 */
export const TENANT_LOGO_RATE_LIMIT = { limit: 120, windowMs: 10 * 60_000 } as const;

/**
 * Forma de un id de Tenant: cuid de Prisma; mismo tope de 64 que la cookie `kine_tenant`. Fuera de forma → 404 sin
 * buscar nada (no es un id de nadie).
 */
export function isTenantIdShape(s: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(s);
}

/** Versión del logo para la URL (`logoUpdatedAt` en ms); null = sin logo. */
export function tenantLogoVersion(logoUpdatedAt: Date | null | undefined): string | null {
  if (!logoUpdatedAt) return null;
  const ms = logoUpdatedAt.getTime();
  return Number.isFinite(ms) ? String(ms) : null;
}

/** URL relativa del logo del consultorio, o null si no tiene. Única fuente del formato (la ruta redirige a esta misma). */
export function tenantLogoUrl(tenantId: string, logoUpdatedAt: Date | null | undefined): string | null {
  const v = tenantLogoVersion(logoUpdatedAt);
  return v ? `${TENANT_LOGO_PATH}?t=${encodeURIComponent(tenantId)}&v=${v}` : null;
}
