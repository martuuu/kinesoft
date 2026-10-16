/**
 * Piezas visuales compartidas por los pasos del turnero público (B5.6).
 * Sin estado ni efectos: el wizard (`../public-booking-wizard.tsx`) es el
 * único dueño del estado. VX2-d1: estilos en `../public-booking.module.css`
 * (antes inline); la tarjeta-botón seleccionable es la clase `.choice` con
 * `aria-pressed` (reemplaza a `choiceStyle`).
 */
import type { ReactNode } from "react";
import s from "../public-booking.module.css";

export function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h2 className={`k-display ${s.stepTitle}`}>{title}</h2>
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
