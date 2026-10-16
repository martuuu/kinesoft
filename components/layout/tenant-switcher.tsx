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
import { AnimatePresence, motion } from "framer-motion";
import type { TenantOption } from "@/lib/tenant-choice";
import { roleLabel } from "@/lib/roles";
import { VERTICAL_LABEL } from "@/lib/tenant-modules";
import { modalVariants } from "@/lib/motion";
import { IconCheck, IconChevD } from "@/components/ui/icons";
import type { ActionResult } from "@/lib/validation";

export const CHOOSE_TENANT_HREF = "/elegir-consultorio";

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
  const listRef = useRef<HTMLUListElement | null>(null);
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

  // Al abrir, el foco va a la lista con el activo marcado (aria-activedescendant).
  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

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

      <AnimatePresence>
        {open && (
          <motion.div
            key="tenant-switcher"
            className="k-glass-strong"
            variants={modalVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            style={{
              position: "absolute",
              zIndex: 40,
              borderRadius: 14,
              padding: 6,
              ...(collapsed ? { top: 0, left: "calc(100% + 12px)", width: 272 } : { top: "100%", left: 0, right: 0, marginTop: -8 }),
            }}
          >
            <div style={sectionLabelStyle} id={`${baseId}-label`}>
              Tus consultorios
            </div>
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-labelledby={`${baseId}-label`}
              aria-activedescendant={options[focusIndex] ? optionId(options[focusIndex].tenantId) : undefined}
              aria-busy={pendingId ? true : undefined}
              onKeyDown={onListKey}
              style={{ listStyle: "none", margin: 0, padding: 0, outline: "none", maxHeight: 320, overflowY: "auto" }}
            >
              {options.map((o, i) => {
                const isActive = o.tenantId === active?.tenantId;
                const focused = i === focusIndex;
                return (
                  <li
                    key={o.tenantId}
                    id={optionId(o.tenantId)}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setFocusIndex(i)}
                    onClick={() => void choose(o)}
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const nameStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13.5,
  fontWeight: 600,
  color: "var(--navy-900)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const sectionLabelStyle: React.CSSProperties = {
  padding: "8px 10px 6px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
};

const initialsStyle: React.CSSProperties = {
  flex: "0 0 auto",
  width: 30,
  height: 30,
  borderRadius: "var(--r-md)",
  display: "grid",
  placeItems: "center",
  fontWeight: 700,
  fontSize: 12,
  background: "var(--sky-100)",
  color: "var(--sky-700)",
};

const seeAllStyle: React.CSSProperties = {
  display: "block",
  padding: "9px 10px",
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 500,
  color: "var(--sky-700)",
  textDecoration: "none",
};

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
