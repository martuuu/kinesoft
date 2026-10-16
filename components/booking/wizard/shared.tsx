/**
 * Piezas visuales compartidas por los pasos del turnero público (B5.6).
 * Sin estado ni efectos: el wizard (`../public-booking-wizard.tsx`) es el
 * único dueño del estado. VX2-d1: estilos en `../public-booking.module.css`
 * (antes inline); la tarjeta-botón seleccionable es la clase `.choice` con
 * `aria-pressed` (reemplaza a `choiceStyle`).
 */
import type { ReactNode } from "react";
import s from "../public-booking.module.css";

/**
 * VX-Z: al avanzar o retroceder, el wizard reemplaza el contenido de la card y el foco quedaba en el botón (o en
 * `<body>` si el botón se desmontaba): el lector de pantalla no anunciaba el paso nuevo. El título del paso es el
 * destino del foco (`tabIndex=-1`: enfocable por script, fuera del orden de tab), marcado con `data-step-heading`.
 */
export const STEP_HEADING_SELECTOR = "[data-step-heading]";

type Focusable = { focus: (opts?: { preventScroll?: boolean }) => void };
type HeadingRoot = { querySelector: (sel: string) => Focusable | null };

/** Enfoca el título del paso dentro de `root`. Devuelve si encontró uno (sin título no se mueve nada). */
export function focusStepHeading(root: HeadingRoot | null): boolean {
  const h = root?.querySelector(STEP_HEADING_SELECTOR) ?? null;
  if (!h) return false;
  h.focus({ preventScroll: false });
  return true;
}

export function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h2 className={`k-display ${s.stepTitle}`} tabIndex={-1} data-step-heading="">
        {title}
      </h2>
      <p className={s.stepSubtitle}>{subtitle}</p>
    </header>
  );
}

/** Caja punteada para estados vacíos / espera / error suave. `role="status"`: el lector anuncia el cambio. */
export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className={s.empty} role="status">
      {children}
    </div>
  );
}

/** Etiqueta chica de sección dentro de un paso ("¿En qué sede?"). Sin `htmlFor` es texto (grupo de botones). */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return htmlFor ? (
    <label htmlFor={htmlFor} className={s.sectionLabel}>
      {children}
    </label>
  ) : (
    <div className={s.sectionLabel}>{children}</div>
  );
}

/** "jueves 02 de octubre, 10:30" en pared AR (el navegador puede estar en otro huso). */
export function formatWhenAR(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}
