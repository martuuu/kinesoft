/**
 * Piezas visuales compartidas por los pasos del turnero público (B5.6).
 * Sin estado ni efectos: el wizard (`../public-booking-wizard.tsx`) es el
 * único dueño del estado.
 */
import type { CSSProperties, ReactNode } from "react";

export function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h2
        className="k-display"
        style={{ fontSize: 20, margin: 0, fontWeight: 700, letterSpacing: "-0.01em" }}
      >
        {title}
      </h2>
      <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "4px 0 0" }}>{subtitle}</p>
    </header>
  );
}

/** Caja punteada para estados vacíos / espera / error suave. */
export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: "center",
        color: "var(--navy-500)",
        fontSize: 13,
        border: "1px dashed rgba(15,30,51,0.12)",
        borderRadius: 14,
      }}
    >
      {children}
    </div>
  );
}

/** Tarjeta-botón seleccionable (profesional, servicio, sede). */
export function choiceStyle(on: boolean): CSSProperties {
  return {
    textAlign: "left",
    padding: 14,
    borderRadius: 14,
    border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.06)",
    background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.7)",
    cursor: "pointer",
    fontFamily: "inherit",
    color: "var(--navy-900)",
    // Táctil: ≥44 px de alto en mobile.
    minHeight: 44,
  };
}

/** Etiqueta chica de sección dentro de un paso ("¿En qué sede?"). */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}
    >
      {children}
    </label>
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
