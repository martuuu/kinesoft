/**
 * [VX F-a · D-VX25 · PV BR-a] Nombre de la marca en un solo lugar.
 *
 * Por qué: el renombre (§20.18, ejecutado en PV Q5) se hizo cambiando estas constantes más un barrido del literal viejo.
 * Todo texto visible lee de acá: el literal de la marca solo vive en este archivo (lo fija
 * `tests/unit/brand-literal.test.ts`). Los identificadores técnicos con el nombre viejo (cookies `kine_*`, claves
 * `kinesoft:*`, roles de DB, cache del service worker, dominios) NO se renombran: cambiarlos cerraría sesiones, rompería
 * firmas HMAC o dejaría datos huérfanos ([BR-9]).
 */
export const BRAND_NAME = "Consultorio Online";

/** Nombre corto (manifest `short_name`, debajo del ícono en la pantalla de inicio): ≤12 caracteres o el SO lo corta. */
export const BRAND_SHORT_NAME = "Consultorio";

/** Bajada de la marca: metadata del sitio y pie de los mails. Sin «kinesiología»: la marca es para cualquier consultorio. */
export const BRAND_TAGLINE = "Gestión para consultorios de salud";
