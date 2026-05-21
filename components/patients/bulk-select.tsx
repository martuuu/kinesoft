"use client";

import { createContext, useContext, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { bulkArchivePatients } from "@/lib/patients";

/**
 * Lightweight client context that lets row checkboxes opt into the
 * bulk-action flow on the Pacientes directory. The page stays a server
 * component; only the rows + the floating action bar are client-side.
 *
 * Usage:
 *   <BulkSelectProvider>
 *     <BulkSelectCheckbox patientId={p.id} />          // per row
 *     ...
 *     <BulkActionBar archivedView={false} />           // floating bar
 *   </BulkSelectProvider>
 */
type Ctx = {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
};

const BulkCtx = createContext<Ctx | null>(null);

export function BulkSelectProvider({ children }: { children: React.ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clear = () => setSelected(new Set());
  return <BulkCtx.Provider value={{ selected, toggle, clear }}>{children}</BulkCtx.Provider>;
}

export function BulkSelectCheckbox({ patientId }: { patientId: string }) {
  const ctx = useContext(BulkCtx);
  if (!ctx) return null;
  const checked = ctx.selected.has(patientId);
  return (
    <input
      type="checkbox"
      checked={checked}
      onClick={(e) => e.stopPropagation()}
      onChange={() => ctx.toggle(patientId)}
      aria-label="Seleccionar paciente"
      style={{ cursor: "pointer", width: 16, height: 16 }}
    />
  );
}

export function BulkActionBar({ archivedView = false }: { archivedView?: boolean }) {
  const router = useRouter();
  const ctx = useContext(BulkCtx);
  const [pending, start] = useTransition();
  if (!ctx) return null;
  const ids = Array.from(ctx.selected);
  if (ids.length === 0) return null;

  const archive = (archived: boolean) => {
    start(async () => {
      const r = await bulkArchivePatients({ ids, archived });
      if (r.ok) {
        ctx.clear();
        router.refresh();
      }
    });
  };

  const exportCsv = () => {
    const sp = new URLSearchParams();
    sp.set("ids", ids.join(","));
    window.open(`/api/pacientes/export?${sp.toString()}`, "_blank");
  };

  return (
    <div
      role="region"
      aria-label="Acciones masivas"
      style={{
        position: "fixed",
        bottom: 22,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 30,
        padding: "10px 14px",
        borderRadius: 16,
        background: "var(--navy-900)",
        color: "#fff",
        boxShadow: "0 16px 36px rgba(15,30,51,0.32)",
        display: "flex",
        gap: 12,
        alignItems: "center",
        minWidth: 360,
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700 }}>
        {ids.length} {ids.length === 1 ? "paciente" : "pacientes"} seleccionado{ids.length === 1 ? "" : "s"}
      </span>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={exportCsv}
        disabled={pending}
        style={pillBtn}
      >
        Exportar CSV
      </button>
      {archivedView ? (
        <Button variant="primary" onClick={() => archive(false)} disabled={pending}>
          Restaurar
        </Button>
      ) : (
        <Button variant="primary" onClick={() => archive(true)} disabled={pending}>
          Archivar
        </Button>
      )}
      <button
        type="button"
        onClick={() => ctx.clear()}
        aria-label="Cancelar"
        style={pillBtn}
      >
        Cancelar
      </button>
    </div>
  );
}

const pillBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 999,
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "#fff",
  cursor: "pointer",
};
