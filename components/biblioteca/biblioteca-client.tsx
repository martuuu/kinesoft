"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { Modal } from "@/components/ui/modal";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import type { TagOption } from "@/components/ui/tag-combobox";
import { IconSearch, IconFilter, IconDumbbell, IconPlus, IconStar } from "@/components/ui/icons";
import type { ExerciseRow, FilterFacets } from "@/lib/exercises-types";
import { toggleFavourite } from "@/lib/favourites";
import { useDebouncedSearchParam } from "@/hooks/use-debounced-search-param";
import { SAAS_PLAN_LABEL, minimumPlanFor } from "@/lib/tenant-modules";
import { relationLabel } from "@/components/diagnostico/labels";
import type { ExerciseRelation } from "@prisma/client";
import styles from "./biblioteca.module.css";

// Superadmin-only editor: lazy so the ~everyone-is-not-an-admin case never
// downloads the drawer + its media/article editors with the page bundle.
const ExerciseDrawer = dynamic(
  () => import("@/components/plataforma/exercise-drawer").then((m) => m.ExerciseDrawer),
  { ssr: false },
);

// [PF1.2 · C-PF2] Alta y asignación masiva: no están en el primer pintado (se abren con un click), así que bajan con
// `next/dynamic` y se precargan en hover/foco del disparador (`import()` sin await) para que el click no espere red.
const loadCreateDrawer = () => import("@/components/biblioteca/create-exercise-drawer");
const CreateExerciseDrawer = dynamic(() => loadCreateDrawer().then((m) => m.CreateExerciseDrawer), { ssr: false });
const loadBulkAssign = () => import("@/components/biblioteca/bulk-assign-modal");
const BulkAssignModal = dynamic(() => loadBulkAssign().then((m) => m.BulkAssignModal), { ssr: false });
const preloadCreate = { onPointerEnter: () => void loadCreateDrawer(), onFocus: () => void loadCreateDrawer() };
const preloadBulk = { onPointerEnter: () => void loadBulkAssign(), onFocus: () => void loadBulkAssign() };

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
  /** Kine Consultorio/Clínica/Libre (`catalogScope: "full"`, C-PL1): ve el catálogo global de Plataforma. */
  hasFullCatalog: boolean;
};

/** PL-1d: «Individual», «Consultorio», …; un plan desconocido se muestra tal cual. */
function planLabel(plan: string): string {
  return (SAAS_PLAN_LABEL as Record<string, string>)[plan] ?? plan;
}

/**
 * PL-1d: desde qué plan se suma cada cosa, sacado de la matriz (C-PL1, `minimumPlanFor`) y no escrito a mano: la
 * biblioteca es solo de Kinesiología. Hoy los dos dan «Consultorio» (decisión 4 de Martin).
 */
const FULL_CATALOG_FROM = `el plan ${planLabel(minimumPlanFor("ejerciciosGlobales", "KINESIOLOGY") ?? "CONSULTORIO")}`;
const FAVOURITES_FROM = `plan ${planLabel(minimumPlanFor("favoritos", "KINESIOLOGY") ?? "CONSULTORIO")}`;
const FULL_CATALOG_UPSELL = `Desde ${FULL_CATALOG_FROM} se suma el catálogo de la plataforma.`;

type Mode = "exercises" | "manual-therapy";

export function BibliotecaClient({
  items,
  facets,
  active,
  tags,
  capabilities,
  mode = "exercises",
  isPlatformAdmin = false,
}: {
  items: ExerciseRow[];
  facets: FilterFacets;
  active: Active;
  tags: TagOption[];
  capabilities: Capabilities;
  mode?: Mode;
  /** Platform superadmin: clicking a CATALOG card opens the editor drawer
   *  instead of the read-only detail (tenant-private items stay read-only). */
  isPlatformAdmin?: boolean;
}) {
  const router = useRouter();
  const [pendingNav, start] = useTransition();
  const [open, setOpen] = useState<ExerciseRow | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ, flushQ] = useDebouncedSearchParam("q", 300);

  // Bulk selection — when `bulkMode` is on, card clicks toggle selection
  // instead of opening the detail modal. The floating action bar at the
  // bottom shows the count and a button to open the BulkAssignModal.
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignOpen, setAssignOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const toast = useToast();

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
  const pageTitle = mode === "manual-therapy" ? "Terapia manual" : "Biblioteca de ejercicios";
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
  // Vacío "de verdad" (sin búsqueda ni filtros): desde EV0 un Kine base arranca
  // así, porque ya no ve los globales `isBasic` (solo sus propios ejercicios).
  const libraryEmpty = items.length === 0 && activeFiltersCount === 0 && !active.q;
  const noun = mode === "manual-therapy" ? "maniobra" : "ejercicio";

  const clearFilters = () =>
    pushFilters({
      difficulty: undefined,
      muscleGroup: undefined,
      equipment: undefined,
      conditionSlug: undefined,
      favouritesOnly: undefined,
      privateOnly: undefined,
    });

  // Mismo contenido en el panel lateral (≥ 1024) y en el Drawer «Filtros (n)» (< 1024, C2).
  const filters = (
    <>
      <FilterSection label="Acceso rápido">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <QuickPill
            label={
              <>
                <IconStar size={12} style={{ verticalAlign: -1 }} /> Favoritos
              </>
            }
            on={!!active.favouritesOnly}
            onToggle={() => pushFilters({ favouritesOnly: !active.favouritesOnly })}
            locked={!capabilities.canFavourite}
          />
          <QuickPill
            label={mode === "manual-therapy" ? "Mis maniobras" : "Mis ejercicios"}
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
          aria-label="Filtrar por diagnóstico"
          className={styles.select}
        >
          <option value="">Todos</option>
          {facets.conditions.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </FilterSection>
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow={
          <>
            {pageTitle} · plan {planLabel(capabilities.plan)}
          </>
        }
        title={
          <>
            {items.length} {mode === "manual-therapy" ? (items.length === 1 ? "maniobra" : "maniobras") : items.length === 1 ? "ejercicio" : "ejercicios"}
          </>
        }
        description={
          <>
            {pageSubtitle}
            {!capabilities.hasFullCatalog && (
              <>
                {" "}
                {FULL_CATALOG_UPSELL}
              </>
            )}
          </>
        }
        actions={
          <div className={styles.tools}>
            <div className={`k-glass ${styles.search}`}>
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
                aria-label={mode === "manual-therapy" ? "Buscar maniobra" : "Buscar ejercicio"}
                className={styles.searchInput}
              />
              {pendingNav && (
                <span role="status" style={{ fontSize: 11 }}>
                  Buscando…
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              className={styles.filtersButton}
              onClick={() => setFiltersOpen(true)}
              aria-haspopup="dialog"
            >
              <IconFilter size={13} /> Filtros{activeFiltersCount > 0 ? ` (${activeFiltersCount})` : ""}
            </Button>
            <Button
              variant={bulkMode ? "primary" : "ghost"}
              onClick={() => (bulkMode ? exitBulk() : setBulkMode(true))}
              title={bulkMode ? "Salir del modo selección" : "Seleccionar varios para asignar a un plan"}
              {...preloadBulk}
            >
              {bulkMode ? "Salir de selección" : "Seleccionar"}
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)} {...preloadCreate}>
              <IconPlus size={14} /> {mode === "manual-therapy" ? "Nueva maniobra" : "Nuevo ejercicio"}
            </Button>
          </div>
        }
      />

      <div className={styles.layout}>
        <aside className={styles.aside} aria-label="Filtros">
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
                  color: "var(--navy-500)",
                }}
              >
                <IconFilter size={11} style={{ verticalAlign: -1 }} /> Filtros
              </div>
              {activeFiltersCount > 0 && (
                <button type="button" onClick={clearFilters} style={linkBtn}>
                  Limpiar ({activeFiltersCount})
                </button>
              )}
            </div>
            {filters}
          </Card>
        </aside>

        <main style={{ minWidth: 0 }}>
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
              {libraryEmpty ? (
                <>
                  <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
                    Creá tu primer{noun === "maniobra" ? "a" : ""} {noun}
                  </div>
                  {!capabilities.hasFullCatalog && (
                    <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 6 }}>
                      {FULL_CATALOG_UPSELL}
                    </div>
                  )}
                  <div style={{ marginTop: 14 }}>
                    <Button variant="primary" onClick={() => setCreating(true)} {...preloadCreate}>
                      <IconPlus size={14} /> Nuev{noun === "maniobra" ? "a" : "o"} {noun}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
                    No encontramos {mode === "manual-therapy" ? "maniobras" : "ejercicios"} con estos filtros
                  </div>
                  {activeFiltersCount > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <Button variant="ghost" onClick={clearFilters}>
                        Limpiar filtros
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          ) : (
            <div className={styles.grid}>
              {items.map((ex) => (
                <ExerciseCard
                  key={ex.id}
                  ex={ex}
                  onOpen={() => {
                    if (bulkMode) toggleSelected(ex.id);
                    // Superadmin + global catalog row → edit in place. Private
                    // tenant exercises have no global row, so they stay read-only.
                    else if (isPlatformAdmin && !ex.isPrivate) setEditingId(ex.id);
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

      <Drawer open={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filtros" width={360}>
        <div style={{ display: "grid", gap: 4 }}>
          {filters}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={clearFilters} disabled={activeFiltersCount === 0}>
              Limpiar
            </Button>
            <Button variant="primary" onClick={() => setFiltersOpen(false)}>
              Ver {items.length} {mode === "manual-therapy" ? "maniobras" : "ejercicios"}
            </Button>
          </div>
        </div>
      </Drawer>

      {open && <ExerciseDetail ex={open} onClose={() => setOpen(null)} />}
      {editingId && (
        <ExerciseDrawer
          mode="edit"
          exerciseId={editingId}
          tagOptions={tags}
          showFichaLink
          onClose={() => setEditingId(null)}
        />
      )}
      {creating && (
        <CreateExerciseDrawer
          tags={tags}
          kind={mode === "manual-therapy" ? "MANUAL_THERAPY" : "EXERCISE"}
          onClose={() => setCreating(false)}
        />
      )}

      {bulkMode && selected.size > 0 && (
        <div role="region" aria-label="Acciones de selección" className={styles.actionBar}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {selected.size} {selected.size === 1 ? "seleccionado" : "seleccionados"}
          </span>
          <Button variant="primary" onClick={() => setAssignOpen(true)} {...preloadBulk}>
            Asignar a plan
          </Button>
          <button
            type="button"
            onClick={clearSelection}
            style={{
              background: "transparent",
              border: "none",
              color: "rgba(255,255,255,0.85)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              minHeight: 32,
              borderRadius: 8,
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
            toast.success(`${created} ${created === 1 ? "asignación creada" : "asignaciones creadas"}`);
            clearSelection();
          }}
        />
      )}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  fontSize: 12,
  color: "var(--sky-700)",
  fontWeight: 600,
  cursor: "pointer",
  minHeight: 28,
  borderRadius: 6,
};

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
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? null : it.slug)}
            style={{
              minHeight: 32,
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
      // EV2-Z (PF-0d): `toggleFavourite` revalida /biblioteca y la respuesta de la action ya trae el árbol nuevo.
    });
  };

  return (
    <div className={`${styles.card} ${selected ? styles.cardSelected : ex.isPrivate ? styles.cardPrivate : ""}`} data-testid="exercise-card">
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
          {selected ? <IconCheckMark /> : null}
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span
          aria-hidden
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
        <div style={{ display: "flex", alignItems: "center", gap: 6, visibility: bulkMode ? "hidden" : undefined }}>
          <Tag tone="soft">Nivel {ex.difficulty}</Tag>
          {canFavourite && !bulkMode && (
            // Hermana del botón principal (no anidada: C1) y por encima de su `::after`.
            <button
              type="button"
              className={styles.cardOver}
              onClick={onStar}
              aria-label={favOptimistic ? `Quitar ${ex.name} de favoritos` : `Agregar ${ex.name} a favoritos`}
              aria-pressed={favOptimistic}
              disabled={pendingFav}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: "none",
                background: favOptimistic ? "var(--lime-300)" : "rgba(15,30,51,0.04)",
                color: favOptimistic ? "var(--navy-900)" : "var(--navy-500)",
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
      {/* El botón principal es el nombre; su `::after` cubre toda la card (C1). */}
      <button type="button" className={styles.cardMain} onClick={onOpen} aria-pressed={bulkMode ? selected : undefined}>
        {ex.name}
      </button>
      {ex.muscleGroups && (
        <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{ex.muscleGroups}</div>
      )}
      <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
        {[
          ex.defaultSets != null && ex.defaultReps != null
            ? `${ex.defaultSets}×${ex.defaultReps}`
            : ex.durationSeconds != null
              ? ex.durationSeconds >= 60
                ? `${Math.round(ex.durationSeconds / 60)} min`
                : `${ex.durationSeconds}s`
              : null,
          ex.equipment || null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
        {ex.conditionsCount > 0 ? (
          <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
            Usado en {ex.conditionsCount} diagnóstico{ex.conditionsCount === 1 ? "" : "s"}
          </div>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {ex.kind === "MANUAL_THERAPY" && <Tag tone="lime">Maniobra</Tag>}
          {/* EV0: `isBasic` ya no decide visibilidad (un Kine base no ve
              globales), así que el chip "Básico" no significaba nada. Lo que no
              es propio viene del catálogo de la plataforma (desde Consultorio, PL-1d). */}
          {ex.isPrivate ? <Tag tone="sky">Mío</Tag> : <Tag tone="soft">Catálogo</Tag>}
        </div>
      </div>
    </div>
  );
}

/** Tilde del modo selección (antes el carácter «✓»). */
function IconCheckMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function QuickPill({
  label,
  on,
  onToggle,
  locked,
}: {
  label: ReactNode;
  on: boolean;
  onToggle: () => void;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={locked ? undefined : onToggle}
      disabled={locked}
      aria-pressed={locked ? undefined : on}
      title={locked ? `Los favoritos están disponibles desde el ${FAVOURITES_FROM}` : undefined}
      style={{
        textAlign: "left",
        minHeight: 36,
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
        // Favoritos van desde Consultorio (C-PL1), igual que el catálogo global.
        <span style={{ marginLeft: 6, fontSize: 10, color: "var(--navy-500)" }}>{FAVOURITES_FROM}</span>
      )}
    </button>
  );
}

/**
 * Ficha rápida del ejercicio. [PF1.2] Sobre el `Modal` del design system (foco atrapado, Esc, portal); antes era un
 * overlay a mano sin Esc ni trap y con el rótulo «Ejercicio» fijo aunque fuera una maniobra.
 */
function ExerciseDetail({ ex, onClose }: { ex: ExerciseRow; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={ex.name} description={ex.muscleGroups || undefined} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 10,
            padding: 12,
            background: "rgba(246,249,253,0.7)",
            borderRadius: 14,
          }}
        >
          {ex.defaultSets == null && ex.defaultReps == null && ex.durationSeconds != null ? (
            <>
              <Stat
                label="Tiempo"
                value={ex.durationSeconds >= 60 ? `${Math.round(ex.durationSeconds / 60)} min` : `${ex.durationSeconds}s`}
              />
              <Stat label="Dificultad" value={`${ex.difficulty} / 5`} />
              <span />
            </>
          ) : (
            <>
              <Stat label="Series" value={ex.defaultSets != null ? String(ex.defaultSets) : "—"} />
              <Stat label="Repeticiones" value={ex.defaultReps != null ? String(ex.defaultReps) : "—"} />
              <Stat label="Dificultad" value={`${ex.difficulty} / 5`} />
            </>
          )}
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
            <H>Indicaciones</H>
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
                    gap: 8,
                    padding: "8px 12px",
                    background: "rgba(255,255,255,0.6)",
                    borderRadius: 10,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600, minWidth: 0, overflowWrap: "anywhere" }}>{c.name}</span>
                  <Tag tone={c.relation === "DIRECT" ? "sky" : "lime"}>{relationLabel(c.relation as ExerciseRelation)}</Tag>
                </div>
              ))}
            </div>
          </section>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Link href={`/biblioteca/${ex.slug}`} className="k-btn k-btn-primary">
            Ver ficha completa
          </Link>
        </div>
      </div>
    </Modal>
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
        color: "var(--navy-500)",
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
