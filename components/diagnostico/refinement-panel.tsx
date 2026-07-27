"use client";

import { Card } from "@/components/ui/card";
import type { CatalogDTO } from "@/lib/diagnosis-engine";

export function RefinementPanel({
  catalog,
  activeRegionLabel,
  symptoms,
  toggleSymptom,
  triggers,
  toggleTrigger,
  phase,
  setPhase,
  intensity,
  setIntensity,
}: {
  catalog: CatalogDTO;
  activeRegionLabel: string | null;
  symptoms: string[];
  toggleSymptom: (slug: string) => void;
  triggers: string[];
  toggleTrigger: (slug: string) => void;
  phase: string | null;
  setPhase: (slug: string | null) => void;
  intensity: number;
  setIntensity: (n: number) => void;
}) {
  return (
    <Card style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
      <div>
        <div className="k-display" style={{ fontSize: 20, fontWeight: 600 }}>
          Refiná la molestia
          {activeRegionLabel && (
            <span style={{ marginLeft: 10, fontSize: 13, color: "var(--sky-700)" }}>
              · {activeRegionLabel}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2 }}>
          Cuanto más completes, mejor el match.
        </div>
      </div>

      <Group label="Tipo de molestia">
        <ChipRow items={catalog.symptoms} active={symptoms} onToggle={toggleSymptom} />
      </Group>

      <Group label="Cuándo aparece">
        <ChipRow items={catalog.triggers} active={triggers} onToggle={toggleTrigger} />
      </Group>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Group label="Evolución">
          <ChipRow
            items={catalog.phases}
            active={phase ? [phase] : []}
            onToggle={(slug) => setPhase(slug === phase ? null : slug)}
            radio
          />
        </Group>
        <Group label={`Intensidad · ${intensity}/10`}>
          <input
            type="range"
            min={0}
            max={10}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div
            aria-hidden
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(11, 1fr)",
              gap: 2,
              marginTop: 6,
              height: 6,
            }}
          >
            {Array.from({ length: 11 }).map((_, i) => (
              <span
                key={i}
                style={{
                  height: 6,
                  borderRadius: 2,
                  background:
                    i <= 3 ? "var(--lime-400)" : i <= 6 ? "var(--sky-500)" : "#E14B4B",
                  opacity: i <= intensity ? 1 : 0.25,
                }}
              />
            ))}
          </div>
        </Group>
      </div>
    </Card>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
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

function ChipRow({
  items,
  active,
  onToggle,
  radio,
}: {
  items: { slug: string; label: string }[];
  active: string[];
  onToggle: (slug: string) => void;
  radio?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((it) => {
        const on = active.includes(it.slug);
        return (
          <button
            key={it.slug}
            type="button"
            onClick={() => onToggle(it.slug)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
              background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
              fontSize: 12,
              fontWeight: 600,
              color: on ? "#fff" : "var(--navy-700)",
              cursor: "pointer",
            }}
            aria-pressed={on}
            role={radio ? "radio" : undefined}
            aria-checked={radio ? on : undefined}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
