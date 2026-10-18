"use client";

import directory from "@/components/patients/patients-directory.module.css";
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
        className={directory.field}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        style={{
          padding: "5px 10px",
          borderRadius: 999,
          fontSize: 11.5,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.7)",
          maxWidth: 200,
          minHeight: 32,
        }}
      >
        <option value="">Todas las obras sociales</option>
        {insurers.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
        {!known && <option value={value}>Obra social inactiva</option>}
        <option value={PARTICULAR_INSURER_KEY}>Particular</option>
      </select>
      <noscript>
        <button type="submit">Filtrar</button>
      </noscript>
    </form>
  );
}
