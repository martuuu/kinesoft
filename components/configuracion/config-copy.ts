/**
 * Copy de Configuración que tiene que coincidir con el server (BO3-F). Archivo puro (sin JSX ni React) para que lo
 * importen el panel y el test de integración, que no transforma JSX.
 *
 * BO2-D (handoff a BO3-F): `updateTenantBasics` acepta `expectedUpdatedAt` (CAS sobre `Tenant.updatedAt`) desde que
 * el superadmin edita las mismas columnas desde Plataforma. Sin él, el último que guardaba pisaba al otro en
 * silencio. Este es el copy del rechazo «stale» del server (lib/tenant-settings.ts): la UI lo reconoce por el texto
 * porque `ActionResult` no lleva código. tests/integration/tenant-plan-usage.test.ts ata los dos lados.
 */
export const TENANT_BASICS_STALE_ERROR = "Otro cambio se guardó antes. Recargá y revisá.";
