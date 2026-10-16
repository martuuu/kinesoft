"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { IconPlus } from "@/components/ui/icons";
import type { KpiKey, KpiRevenueScope } from "@/lib/preferences-constants";
import dash from "./dashboard.module.css";

/**
 * PF1.1-dashboard (C-PF2): el selector se baja recién al abrirlo y se precarga en hover/foco del botón (`import()` sin
 * await), así el click no espera red. `ssr: false` es seguro: el modal nunca está abierto en el primer render.
 */
const loadPinKpiModal = () => import("./pin-kpi-modal");
const PinKpiModal = dynamic(() => loadPinKpiModal().then((m) => m.PinKpiModal), { ssr: false, loading: () => null });

/**
 * The "+ Agregar" button on the pinned-KPIs row.
 *
 * Same picker as the Profile menu's Settings modal, but scoped to KPIs
 * only — so a practitioner mid-flow can tweak the row without leaving
 * the dashboard.
 *
 * SRZ-FX3 (B8): `revenueScope` (SR-D5I) decide si se ofrece la KPI de
 * ingresos y con qué rótulo (`kpiOptionsFor`). Default `tenant` = lo de antes.
 */
export function PinKpiButton({
  currentPinned,
  revenueScope = "tenant",
}: {
  currentPinned: KpiKey[];
  revenueScope?: KpiRevenueScope;
}) {
  const [open, setOpen] = useState(false);
  // Una vez abierto queda montado: el Modal anima la salida y la segunda apertura no vuelve a pedir el chunk.
  const [mounted, setMounted] = useState(false);
  const preload = () => void loadPinKpiModal();
  return (
    <>
      <button
        type="button"
        // MB-1d: el mínimo de 32 px pasó a la clase (`.pinBtn`) y < 768 sube a 44 (`.tap`): un `minHeight` inline no
        // se pisa desde una media query.
        className={`k-btn k-btn-ghost ${dash.pinBtn} ${dash.tap}`}
        aria-haspopup="dialog"
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
        style={{ fontSize: 12, padding: "6px 12px", gap: 6 }}
      >
        <IconPlus size={12} /> Agregar
      </button>
      {mounted && (
        <PinKpiModal
          open={open}
          currentPinned={currentPinned}
          revenueScope={revenueScope}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
