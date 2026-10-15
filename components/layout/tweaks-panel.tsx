"use client";

import { useEffect, useRef } from "react";
import { useTweaks, type Palette } from "./tweaks-context";
import { useTenantModules } from "./tenant-modules-context";
import { IconX } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import type { ReceptionLayout } from "@/lib/preferences-constants";

/**
 * Panel «Apariencia» (ex «KineSoft · Tweaks»; Martin lo mantiene, §20.18: «se arreglan las opciones que no
 * funcionan»). PL-F1c, inventario de lo que queda y quién lo lee (cada una con su test en
 * `tests/unit/render/pl-f1c-tweaks.test.tsx`):
 *   - Paleta → `data-palette` de `<html>` (efecto de `TweaksProvider`) y `UserPreferences.palette` en el server.
 *   - Navegación «Barra lateral / Barra superior» → `dashChrome`, lo lee `AppShell` (monta `Sidebar` o `TopBar`).
 *   - «Barra lateral contraída» → `sidebarCollapsed`, prop `collapsed` del `Sidebar` (solo con barra lateral).
 *   - Vista semanal (encabezado, sábado, domingo) → prefs del server (`setAgenda`), las lee la agenda semanal.
 *   - RX-1e «Recepción» → «Escritorio de recepción» (`receptionLayout`, server-backed), lo lee `SalaClient` para
 *     elegir la cara de `/sala`. Solo con el módulo `salaEspera` y la capacidad `agenda.reception` (`canReception`,
 *     la calcula `AppShell` con sus `caps`); test en `tests/unit/render/tweaks-panel.test.tsx`.
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

/** RX-1e: las tres caras de `/sala`, con una línea que explica cada una (orden = `RECEPTION_LAYOUTS`). */
export const RECEPTION_LAYOUT_OPTIONS: ReadonlyArray<{ value: ReceptionLayout; label: string; hint: string }> = [
  { value: "board", label: "Tablero", hint: "Columnas por estado, como hasta ahora." },
  { value: "list", label: "Lista y panel", hint: "Los turnos del día en una tabla y la sala de espera al costado." },
  { value: "flow", label: "Flujo", hint: "La línea del día a la izquierda y la sala en carriles." },
];

export const RECEPTION_SAVE_ERROR = "No pudimos guardar la vista. Probá de nuevo.";

/**
 * RX-1e: ¿el valor del contexto volvió solo al anterior? `setReceptionLayout` (C-RX2) es optimista y, si el server
 * rechaza el cambio (o tira), vuelve al previo sin avisar: «si RX-1e quiere avisar, que lea el valor». `pending` es el
 * último cambio pedido desde este panel; si el valor actual es su `prev` (y no su `next`), el server lo rechazó.
 * Puro y exportado para el test (sin DOM no hay effects).
 */
export function receptionRolledBack(
  pending: { next: ReceptionLayout; prev: ReceptionLayout } | null,
  current: ReceptionLayout
): boolean {
  return pending !== null && pending.next !== pending.prev && current === pending.prev;
}

export function TweaksPanel({ canReception = false }: { canReception?: boolean } = {}) {
  const { t, set, agenda, setAgenda } = useTweaks();
  const modules = useTenantModules();
  const showReception = canReception && modules.has("salaEspera");
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

      {/* Componente aparte: el `useToast` solo corre cuando la sección se ve (los render tests de PL-F1c montan el
          panel sin `ToastProvider`; en la app lo pone `UIProviders` en el layout raíz). */}
      {showReception && <ReceptionSection />}
    </aside>
  );
}

function ReceptionSection() {
  const { receptionLayout, setReceptionLayout } = useTweaks();
  const toast = useToast();
  // Último cambio pedido desde acá. Se limpia al detectar el rechazo para no avisar dos veces.
  const pending = useRef<{ next: ReceptionLayout; prev: ReceptionLayout } | null>(null);

  useEffect(() => {
    if (receptionRolledBack(pending.current, receptionLayout)) {
      pending.current = null;
      toast.error(RECEPTION_SAVE_ERROR);
    }
  }, [receptionLayout, toast]);

  return (
    <Section label="Recepción">
      <ReceptionLayoutControl
        value={receptionLayout}
        onChange={(v) => {
          if (v === receptionLayout) return;
          pending.current = { next: v, prev: receptionLayout };
          setReceptionLayout(v);
        }}
      />
    </Section>
  );
}

/**
 * RX-1e: segmentado vertical (tres opciones con su línea de explicación no entran a lo ancho en 296 px). Sin hooks y
 * exportado: el test lo llama como función y dispara el `onClick` real de cada botón (no hay jsdom).
 */
export function ReceptionLayoutControl({
  value,
  onChange,
}: {
  value: ReceptionLayout;
  onChange: (v: ReceptionLayout) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Escritorio de recepción"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 3,
        borderRadius: 12,
        background: "rgba(15,30,51,0.04)",
      }}
    >
      <div style={{ fontSize: 12.5, color: "var(--navy-700)", padding: "4px 7px 2px" }}>Escritorio de recepción</div>
      {RECEPTION_LAYOUT_OPTIONS.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            data-layout={o.value}
            onClick={() => onChange(o.value)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 2,
              padding: "7px 10px",
              borderRadius: 9,
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              background: on ? "#fff" : "transparent",
              boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: on ? "var(--navy-900)" : "var(--navy-500)" }}>
              {o.label}
            </span>
            <span style={{ fontSize: 11, lineHeight: 1.35, color: "var(--navy-500)" }}>{o.hint}</span>
          </button>
        );
      })}
    </div>
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
