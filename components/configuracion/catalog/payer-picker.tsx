"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Tag } from "@/components/ui/tag";
import { searchPayers } from "@/lib/catalog";
import { PAYER_KIND_LABEL, type PayerOption } from "@/lib/catalog-schemas";
import { useCatalogSearch, searchInputStyle } from "./use-catalog-search";

/**
 * Buscador de prestadoras del catálogo global (B1.4). Lo usan "Agregar del
 * catálogo" y "Vincular a otra prestadora" en Obras sociales. Solo elige: la
 * escritura (y la validación de que la prestadora exista y no esté archivada)
 * la hace la action del caller.
 *
 * `linkedPayerIds` marca las prestadoras que ya tienen una OS del consultorio
 * vinculada; se pueden volver a elegir (OSDE 210 y OSDE 310 como dos OS con
 * copagos distintos), solo se avisa.
 */
export function PayerPickerModal({
  title,
  description,
  linkedPayerIds,
  busy,
  onPick,
  onClose,
}: {
  title: string;
  description?: string;
  linkedPayerIds?: ReadonlySet<string>;
  busy?: boolean;
  onPick: (payer: PayerOption) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const { results, loading, error } = useCatalogSearch(searchPayers, q);

  return (
    <Modal onClose={onClose} title={title} description={description} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscá por nombre: OSDE, IOMA, Unión Personal…"
          aria-label="Buscar prestadora"
          autoFocus
          style={searchInputStyle}
        />
        {loading && (
          <div style={{ fontSize: 12, color: "var(--navy-300)", textAlign: "center" }}>Buscando…</div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: "var(--danger-fg)", textAlign: "center" }}>
            No pudimos buscar en el catálogo. Probá de nuevo.
          </div>
        )}
        <div
          className="k-scroll"
          style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}
        >
          {results.map((p) => {
            const linked = linkedPayerIds?.has(p.id) ?? false;
            return (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                onClick={() => onPick(p)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(31,79,190,0.15)",
                  background: "rgba(31,79,190,0.04)",
                  cursor: busy ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 2 }}>
                    {PAYER_KIND_LABEL[p.kind]}
                    {p.province ? ` · ${p.province}` : ""}
                  </div>
                </div>
                {linked && <Tag tone="soft">Ya vinculada</Tag>}
                <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>+</span>
              </button>
            );
          })}
          {!loading && !error && results.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--navy-300)", padding: 18, textAlign: "center" }}>
              {q.trim()
                ? "No la encontramos en el catálogo. Podés cargarla a mano con «Nueva obra social»."
                : "El catálogo de prestadoras todavía está vacío."}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
