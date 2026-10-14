"use client";

/**
 * Controles de las preferencias de avisos de la sala (SV11b; FX3 los separó del
 * provider). Los importan SOLO la Card de Configuración → General y el menú
 * «Vista» de la agenda: en `components/providers/arrival-alerts.tsx` iban al
 * first-load de todas las rutas del workspace sin que ninguna los mostrara.
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { previewChime } from "@/lib/arrival-chime";
import type { AlertMode } from "@/lib/preferences-constants";
import { SOUND_BLOCKED_NOTE } from "@/components/providers/arrival-alerts-constants";

export { SOUND_BLOCKED_NOTE };

export const ALERT_MODE_OPTIONS: ReadonlyArray<{ value: AlertMode; label: string }> = [
  { value: "visual", label: "Visual" },
  { value: "sound", label: "Visual y sonido" },
  { value: "off", label: "Apagado" },
];

/**
 * Segmentado «Visual · Visual y sonido · Apagado» + «Probar sonido». Uno solo
 * para la Card de Configuración y el menú de la agenda: mismo estado (contexto)
 * y mismo copy.
 */
export function AlertModeControl({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: AlertMode;
  onChange: (m: AlertMode) => void;
  compact?: boolean;
}) {
  const [probe, setProbe] = useState<"idle" | "blocked">("idle");
  const test = () => {
    void previewChime().then((ok) => setProbe(ok ? "idle" : "blocked"));
  };
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  // Roving tabindex (patrón radiogroup de WAI-ARIA): Tab entra al marcado y
  // sale del grupo; las flechas mueven Y eligen (en un radio nativo, moverse es
  // elegir). Si el valor no está entre las opciones, entra por la primera.
  const checkedIdx = Math.max(0, ALERT_MODE_OPTIONS.findIndex((o) => o.value === value));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = ALERT_MODE_OPTIONS.length;
    const target = alertRadioKeyTarget(e.key, checkedIdx, n);
    if (target === null) return;
    e.preventDefault();
    onChange(ALERT_MODE_OPTIONS[target].value);
    radios.current[target]?.focus();
  };
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 6 }}>
      <div
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
        style={{
          display: "flex",
          padding: 3,
          borderRadius: 999,
          background: "rgba(15,30,51,0.04)",
          maxWidth: compact ? undefined : 360,
        }}
      >
        {ALERT_MODE_OPTIONS.map((o, i) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                radios.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === checkedIdx ? 0 : -1}
              onClick={() => onChange(o.value)}
              style={{
                flex: 1,
                // ≥ 32 px de alto también en el compacto (target táctil del menú).
                minHeight: 32,
                padding: compact ? "6px 6px" : "7px 10px",
                borderRadius: 999,
                border: "none",
                fontSize: compact ? 11 : 12.5,
                fontWeight: 600,
                whiteSpace: "nowrap",
                background: on ? "#fff" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                cursor: "pointer",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="ghost"
          onClick={test}
          style={{ height: 32, padding: "0 10px", fontSize: compact ? 11 : 12 }}
        >
          Probar sonido
        </Button>
        {/* En el menú compacto la ayuda va una sola vez abajo (no por fila); el
            aviso de bloqueo sí se muestra siempre. */}
        {(probe === "blocked" || !compact) && (
          <span
            role={probe === "blocked" ? "status" : undefined}
            // --navy-500 y no --navy-300: a 11 px el 300 no llega a AA sobre el vidrio.
            style={{ fontSize: 11, color: "var(--navy-500)", lineHeight: 1.4 }}
          >
            {probe === "blocked" ? "Tu navegador no dejó reproducir el sonido en esta página." : SOUND_BLOCKED_NOTE}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Tecla → índice destino del radiogroup (puro, para testear sin DOM). Flechas
 * izquierda/arriba y derecha/abajo con vuelta al otro extremo; Inicio y Fin.
 * null = la tecla no es del grupo (Tab, Espacio, Enter siguen su curso).
 */
export function alertRadioKeyTarget(key: string, current: number, n: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % n;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + n) % n;
    case "Home":
      return 0;
    case "End":
      return n - 1;
    default:
      return null;
  }
}
