/**
 * Estilos compartidos entre el botón del selector de consultorio (`tenant-switcher.tsx`, en el shell) y su lista
 * (`tenant-switcher-panel.tsx`, que se baja al abrir). PF1.0-a: viven aparte para que el chunk diferido y el shell no
 * se importen entre sí.
 */
import type { CSSProperties } from "react";

/** Caja flotante de la lista: al costado del botón con el sidebar contraído, debajo con el expandido. */
export function panelBoxStyle(collapsed: boolean): CSSProperties {
  return {
    position: "absolute",
    zIndex: 40,
    borderRadius: 14,
    padding: 6,
    ...(collapsed ? { top: 0, left: "calc(100% + 12px)", width: 272 } : { top: "100%", left: 0, right: 0, marginTop: -8 }),
  };
}

export const nameStyle: CSSProperties = {
  display: "block",
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--navy-900)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const sectionLabelStyle: CSSProperties = {
  padding: "8px 10px 6px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
};

export const initialsStyle: CSSProperties = {
  flex: "0 0 auto",
  width: 30,
  height: 30,
  borderRadius: "var(--r-md)",
  display: "grid",
  placeItems: "center",
  fontWeight: 700,
  fontSize: 12,
  background: "var(--sky-100)",
  color: "var(--sky-700)",
};

export const seeAllStyle: CSSProperties = {
  display: "block",
  padding: "9px 10px",
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 500,
  color: "var(--sky-700)",
  textDecoration: "none",
};
