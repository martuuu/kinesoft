"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { IconCheck, IconPlus, IconX } from "@/components/ui/icons";
import {
  KPI_OPTIONS,
  updateUserPreferences,
  type KpiKey,
} from "@/lib/preferences";

/**
 * The "+ Agregar" button on the pinned-KPIs row.
 *
 * Same picker as the Profile menu's Settings modal, but scoped to KPIs
 * only — so a practitioner mid-flow can tweak the row without leaving
 * the dashboard.
 */
export function PinKpiButton({ currentPinned }: { currentPinned: KpiKey[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.6)",
          border: "1px solid rgba(15,30,51,0.06)",
          fontSize: 12,
          color: "var(--navy-700)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <IconPlus size={12} /> Agregar
      </button>
      {open && (
        <PinKpiModal currentPinned={currentPinned} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function PinKpiModal({
  currentPinned,
  onClose,
}: {
  currentPinned: KpiKey[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pinned, setPinned] = useState<KpiKey[]>(currentPinned);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: KpiKey) =>
    setPinned((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  const save = () => {
    setError(null);
    start(async () => {
      const r = await updateUserPreferences({ pinnedKpis: pinned });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong"
        style={{ width: "min(520px, 100%)", borderRadius: 22, padding: 22 }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div>
            <h2 className="k-display" style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
              Indicadores fijados
            </h2>
            <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "2px 0 0" }}>
              Elegí hasta 6. El orden de selección define el orden en la grilla.
            </p>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 32,
              height: 32,
              borderRadius: 10,
              cursor: "pointer",
              color: "var(--navy-700)",
            }}
          >
            <IconX size={14} />
          </button>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {KPI_OPTIONS.map((opt) => {
            const on = pinned.includes(opt.key);
            const idx = pinned.indexOf(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => toggle(opt.key)}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: on
                    ? "1px solid var(--sky-700)"
                    : "1px solid rgba(15,30,51,0.08)",
                  background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.6)",
                  textAlign: "left",
                  cursor: "pointer",
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
                  <div style={{ fontSize: 10.5, color: "var(--navy-300)" }}>
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
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
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
            <IconCheck size={12} stroke={3} /> {pinned.length} de 6 seleccionados
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
      </div>
    </div>
  );
}
