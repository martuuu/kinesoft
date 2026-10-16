"use client";

/**
 * Selector de consultorio (IAM-3b). Decisión 6 de Martin (14-oct): **un mismo usuario puede trabajar en varios
 * consultorios** (M6 hizo `Practitioner` único por consultorio). Al iniciar sesión con 2+ la app pregunta a cuál
 * entrar (`/elegir-consultorio`, IAM-3a); después se cambia desde acá, en el encabezado del sidebar.
 *
 * - `TenantChoiceProvider`: el layout `(app)` ya lee `getTenantChoiceState()` para el gate (cache por request: misma
 *   foto que `tryGetActor`, sin otra query) y el AppShell publica las opciones acá. Así el sidebar y el menú de
 *   perfil (que vive en el dashboard, fuera del shell) las leen sin props nuevas. Solo trae los consultorios USABLES
 *   de la propia sesión: nunca otros.
 * - Con 1 consultorio: el nombre, sin flecha ni lista (no hay nada que cambiar). Sin provider (render suelto, actor
 *   demo): nada, el sidebar queda como antes.
 * - Con 2+: botón `aria-haspopup="listbox"` → lista con nombre, rol (`roleLabel` con la vertical de CADA consultorio:
 *   en uno General es «Profesional», en uno de Kine «Kinesiólogo/a»), tipo y check en el activo; «Ver todos» lleva a
 *   `/elegir-consultorio`.
 * - Al elegir: `switchTenant` (valida en el server) y navegación DURA a /dashboard. Una navegación blanda dejaría
 *   montados el canal realtime, los avisos de llegada y el estado cliente del consultorio anterior (y la página
 *   actual puede tener ids que en el otro consultorio no existen).
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import type { TenantOption } from "@/lib/tenant-choice";
import { roleLabel } from "@/lib/roles";
import { IconChevD } from "@/components/ui/icons";
import { nameStyle } from "./tenant-switcher-styles";
import type { ActionResult } from "@/lib/validation";

export const CHOOSE_TENANT_HREF = "/elegir-consultorio";

const loadPanel = () => import("./tenant-switcher-panel");

/** Precarga del chunk de la lista (hover/foco del botón): el clic ya no espera red. */
export function preloadTenantSwitcherPanel(): void {
  void loadPanel();
}

const TenantSwitcherPanel = dynamic(() => loadPanel().then((m) => m.TenantSwitcherPanel), {
  ssr: false,
  // Sin placeholder: es una capa `position: absolute` sobre el sidebar, no empuja nada (CLS 0 por construcción), y el
  // chunk ya se precargó en el hover/foco del botón. Un esqueleto acá no sabría si va al costado (contraído) o debajo.
  loading: () => null,
});

/**
 * La action llega por props desde el layout (server → client) y no por import: así este módulo no arrastra
 * `lib/tenant-switch.ts` (server) a los tests de render que montan el sidebar o el menú de perfil sin mockearla.
 */
export type SwitchTenantAction = (tenantId: string) => Promise<ActionResult>;

type TenantChoiceValue = { options: readonly TenantOption[]; active: TenantOption | null; switchTenant: SwitchTenantAction | null };

const TenantChoiceContext = createContext<TenantChoiceValue>({ options: [], active: null, switchTenant: null });

export function TenantChoiceProvider({
  options,
  activeTenantId,
  switchTenant,
  children,
}: {
  options: readonly TenantOption[];
  activeTenantId: string | null;
  /** `switchTenant` de `lib/tenant-switch.ts`. Sin action no hay selector (solo el nombre). */
  switchTenant: SwitchTenantAction | null;
  children: ReactNode;
}) {
  // Clave estable: el layout re-renderiza en cada navegación y el array llega nuevo.
  const key = JSON.stringify([options, activeTenantId]);
  const value = useMemo<TenantChoiceValue>(
    () => ({ options, active: options.find((o) => o.tenantId === activeTenantId) ?? null, switchTenant }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, switchTenant]
  );
  return <TenantChoiceContext.Provider value={value}>{children}</TenantChoiceContext.Provider>;
}

export function useTenantChoice(): TenantChoiceValue & { canSwitch: boolean } {
  const v = useContext(TenantChoiceContext);
  return { ...v, canSwitch: v.options.length >= 2 && !!v.switchTenant };
}

/**
 * Índice siguiente de la lista según la tecla (patrón listbox de WAI-ARIA): flechas con vuelta, Home/End.
 * `null` = la tecla no mueve el foco (Enter/Espacio/Escape los maneja el componente). Puro para el unit test.
 */
export function switcherKeyIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** «Centro Kinésico Movare» → «CK». Decorativo: el nombre completo va en `title`/`aria-label`. */
export function tenantInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length >= 2 ? [words[0], words[1]] : [words[0] ?? "?"]).map((w) => w[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

export function TenantSwitcher({
  collapsed = false,
  defaultOpen = false,
}: {
  collapsed?: boolean;
  /** Solo para el test de render (sin jsdom no hay click): arranca con la lista abierta. */
  defaultOpen?: boolean;
}) {
  const { options, active, canSwitch, switchTenant } = useTenantChoice();
  const [open, setOpen] = useState(defaultOpen);
  const activeIndex = Math.max(0, options.findIndex((o) => o.tenantId === active?.tenantId));
  const [focusIndex, setFocusIndex] = useState(activeIndex);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (tenantId: string) => `${baseId}-opt-${tenantId}`;

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setError(null);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Click afuera cierra (mismo patrón que el menú de perfil).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // Al abrir, el foco va a la lista con el activo marcado (aria-activedescendant): lo hace el panel al montarse
  // (`tenant-switcher-panel.tsx`), porque con la carga diferida la lista puede no existir todavía en este render.

  if (options.length === 0) return null;

  if (!canSwitch) {
    // Un solo consultorio: el nombre como referencia, sin nada clickeable. Colapsado no entra: queda el logo.
    if (collapsed || !active) return null;
    return (
      <div style={{ padding: "0 6px 14px", minWidth: 0 }}>
        <div style={nameStyle} title={active.name}>
          {active.name}
        </div>
      </div>
    );
  }

  const openList = () => {
    setFocusIndex(activeIndex);
    setError(null);
    setOpen(true);
  };

  const choose = async (o: TenantOption) => {
    if (pendingId || !switchTenant) return;
    if (o.tenantId === active?.tenantId) {
      close(true);
      return;
    }
    setPendingId(o.tenantId);
    setError(null);
    const r = await switchTenant(o.tenantId);
    if (r.ok) {
      // Navegación dura a propósito (ver cabecera): el pending queda puesto hasta que el navegador descarga la página.
      window.location.assign("/dashboard");
      return;
    }
    setPendingId(null);
    setError(r.error);
  };

  const onListKey = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const next = switcherKeyIndex(e.key, focusIndex, options.length);
    if (next !== null) {
      e.preventDefault();
      setFocusIndex(next);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[focusIndex];
      if (o) void choose(o);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  const label = active ? `Consultorio activo: ${active.name}. Cambiar de consultorio` : "Elegir consultorio";

  return (
    <div ref={wrapRef} style={{ position: "relative", padding: collapsed ? "0 0 12px" : "0 0 14px", display: "flex", justifyContent: "center" }}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        title={collapsed ? active?.name : undefined}
        onClick={() => (open ? close(false) : openList())}
        onPointerEnter={preloadTenantSwitcherPanel}
        onFocus={preloadTenantSwitcherPanel}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          } else if (open && e.key === "Escape") {
            e.preventDefault();
            close(true);
          }
        }}
        style={collapsed ? collapsedButtonStyle(open) : buttonStyle(open)}
      >
        {collapsed ? (
          <span aria-hidden>{tenantInitials(active?.name ?? "?")}</span>
        ) : (
          <>
            <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
              <span style={nameStyle}>{active?.name ?? "Elegí un consultorio"}</span>
              {active && (
                <span style={{ display: "block", fontSize: 11.5, color: "var(--navy-500)", marginTop: 2 }}>
                  {roleLabel(active.role, active.vertical)}
                </span>
              )}
            </span>
            <span
              aria-hidden
              style={{ display: "inline-flex", color: "var(--navy-300)", transform: open ? "rotate(180deg)" : undefined }}
            >
              <IconChevD size={14} />
            </span>
          </>
        )}
      </button>

      {/* PF1.0-a (C-PF2): la lista se baja recién al abrir (chunk aparte, precargado al pasar el mouse o llegar con
          Tab al botón). Es una capa flotante: mientras llega no empuja nada (CLS 0 por construcción). */}
      {open && (
        <TenantSwitcherPanel
          collapsed={collapsed}
          options={options}
          activeTenantId={active?.tenantId ?? null}
          focusIndex={focusIndex}
          onFocusIndex={setFocusIndex}
          pendingId={pendingId}
          error={error}
          onChoose={(o) => void choose(o)}
          onListKey={onListKey}
          listId={listId}
          labelId={`${baseId}-label`}
          optionId={optionId}
        />
      )}
    </div>
  );
}

function buttonStyle(open: boolean): React.CSSProperties {
  return {
    // Sin `all: "unset"` (como el botón de Cerrar sesión): eso borra el anillo de foco del navegador y el selector
    // tiene que verse al llegar con Tab (no hay un :focus-visible global en globals.css).
    appearance: "none",
    font: "inherit",
    color: "inherit",
    margin: 0,
    boxSizing: "border-box",
    cursor: "pointer",
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderRadius: 12,
    background: open ? "rgba(31,79,190,0.08)" : "rgba(255,255,255,0.45)",
    border: "1px solid rgba(15,30,51,0.06)",
    minWidth: 0,
  };
}

function collapsedButtonStyle(open: boolean): React.CSSProperties {
  return {
    appearance: "none",
    font: "inherit",
    margin: 0,
    padding: 0,
    border: "none",
    boxSizing: "border-box",
    cursor: "pointer",
    width: 40,
    height: 40,
    borderRadius: "var(--r-md)",
    display: "grid",
    placeItems: "center",
    fontWeight: 700,
    fontSize: 13,
    background: "var(--sky-100)",
    color: "var(--sky-700)",
    outline: open ? "2px solid var(--sky-700)" : undefined,
    outlineOffset: 2,
  };
}
