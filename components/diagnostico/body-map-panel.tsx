"use client";

import { Card } from "@/components/ui/card";
import type { CatalogDTO } from "@/lib/diagnosis-engine";

export function BodyMapPanel({
  catalog,
  view,
  setView,
  selectedRegions,
  relatedRegions,
  active,
  onToggleRegion,
  onSelectRegion,
}: {
  catalog: CatalogDTO;
  view: "FRONT" | "BACK";
  setView: (v: "FRONT" | "BACK") => void;
  selectedRegions: string[];
  relatedRegions: string[];
  active: string | null;
  onToggleRegion: (slug: string) => void;
  onSelectRegion: (slug: string) => void;
}) {
  const regions = catalog.regions.filter((r) => r.view === view);

  // Keyboard navigation: ←/→ cycle between zones, Enter/Space toggles the
  // active zone, F switches to FRONT, B to BACK. Practitioners who can't
  // use a mouse get the full body-map workflow.
  const moveFocus = (delta: 1 | -1) => {
    if (!regions.length) return;
    const idx = active ? regions.findIndex((r) => r.slug === active) : -1;
    const next = regions[(idx + delta + regions.length) % regions.length] ?? regions[0];
    onSelectRegion(next.slug);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === " " || e.key === "Enter") {
      if (active) {
        e.preventDefault();
        onToggleRegion(active);
      }
    } else if (e.key === "f" || e.key === "F") {
      setView("FRONT");
    } else if (e.key === "b" || e.key === "B") {
      setView("BACK");
    }
  };

  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
          Marcá la zona de dolor
        </div>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 999, background: "rgba(15,30,51,0.04)" }}>
          {(["FRONT", "BACK"] as const).map((v) => {
            const on = view === v;
            return (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 999,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  background: on ? "#fff" : "transparent",
                  color: on ? "var(--navy-900)" : "var(--navy-500)",
                  boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
                }}
              >
                {v === "FRONT" ? "Frente" : "Espalda"}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          background:
            "radial-gradient(ellipse at center 60%, rgba(31,79,190,0.04), transparent 70%)",
          borderRadius: 16,
          minHeight: 480,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <svg
          viewBox="0 0 240 520"
          width="100%"
          height={500}
          style={{ maxWidth: 240, outline: "none" }}
          role="application"
          aria-label={`Mapa corporal · vista ${view === "FRONT" ? "frontal" : "posterior"}. Usá las flechas para navegar, Enter para marcar, F/B para alternar vista.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {/* Body silhouette */}
          <ellipse cx="120" cy="50" rx="30" ry="36" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="80" y="84" width="80" height="200" rx="20" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="57" y="116" width="26" height="180" rx="13" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="157" y="116" width="26" height="180" rx="13" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="86" y="270" width="68" height="220" rx="22" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />

          {regions.map((r) => {
            const isActive = selectedRegions.includes(r.slug);
            const isRelated = relatedRegions.includes(r.slug);
            const isFocus = active === r.slug;
            const ariaLabel = `${r.label}${isActive ? " (marcada)" : ""}${isRelated ? " (relacionada por cadena cinemática)" : ""}`;
            const common = {
              "data-active": isActive ? "true" : undefined,
              "data-related": isRelated ? "true" : undefined,
              className: "body-zone",
              role: "checkbox",
              "aria-checked": isActive,
              "aria-label": ariaLabel,
              tabIndex: isFocus ? 0 : -1,
              onClick: () => onToggleRegion(r.slug),
              onFocus: () => onSelectRegion(r.slug),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onToggleRegion(r.slug);
                }
              },
              style: isFocus ? { outline: "2px dashed var(--sky-700)", outlineOffset: 2 } : undefined,
            } as const;
            if (r.shape === "RECT" && r.x != null && r.y != null && r.width != null && r.height != null) {
              return (
                <rect
                  key={r.slug}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  rx={r.rx ?? 0}
                  {...common}
                >
                  <title>{r.label}</title>
                </rect>
              );
            }
            if (r.shape === "ELLIPSE" && r.x != null && r.y != null) {
              return (
                <ellipse key={r.slug} cx={r.x} cy={r.y} rx={r.rx ?? 12} ry={r.ry ?? 10} {...common}>
                  <title>{r.label}</title>
                </ellipse>
              );
            }
            if (r.shape === "PATH" && r.path) {
              return (
                <path key={r.slug} d={r.path} {...common}>
                  <title>{r.label}</title>
                </path>
              );
            }
            return null;
          })}
        </svg>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {selectedRegions.map((slug) => {
          const reg = catalog.regions.find((r) => r.slug === slug);
          if (!reg) return null;
          return (
            <button
              key={slug}
              onClick={() => onSelectRegion(slug)}
              style={{
                padding: "5px 10px",
                borderRadius: 999,
                border: slug === active ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
                background: slug === active ? "rgba(31,79,190,0.12)" : "rgba(255,255,255,0.6)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--navy-700)",
                cursor: "pointer",
              }}
            >
              {reg.label}
            </button>
          );
        })}
        {!selectedRegions.length && (
          <span style={{ fontSize: 12, color: "var(--navy-300)" }}>
            Tocá una zona del cuerpo para empezar.
          </span>
        )}
      </div>
    </Card>
  );
}
