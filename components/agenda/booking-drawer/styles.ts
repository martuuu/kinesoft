import type { CSSProperties } from "react";

/** Estilos inline compartidos por las piezas del drawer de turno. */

export const menuLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  padding: "0 4px 6px",
};

export const miniGhostBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.1)",
  borderRadius: 999,
  padding: "5px 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

/** Etiqueta de campo de los formularios inline (Editar / Reprogramar). */
export const fieldLabel: CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--navy-300)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
};

/** Tarjeta gris de las secciones de lectura (detalle, últimos turnos, compartir). */
export const sectionCard: CSSProperties = {
  padding: 14,
  borderRadius: 14,
  background: "rgba(246,249,253,0.7)",
  border: "1px solid rgba(15,30,51,0.06)",
};
