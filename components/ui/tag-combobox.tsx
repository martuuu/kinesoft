"use client";

import { useEffect, useRef, useState } from "react";
import { IconPlus, IconX } from "@/components/ui/icons";

/**
 * Tag input with autocomplete + create-new-on-the-fly.
 *
 * - `suggestions` is the full list (slug + label) we may offer.
 * - `value` is the currently selected slugs.
 * - Typing filters suggestions; arrow keys navigate; Enter selects.
 * - If nothing matches, Enter creates a new tag via `onCreate(label)`
 *   which the caller resolves (e.g. POST to the server, return slug).
 */
export type TagOption = { slug: string; label: string };

export function TagCombobox({
  suggestions,
  value,
  onChange,
  onCreate,
  placeholder = "Agregar tag…",
}: {
  suggestions: TagOption[];
  value: string[];
  onChange: (next: string[]) => void;
  onCreate?: (label: string) => Promise<TagOption | null>;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const q = query.trim().toLowerCase();
  const matching = suggestions.filter(
    (t) => !value.includes(t.slug) && (q ? t.label.toLowerCase().includes(q) : true)
  );
  const exactMatch = matching.find((t) => t.label.toLowerCase() === q);
  const canCreate = !!onCreate && q.length > 0 && !exactMatch;

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const select = (slug: string) => {
    if (value.includes(slug)) return;
    onChange([...value, slug]);
    setQuery("");
    inputRef.current?.focus();
  };

  const create = async () => {
    if (!onCreate || !q) return;
    setCreating(true);
    try {
      const created = await onCreate(query.trim());
      if (created) {
        onChange([...value, created.slug]);
        setQuery("");
      }
    } finally {
      setCreating(false);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (matching[highlight]) {
        select(matching[highlight].slug);
      } else if (canCreate) {
        create();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(matching.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Backspace" && query === "" && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          padding: "8px 10px",
          minHeight: 38,
          borderRadius: 12,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.7)",
          cursor: "text",
        }}
      >
        {value.map((slug) => {
          const meta = suggestions.find((t) => t.slug === slug);
          return (
            <span
              key={slug}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "3px 4px 3px 10px",
                borderRadius: 999,
                background: "var(--sky-100)",
                color: "var(--sky-700)",
                fontSize: 11.5,
                fontWeight: 700,
              }}
            >
              {meta?.label ?? slug}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== slug));
                }}
                aria-label={`Quitar ${meta?.label ?? slug}`}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--sky-700)",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  padding: 0,
                }}
              >
                <IconX size={10} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 100)}
          onKeyDown={onKey}
          placeholder={value.length === 0 ? placeholder : ""}
          style={{
            flex: 1,
            minWidth: 100,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 13,
            color: "var(--navy-900)",
          }}
        />
      </div>

      {focused && (matching.length > 0 || canCreate) && (
        <div
          className="k-glass-strong k-scroll"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: 220,
            overflowY: "auto",
            borderRadius: 12,
            padding: 6,
            zIndex: 20,
            boxShadow: "0 12px 24px rgba(15,30,51,0.12)",
          }}
        >
          {matching.map((t, i) => {
            const on = i === highlight;
            return (
              <button
                key={t.slug}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(t.slug)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "none",
                  background: on ? "rgba(31,79,190,0.08)" : "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--navy-700)",
                }}
              >
                {t.label}
              </button>
            );
          })}
          {canCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={create}
              disabled={creating}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 8,
                border: "none",
                background: matching.length === 0 ? "rgba(31,79,190,0.08)" : "transparent",
                cursor: creating ? "wait" : "pointer",
                fontSize: 13,
                color: "var(--sky-700)",
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <IconPlus size={12} /> {creating ? "Creando…" : `Crear "${query.trim()}"`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
