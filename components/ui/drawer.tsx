"use client";

import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, m } from "framer-motion";
import { IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { backdropVariants, drawerVariants } from "@/lib/motion";
import { OverlayPortal, overlayArmed } from "@/components/ui/overlay-portal";
import { useHydrated } from "@/components/ui/use-hydrated";

/** Pura (para el test): ¿este Esc cierra el drawer? No si ya lo consumió un overlay de arriba (Modal, ConfirmDialog). */
export function drawerHandlesEscape(e: { key: string; defaultPrevented: boolean }): boolean {
  return e.key === "Escape" && !e.defaultPrevented;
}

/**
 * PF1-Z-F1 (#1/#3): atributo con el que un hijo marca su footer `position: sticky; bottom` («Nuevo turno», drawer
 * del turno). El Drawer lo mide y reserva ese alto como `scroll-padding-bottom` del panel: sin eso, el
 * `scrollIntoView` de los avisos de conflicto y el scroll del navegador al tabular dejaban el elemento DEBAJO del
 * footer (botones del aviso no clickeables; foco tapado, WCAG 2.4.11). Se mide (ResizeObserver) porque el alto
 * cambia: el footer del turno suma el error o la línea del plan, y a 390 los botones bajan de renglón.
 */
export const DRAWER_FOOTER_ATTR = "data-drawer-footer";

/** Pura (para el test): `scroll-padding-bottom` del panel para un footer de `height` px. 8 px de aire para que el
 *  anillo de foco no quede pegado al borde del footer. Sin footer, "" (el valor por defecto del navegador). */
export function drawerScrollPaddingBottom(height: number | null | undefined): string {
  return height && height > 0 ? `${Math.ceil(height) + 8}px` : "";
}

/** Lo mínimo del `<html>` que toca `drawerOpenMark` (para el test sin DOM). */
type DrawerMarkRoot = {
  dataset: Record<string, string | undefined>;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
};

/**
 * [MB-0d] pf1z-toast-tapa-drawer + C-MB2: marca el `<html>` mientras haya drawers abiertos (`data-k-drawer-open` =
 * cuántos) para que el toast se corra (globals.css `.k-toaster`): en escritorio arriba a la derecha tapaba la X del
 * panel y en el celular, abajo, tapaba el pie con «Guardar». `footerHeight` (el pie medido por `DRAWER_FOOTER_ATTR`)
 * se publica como `--k-drawer-footer-h` para que el toast quede encima. Es un contador y no un booleano porque hay
 * drawers que abren otro (Plataforma) y el primero en cerrarse no tiene que borrar la marca del otro.
 */
export function drawerOpenMark(root: DrawerMarkRoot, delta: 1 | -1 | 0, footerHeight?: number | null): void {
  const count = Math.max(0, (Number(root.dataset.kDrawerOpen) || 0) + delta);
  if (count === 0) {
    delete root.dataset.kDrawerOpen;
    root.style.removeProperty("--k-drawer-footer-h");
    return;
  }
  root.dataset.kDrawerOpen = String(count);
  if (footerHeight != null) root.style.setProperty("--k-drawer-footer-h", `${Math.ceil(footerHeight)}px`);
}

/** [AS-0a] Medidas de la pila de toasts (`.k-toaster`, globals.css) y del panel (`.k-drawer-panel`). */
const TOASTER_MAX_W = 360;
/** Más angosta que esto el aviso de llegada (nombre · hora + «Ver sala») parte en tres renglones: mejor abajo. */
export const TOASTER_BESIDE_MIN_W = 260;
const TOASTER_EDGE = 16; // `left: 16px` de la pila
const TOASTER_GAP = 12; // aire entre la pila y el panel
const PANEL_MARGIN = 12; // `right: 12px` del panel (y `max-width: calc(100vw - 24px)`)
const MOBILE_MAX = 767; // < 768 manda el CSS móvil (abajo, sobre el pie del drawer)

export type ToasterPlacement = { placement: "default" | "beside" | "bottom"; toastWidth: number | null };

/**
 * [AS-0a] Pura: dónde va la pila de toasts con un drawer de `drawerWidth` abierto. Bug «Servicio solo anda después
 * de elegir Sala»: desde MB-0d la pila se corría arriba a la izquierda con 360 px fijos suponiendo drawers ≤ 480, pero
 * «Nuevo turno» mide 580 y a 800/900 px de ancho el toast tapaba el borde izquierdo de Profesional y Servicio (medido
 * con `elementFromPoint`). Como el toast se pausa con el mouse encima (12 s el de llegada), no se iba nunca mientras
 * la Secretaria intentaba abrir el select. Ahora: al lado del panel si entra (angostada hasta `TOASTER_BESIDE_MIN_W`),
 * y si no, abajo a la izquierda sobre el pie del drawer: tapa a lo sumo los últimos campos del form (que se scrollean),
 * nunca los primeros que se cargan ni «Guardar».
 */
export function drawerToasterPlacement(o: { viewportWidth: number; drawerWidth: number | null | undefined }): ToasterPlacement {
  if (!o.drawerWidth || o.drawerWidth <= 0 || o.viewportWidth <= MOBILE_MAX) return { placement: "default", toastWidth: null };
  const panel = Math.min(o.drawerWidth, o.viewportWidth - 2 * PANEL_MARGIN);
  const free = o.viewportWidth - PANEL_MARGIN - panel - TOASTER_EDGE - TOASTER_GAP;
  const toastWidth = Math.min(TOASTER_MAX_W, Math.floor(free));
  if (toastWidth >= TOASTER_BESIDE_MIN_W) return { placement: "beside", toastWidth };
  return { placement: "bottom", toastWidth: null };
}

/**
 * [AS-0a] Publica en el `<html>` el ancho del drawer más ancho abierto (`--k-drawer-w`) y el lugar de la pila
 * (`data-k-toaster` + `--k-toaster-w`). Lo llama cada Drawer al abrirse, al cerrarse y en `resize`; con la lista
 * vacía limpia todo. Lista y no un valor porque hay drawers que abren otro (Plataforma).
 */
export function applyDrawerToasterMark(root: DrawerMarkRoot, openWidths: readonly number[], viewportWidth: number): void {
  if (openWidths.length === 0) {
    delete root.dataset.kToaster;
    root.style.removeProperty("--k-drawer-w");
    root.style.removeProperty("--k-toaster-w");
    return;
  }
  const w = Math.max(...openWidths);
  root.style.setProperty("--k-drawer-w", `${w}px`);
  const p = drawerToasterPlacement({ viewportWidth, drawerWidth: w });
  if (p.placement === "default") delete root.dataset.kToaster;
  else root.dataset.kToaster = p.placement;
  if (p.toastWidth != null) root.style.setProperty("--k-toaster-w", `${p.toastWidth}px`);
  else root.style.removeProperty("--k-toaster-w");
}

/** Anchos de los drawers abiertos (uno por instancia; ver `applyDrawerToasterMark`). */
const openDrawerWidths: number[] = [];

/**
 * PF1-Z-F1 (#4): enfoca el primer campo habilitado de `container` y lo trae a la vista (p. ej. «Reprogramar», que
 * se abre debajo de la tarjeta y quedaba fuera del panel). `preventScroll` + `scrollIntoView` suave: el foco solo
 * haría un salto seco. `false` si todavía no hay campo (el form llega en un chunk aparte).
 */
export function focusFirstField(
  container: Pick<ParentNode, "querySelector"> & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void } | null | undefined
): boolean {
  const field = container?.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)'
  );
  if (!container || !field) return false;
  field.focus({ preventScroll: true });
  container.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  return true;
}

/**
 * Right-side sliding drawer.
 *
 * Use this instead of a modal when the content is contextual to the
 * underlying view (e.g. a booking preview overlaid on the calendar).
 * The page behind stays visible and the drawer slides in from the right.
 *
 * Escape + outside-click close the drawer. Body scroll is locked while
 * open so the page underneath doesn't reflow. Enter/exit animated via
 * framer-motion AnimatePresence.
 *
 * Dirty-guard (A2b-S-ui): con `dirty` en true, Esc / click en el fondo / la X
 * piden confirmación antes de cerrar ("¿Descartar los cambios?"). Antes un Esc
 * de más o un click fuera del panel tiraba el formulario de turno o de paciente
 * a medio cargar. Los botones propios del formulario ("Cancelar") siguen
 * llamando a `onClose` directo: ahí la intención de descartar es explícita.
 * Un Esc que ya consumió otro overlay (p. ej. el `ConfirmDialog`, que corta la
 * propagación) no cierra el drawer; por las dudas también se respeta
 * `defaultPrevented`.
 *
 * PF1.0-b (C-PF6): portal a `document.body` (`OverlayPortal`). Un `Modal` abierto desde el drawer ya no queda
 * encerrado por el `transform` del panel y queda por encima (`--z-drawer` < `--z-modal`). Foco atrapado, Esc y
 * scroll-lock se arman recién con el panel en su lugar definitivo (`overlayArmed`): un drawer abierto en SSR pasa de
 * en línea a portal al hidratar, y el trap tiene que apuntar al nodo nuevo.
 *
 * MB-0d (C-MB2): bajo 640 px es una hoja a pantalla completa (encabezado sticky con el cierre de 44×44 y safe-area; el
 * pie marcado con `DRAWER_FOOTER_ATTR` suma el indicador de inicio). Por eso las medidas viven en `.k-drawer-panel`
 * (globals.css) y no inline: un estilo inline no se puede pisar desde una media query. El cierre es propio (mismo
 * aspecto que `ModalCloseButton` en escritorio) porque el de los Modales es de 32 px fijos inline. Misma API.
 */
export function Drawer({
  open,
  onClose,
  title,
  // Default sized so a two-column form fits without sideways scrolling
  // (22px padding each side eats 44px of it).
  width = 480,
  dirty = false,
  dirtyMessage,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  width?: number;
  /** Hay cambios sin guardar: cerrar con Esc / fondo / X pide confirmación. */
  dirty?: boolean;
  /** Texto del aviso de descarte (default genérico). */
  dirtyMessage?: string;
  children: ReactNode;
}) {
  const hydrated = useHydrated();
  const armed = overlayArmed(open, hydrated);
  const trapRef = useFocusTrap<HTMLElement>(armed);
  // PF1-Z-F1 (#1/#3): el panel reserva el alto del footer sticky (ver `DRAWER_FOOTER_ATTR`). Un MutationObserver
  // vuelve a buscarlo porque puede montarse después (el turno llega, aparece un error); el ResizeObserver sigue su
  // alto. Sin footer el panel queda como siempre.
  useEffect(() => {
    const panel = trapRef.current;
    if (!armed || !panel) return;
    let footer: HTMLElement | null = null;
    const root = document.documentElement as unknown as DrawerMarkRoot;
    drawerOpenMark(root, 1);
    const apply = () => {
      const h = footer?.getBoundingClientRect().height ?? null;
      panel.style.scrollPaddingBottom = drawerScrollPaddingBottom(h);
      drawerOpenMark(root, 0, h ?? 0);
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    const track = () => {
      const next = panel.querySelector<HTMLElement>(`[${DRAWER_FOOTER_ATTR}]`);
      if (next === footer) return;
      if (footer) ro?.unobserve(footer);
      footer = next;
      if (footer) ro?.observe(footer);
      apply();
    };
    track();
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(track) : null;
    mo?.observe(panel, { childList: true, subtree: true });
    return () => {
      mo?.disconnect();
      ro?.disconnect();
      drawerOpenMark(root, -1);
    };
  }, [armed, trapRef]);
  // [AS-0a] Ancho del panel → lugar de la pila de toasts (ver `drawerToasterPlacement`). Se recalcula en `resize`
  // (girar la tablet, achicar la ventana) porque el lugar depende del ancho de la ventana.
  useEffect(() => {
    if (!armed) return;
    const root = document.documentElement as unknown as DrawerMarkRoot;
    openDrawerWidths.push(width);
    const apply = () => applyDrawerToasterMark(root, openDrawerWidths, window.innerWidth);
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      const at = openDrawerWidths.indexOf(width);
      if (at >= 0) openDrawerWidths.splice(at, 1);
      apply();
    };
  }, [armed, width]);
  const offset = width + 24;
  const confirm = useConfirm();
  // Evita apilar dos confirmaciones (Esc + click en el fondo seguidos).
  const asking = useRef(false);

  const requestClose = useCallback(async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirm({
        title: "¿Descartar los cambios?",
        message: dirtyMessage ?? "Tenés cambios sin guardar. Si cerrás, se pierden.",
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  }, [dirty, dirtyMessage, onClose, confirm]);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (drawerHandlesEscape(e)) void requestClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [armed, requestClose]);

  return (
    <OverlayPortal>
      <AnimatePresence>
        {open && (
          <>
            {/* backdrop */}
            <m.div
              onClick={() => void requestClose()}
              aria-hidden
              variants={backdropVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(15,30,51,0.32)",
                zIndex: "var(--z-drawer-backdrop)",
              }}
            />
            {/* panel — slides in from the right */}
            <m.aside
              ref={trapRef}
              tabIndex={-1}
              role="dialog"
              aria-modal
              aria-label={title}
              className="k-glass-strong k-scroll k-overlay-panel k-drawer-panel"
              custom={offset}
              variants={drawerVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              style={
                {
                  position: "fixed",
                  "--k-drawer-width": `${width}px`,
                  overflowY: "auto",
                  zIndex: "var(--z-drawer)",
                } as CSSProperties
              }
            >
              {/* El cierre va primero en el DOM (primer focuseable del trap, como antes); < 640 se ve a la derecha
                  del título por `order`. Sin título el encabezado igual existe: en la hoja del celular es el lugar
                  sticky del cierre. */}
              <div className="k-drawer-head" data-titled={title ? "" : undefined}>
                <button type="button" className="k-drawer-close" onClick={() => void requestClose()} aria-label="Cerrar">
                  <IconX size={14} />
                </button>
                {title && <h2 className="k-display k-drawer-title">{title}</h2>}
              </div>
              {children}
            </m.aside>
          </>
        )}
      </AnimatePresence>
    </OverlayPortal>
  );
}
