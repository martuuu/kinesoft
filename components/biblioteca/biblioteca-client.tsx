"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconSearch, IconX, IconFilter, IconDumbbell } from "@/components/ui/icons";
import type { ExerciseRow, FilterFacets } from "@/lib/exercises";

type Active = {
  q?: string;
  difficulty?: number;
  muscleGroup?: string;
  equipment?: string;
  conditionSlug?: string;
};

export function BibliotecaClient({
  items,
  facets,
  active,
}: {
  items: ExerciseRow[];
  facets: FilterFacets;
  active: Active;
}) {
  const router = useRouter();
  const [pendingNav, start] = useTransition();
  const [open, setOpen] = useState<ExerciseRow | null>(null);
  const [draftQ, setDraftQ] = useState(active.q ?? "");

  const pushFilters = (next: Partial<Active>) => {
    const merged = { ...active, ...next };
    const sp = new URLSearchParams();
    if (merged.q) sp.set("q", merged.q);
    if (merged.difficulty != null) sp.set("difficulty", String(merged.difficulty));
    if (merged.muscleGroup) sp.set("muscle", merged.muscleGroup);
    if (merged.equipment) sp.set("equipment", merged.equipment);
    if (merged.conditionSlug) sp.set("condition", merged.conditionSlug);
    start(() => router.push(`/biblioteca${sp.toString() ? "?" + sp.toString() : ""}`));
  };

  const onSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    pushFilters({ q: draftQ });
  };

  const activeFiltersCount = useMemo(
    () =>
      [active.difficulty, active.muscleGroup, active.equipment, active.conditionSlug].filter(
        (x) => x != null && x !== ""
      ).length,
    [active]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Biblioteca</div>
          <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            <span style={{ color: "var(--sky-700)" }}>{items.length}</span> ejercicios
          </h1>
        </div>
        <form
          onSubmit={onSubmitSearch}
          className="k-glass"
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 280,
            fontSize: 13,
            color: "var(--navy-300)",
          }}
        >
          <IconSearch size={15} />
          <input
            type="search"
            value={draftQ}
            onChange={(e) => setDraftQ(e.target.value)}
            placeholder="Buscar por nombre, músculo, descripción…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 13,
              color: "var(--navy-900)",
            }}
          />
          {pendingNav && <span style={{ fontSize: 11 }}>…</span>}
        </form>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
        <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card glass style={{ padding: 14 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--navy-300)",
                }}
              >
                <IconFilter size={11} style={{ verticalAlign: -1 }} /> Filtros
              </div>
              {activeFiltersCount > 0 && (
                <button
                  onClick={() =>
                    pushFilters({
                      difficulty: undefined,
                      muscleGroup: undefined,
                      equipment: undefined,
                      conditionSlug: undefined,
                    })
                  }
                  style={{
                    background: "none",
                    border: "none",
                    fontSize: 11,
                    color: "var(--sky-700)",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Limpiar ({activeFiltersCount})
                </button>
              )}
            </div>

            <FilterSection label="Dificultad">
              <ChipRow
                value={active.difficulty != null ? String(active.difficulty) : null}
                items={facets.difficulties.map((d) => ({ slug: String(d), label: `Nivel ${d}` }))}
                onChange={(v) => pushFilters({ difficulty: v ? Number(v) : undefined })}
              />
            </FilterSection>

            <FilterSection label="Grupo muscular">
              <ChipRow
                value={active.muscleGroup ?? null}
                items={facets.muscleGroups.map((m) => ({ slug: m, label: m }))}
                onChange={(v) => pushFilters({ muscleGroup: v ?? undefined })}
              />
            </FilterSection>

            <FilterSection label="Equipo">
              <ChipRow
                value={active.equipment ?? null}
                items={facets.equipment.map((m) => ({ slug: m, label: m }))}
                onChange={(v) => pushFilters({ equipment: v ?? undefined })}
              />
            </FilterSection>

            <FilterSection label="Diagnóstico">
              <select
                value={active.conditionSlug ?? ""}
                onChange={(e) => pushFilters({ conditionSlug: e.target.value || undefined })}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(15,30,51,0.08)",
                  background: "rgba(255,255,255,0.8)",
                  fontSize: 12.5,
                  color: "var(--navy-700)",
                }}
              >
                <option value="">Todos</option>
                {facets.conditions.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </select>
            </FilterSection>
          </Card>
        </aside>

        <main>
          {items.length === 0 ? (
            <Card style={{ padding: 40, textAlign: "center" }}>
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "50%",
                  background: "var(--sky-100)",
                  color: "var(--sky-700)",
                  margin: "0 auto 12px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <IconDumbbell size={26} />
              </div>
              <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
                No encontramos ejercicios con estos filtros
              </div>
            </Card>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: 12,
              }}
            >
              {items.map((ex) => (
                <ExerciseCard key={ex.id} ex={ex} onOpen={() => setOpen(ex)} />
              ))}
            </div>
          )}
        </main>
      </div>

      {open && <ExerciseDetail ex={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--navy-500)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ChipRow({
  value,
  items,
  onChange,
}: {
  value: string | null;
  items: { slug: string; label: string }[];
  onChange: (v: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((it) => {
        const on = it.slug === value;
        return (
          <button
            key={it.slug}
            onClick={() => onChange(on ? null : it.slug)}
            style={{
              padding: "5px 10px",
              borderRadius: 999,
              border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
              background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
              fontSize: 11,
              fontWeight: 600,
              color: on ? "#fff" : "var(--navy-700)",
              cursor: "pointer",
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function ExerciseCard({ ex, onOpen }: { ex: ExerciseRow; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      style={{
        textAlign: "left",
        padding: 14,
        borderRadius: 14,
        background: "#fff",
        border: "1px solid rgba(15,30,51,0.06)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: "var(--sky-100)",
            color: "var(--sky-700)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconDumbbell size={16} />
        </span>
        <Tag tone="soft">Nivel {ex.difficulty}</Tag>
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)", lineHeight: 1.25 }}>
        {ex.name}
      </div>
      {ex.muscleGroups && (
        <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{ex.muscleGroups}</div>
      )}
      <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
        {ex.defaultSets}×{ex.defaultReps}
        {ex.equipment ? ` · ${ex.equipment}` : ""}
      </div>
      {ex.conditionsCount > 0 && (
        <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
          Usado en {ex.conditionsCount} diagnóstico{ex.conditionsCount === 1 ? "" : "s"}
        </div>
      )}
    </button>
  );
}

function ExerciseDetail({ ex, onClose }: { ex: ExerciseRow; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong"
        style={{
          width: "min(620px, 100%)",
          borderRadius: 24,
          padding: 24,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
          <div>
            <Tag tone="lime">Ejercicio</Tag>
            <h2 className="k-display" style={{ fontSize: 24, margin: "8px 0 4px", fontWeight: 700 }}>
              {ex.name}
            </h2>
            {ex.muscleGroups && (
              <div style={{ fontSize: 13, color: "var(--navy-500)" }}>{ex.muscleGroups}</div>
            )}
          </div>
          <button
            aria-label="Cerrar"
            onClick={onClose}
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 36,
              height: 36,
              borderRadius: 12,
              cursor: "pointer",
              color: "var(--navy-700)",
            }}
          >
            <IconX size={16} />
          </button>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 10,
            padding: 12,
            background: "rgba(246,249,253,0.7)",
            borderRadius: 14,
          }}
        >
          <Stat label="Series" value={String(ex.defaultSets)} />
          <Stat label="Repeticiones" value={String(ex.defaultReps)} />
          <Stat label="Dificultad" value={`${ex.difficulty} / 5`} />
        </div>

        {ex.description && (
          <section>
            <H>Descripción</H>
            <p style={{ fontSize: 13.5, color: "var(--navy-700)", margin: 0, lineHeight: 1.55 }}>
              {ex.description}
            </p>
          </section>
        )}

        {ex.cues && (
          <section>
            <H>Cues / coaching</H>
            <p style={{ fontSize: 13.5, color: "var(--navy-700)", margin: 0, lineHeight: 1.55 }}>{ex.cues}</p>
          </section>
        )}

        {ex.equipment && (
          <section>
            <H>Equipo</H>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {ex.equipment.split(",").map((e) => (
                <Tag key={e} tone="soft">{e.trim()}</Tag>
              ))}
            </div>
          </section>
        )}

        {ex.conditions.length > 0 && (
          <section>
            <H>Aparece en diagnósticos</H>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ex.conditions.map((c) => (
                <div
                  key={c.slug + c.relation}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 12px",
                    background: "rgba(255,255,255,0.6)",
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <Tag tone={c.relation === "DIRECT" ? "sky" : "lime"}>{c.relation}</Tag>
                </div>
              ))}
            </div>
          </section>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}

function H({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-300)",
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div className="k-mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--sky-700)" }}>
        {value}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--navy-500)" }}>{label}</div>
    </div>
  );
}
