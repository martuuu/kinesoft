"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { globalSearch } from "@/lib/search";
import type { SearchHit } from "@/lib/search-types";
import { IconSearch } from "@/components/ui/icons";

/**
 * ⌘K / Ctrl+K command palette.
 *
 * Mounted once at the app-shell level. Listens for the shortcut globally,
 * debounces the search by 200 ms, and exposes a router-driven action on
 * each hit. Arrow keys + Enter navigate without leaving the keyboard.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Global shortcut ───────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isToggle =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (isToggle) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ── Focus the input + clear state on open ─────────────────────────
  useEffect(() => {
    if (!open) return;
    setActive(0);
    setQ("");
    setHits([]);
    // Seed with shortcuts immediately so the panel never looks empty.
    start(async () => {
      const r = await globalSearch("");
      setHits(r);
    });
    setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // ── Debounced search ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
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
  }, [q, open]);

  const choose = useCallback(
    (hit: SearchHit) => {
      setOpen(false);
      router.push(hit.href);
    },
    [router]
  );

  if (!open) return null;

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
      onClick={() => setOpen(false)}
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
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 20px",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <IconSearch size={18} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Buscar paciente, ejercicio, diagnóstico, turno…"
            // Global search — suppress the browser's own autofill dropdown.
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 16,
              color: "var(--navy-900)",
            }}
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

function CategoryIcon({ cat }: { cat: SearchHit["category"] }) {
  const emoji =
    cat === "patient" ? "👤" : cat === "exercise" ? "🏋️" : cat === "condition" ? "🏥" : cat === "booking" ? "📅" : "↗︎";
  return (
    <span
      style={{
        width: 28,
        height: 28,
        borderRadius: 8,
        background: "rgba(255,255,255,0.7)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        flexShrink: 0,
      }}
    >
      {emoji}
    </span>
  );
}
