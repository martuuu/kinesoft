"use client";

/**
 * Plataforma → Ejercicios: the global catalog admin table.
 *
 * URL is the source of truth for search / filters / sort / page (shareable,
 * back-button friendly); every change is ALSO persisted to the user's
 * `catalogPrefs` so the next visit restores the same view. Quick mutations
 * (plan tier, archive/restore) happen inline on the row — the drawer is only
 * for full edits (name, tags, media, article).
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { TagOption } from "@/components/ui/tag-combobox";
import { IconSearch, IconChevL, IconChevR, IconPlay, IconFile, IconPlus } from "@/components/ui/icons";
import { updateGlobalExercise, archiveGlobalExercise, restoreGlobalExercise } from "@/lib/exercises-admin";
import type { GlobalExerciseAdminRow } from "@/lib/exercises-admin";
import { updateUserPreferences } from "@/lib/preferences";
import {
  CATALOG_PAGE_SIZES,
  DEFAULT_CATALOG_FILTERS,
  type CatalogFilters,
  type CatalogPrefs,
  type CatalogSortCol,
  type CatalogSortDir,
} from "@/lib/preferences-constants";
import { ExerciseDrawer } from "@/components/plataforma/exercise-drawer";
import { TagFilterMenu, type TagOpt } from "@/components/plataforma/tag-filter-menu";

/** Column track shared by the header and every row so the two never drift. */
const COLS = "minmax(190px,2.3fr) 108px 58px 92px minmax(150px,1.7fr) 96px 176px";

type CatalogTagOptions = { muscle: TagOpt[]; equipment: TagOpt[]; discipline: TagOpt[] };

export function ExerciseAdminClient({
  rows,
  total,
  page,
  state,
  tagOptions,
  catalogTags,
}: {
  rows: GlobalExerciseAdminRow[];
  total: number;
  page: number;
  state: CatalogPrefs;
  /** All tags, for the drawer's combobox. */
  tagOptions: TagOption[];
  /** Grouped tags, for the toolbar filters. */
  catalogTags: CatalogTagOptions;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [q, setQ] = useState(state.filters.q);

  const { filters, sortCol, sortDir, pageSize } = state;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  /** Push the next view to the URL and persist it as the user's default. */
  const apply = (
    next: Partial<{ filters: Partial<CatalogFilters>; sortCol: CatalogSortCol; sortDir: CatalogSortDir; pageSize: number; page: number }>,
  ) => {
    const f: CatalogFilters = { ...filters, ...(next.filters ?? {}) };
    const nextState: CatalogPrefs = {
      filters: f,
      sortCol: next.sortCol ?? sortCol,
      sortDir: next.sortDir ?? sortDir,
      pageSize: next.pageSize ?? pageSize,
    };
    // Any filter/sort change resets to page 1 unless a page was requested.
    const nextPage = next.page ?? (next.filters || next.sortCol || next.sortDir || next.pageSize ? 1 : page);

    const p = new URLSearchParams();
    if (f.q) p.set("q", f.q);
    if (f.kind) p.set("kind", f.kind);
    if (f.tier) p.set("tier", f.tier);
    if (f.difficulty != null) p.set("dif", String(f.difficulty));
    if (f.muscle.length) p.set("muscle", f.muscle.join(","));
    if (f.equipment.length) p.set("equip", f.equipment.join(","));
    if (f.discipline.length) p.set("disc", f.discipline.join(","));
    if (f.archived !== "active") p.set("arch", f.archived);
    p.set("sort", nextState.sortCol);
    p.set("dir", nextState.sortDir);
    p.set("size", String(nextState.pageSize));
    if (nextPage > 1) p.set("page", String(nextPage));
    router.push(`/plataforma/ejercicios?${p.toString()}`, { scroll: false });
    // Fire-and-forget: remember this view for the next visit.
    void updateUserPreferences({ catalogPrefs: nextState });
  };

  // Keep the freshest `apply` reachable from the debounce timer: the timeout
  // must never fire with the filter set captured when the user started typing
  // (that would resurrect filters cleared meanwhile).
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Re-sync the box when the applied query changes underneath us (Back/Forward,
  // "Limpiar filtros"), so input and table never disagree.
  useEffect(() => {
    setQ(filters.q);
  }, [filters.q]);

  // Debounce the search box, then apply. Depending on `filters.q` too means a
  // pending timer is cancelled as soon as the applied state changes.
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => applyRef.current({ filters: { q } }), 350);
    return () => clearTimeout(t);
  }, [q, filters.q]);

  const activeCount =
    (filters.q ? 1 : 0) +
    (filters.kind ? 1 : 0) +
    (filters.tier ? 1 : 0) +
    (filters.difficulty != null ? 1 : 0) +
    filters.muscle.length +
    filters.equipment.length +
    filters.discipline.length +
    (filters.archived !== "active" ? 1 : 0);

  const clearAll = () => {
    setQ("");
    apply({ filters: DEFAULT_CATALOG_FILTERS });
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <header
        style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <h1 style={{ fontSize: 19, fontWeight: 700, color: "var(--navy-900)", margin: 0, letterSpacing: "-0.01em" }}>
            Catálogo de ejercicios
          </h1>
          <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "3px 0 0" }}>
            Ejercicios y terapias manuales globales — la base compartida por todos los consultorios.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={13} /> Nuevo ejercicio
        </Button>
      </header>

      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <Card style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 200 }}>
          <span
            style={{
              position: "absolute",
              left: 11,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--navy-300)",
              display: "inline-flex",
            }}
          >
            <IconSearch size={14} />
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre, descripción o tag…"
            autoComplete="new-password"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            style={{
              width: "100%",
              padding: "8px 12px 8px 32px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.1)",
              background: "rgba(255,255,255,0.95)",
              fontSize: 13,
              color: "var(--navy-900)",
              outline: "none",
            }}
          />
        </div>

        <Select
          value={filters.kind}
          onChange={(v) => apply({ filters: { kind: v as CatalogFilters["kind"] } })}
          options={[
            { v: "", l: "Todo tipo" },
            { v: "EXERCISE", l: "Ejercicios" },
            { v: "MANUAL_THERAPY", l: "Maniobras" },
          ]}
        />
        <Select
          value={filters.tier}
          onChange={(v) => apply({ filters: { tier: v as CatalogFilters["tier"] } })}
          options={[
            { v: "", l: "Todo plan" },
            { v: "comun", l: "Común" },
            { v: "pro", l: "Pro" },
          ]}
        />
        <Select
          value={filters.difficulty == null ? "" : String(filters.difficulty)}
          onChange={(v) => apply({ filters: { difficulty: v ? Number(v) : null } })}
          options={[{ v: "", l: "Toda dificultad" }, ...[1, 2, 3, 4, 5].map((n) => ({ v: String(n), l: `Nivel ${n}` }))]}
        />
        <Select
          value={filters.archived}
          onChange={(v) => apply({ filters: { archived: v as CatalogFilters["archived"] } })}
          options={[
            { v: "active", l: "Activos" },
            { v: "archived", l: "Archivados" },
            { v: "all", l: "Todos" },
          ]}
        />

        <span style={{ width: 1, height: 22, background: "rgba(15,30,51,0.08)" }} />

        <TagFilterMenu
          label="Grupo muscular"
          options={catalogTags.muscle}
          value={filters.muscle}
          onChange={(muscle) => apply({ filters: { muscle } })}
        />
        <TagFilterMenu
          label="Elementos"
          options={catalogTags.equipment}
          value={filters.equipment}
          onChange={(equipment) => apply({ filters: { equipment } })}
        />
        <TagFilterMenu
          label="Disciplina"
          options={catalogTags.discipline}
          value={filters.discipline}
          onChange={(discipline) => apply({ filters: { discipline } })}
        />

        {activeCount > 0 && (
          <button
            type="button"
            onClick={clearAll}
            style={{
              marginLeft: "auto",
              background: "none",
              border: "none",
              color: "var(--sky-700)",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              padding: "6px 4px",
            }}
          >
            Limpiar filtros ({activeCount})
          </button>
        )}
      </Card>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 880 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: COLS,
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid rgba(15,30,51,0.07)",
                background: "rgba(246,249,253,0.6)",
              }}
            >
              <SortHead col="name" label="Nombre" state={state} onSort={apply} />
              <SortHead col="kind" label="Tipo" state={state} onSort={apply} />
              <SortHead col="difficulty" label="Dif." state={state} onSort={apply} />
              <SortHead col="tier" label="Plan" state={state} onSort={apply} />
              <Head>Clasificación</Head>
              <Head>Prescripción</Head>
              <Head align="right">Acciones</Head>
            </div>

            {rows.length === 0 ? (
              <div style={{ padding: "44px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
                  {activeCount > 0 ? "Ningún ejercicio coincide con los filtros." : "El catálogo está vacío."}
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4 }}>
                  {activeCount > 0 ? "Probá quitando alguno." : "Creá el primer ejercicio global."}
                </div>
                {activeCount > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    style={{
                      marginTop: 12,
                      background: "none",
                      border: "1px solid rgba(15,30,51,0.12)",
                      borderRadius: 10,
                      padding: "7px 14px",
                      color: "var(--navy-700)",
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Limpiar filtros
                  </button>
                )}
              </div>
            ) : (
              rows.map((e) => <Row key={e.id} e={e} onEdit={() => setEditingId(e.id)} />)
            )}
          </div>
        </div>
      </Card>

      {/* ── Pager ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "0 2px",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {total === 0 ? "Sin resultados" : `Mostrando ${from}–${to} de ${total}`}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Select
            value={String(pageSize)}
            onChange={(v) => apply({ pageSize: Number(v) })}
            options={CATALOG_PAGE_SIZES.map((n) => ({ v: String(n), l: `${n} / página` }))}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <PagerBtn disabled={page <= 1} onClick={() => apply({ page: page - 1 })} label="Anterior">
              <IconChevL size={14} />
            </PagerBtn>
            <span className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)", minWidth: 92, textAlign: "center" }}>
              Página {page} / {pageCount}
            </span>
            <PagerBtn disabled={page >= pageCount} onClick={() => apply({ page: page + 1 })} label="Siguiente">
              <IconChevR size={14} />
            </PagerBtn>
          </div>
        </div>
      </div>

      {creating && (
        <ExerciseDrawer mode="create" tagOptions={tagOptions} onClose={() => setCreating(false)} />
      )}
      {editingId && (
        <ExerciseDrawer
          mode="edit"
          exerciseId={editingId}
          tagOptions={tagOptions}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

/* ── Row ─────────────────────────────────────────────────────────────── */

function Row({ e, onEdit }: { e: GlobalExerciseAdminRow; onEdit: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [hover, setHover] = useState(false);

  const toggleTier = () => {
    start(async () => {
      const r = await updateGlobalExercise({ id: e.id, isBasic: !e.isBasic });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(!e.isBasic ? "Ahora es plan Común" : "Ahora es plan Pro");
      router.refresh();
    });
  };

  const toggleArchive = () => {
    start(async () => {
      const r = e.archived ? await restoreGlobalExercise(e.id) : await archiveGlobalExercise(e.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(e.archived ? "Restaurado" : "Archivado");
      router.refresh();
    });
  };

  const muscle = e.tags.filter((t) => t.kind === "MUSCLE_GROUP");
  const equip = e.tags.filter((t) => t.kind === "EQUIPMENT");
  const disc = e.tags.filter((t) => t.kind === "DISCIPLINE");
  const prescription =
    e.defaultSets != null && e.defaultReps != null
      ? `${e.defaultSets}×${e.defaultReps}`
      : e.durationSeconds != null
        ? e.durationSeconds >= 60
          ? `${Math.round(e.durationSeconds / 60)} min`
          : `${e.durationSeconds}s`
        : "—";

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        padding: "11px 16px",
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.045)",
        background: hover ? "rgba(31,79,190,0.025)" : "transparent",
        opacity: e.archived ? 0.62 : pending ? 0.55 : 1,
        transition: "background 0.12s ease, opacity 0.12s ease",
      }}
    >
      {/* Nombre */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--navy-900)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {e.name}
          {e.archived && (
            <span
              style={{
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--navy-400)",
                border: "1px solid rgba(15,30,51,0.14)",
                borderRadius: 5,
                padding: "1px 5px",
                flexShrink: 0,
              }}
            >
              archivado
            </span>
          )}
        </div>
        <div
          className="k-mono"
          style={{
            fontSize: 10.5,
            color: "var(--navy-300)",
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {e.slug}
        </div>
      </div>

      {/* Tipo — a coloured dot reads faster than a pill at this density */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--navy-700)" }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: e.kind === "MANUAL_THERAPY" ? "var(--lime-500)" : "var(--sky-600)",
            flexShrink: 0,
          }}
        />
        {e.kind === "MANUAL_THERAPY" ? "Maniobra" : "Ejercicio"}
      </div>

      {/* Dificultad */}
      <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)" }}>
        {e.difficulty}
        <span style={{ color: "var(--navy-300)" }}>/5</span>
      </div>

      {/* Plan — inline toggle */}
      <button
        type="button"
        onClick={toggleTier}
        disabled={pending}
        title={e.isBasic ? "Cambiar a Pro (solo planes pagos)" : "Cambiar a Común (visible en todos los planes)"}
        style={{
          justifySelf: "start",
          border: `1px solid ${e.isBasic ? "rgba(15,30,51,0.14)" : "rgba(31,79,190,0.3)"}`,
          background: e.isBasic ? "rgba(15,30,51,0.03)" : "rgba(31,79,190,0.08)",
          color: e.isBasic ? "var(--navy-500)" : "var(--sky-700)",
          borderRadius: 999,
          padding: "3px 10px",
          fontSize: 11,
          fontWeight: 700,
          cursor: pending ? "not-allowed" : "pointer",
        }}
      >
        {e.isBasic ? "Común" : "Pro"}
      </button>

      {/* Clasificación — grouped chips, muscle → equipment → discipline */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minWidth: 0 }}>
        {muscle.slice(0, 2).map((t) => (
          <Chip key={t.slug} tone="sky">{t.label}</Chip>
        ))}
        {equip.slice(0, 1).map((t) => (
          <Chip key={t.slug} tone="soft">{t.label}</Chip>
        ))}
        {disc.slice(0, 1).map((t) => (
          <Chip key={t.slug} tone="lime">{t.label}</Chip>
        ))}
        {e.tags.length > 4 && <Chip tone="ghost">+{e.tags.length - 4}</Chip>}
        {e.tags.length === 0 && <span style={{ fontSize: 11, color: "var(--navy-300)" }}>Sin clasificar</span>}
      </div>

      {/* Prescripción */}
      <div className="k-mono" style={{ fontSize: 11.5, color: prescription === "—" ? "var(--navy-300)" : "var(--sky-700)" }}>
        {prescription}
      </div>

      {/* Acciones — passive media/article badges + the two quick actions */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <span
          title={`${e.mediaCount} archivo${e.mediaCount === 1 ? "" : "s"} de media`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            fontSize: 11,
            color: e.mediaCount ? "var(--sky-700)" : "var(--navy-300)",
          }}
        >
          <IconPlay size={11} />
          {e.mediaCount}
        </span>
        <span
          title={e.hasArticle ? "Tiene artículo" : "Sin artículo"}
          style={{ display: "inline-flex", color: e.hasArticle ? "var(--sky-700)" : "var(--navy-300)" }}
        >
          <IconFile size={12} />
        </span>
        <button
          type="button"
          onClick={onEdit}
          style={{
            border: "1px solid rgba(15,30,51,0.12)",
            background: "rgba(255,255,255,0.9)",
            borderRadius: 8,
            padding: "5px 10px",
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--navy-700)",
            cursor: "pointer",
          }}
        >
          Editar
        </button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={pending}
          title={e.archived ? "Restaurar" : "Archivar"}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--navy-400)",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: pending ? "not-allowed" : "pointer",
            padding: "5px 2px",
          }}
        >
          {e.archived ? "Restaurar" : "Archivar"}
        </button>
      </div>
    </div>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function Chip({ children, tone }: { children: React.ReactNode; tone: "sky" | "soft" | "lime" | "ghost" }) {
  const palette = {
    sky: { bg: "rgba(31,79,190,0.08)", fg: "var(--sky-700)" },
    lime: { bg: "rgba(142,204,48,0.18)", fg: "#3F5A12" },
    soft: { bg: "rgba(15,30,51,0.05)", fg: "var(--navy-500)" },
    ghost: { bg: "transparent", fg: "var(--navy-300)" },
  }[tone];
  return (
    <span
      style={{
        background: palette.bg,
        color: palette.fg,
        borderRadius: 999,
        padding: "2px 7px",
        fontSize: 10.5,
        fontWeight: 600,
        maxWidth: 120,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

const headStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
};

function Head({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return <span style={{ ...headStyle, textAlign: align }}>{children}</span>;
}

function SortHead({
  col,
  label,
  state,
  onSort,
}: {
  col: CatalogSortCol;
  label: string;
  state: CatalogPrefs;
  onSort: (next: { sortCol: CatalogSortCol; sortDir: CatalogSortDir }) => void;
}) {
  const active = state.sortCol === col;
  const dir: CatalogSortDir = active && state.sortDir === "asc" ? "desc" : "asc";
  return (
    <button
      type="button"
      onClick={() => onSort({ sortCol: col, sortDir: dir })}
      title={`Ordenar por ${label.toLowerCase()}`}
      style={{
        ...headStyle,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: "none",
        background: "none",
        padding: 0,
        cursor: "pointer",
        color: active ? "var(--sky-700)" : "var(--navy-300)",
      }}
    >
      {label}
      <span style={{ fontSize: 8, opacity: active ? 1 : 0.35 }}>
        {active ? (state.sortDir === "asc" ? "▲" : "▼") : "▲"}
      </span>
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "8px 10px",
        borderRadius: 10,
        border: "1px solid rgba(15,30,51,0.1)",
        background: "rgba(255,255,255,0.9)",
        fontSize: 12.5,
        color: "var(--navy-700)",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.l}
        </option>
      ))}
    </select>
  );
}

function PagerBtn({
  disabled,
  onClick,
  label,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        border: "1px solid rgba(15,30,51,0.1)",
        background: disabled ? "rgba(15,30,51,0.03)" : "rgba(255,255,255,0.95)",
        color: disabled ? "var(--navy-300)" : "var(--navy-700)",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </button>
  );
}
