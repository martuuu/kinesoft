"use client";

import type { Role } from "@prisma/client";

export type Tab = "general" | "servicios" | "obras-sociales" | "diagnosticos" | "usuarios";

export function TabsBar({ tab, setTab, role }: { tab: Tab; setTab: (t: Tab) => void; role: Role }) {
  const tabs: { key: Tab; label: string; ownerOnly?: boolean }[] = [
    { key: "general", label: "General" },
    { key: "servicios", label: "Servicios" },
    { key: "obras-sociales", label: "Obras Sociales" },
    { key: "diagnosticos", label: "Diagnósticos" },
    { key: "usuarios", label: "Usuarios", ownerOnly: true },
  ];
  return (
    <div
      className="k-glass"
      style={{
        display: "inline-flex",
        padding: 4,
        borderRadius: 999,
        gap: 2,
        alignSelf: "flex-start",
      }}
    >
      {tabs.map((t) => {
        if (t.ownerOnly && role !== "OWNER") return null;
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              background: on ? "var(--navy-900)" : "transparent",
              color: on ? "#fff" : "var(--navy-500)",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      disabled={disabled}
      style={{
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 2px 6px rgba(15,30,51,0.18)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(228,70,70,0.1)",
        color: "#9F1F1F",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}
