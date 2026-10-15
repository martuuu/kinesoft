"use client";

import { useEffect } from "react";
import { useTweaks, type Palette } from "./tweaks-context";
import { IconX } from "@/components/ui/icons";

/**
 * Panel «Apariencia» (ex «KineSoft · Tweaks»; Martin lo mantiene, §20.18: «se arreglan las opciones que no
 * funcionan»). PL-F1c, inventario de lo que queda y quién lo lee (cada una con su test en
 * `tests/unit/render/pl-f1c-tweaks.test.tsx`):
 *   - Paleta → `data-palette` de `<html>` (efecto de `TweaksProvider`) y `UserPreferences.palette` en el server.
 *   - Navegación «Barra lateral / Barra superior» → `dashChrome`, lo lee `AppShell` (monta `Sidebar` o `TopBar`).
 *   - «Barra lateral contraída» → `sidebarCollapsed`, prop `collapsed` del `Sidebar` (solo con barra lateral).
 *   - Vista semanal (encabezado, sábado, domingo) → prefs del server (`setAgenda`), las lee la agenda semanal.
 * Se quitaron «Timeline / Semana / Lista» y «Card de paciente»: nadie los leía (regla del 16-oct).
 *
 * Arranca cerrado y, cerrado, no deja nada flotando: el engranaje fijo abajo a la derecha (zIndex 100) tapaba el pie
 * de los Drawers («Guardar»). Se abre desde el pie del sidebar o el menú de cuenta de la barra superior; abierto va
 * debajo de modales, Drawers y toasts (zIndex 35 < 40/45/90).
 */
export const PALETTE_OPTIONS: { value: Palette; label: string; swatch: [string, string, string] }[] = [
  { value: "sky", label: "Celeste", swatch: ["#1F4FBE", "#C8F564", "#E6EFFA"] },
  { value: "mint", label: "Verde", swatch: ["#1F8A5B", "#DBFD8C", "#DBF4EA"] },
  { value: "coral", label: "Coral", swatch: ["#C9622E", "#FFD66A", "#FAE5D6"] },
  { value: "violet", label: "Violeta", swatch: ["#5F40C7", "#B6F3D8", "#E5E0FB"] },
];

export function TweaksPanel() {
  const { t, set, agenda, setAgenda } = useTweaks();
  const open = !t.minimised;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") set("minimised", true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, set]);

  if (!open) return null;

  return (
    <aside
      aria-label="Apariencia"
      className="k-glass-strong"
      style={{
        position: "fixed",
        right: 14,
        bottom: 14,
        width: 296,
        maxHeight: "calc(100vh - 28px)",
        overflowY: "auto",
        borderRadius: "var(--r-xl)",
        padding: 16,
        zIndex: 35,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--navy-500)",
          }}
        >
          Apariencia
        </h2>
        <button
          type="button"
          aria-label="Cerrar Apariencia"
          onClick={() => set("minimised", true)}
          style={{
            border: "none",
            background: "rgba(255,255,255,0.6)",
            borderRadius: 8,
            width: 28,
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            color: "var(--navy-500)",
          }}
        >
          <IconX size={14} />
        </button>
      </header>

      <Section label="Paleta">
        <div style={{ display: "flex", gap: 8 }}>
          {PALETTE_OPTIONS.map((p) => {
            const on = p.value === t.palette;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => set("palette", p.value)}
                aria-label={`Paleta ${p.label}`}
                aria-pressed={on}
                title={p.label}
                style={{
                  flex: 1,
                  padding: 6,
                  borderRadius: 12,
                  border: on
                    ? "2px solid var(--sky-700)"
                    : "1px solid rgba(15,30,51,0.08)",
                  background: "rgba(255,255,255,0.7)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 3,
                }}
              >
                {p.swatch.map((c) => (
                  <span
                    key={c}
                    style={{
                      flex: 1,
                      height: 22,
                      borderRadius: 6,
                      background: c,
                    }}
                  />
                ))}
              </button>
            );
          })}
        </div>
      </Section>

      <Section label="Navegación">
        <Radio
          value={t.dashChrome}
          options={[
            { value: "sidebar", label: "Barra lateral" },
            { value: "topbar", label: "Barra superior" },
          ]}
          onChange={(v) => set("dashChrome", v as typeof t.dashChrome)}
        />
        {/* Solo con barra lateral: con la superior no hay nada que contraer. */}
        {t.dashChrome === "sidebar" && (
          <Toggle
            label="Barra lateral contraída"
            value={t.sidebarCollapsed}
            onChange={(v) => set("sidebarCollapsed", v)}
          />
        )}
      </Section>

      <Section label="Vista semanal de la agenda">
        <Toggle
          label="Encabezado de días"
          value={agenda.agendaShowWeekHeader}
          onChange={(v) => setAgenda("agendaShowWeekHeader", v)}
        />
        <Toggle
          label="Mostrar sábado"
          value={agenda.agendaShowSaturday}
          onChange={(v) => setAgenda("agendaShowSaturday", v)}
        />
        <Toggle
          label="Mostrar domingo"
          value={agenda.agendaShowSunday}
          onChange={(v) => setAgenda("agendaShowSunday", v)}
        />
      </Section>
    </aside>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--navy-300)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Radio<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: 3,
        borderRadius: 12,
        background: "rgba(15,30,51,0.04)",
        marginBottom: 8,
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: 9,
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              background: on ? "#fff" : "transparent",
              color: on ? "var(--navy-900)" : "var(--navy-500)",
              boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 12.5,
        color: "var(--navy-700)",
        padding: "8px 4px",
        cursor: "pointer",
      }}
    >
      {label}
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          border: "none",
          cursor: "pointer",
          background: value ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
          position: "relative",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 2px rgba(15,30,51,0.2)",
            transition: "left .15s",
          }}
        />
      </button>
    </label>
  );
}
