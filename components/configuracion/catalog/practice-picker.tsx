"use client";

import { useState } from "react";
import { Tag } from "@/components/ui/tag";
import { searchPractices } from "@/lib/catalog";
import type { PracticeOption } from "@/lib/catalog-schemas";
import { useCatalogSearch, searchInputStyle } from "./use-catalog-search";

export type PickedPractice = Pick<PracticeOption, "id" | "name"> &
  Partial<Pick<PracticeOption, "code" | "nomenclador" | "defaultDurationMin">>;

/**
 * Picker opcional de práctica del catálogo global para un servicio (B1.4).
 * Inline (no modal) porque vive dentro del Drawer del servicio. Escribe el id
 * en un `<input type="hidden" name={name}>` para que el `FormData` del form lo
 * lleve; "" = sin práctica. La validación (existe y no archivada) la hace
 * `lib/services.ts` en la tx de escritura.
 */
export function PracticePicker({
  name = "practiceId",
  value,
  onChange,
}: {
  name?: string;
  value: PickedPractice | null;
  onChange: (p: PracticeOption | null) => void;
}) {
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const { results, loading, error } = useCatalogSearch(searchPractices, q, searching);

  return (
    <div style={{ fontSize: 12, minWidth: 0 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Práctica del catálogo (opcional)</span>
      <input type="hidden" name={name} value={value?.id ?? ""} />
      {value && !searching ? (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 12,
            border: "1px solid rgba(15,30,51,0.08)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{value.name}</div>
            {(value.code || value.nomenclador) && (
              <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                {[value.nomenclador, value.code].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          <LinkButton onClick={() => setSearching(true)}>Cambiar</LinkButton>
          <LinkButton onClick={() => onChange(null)}>Quitar</LinkButton>
        </div>
      ) : !searching ? (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: "var(--navy-300)" }}>Sin práctica: servicio propio del consultorio.</span>
          <LinkButton onClick={() => setSearching(true)}>Elegir del catálogo</LinkButton>
        </div>
      ) : (
        <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscá: fisiokinesioterapia, RPG, código…"
            aria-label="Buscar práctica"
            autoFocus
            style={searchInputStyle}
          />
          {loading && <div style={{ color: "var(--navy-300)" }}>Buscando…</div>}
          {error && <div style={{ color: "#9F1F1F" }}>No pudimos buscar en el catálogo.</div>}
          <div className="k-scroll" style={{ display: "grid", gap: 4, maxHeight: 220, overflowY: "auto" }}>
            {results.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p);
                  setSearching(false);
                  setQ("");
                }}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(31,79,190,0.15)",
                  background: "rgba(31,79,190,0.04)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                {p.code && <span className="k-mono" style={{ fontSize: 11 }}>{p.code}</span>}
                {p.defaultDurationMin != null && <Tag tone="soft">{p.defaultDurationMin} min</Tag>}
              </button>
            ))}
            {!loading && !error && results.length === 0 && (
              <div style={{ color: "var(--navy-300)", padding: 8 }}>Sin resultados.</div>
            )}
          </div>
          <LinkButton onClick={() => { setSearching(false); setQ(""); }}>Cancelar</LinkButton>
        </div>
      )}
    </div>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        color: "var(--sky-700)",
        cursor: "pointer",
        fontSize: 12.5,
        fontWeight: 700,
        padding: 0,
        justifySelf: "start",
      }}
    >
      {children}
    </button>
  );
}
