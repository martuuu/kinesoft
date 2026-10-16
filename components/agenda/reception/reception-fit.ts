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

/**
 * [MB-Z-F2] Lo que hay DEBAJO del scroller hasta el borde de la ventana, por nivel del árbol (del scroller hacia
 * `main`). El revisor B midió 46 px de scroll del documento a 1366/1024 × 625/695: el `bottomGap = 14` fijo solo
 * contaba el padding de `main` con sidebar; se olvidaba de la leyenda «Servicios / Turnos» que la agenda pone debajo
 * de la vista (~38 px + el gap de 8 de `.agendaRoot`) y del padding de 18 de `main` con «Barra superior».
 *
 * Se suman ALTOS de los hermanos que siguen (no posiciones): el contenedor de la vista tiene `flex: 1` dentro de
 * `.agendaRoot`, que tiene `min-height` de ventana; con posiciones, el estirado contaría como «lo de abajo» y la
 * tabla no volvería a crecer al sumar turnos.
 */
export type ReceptionTrailingLevel = {
  /** Alto (con márgenes) de cada hermano en el flujo que sigue al ancestro de este nivel. */
  siblings: readonly number[];
  /** `row-gap` del padre (0 si es bloque o flex en fila). */
  gap: number;
  /** `padding-bottom` + `border-bottom` del padre. */
  padBottom: number;
};

/** Pura: `inSection` = del borde de abajo del scroller al de su sección (borde de la Card, nota). */
export function receptionBottomGap(inSection: number, levels: readonly ReceptionTrailingLevel[]): number {
  let total = Math.max(0, inSection);
  for (const l of levels) {
    for (const h of l.siblings) total += l.gap + h;
    total += l.padBottom;
  }
  return Math.ceil(total);
}

const px = (v: string | null | undefined) => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

/**
 * DOM: arma los niveles desde la sección hasta `main` (incluido su padding de abajo) y devuelve el gap. Los hermanos
 * fuera del flujo (`position: fixed/absolute`, como el FAB) o `display: none` (los `<style>`) no cuentan. Sin `main`
 * (tests, otro layout), el `fallback` de siempre.
 */
export function measureReceptionBottomGap(scroller: HTMLElement, section: HTMLElement, fallback = 14): number {
  const main = section.closest("main");
  if (!main) return fallback;
  const inSection = section.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
  const levels: ReceptionTrailingLevel[] = [];
  let node: HTMLElement = section;
  while (node !== main && node.parentElement) {
    const parent: HTMLElement = node.parentElement;
    const ps = getComputedStyle(parent);
    const rowFlex = ps.display.includes("flex") && !ps.flexDirection.startsWith("column");
    const siblings: number[] = [];
    if (!rowFlex) {
      for (let s = node.nextElementSibling; s; s = s.nextElementSibling) {
        const cs = getComputedStyle(s);
        if (cs.display === "none" || cs.position === "fixed" || cs.position === "absolute") continue;
        siblings.push(s.getBoundingClientRect().height + px(cs.marginTop) + px(cs.marginBottom));
      }
    }
    levels.push({ siblings, gap: rowFlex ? 0 : px(ps.rowGap), padBottom: px(ps.paddingBottom) + px(ps.borderBottomWidth) });
    node = parent;
  }
  return receptionBottomGap(inSection, levels);
}
