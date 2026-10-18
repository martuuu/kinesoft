"use client";

import { INSURER_FILTER_PARTICULAR } from "@/lib/agenda-client-state";
import styles from "./agenda-toolbar.module.css";

/**
 * [AS-2o] Filtro por obra social de la agenda (T3e-2o, plan §23.9). Presentacional y controlado: `value` = el filtro
 * ya pasado por `effectiveInsurerFilter` (null = todas) y `onChange` lo pone en la URL (`?os=`) el caller.
 *
 * `<select>` nativo y no chips como la sala: un consultorio tiene decenas de obras sociales (la densidad de la
 * Secretaria no admite una fila de chips más) y el nativo trae teclado, lector de pantalla y el picker del celular
 * sin JS propio. Mismo look que el select de profesionales de la toolbar (`styles.select`, 44 px en touch).
 *
 * Va diferido (`next/dynamic` + `SsrHold`, como `RoomFilter`): solo existe con ≥1 obra social que no sea Particular
 * (`showInsurerFilter`) y no suma al first load de `/agenda`. `insurers` = el catálogo de la página (activas, sin la
 * Particular, que va como opción fija).
 */
export function InsurerFilter({
  insurers,
  value,
  onChange,
}: {
  insurers: ReadonlyArray<{ id: string; name: string }>;
  value: string | null;
  onChange: (insurerKey: string | null) => void;
}) {
  if (insurers.length === 0) return null;
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Filtrar por obra social"
      className={styles.select}
    >
      <option value="">Todas las obras sociales</option>
      <option value={INSURER_FILTER_PARTICULAR}>Particular</option>
      {insurers.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </select>
  );
}
