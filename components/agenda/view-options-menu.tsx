"use client";

import { useEffect, useRef, useState } from "react";
import type { AgendaVisibility } from "@/lib/agenda-filters";

// ──────────────────────────────────────────────────────────────────────
// View Options dropdown — small menu next to the day/week/list switch
// ──────────────────────────────────────────────────────────────────────

export function ViewOptionsMenu({
  density,
  setDensity,
  visibility,
  setVisibility,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  /** A2b-S-ui: "Mostrar cancelados" / "Mostrar ausentes" (por defecto prendidos). */
  visibility: AgendaVisibility;
  setVisibility: (v: AgendaVisibility) => void;
}) {
  const filtering = !visibility.showCancelled || !visibility.showNoShow;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="k-glass"
        style={{
          height: 36,
          padding: "0 12px",
          borderRadius: 999,
          border: "none",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--navy-700)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Vista
        {/* Punto = hay turnos filtrados: que el filtro no quede "olvidado". */}
        {filtering && (
          <span
            aria-label="Hay filtros activos"
            style={{ width: 6, height: 6, borderRadius: 999, background: "var(--sky-700)" }}
          />
        )}
        <span style={{ fontSize: 9, color: "var(--navy-300)" }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            width: 240,
            borderRadius: 14,
            padding: 10,
            zIndex: 25,
          }}
        >
          <div style={menuLabel}>Densidad</div>
          <div
            style={{
              display: "flex",
              padding: 3,
              borderRadius: 999,
              background: "rgba(15,30,51,0.04)",
              marginBottom: 10,
            }}
          >
            {(["comfortable", "compact"] as const).map((d) => {
              const on = density === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: on ? "#fff" : "transparent",
                    color: on ? "var(--navy-900)" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {d === "comfortable" ? "Cómoda" : "Compacta"}
                </button>
              );
            })}
          </div>
          <div style={menuLabel}>Mostrar</div>
          <div style={{ display: "grid", gap: 2, marginBottom: 10 }}>
            <ToggleRow
              label="Mostrar cancelados"
              checked={visibility.showCancelled}
              onChange={(v) => setVisibility({ ...visibility, showCancelled: v })}
            />
            <ToggleRow
              label="Mostrar ausentes"
              checked={visibility.showNoShow}
              onChange={(v) => setVisibility({ ...visibility, showNoShow: v })}
            />
          </div>
          <div style={{ fontSize: 11.5, color: "var(--navy-300)", padding: "2px 4px", lineHeight: 1.4 }}>
            El encabezado de días (tira + grilla) se controla desde Tweaks → «Vista semanal».
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      role="menuitemcheckbox"
      aria-checked={checked}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 4px",
        borderRadius: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: "var(--navy-700)",
        cursor: "pointer",
      }}
    >
      {label}
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const menuLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  padding: "0 4px 6px",
};
