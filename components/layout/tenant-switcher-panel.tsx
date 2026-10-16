"use client";

/**
 * Lista del selector de consultorio (IAM-3b), separada del botón en PF1.0-a (C-PF2): arranca cerrada, así que no
 * tiene por qué viajar en el bundle inicial de cada ruta del workspace. `tenant-switcher.tsx` la carga con
 * `next/dynamic` al abrir (y la precarga en hover/foco del botón). El estado (abierta, foco, pendiente, error) sigue en
 * el botón: esto es solo el dibujo, más el foco inicial en la lista.
 */
import { useEffect, useRef } from "react";
import type { TenantOption } from "@/lib/tenant-choice";
import { roleLabel } from "@/lib/roles";
import { VERTICAL_LABEL } from "@/lib/tenant-modules";
import { IconCheck } from "@/components/ui/icons";
import { CHOOSE_TENANT_HREF, tenantInitials } from "./tenant-switcher";
import { initialsStyle, nameStyle, panelBoxStyle, sectionLabelStyle, seeAllStyle } from "./tenant-switcher-styles";

export function TenantSwitcherPanel({
  collapsed,
  options,
  activeTenantId,
  focusIndex,
  onFocusIndex,
  pendingId,
  error,
  onChoose,
  onListKey,
  listId,
  labelId,
  optionId,
}: {
  collapsed: boolean;
  options: readonly TenantOption[];
  activeTenantId: string | null;
  focusIndex: number;
  onFocusIndex: (i: number) => void;
  pendingId: string | null;
  error: string | null;
  onChoose: (o: TenantOption) => void;
  onListKey: (e: React.KeyboardEvent<HTMLUListElement>) => void;
  listId: string;
  labelId: string;
  optionId: (tenantId: string) => string;
}) {
  const listRef = useRef<HTMLUListElement | null>(null);
  // Al montarse (= al abrir), el foco va a la lista con el activo marcado (aria-activedescendant).
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    // Entrada con CSS (`.k-enter-fade`, apagada con «reducir movimiento») y sin framer: la lista aparece tras un clic,
    // pero no hace falta cargar framer para un fundido. Sin animación de salida: al cerrar se va al instante.
    <div className="k-glass-strong k-enter-fade" style={panelBoxStyle(collapsed)}>
      <div style={sectionLabelStyle} id={labelId}>
        Tus consultorios
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        tabIndex={-1}
        aria-labelledby={labelId}
        aria-activedescendant={options[focusIndex] ? optionId(options[focusIndex].tenantId) : undefined}
        aria-busy={pendingId ? true : undefined}
        onKeyDown={onListKey}
        // Sin `outline: none` (PF1.0-a, C-PF5.4): el foco global de `globals.css` (`[tabindex]:focus-visible`) pinta el anillo.
        style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 320, overflowY: "auto" }}
      >
        {options.map((o, i) => {
          const isActive = o.tenantId === activeTenantId;
          const focused = i === focusIndex;
          return (
            <li
              key={o.tenantId}
              id={optionId(o.tenantId)}
              role="option"
              aria-selected={isActive}
              onMouseEnter={() => onFocusIndex(i)}
              onClick={() => onChoose(o)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 10,
                cursor: pendingId ? "progress" : "pointer",
                background: focused ? "rgba(31,79,190,0.08)" : "transparent",
                opacity: pendingId && pendingId !== o.tenantId ? 0.5 : 1,
              }}
            >
              <span style={initialsStyle} aria-hidden>
                {tenantInitials(o.name)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={nameStyle}>{o.name}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--navy-500)", marginTop: 2 }}>
                  {roleLabel(o.role, o.vertical)} · {VERTICAL_LABEL[o.vertical]}
                </span>
              </span>
              <span aria-hidden style={{ width: 16, display: "inline-flex", color: "var(--sky-700)" }}>
                {pendingId === o.tenantId ? "…" : isActive ? <IconCheck size={14} stroke={3} /> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" style={{ margin: "6px 4px 2px", padding: "8px 10px", borderRadius: 10, fontSize: 12, background: "var(--danger-bg)", color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}
      <div style={{ borderTop: "1px solid rgba(15,30,51,0.06)", marginTop: 6, paddingTop: 6 }}>
        {/* `<a>` y no `next/link`: misma navegación dura que al elegir (la pantalla está fuera de `(app)`). */}
        <a href={CHOOSE_TENANT_HREF} style={seeAllStyle}>
          Ver todos
        </a>
      </div>
    </div>
  );
}
