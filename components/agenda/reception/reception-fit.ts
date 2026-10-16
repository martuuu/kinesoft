/**
 * [MB-1b · C-MB4] Recepción de la agenda en el escritorio chico (1366/1024 de ancho con 625 de alto en el navegador
 * o 695 en la PWA, MB-D12): la tabla scrollea ADENTRO y el documento no. Antes la tabla crecía con la página y a
 * 1366×625 se veían ~4 filas debajo de la toolbar, los KPIs y los filtros; la Secretaria scrolleaba la página entera
 * y perdía de vista los contadores.
 *
 * El alto disponible se mide (el tope de la tabla depende de la toolbar de la agenda, que es de otra sesión y cambia
 * de alto con los chips y los filtros) en vez de restar una constante adivinada. Solo en el escritorio chico: en los
 * monitores altos la página queda como siempre, y en el celular el documento scrollea con la barra inferior.
 */
export const RECEPTION_FIT_MQ = "(min-width: 1024px) and (max-height: 820px)";

/** Piso del scroller: con mucho encima (avisos, filtros en dos renglones) la tabla no se achica a nada. */
export const RECEPTION_FIT_MIN_PX = 200;

/**
 * Pura (para el test): alto máximo del scroller de la tabla. `topInDoc` = tope del scroller en coordenadas del
 * documento (`getBoundingClientRect().top + scrollY`), `bottomGap` = lo que queda debajo (padding del `main`).
 * `null` si el viewport no es un número (SSR / entorno sin ventana): el llamador no fija nada.
 */
export function receptionScrollMaxHeight(viewportH: number, topInDoc: number, bottomGap = 14): number | null {
  if (!Number.isFinite(viewportH) || !Number.isFinite(topInDoc)) return null;
  return Math.max(RECEPTION_FIT_MIN_PX, Math.floor(viewportH - topInDoc - bottomGap));
}
