"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition, type ComponentType } from "react";
import { globalSearch } from "@/lib/search";
import type { SearchHit } from "@/lib/search-types";
import { IconArrow, IconCal, IconDumbbell, IconHeart, IconSearch, IconUsers } from "@/components/ui/icons";
import styles from "./command-palette.module.css";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import type { TenantModule } from "@/lib/tenant-modules";

/**
 * Placeholder del buscador según los módulos (EV1-C1). En Clínica general no
 * hay ejercicios ni diagnósticos: `globalSearch` ya no los devuelve (gate de
 * módulo en `lib/search.ts`), así que el grupo «Ejercicios»/«Diagnósticos»
 * nunca aparece; el placeholder tampoco los promete. Kine: el texto de siempre.
 */
export function paletteSearchPlaceholder(has: (m: TenantModule) => boolean): string {
  const parts = ["paciente"];
  if (has("ejercicios")) parts.push("ejercicio");
  if (has("diagnostico")) parts.push("diagnóstico");
  parts.push("turno");
  return `Buscar ${parts.join(", ")}…`;
}

/**
 * ⌘K / Ctrl+K command palette.
 *
 * PF1.0-a (C-PF2): ya no se monta siempre ni escucha el atajo. El atajo lo escucha `CommandPaletteLauncher`
 * (`components/layout/command-palette-launcher.tsx`, en el shell), que monta este módulo con `next/dynamic` recién al
 * abrir y lo desmonta al cerrar: antes viajaba en el bundle inicial de TODAS las rutas del workspace aunque casi
 * nadie lo abra. Montado = abierto. Debounce de 200 ms; flechas + Enter navegan sin soltar el teclado.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const modules = useTenantModules();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Escape cierra; el foco vuelve a donde estaba (el buscador del topbar, el botón de la barra móvil…) ──
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  // ── Al abrir: atajos de entrada (el panel nunca se ve vacío) y foco en el input ──
  useEffect(() => {
    start(async () => {
      const r = await globalSearch("");
      setHits(r);
    });
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, []);

  // ── Debounced search ──────────────────────────────────────────────
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Sequence guard — drop stale responses so a late slow query can't
    // overwrite a newer fast one. Each effect run owns its own `cancelled`
    // flag and tears it down via the cleanup.
    let cancelled = false;
    debounceRef.current = setTimeout(() => {
      start(async () => {
        const r = await globalSearch(q);
        if (cancelled) return;
        setHits(r);
        setActive(0);
      });
    }, 200);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const choose = useCallback(
    (hit: SearchHit) => {
      onClose();
      router.push(hit.href);
    },
    [router, onClose]
  );

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) choose(hit);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Búsqueda rápida"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong"
        style={{
          width: "min(640px, 92%)",
          borderRadius: 20,
          padding: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header className={styles.searchBar}>
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder={paletteSearchPlaceholder(modules.has)}
            // Global search — suppress the browser's own autofill dropdown.
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            aria-label="Buscar"
            className={styles.input}
          />
          <span
            className="k-mono"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--navy-300)",
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid rgba(15,30,51,0.08)",
            }}
          >
            ESC
          </span>
        </header>

        <div style={{ maxHeight: "60vh", overflowY: "auto", padding: 8 }}>
          {pending && hits.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--navy-300)",
                fontSize: 13,
              }}
            >
              Buscando…
            </div>
          ) : hits.length === 0 ? (
            <div
              style={{
                padding: 24,
                textAlign: "center",
                color: "var(--navy-300)",
                fontSize: 13,
              }}
            >
              Sin resultados para “{q}”.
            </div>
          ) : (
            <Grouped hits={hits} active={active} setActive={setActive} choose={choose} />
          )}
        </div>

        <footer
          style={{
            padding: "10px 20px",
            borderTop: "1px solid rgba(15,30,51,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 11,
            color: "var(--navy-500)",
          }}
        >
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>moverse</span>
          <Kbd>↵</Kbd>
          <span>abrir</span>
          <div style={{ flex: 1 }} />
          <span>
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> para cerrar
          </span>
        </footer>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="k-mono"
      style={{
        padding: "1px 6px",
        borderRadius: 4,
        border: "1px solid rgba(15,30,51,0.12)",
        background: "rgba(255,255,255,0.6)",
        fontSize: 10,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

const GROUP_LABELS: Record<SearchHit["category"], string> = {
  patient: "Pacientes",
  exercise: "Ejercicios",
  condition: "Diagnósticos",
  booking: "Turnos próximos",
  shortcut: "Atajos",
};

function Grouped({
  hits,
  active,
  setActive,
  choose,
}: {
  hits: SearchHit[];
  active: number;
  setActive: (i: number) => void;
  choose: (h: SearchHit) => void;
}) {
  // Preserve hit order but group by category.
  const groups = new Map<SearchHit["category"], { hit: SearchHit; index: number }[]>();
  hits.forEach((hit, index) => {
    const arr = groups.get(hit.category) ?? [];
    arr.push({ hit, index });
    groups.set(hit.category, arr);
  });

  return (
    <div>
      {Array.from(groups.entries()).map(([cat, items]) => (
        <div key={cat} style={{ marginBottom: 6 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--navy-300)",
              padding: "8px 12px 4px",
            }}
          >
            {GROUP_LABELS[cat]}
          </div>
          {items.map(({ hit, index }) => {
            const on = index === active;
            return (
              <button
                key={hit.id}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(hit)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "none",
                  background: on ? "rgba(31,79,190,0.08)" : "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <CategoryIcon cat={hit.category} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--navy-900)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {hit.label}
                  </div>
                  {hit.sublabel && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--navy-300)",
                        marginTop: 1,
                      }}
                    >
                      {hit.sublabel}
                    </div>
                  )}
                </div>
                {on && (
                  <span
                    className="k-mono"
                    style={{ fontSize: 10, color: "var(--sky-700)", fontWeight: 700 }}
                  >
                    ↵
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// PF1.0-a: íconos del sistema en vez de emoji (👤 🏋️ 🏥 📅): el emoji cambia de dibujo según el sistema operativo y
// desentona con el resto de la app (C-PF5).
const CATEGORY_ICON: Record<SearchHit["category"], ComponentType<{ size?: number }>> = {
  patient: IconUsers,
  exercise: IconDumbbell,
  condition: IconHeart,
  booking: IconCal,
  shortcut: IconArrow,
};

function CategoryIcon({ cat }: { cat: SearchHit["category"] }) {
  const I = CATEGORY_ICON[cat];
  return (
    <span className={styles.categoryIcon} aria-hidden>
      <I size={15} />
    </span>
  );
}
