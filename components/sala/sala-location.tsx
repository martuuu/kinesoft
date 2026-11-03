"use client";

import { useContext } from "react";
import Link from "next/link";
import { SalaLocationContext } from "./sala-location-context";

/**
 * [CF2 · D-CF2-5] Sede y fecha en los headers de /sala.
 *
 * - **Sede**: con ≥2 sedes, `SalaClient` provee `SalaLocationContext` (`sala-location-context.ts`) y recorta `live`
 *   antes de dárselo a las caras; los headers (Tablero `sala-header.tsx`, Lista/Flujo `desk/desk-header.tsx`) montan
 *   `<SalaLocationSelect />` sin sumar props, como «Pantallas» (`DisplaysContext`). Sin provider o con una sede → nada.
 * - **Fecha**: /sala sigue siendo solo de hoy (SV-D8); para otro día, `SalaOtherDayLink` lleva a la Recepción de la
 *   agenda, que sí navega fechas.
 *
 * Este módulo lo importan SOLO los headers (chunks de las caras, C-PF2): no entra al first load de /sala.
 */
export { SalaLocationContext, persistSalaLocation, type SalaLocationValue } from "./sala-location-context";

const LOC_STYLE = { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--navy-500)" } as const;
const SELECT_STYLE = { width: "auto", height: 40, fontSize: 14 } as const;

export function SalaLocationSelect({ className }: { className?: string }) {
  const ctx = useContext(SalaLocationContext);
  if (!ctx) return null;
  return (
    // Estilo en línea a propósito: el CSS de cada header es de su cara (otro chunk); acá solo lo mínimo para que el
    // `k-input` (ancho 100 %) no se estire en la fila de herramientas. 40 px = `k-btn-sm`, el alto de «Pantallas».
    <label className={className ? `sala-loc ${className}` : "sala-loc"} style={LOC_STYLE}>
      <span className="sala-loc-label">Sede</span>
      <select
        className="k-input sala-loc-select"
        style={SELECT_STYLE}
        value={ctx.locationId ?? ""}
        onChange={(e) => ctx.setLocationId(e.target.value || null)}
      >
        <option value="">Todas las sedes</option>
        {ctx.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export const SALA_OTHER_DAY_HREF = "/agenda?view=reception";

export function SalaOtherDayLink({ className }: { className?: string }) {
  return (
    <Link href={SALA_OTHER_DAY_HREF} className={className ? `sala-otherday ${className}` : "sala-otherday"}>
      ¿Otro día? <span aria-hidden="true">→</span> Recepción de la agenda
    </Link>
  );
}
