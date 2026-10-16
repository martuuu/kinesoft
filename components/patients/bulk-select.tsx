"use client";

import { createContext, useContext, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { bulkArchivePatients } from "@/lib/patients";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import {
  ArchivePatientDialog,
  shouldAskArchivePlans,
  type ArchivePatientResult,
} from "@/components/patients/archive-patient-dialog";
import type { PatientArchivePlansAction } from "@/lib/plans-lifecycle-state";

/**
 * S32a (ES4): ¿«Archivar» masivo pasa por la pregunta L9? Antes la barra llamaba
 * a `bulkArchivePatients` sin `plansAction` y el server pausaba los planes sin
 * preguntar (AUDIT `archivar-paciente-lista-sin-L9`). En bulk no se conocen los
 * planes vivos de la selección (`livePlanCount: null`): con el módulo `planes`
 * se pregunta siempre y el copy lo dice en condicional. Restaurar no toca planes.
 */
export function bulkArchiveStep(input: { archived: boolean; plansEnabled: boolean }): "ask-plans" | "direct" {
  if (!input.archived) return "direct";
  return shouldAskArchivePlans({ plansEnabled: input.plansEnabled, livePlanCount: null }) ? "ask-plans" : "direct";
}

/** La action que dispara el diálogo L9 de la barra (todo-o-nada, A2b). */
export async function bulkArchiveWithPlans(
  ids: string[],
  plansAction: PatientArchivePlansAction,
): Promise<ArchivePatientResult> {
  const r = await bulkArchivePatients({ ids, archived: true, plansAction });
  if (!r.ok) return { ok: false, error: r.error };
  // PF-0d: sin `router.refresh()`; la action revalida "/pacientes".
  return { ok: true };
}

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
  const ctx = useContext(BulkCtx);
  const [pending, start] = useTransition();
  const [askPlans, setAskPlans] = useState(false);
  const toast = useToast();
  const plansEnabled = useTenantModules().has("planes");
  if (!ctx) return null;
  const ids = Array.from(ctx.selected);
  if (ids.length === 0) return null;

  const archive = (archived: boolean) => {
    if (bulkArchiveStep({ archived, plansEnabled }) === "ask-plans") {
      setAskPlans(true);
      return;
    }
    start(async () => {
      const r = await bulkArchivePatients({ ids, archived });
      // Todo-o-nada (A2b): si un paciente de la selección no se puede tocar
      // (acceso básico, de otro tenant), no se archiva ninguno. Antes el
      // rechazo era silencioso y la barra quedaba como si nada.
      if (!r.ok) {
        toast.error(archived ? "No pudimos archivar" : "No pudimos reactivar", { description: r.error });
        return;
      }
      ctx.clear();
      // PF-0d: sin `router.refresh()`. `bulkArchivePatients` revalida
      // "/pacientes" en el OK: la lista nueva llega con la respuesta.
    });
  };

  const exportCsv = () => {
    const sp = new URLSearchParams();
    sp.set("ids", ids.join(","));
    window.open(`/api/pacientes/export?${sp.toString()}`, "_blank");
  };

  return (
    <>
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
    {/* Portal a body: la barra es `position: fixed` con `transform` y un Modal
        adentro quedaría atrapado en ella. Montado solo abierto (arranca en pausar). */}
    {askPlans && typeof document !== "undefined"
      ? createPortal(
          <ArchivePatientDialog
            open
            onClose={() => setAskPlans(false)}
            count={ids.length}
            livePlanCount={null}
            onConfirm={async (plansAction) => {
              const r = await bulkArchiveWithPlans(ids, plansAction);
              if (r.ok) ctx.clear();
              return r;
            }}
          />,
          document.body,
        )
      : null}
    </>
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
