"use client";

/**
 * Compact multi-select filter used by the catalog table toolbar (grupo
 * muscular / elementos / disciplina). A button showing the active count opens a
 * popover with a type-to-filter box + checkboxes. Deliberately small: the
 * catalog has ~70 muscle tags, so a plain <select multiple> would be unusable.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconChevD, IconCheck } from "@/components/ui/icons";

export type TagOpt = { slug: string; label: string };

export function TagFilterMenu({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: TagOpt[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Optimistic local selection. `value` only refreshes once the RSC navigation
  // lands, so deriving each toggle from the prop would drop a second click made
  // before that — exactly what happens when ticking several tags in a row.
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);

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

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = term ? options.filter((o) => o.label.toLowerCase().includes(term)) : options;
    return list.slice(0, 120);
  }, [options, q]);

  const active = local.length > 0;
  const toggle = (slug: string) => {
    const next = local.includes(slug) ? local.filter((s) => s !== slug) : [...local, slug];
    setLocal(next);
    onChange(next);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          borderRadius: 10,
          border: `1px solid ${active ? "rgba(31,79,190,0.35)" : "rgba(15,30,51,0.1)"}`,
          background: active ? "rgba(31,79,190,0.07)" : "rgba(255,255,255,0.9)",
          color: active ? "var(--sky-700)" : "var(--navy-700)",
          fontSize: 12.5,
          fontWeight: active ? 700 : 500,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        {active && (
          <span
            className="k-mono"
            style={{
              fontSize: 10,
              background: "var(--sky-700)",
              color: "#fff",
              borderRadius: 999,
              padding: "1px 5px",
              lineHeight: 1.5,
            }}
          >
            {local.length}
          </span>
        )}
        <IconChevD size={12} />
      </button>

      {open && (
        <div
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            width: 268,
            maxHeight: 320,
            display: "flex",
            flexDirection: "column",
            borderRadius: 12,
            padding: 8,
            zIndex: 40,
            boxShadow: "0 12px 32px rgba(15,30,51,0.16)",
            background: "rgba(255,255,255,0.98)",
          }}
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Buscar en ${label.toLowerCase()}…`}
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            spellCheck={false}
            style={{
              padding: "7px 10px",
              borderRadius: 9,
              border: "1px solid rgba(15,30,51,0.1)",
              fontSize: 12.5,
              outline: "none",
              marginBottom: 6,
            }}
          />
          <div className="k-scroll" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {filtered.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: "var(--navy-300)", textAlign: "center" }}>
                Sin coincidencias.
              </div>
            ) : (
              filtered.map((o) => {
                const on = local.includes(o.slug);
                return (
                  <button
                    key={o.slug}
                    type="button"
                    onClick={() => toggle(o.slug)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "7px 8px",
                      border: "none",
                      borderRadius: 8,
                      background: on ? "rgba(31,79,190,0.08)" : "transparent",
                      color: on ? "var(--sky-700)" : "var(--navy-700)",
                      fontSize: 12.5,
                      fontWeight: on ? 600 : 500,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 4,
                        border: on ? "none" : "1px solid rgba(15,30,51,0.2)",
                        background: on ? "var(--sky-700)" : "transparent",
                        color: "#fff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {on && <IconCheck size={9} stroke={3} />}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {o.label}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {active && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{
                marginTop: 6,
                padding: "6px 8px",
                border: "none",
                borderTop: "1px solid rgba(15,30,51,0.06)",
                background: "transparent",
                color: "var(--navy-500)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Limpiar selección
            </button>
          )}
        </div>
      )}
    </div>
  );
}
