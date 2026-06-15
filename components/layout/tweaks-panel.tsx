"use client";

import { useTweaks, type Palette, type AgendaView, type PatientCard } from "./tweaks-context";
import { IconChevR, IconSettings } from "@/components/ui/icons";

/**
 * Floating tweaks panel — same controls as the design prototype, refactored
 * around a typed React context and with an additional minimise/collapse
 * toggle (per the brief). The panel collapses to a 44×44 tab on the right
 * edge; clicking the tab restores the full panel.
 */
export function TweaksPanel() {
  const { t, set, agenda, setAgenda } = useTweaks();

  if (t.minimised) {
    return (
      <button
        type="button"
        aria-label="Abrir Tweaks"
        onClick={() => set("minimised", false)}
        className="k-glass-strong"
        style={{
          position: "fixed",
          right: 14,
          bottom: 14,
          width: 44,
          height: 44,
          borderRadius: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          color: "var(--navy-700)",
          zIndex: 100,
          border: "none",
        }}
      >
        <IconSettings size={18} />
      </button>
    );
  }

  const palettes: { value: Palette; swatch: [string, string, string] }[] = [
    { value: "sky", swatch: ["#1F4FBE", "#C8F564", "#E6EFFA"] },
    { value: "mint", swatch: ["#1F8A5B", "#DBFD8C", "#DBF4EA"] },
    { value: "coral", swatch: ["#C9622E", "#FFD66A", "#FAE5D6"] },
    { value: "violet", swatch: ["#5F40C7", "#B6F3D8", "#E5E0FB"] },
  ];

  return (
    <aside
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
        zIndex: 100,
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
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--navy-500)",
          }}
        >
          KineSoft · Tweaks
        </div>
        <button
          type="button"
          aria-label="Minimizar Tweaks"
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
          <IconChevR size={14} />
        </button>
      </header>

      <Section label="Paleta">
        <div style={{ display: "flex", gap: 8 }}>
          {palettes.map((p) => {
            const on = p.value === t.palette;
            return (
              <button
                key={p.value}
                onClick={() => set("palette", p.value)}
                aria-label={p.value}
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

      <Section label="Dashboard">
        <Radio
          value={t.dashChrome}
          options={[
            { value: "sidebar", label: "Sidebar" },
            { value: "topbar", label: "Topbar" },
          ]}
          onChange={(v) => set("dashChrome", v as typeof t.dashChrome)}
        />
        <Toggle
          label="Sidebar collapsed"
          value={t.sidebarCollapsed}
          onChange={(v) => set("sidebarCollapsed", v)}
        />
      </Section>

      <Section label="Agenda">
        <Radio
          value={t.agendaView}
          options={[
            { value: "timeline", label: "Timeline" },
            { value: "grilla", label: "Semana" },
            { value: "lista", label: "Lista" },
          ]}
          onChange={(v) => set("agendaView", v as AgendaView)}
        />
        <Select
          label="Card de paciente"
          value={t.patientCard}
          options={[
            { value: "rich", label: "Hero con foto" },
            { value: "compact", label: "Compacta" },
            { value: "clinical", label: "Clínica" },
          ]}
          onChange={(v) => set("patientCard", v as PatientCard)}
        />
      </Section>

      <Section label="Vista semanal">
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

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label
      style={{
        display: "block",
        fontSize: 11,
        color: "var(--navy-500)",
        fontWeight: 600,
        marginTop: 4,
      }}
    >
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        style={{
          marginTop: 6,
          width: "100%",
          padding: "8px 10px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.8)",
          fontSize: 13,
          color: "var(--navy-900)",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
