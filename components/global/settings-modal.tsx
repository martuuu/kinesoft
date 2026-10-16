"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { IconCheck } from "@/components/ui/icons";
import { updateUserPreferences } from "@/lib/preferences";
import {
  effectivePinnedKpis,
  kpiOptionsFor,
  type KpiKey,
  type KpiRevenueScope,
  type Palette,
  type Preferences,
} from "@/lib/preferences-constants";
import { useTweaks } from "@/components/layout/tweaks-context";
// PL-F: las mismas cuatro paletas y rótulos que «Apariencia». PF1.0-a: desde `appearance-options` (sin dependencias),
// no desde `tweaks-panel`, que arrastraba el panel entero de Apariencia a `/dashboard`.
import { PALETTE_OPTIONS as PALETTES } from "@/components/layout/appearance-options";
import { useTenantModules } from "@/components/layout/tenant-modules-context";

/**
 * «Ajustes» del menú de perfil: paleta (la misma de Apariencia, guardada en el server) + indicadores fijados.
 *
 * PF1.1-dashboard (C-PF2): módulo aparte para que el menú de perfil y el botón «Ajustes» del tablero lo bajen con
 * `next/dynamic` al abrirlo (`SettingsModalLazy` de `profile-menu.tsx`). Antes iba en el JS inicial de `/dashboard`.
 */
/** Exportado para el test de render (tests/unit/render/kpi-picker.test.tsx). */
export function SettingsModal({
  preferences,
  onClose,
  open = true,
  revenueScope = "tenant",
}: {
  preferences: Preferences;
  onClose: () => void;
  /** Para animar la salida: quien lo monta lo deja montado y baja `open`. */
  open?: boolean;
  revenueScope?: KpiRevenueScope;
}) {
  const { t, set } = useTweaks();
  // EV1-A: el picker de Ajustes ofrece y preselecciona lo mismo que la fila del dashboard
  // (`PinKpiModal`): en Clínica general sin las KPIs de planes y con los rótulos de turnos.
  // Antes ofrecía «Planes en curso»/«Cerca del alta», que en General valen 0 siempre.
  const modules = useTenantModules();
  const kpiOptions = kpiOptionsFor(revenueScope, modules);
  const [palette, setPalette] = useState<Palette>(preferences.palette);
  const [pinned, setPinned] = useState<KpiKey[]>(() =>
    effectivePinnedKpis(preferences.pinnedKpis, revenueScope, modules)
  );
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const togglePinned = (key: KpiKey) => {
    // Tope de 6 también en la UI (el server rechaza la séptima: «Máx 6 KPIs fijados.»).
    setPinned((s) => (s.includes(key) ? s.filter((k) => k !== key) : s.length >= 6 ? s : [...s, key]));
  };

  const save = () => {
    setError(null);
    start(async () => {
      // PL-F: la paleta se guardaba dos veces (acá y otra vez en `set("palette")`, que desde PL-F1c también la
      // persiste). Ahora este guardado lleva solo las KPIs y la paleta la escribe `set` una vez, si cambió.
      const r = await updateUserPreferences({ pinnedKpis: pinned });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Aplica `data-palette` en vivo vía el contexto de Tweaks (y la guarda en el server).
      if (palette !== t.palette) set("palette", palette);
      // C-PF4: `updateUserPreferences` hace `revalidatePath("/dashboard")`: sin `router.refresh()` (doble render).
      onClose();
    });
  };

  return (
    // PF1.1-dashboard: era un overlay a mano (div fijo z 60, sin foco atrapado ni Esc, sin portal): ahora el `Modal`
    // del design system (portal, `--z-modal`, foco atrapado, Esc, scroll-lock y la X de `ModalCloseButton`).
    <Modal open={open} onClose={onClose} width={540} title="Ajustes">
        <section style={{ marginBottom: 18 }}>
          <SectionLabel>Paleta</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
            {PALETTES.map((p) => {
              const on = p.value === palette;
              return (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={on}
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
          <SectionLabel>Indicadores fijados en Inicio</SectionLabel>
          <p style={{ fontSize: 11.5, color: "var(--navy-500)", margin: "0 0 10px" }}>
            Hasta 6. Elegí los que querés ver siempre.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 6,
            }}
          >
            {kpiOptions.map((opt) => {
              const on = pinned.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={on}
                  disabled={!on && pinned.length >= 6}
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
                    <div style={{ fontSize: 10.5, color: "var(--navy-400)" }}>
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
              background: "var(--danger-bg)",
              color: "var(--danger-fg)",
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
    </Modal>
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
        color: "var(--navy-400)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
