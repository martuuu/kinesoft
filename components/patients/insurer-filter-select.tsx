"use client";

import directory from "@/components/patients/patients-directory.module.css";
import styles from "./insurer-filter-select.module.css";
import { PARTICULAR_INSURER_KEY } from "@/lib/patients-os-filter";

/**
 * T3e-2p (plan §23.9): filtro «Obra social» de /pacientes. `<select>` nativo dentro de un form GET: elegir envía el
 * form (sin JS no hay `onChange`, pero el botón «Filtrar» del `<noscript>` lo cubre). Antes era un input de texto que
 * hacía ILIKE sobre el nombre de cualquier cobertura: «OSDE» traía a quien había sido de OSDE y nombres parecidos.
 * `preserved` = el resto de la query (búsqueda, orden y filtros avanzados), así elegir la OS no los pierde.
 */
export function InsurerFilterSelect({
  value,
  insurers,
  preserved,
}: {
  value: string;
  insurers: { id: string; name: string }[];
  preserved: Record<string, string | undefined>;
}) {
  // Un `?os=` que ya no está en el catálogo activo (OS dada de baja, link viejo) se muestra igual: si no, el select
  // diría «Todas» con la lista filtrada.
  const known = value === "" || value === PARTICULAR_INSURER_KEY || insurers.some((i) => i.id === value);
  return (
    <form action="/pacientes" method="get" style={{ display: "inline-flex", gap: 4 }}>
      {Object.entries(preserved).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <select
        name="os"
        defaultValue={value}
        aria-label="Filtrar por obra social"
        className={`${directory.field} ${styles.select}`}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {/* T3-Z (M9): mismo orden que el filtro de la agenda (Todas, Particular, catálogo) y la inactiva al final:
            Particular arriba porque es la opción más usada y con decenas de OS quedaba perdida al fondo. */}
        <option value="">Todas las obras sociales</option>
        <option value={PARTICULAR_INSURER_KEY}>Particular</option>
        {insurers.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
        {!known && <option value={value}>Obra social inactiva</option>}
      </select>
      <noscript>
        <button type="submit">Filtrar</button>
      </noscript>
    </form>
  );
}
