"use client";

import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { IconCheck } from "@/components/ui/icons";
import { updateUserPreferences } from "@/lib/preferences";
import { kpiOptionsFor, pinnableKpis, type KpiKey, type KpiRevenueScope } from "@/lib/preferences-constants";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

/**
 * Selector de indicadores fijados del «+ Agregar» de la fila (antes en `pin-kpi-button.tsx`).
 *
 * PF1.1-dashboard (C-PF2): vive en su propio módulo para que `PinKpiButton` lo baje con `next/dynamic` recién al
 * abrirlo (se precarga en hover/foco del botón). Antes el `Modal`, el picker y la action iban en el JS inicial de
 * `/dashboard` aunque casi nadie lo abre.
 */
/** Exportado para el test de render (tests/unit/render/kpi-picker.test.tsx). */
const MAX_PINNED_KPIS = 6;

export function PinKpiModal({
  open,
  currentPinned,
  onClose,
  revenueScope = "tenant",
}: {
  open: boolean;
  currentPinned: KpiKey[];
  onClose: () => void;
  revenueScope?: KpiRevenueScope;
}) {
  // EV1-A: sin `planes` (General) el picker no ofrece KPIs de planes y rotula
  // con turnos (`kpiOptionsFor`). Fuera del AppShell el default es Kine PRO.
  const modules = useTenantModules();
  const options = kpiOptionsFor(revenueScope, modules);
  const [pinned, setPinned] = useState<KpiKey[]>(() => pinnableKpis(currentPinned, revenueScope, modules));
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Reset the draft selection each time the picker opens so a prior
  // cancelled edit doesn't linger (the component stays mounted for the
  // exit animation).
  useEffect(() => {
    if (open) {
      setPinned(pinnableKpis(currentPinned, revenueScope, modules));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Tope de 6 también en la UI: antes se podía marcar una séptima y el server la rechazaba al guardar
  // («Máx 6 KPIs fijados.», lib/preferences.ts). Las no elegidas quedan deshabilitadas con el tope lleno.
  const full = pinned.length >= MAX_PINNED_KPIS;
  const toggle = (key: KpiKey) =>
    setPinned((s) =>
      s.includes(key) ? s.filter((k) => k !== key) : s.length >= MAX_PINNED_KPIS ? s : [...s, key]
    );

  const save = () => {
    setError(null);
    start(async () => {
      const r = await updateUserPreferences({ pinnedKpis: pinned });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // C-PF4: `updateUserPreferences` hace `revalidatePath("/dashboard")` y Next ya trae el RSC nuevo con la
      // respuesta de la action; el `router.refresh()` que había acá era un segundo render del tablero entero.
      onClose();
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={520}
      title="Indicadores fijados"
      description="Elegí hasta 6. El orden de selección define el orden en la grilla."
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 6 }}>
          {options.map((opt) => {
            const on = pinned.includes(opt.key);
            const idx = pinned.indexOf(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                aria-pressed={on}
                disabled={!on && full}
                onClick={() => toggle(opt.key)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: on
                    ? "1px solid var(--sky-700)"
                    : "1px solid rgba(15,30,51,0.08)",
                  background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.6)",
                  textAlign: "left",
                  cursor: !on && full ? "not-allowed" : "pointer",
                  opacity: !on && full ? 0.55 : 1,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 5,
                    background: on ? "var(--sky-700)" : "rgba(15,30,51,0.06)",
                    color: "#fff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    marginTop: 1,
                    fontSize: 9,
                    fontWeight: 800,
                  }}
                >
                  {on ? idx + 1 : ""}
                </span>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--navy-400)" }}>
                    {opt.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 10,
              background: "var(--danger-bg)",
              color: "var(--danger-fg)",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            <IconCheck size={12} stroke={3} /> {pinned.length} de {MAX_PINNED_KPIS} seleccionados
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
    </Modal>
  );
}
