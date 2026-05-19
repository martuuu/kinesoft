"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { IconCheck, IconLogout, IconSettings, IconX } from "@/components/ui/icons";
import {
  KPI_OPTIONS,
  updateUserPreferences,
  type KpiKey,
  type Palette,
  type Preferences,
} from "@/lib/preferences";
import { useTweaks } from "@/components/layout/tweaks-context";

const PALETTES: { value: Palette; swatch: [string, string, string]; label: string }[] = [
  { value: "sky", swatch: ["#1F4FBE", "#C8F564", "#E6EFFA"], label: "Sky" },
  { value: "mint", swatch: ["#1F8A5B", "#DBFD8C", "#DBF4EA"], label: "Mint" },
  { value: "coral", swatch: ["#C9622E", "#FFD66A", "#FAE5D6"], label: "Coral" },
  { value: "violet", swatch: ["#5F40C7", "#B6F3D8", "#E5E0FB"], label: "Violet" },
];

/**
 * Profile menu — the avatar in the dashboard top-right.
 *
 * Click → dropdown with the practitioner name + "Ajustes" + "Cerrar
 * sesión". Ajustes opens a modal with palette picker (mirrors Tweaks,
 * but persisted server-side) + pinned KPIs picker.
 */
export function ProfileMenu({
  name,
  preferences,
}: {
  name: string;
  preferences: Preferences;
}) {
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
        aria-label="Menú de perfil"
        style={{
          padding: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          borderRadius: "50%",
          outline: open ? "2px solid var(--sky-700)" : "none",
          outlineOffset: 2,
        }}
      >
        <Avatar name={name} size={36} />
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
            padding: 6,
            zIndex: 30,
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--navy-300)",
            }}
          >
            {name}
          </div>
          <MenuItem
            icon={<IconSettings size={14} />}
            label="Ajustes"
            onClick={() => {
              setOpen(false);
              setShowSettings(true);
            }}
          />
          <form action="/api/auth/sign-out" method="post">
            <button
              type="submit"
              role="menuitem"
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 500,
                color: "#9F1F1F",
                cursor: "pointer",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <IconLogout size={14} /> Cerrar sesión
            </button>
          </form>
        </div>
      )}

      {showSettings && (
        <SettingsModal preferences={preferences} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "10px 12px",
        fontSize: 13,
        fontWeight: 500,
        color: "var(--navy-700)",
        cursor: "pointer",
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {icon} {label}
    </button>
  );
}

function SettingsModal({
  preferences,
  onClose,
}: {
  preferences: Preferences;
  onClose: () => void;
}) {
  const router = useRouter();
  const { set } = useTweaks();
  const [palette, setPalette] = useState<Palette>(preferences.palette);
  const [pinned, setPinned] = useState<KpiKey[]>(preferences.pinnedKpis);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const togglePinned = (key: KpiKey) => {
    setPinned((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
  };

  const save = () => {
    setError(null);
    start(async () => {
      const r = await updateUserPreferences({ palette, pinnedKpis: pinned });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Apply palette to the live `data-palette` attribute via Tweaks
      // context so the UI updates without a refresh.
      set("palette", palette);
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
        style={{ width: "min(540px, 100%)", borderRadius: 22, padding: 24 }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2 className="k-display" style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
            Ajustes
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
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

        <section style={{ marginBottom: 18 }}>
          <SectionLabel>Paleta</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {PALETTES.map((p) => {
              const on = p.value === palette;
              return (
                <button
                  key={p.value}
                  onClick={() => setPalette(p.value)}
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    cursor: "pointer",
                    border: on
                      ? "2px solid var(--sky-700)"
                      : "1px solid rgba(15,30,51,0.08)",
                    background: "rgba(255,255,255,0.7)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 3 }}>
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
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-700)" }}>
                    {p.label}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section style={{ marginBottom: 14 }}>
          <SectionLabel>KPIs fijados al dashboard</SectionLabel>
          <p style={{ fontSize: 11.5, color: "var(--navy-500)", margin: "0 0 10px" }}>
            Hasta 6. Elegí los que querés ver siempre.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
            }}
          >
            {KPI_OPTIONS.map((opt) => {
              const on = pinned.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => togglePinned(opt.key)}
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
                    }}
                  >
                    {on && <IconCheck size={10} stroke={3} />}
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
        </section>

        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-300)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
