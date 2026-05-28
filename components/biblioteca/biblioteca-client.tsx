"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { TagCombobox, type TagOption } from "@/components/ui/tag-combobox";
import { IconSearch, IconX, IconFilter, IconDumbbell, IconPlus, IconStar } from "@/components/ui/icons";
import { createExercise, ensureTag } from "@/lib/exercises";
import type { ExerciseRow, FilterFacets } from "@/lib/exercises-types";
import { toggleFavourite } from "@/lib/favourites";
import { useDebouncedSearchParam } from "@/hooks/use-debounced-search-param";
import { BulkAssignModal } from "@/components/biblioteca/bulk-assign-modal";

type Active = {
  q?: string;
  difficulty?: number;
  muscleGroup?: string;
  equipment?: string;
  conditionSlug?: string;
  favouritesOnly?: boolean;
  privateOnly?: boolean;
};

export type Capabilities = {
  plan: string;
  canFavourite: boolean;
  hasFullCatalog: boolean;
};

type Mode = "exercises" | "manual-therapy";

export function BibliotecaClient({
  items,
  facets,
  active,
  tags,
  capabilities,
  mode = "exercises",
}: {
  items: ExerciseRow[];
  facets: FilterFacets;
  active: Active;
  tags: TagOption[];
  capabilities: Capabilities;
  mode?: Mode;
}) {
  const router = useRouter();
  const [pendingNav, start] = useTransition();
  const [open, setOpen] = useState<ExerciseRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ, flushQ] = useDebouncedSearchParam("q", 300);

  // Bulk selection — when `bulkMode` is on, card clicks toggle selection
  // instead of opening the detail modal. The floating action bar at the
  // bottom shows the count and a button to open the BulkAssignModal.
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  const exitBulk = () => {
    setBulkMode(false);
    clearSelection();
  };

  const basePath = mode === "manual-therapy" ? "/terapia-manual" : "/biblioteca";
  const pageTitle = mode === "manual-therapy" ? "Terapia Manual" : "Biblioteca de ejercicios";
  const pageSubtitle =
    mode === "manual-therapy"
      ? "Maniobras y técnicas manuales para combinar con ejercicios en cada sesión."
      : "Catálogo de ejercicios. Combinalos con maniobras de terapia manual al armar una sesión.";

  const pushFilters = (next: Partial<Active>) => {
    const merged = { ...active, ...next };
    const sp = new URLSearchParams();
    if (merged.q) sp.set("q", merged.q);
    if (merged.difficulty != null) sp.set("difficulty", String(merged.difficulty));
    if (merged.muscleGroup) sp.set("muscle", merged.muscleGroup);
    if (merged.equipment) sp.set("equipment", merged.equipment);
    if (merged.conditionSlug) sp.set("condition", merged.conditionSlug);
    if (merged.favouritesOnly) sp.set("favs", "1");
    if (merged.privateOnly) sp.set("priv", "1");
    start(() => router.push(`${basePath}${sp.toString() ? "?" + sp.toString() : ""}`));
  };

  const activeFiltersCount = useMemo(
    () =>
      [
        active.difficulty,
        active.muscleGroup,
        active.equipment,
        active.conditionSlug,
        active.favouritesOnly ? "favs" : undefined,
        active.privateOnly ? "priv" : undefined,
      ].filter((x) => x != null && x !== "").length,
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
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>
            {pageTitle} · plan{" "}
            <span
              style={{
                fontWeight: 700,
                color: capabilities.hasFullCatalog ? "var(--sky-700)" : "var(--navy-500)",
              }}
            >
              {capabilities.plan}
            </span>
          </div>
          <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            <span style={{ color: mode === "manual-therapy" ? "var(--lime-700, #4f8a10)" : "var(--sky-700)" }}>
              {items.length}
            </span>{" "}
            {mode === "manual-therapy" ? "maniobras" : "ejercicios"}
          </h1>
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 4 }}>{pageSubtitle}</div>
          {!capabilities.hasFullCatalog && (
            <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 4 }}>
              Estás viendo el catálogo básico + tus elementos. Pasá a PRO para ver el catálogo
              completo con videos.
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div
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
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  flushQ();
                }
              }}
              placeholder="Buscar por nombre, músculo, descripción…"
              aria-label="Buscar ejercicio"
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
          </div>
          <Button
            variant={bulkMode ? "primary" : "ghost"}
            onClick={() => (bulkMode ? exitBulk() : setBulkMode(true))}
            style={{ fontSize: 12 }}
            title={bulkMode ? "Salir del modo selección" : "Seleccionar varios para asignar a un plan"}
          >
            {bulkMode ? "Salir de selección" : "Seleccionar"}
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> Nuevo ejercicio
          </Button>
        </div>
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

            <FilterSection label="Acceso rápido">
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <QuickPill
                  label="⭐ Favoritos"
                  on={!!active.favouritesOnly}
                  onToggle={() => pushFilters({ favouritesOnly: !active.favouritesOnly })}
                  locked={!capabilities.canFavourite}
                />
                <QuickPill
                  label="🔒 Mis ejercicios"
                  on={!!active.privateOnly}
                  onToggle={() => pushFilters({ privateOnly: !active.privateOnly })}
                />
              </div>
            </FilterSection>

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
                <ExerciseCard
                  key={ex.id}
                  ex={ex}
                  onOpen={() => {
                    if (bulkMode) toggleSelected(ex.id);
                    else setOpen(ex);
                  }}
                  canFavourite={capabilities.canFavourite}
                  bulkMode={bulkMode}
                  selected={selected.has(ex.id)}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {open && <ExerciseDetail ex={open} onClose={() => setOpen(null)} />}
      {creating && (
        <CreateExerciseModal
          tags={tags}
          kind={mode === "manual-therapy" ? "MANUAL_THERAPY" : "EXERCISE"}
          onClose={() => setCreating(false)}
        />
      )}

      {bulkMode && selected.size > 0 && (
        <div
          role="region"
          aria-label="Acciones de selección"
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 60,
            padding: "12px 16px",
            borderRadius: 999,
            background: "var(--navy-900)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: 14,
            boxShadow: "0 16px 40px -10px rgba(15,30,51,0.4)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {selected.size} {selected.size === 1 ? "seleccionado" : "seleccionados"}
          </span>
          <Button
            variant="primary"
            onClick={() => setAssignOpen(true)}
            style={{ fontSize: 12, padding: "8px 14px" }}
          >
            Asignar a plan
          </Button>
          <button
            type="button"
            onClick={clearSelection}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.7)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Limpiar
          </button>
        </div>
      )}
      {assignOpen && (
        <BulkAssignModal
          exerciseIds={Array.from(selected)}
          onClose={() => setAssignOpen(false)}
          onApplied={(created) => {
            setAssignOpen(false);
            setAppliedMsg(`✓ ${created} asignaciones creadas.`);
            clearSelection();
            setTimeout(() => setAppliedMsg(null), 3000);
          }}
        />
      )}
      {appliedMsg && (
        <div
          role="status"
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 60,
            padding: "12px 16px",
            borderRadius: 12,
            background: "rgba(200,245,100,0.95)",
            color: "var(--navy-900)",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 12px 30px -10px rgba(15,30,51,0.3)",
          }}
        >
          {appliedMsg}
        </div>
      )}
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

function ExerciseCard({
  ex,
  onOpen,
  canFavourite,
  bulkMode = false,
  selected = false,
}: {
  ex: ExerciseRow;
  onOpen: () => void;
  canFavourite: boolean;
  /** When true, card click toggles selection and shows a check chip. */
  bulkMode?: boolean;
  selected?: boolean;
}) {
  const router = useRouter();
  const [favOptimistic, setFavOptimistic] = useState(ex.isFavourite);
  const [pendingFav, startFav] = useTransition();

  const onStar = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canFavourite) return;
    setFavOptimistic((s) => !s);
    startFav(async () => {
      const r = await toggleFavourite(ex.id);
      if (!r.ok) {
        setFavOptimistic((s) => !s); // revert
        return;
      }
      router.refresh();
    });
  };

  return (
    <button
      onClick={onOpen}
      aria-pressed={bulkMode ? selected : undefined}
      style={{
        textAlign: "left",
        padding: 14,
        borderRadius: 14,
        background: selected ? "rgba(200,245,100,0.18)" : "#fff",
        border: selected
          ? "1.5px solid var(--sky-700)"
          : ex.isPrivate
            ? "1px solid rgba(31,79,190,0.2)"
            : "1px solid rgba(15,30,51,0.06)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "var(--shadow-card)",
        position: "relative",
      }}
    >
      {bulkMode && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            width: 22,
            height: 22,
            borderRadius: 8,
            background: selected ? "var(--sky-700)" : "rgba(15,30,51,0.06)",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: selected ? "none" : "1.5px solid rgba(15,30,51,0.18)",
          }}
        >
          {selected ? "✓" : ""}
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: ex.isPrivate ? "var(--sky-700)" : "var(--sky-100)",
            color: ex.isPrivate ? "#fff" : "var(--sky-700)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconDumbbell size={16} />
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Tag tone="soft">Nivel {ex.difficulty}</Tag>
          {canFavourite && (
            <button
              type="button"
              onClick={onStar}
              aria-label={favOptimistic ? "Quitar de favoritos" : "Agregar a favoritos"}
              aria-pressed={favOptimistic}
              disabled={pendingFav}
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: "none",
                background: favOptimistic ? "var(--lime-300)" : "rgba(255,255,255,0.6)",
                color: favOptimistic ? "var(--navy-900)" : "var(--navy-300)",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <IconStar size={13} fill={favOptimistic ? "var(--navy-900)" : "none"} />
            </button>
          )}
        </div>
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        {ex.conditionsCount > 0 ? (
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
            Usado en {ex.conditionsCount} diagnóstico{ex.conditionsCount === 1 ? "" : "s"}
          </div>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {ex.kind === "MANUAL_THERAPY" && <Tag tone="lime">Maniobra</Tag>}
          {ex.isPrivate ? (
            <Tag tone="sky">🔒 Mío</Tag>
          ) : ex.isBasic ? (
            <Tag tone="soft">Básico</Tag>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function QuickPill({
  label,
  on,
  onToggle,
  locked,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={locked ? undefined : onToggle}
      disabled={locked}
      title={locked ? "Mejorá tu plan para usar favoritos" : undefined}
      style={{
        textAlign: "left",
        padding: "7px 10px",
        borderRadius: 10,
        border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
        background: on ? "rgba(31,79,190,0.06)" : "rgba(255,255,255,0.5)",
        cursor: locked ? "not-allowed" : "pointer",
        fontSize: 12,
        fontWeight: 600,
        color: locked ? "var(--navy-300)" : "var(--navy-700)",
      }}
    >
      {label}
      {locked && (
        <span style={{ marginLeft: 6, fontSize: 9, color: "var(--navy-300)" }}>plan PRO</span>
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
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
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

function CreateExerciseModal({
  tags,
  onClose,
  kind = "EXERCISE",
}: {
  tags: TagOption[];
  onClose: () => void;
  kind?: "EXERCISE" | "MANUAL_THERAPY";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState(tags);

  const onCreateTag = async (label: string) => {
    const created = await ensureTag(label, "GOAL");
    setAvailableTags((s) => (s.find((t) => t.slug === created.slug) ? s : [...s, created]));
    return created;
  };

  const submit = (form: FormData) => {
    setError(null);
    start(async () => {
      const r = await createExercise({
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? "") || undefined,
        difficulty: Number(form.get("difficulty")) || 1,
        defaultSets: Number(form.get("defaultSets")) || 3,
        defaultReps: Number(form.get("defaultReps")) || 12,
        equipment: String(form.get("equipment") ?? "") || undefined,
        muscleGroups: String(form.get("muscleGroups") ?? "") || undefined,
        cues: String(form.get("cues") ?? "") || undefined,
        instructions: String(form.get("instructions") ?? "") || undefined,
        tagSlugs: selectedTags,
        kind,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

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
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong k-scroll"
        style={{
          position: "relative",
          width: "min(600px, 100%)",
          maxHeight: "92vh",
          overflowY: "auto",
          borderRadius: 22,
          padding: 24,
        }}
      >
        <ModalCloseButton onClose={onClose} />
        <header style={{ marginRight: 40, marginBottom: 16 }}>
          <Tag tone="lime">Nuevo ejercicio</Tag>
          <h2 className="k-display" style={{ fontSize: 22, margin: "8px 0 0", fontWeight: 700 }}>
            Crear ejercicio personalizado
          </h2>
        </header>

        <form action={submit} style={{ display: "grid", gap: 12 }}>
          <Labeled label="Nombre" required>
            <input name="name" required style={fieldStyle} placeholder="Sentadilla búlgara" />
          </Labeled>
          <Labeled label="Grupo muscular">
            <input name="muscleGroups" style={fieldStyle} placeholder="Cuádriceps, Glúteo" />
          </Labeled>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <Labeled label="Series">
              <input name="defaultSets" type="number" min={1} max={10} defaultValue={3} style={fieldStyle} />
            </Labeled>
            <Labeled label="Reps">
              <input name="defaultReps" type="number" min={1} max={100} defaultValue={12} style={fieldStyle} />
            </Labeled>
            <Labeled label="Dificultad">
              <input
                name="difficulty"
                type="number"
                min={1}
                max={5}
                defaultValue={1}
                style={fieldStyle}
              />
            </Labeled>
          </div>
          <Labeled label="Equipo">
            <input name="equipment" style={fieldStyle} placeholder="banda, foam roller" />
          </Labeled>
          <Labeled label="Descripción">
            <textarea name="description" rows={3} style={{ ...fieldStyle, resize: "vertical" }} />
          </Labeled>
          <Labeled label="Cues / coaching">
            <textarea name="cues" rows={2} style={{ ...fieldStyle, resize: "vertical" }} />
          </Labeled>
          <Labeled label="Tags">
            <TagCombobox
              suggestions={availableTags}
              value={selectedTags}
              onChange={setSelectedTags}
              onCreate={onCreateTag}
              placeholder="Tocá Enter para crear un tag nuevo"
            />
          </Labeled>

          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Creando…" : "Crear ejercicio"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Labeled({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
        {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
      </span>
      <div style={{ marginTop: 6 }}>{children}</div>
    </label>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.08)",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};
