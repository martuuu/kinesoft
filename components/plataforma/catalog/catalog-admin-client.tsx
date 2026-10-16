"use client";

/**
 * Plataforma → Catálogo: tabla de curado de prestadoras / prácticas /
 * especialidades (B1.3). Mismo esqueleto que `exercise-admin-client.tsx`: la URL
 * es la fuente de verdad de búsqueda, filtros y página; archivar/restaurar va
 * en la fila; editar y fusionar, en el drawer.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { IconSearch, IconChevL, IconChevR } from "@/components/ui/icons";
import { setCatalogArchived } from "@/lib/catalog-admin";
import {
  CATALOG_ADMIN_PAGE_SIZE,
  type CatalogAdminPage,
  type CatalogAdminRow,
  type CatalogEntityKind,
} from "@/lib/catalog-admin-types";
import { CatalogDrawer } from "@/components/plataforma/catalog/catalog-drawer";
import {
  ENTITY_COPY,
  PAYER_KIND_OPTIONS,
  SOURCE_LABEL,
  SOURCE_OPTIONS,
  formatARDate,
} from "@/components/plataforma/catalog/catalog-copy";
import ctl from "../controls.module.css";

export type CatalogListState = {
  q: string;
  kind: string;
  source: string;
  archived: "active" | "archived" | "all";
};

/** Column track shared by header and rows so they never drift. Especialidades
 *  no tienen tipo ni código: esas dos columnas no se dibujan. */
const colsFor = (entity: CatalogEntityKind) =>
  entity === "specialty"
    ? "minmax(220px,2.4fr) 170px 150px 150px"
    : "minmax(220px,2.4fr) 118px 120px 150px 150px 150px";

export function CatalogAdminClient({
  entity,
  state,
  data,
}: {
  entity: CatalogEntityKind;
  state: CatalogListState;
  data: CatalogAdminPage;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const copy = ENTITY_COPY[entity];
  const [q, setQ] = useState(state.q);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { rows, total, page, pageCount } = data;
  const from = total === 0 ? 0 : (page - 1) * CATALOG_ADMIN_PAGE_SIZE + 1;
  const to = Math.min(from + rows.length - 1, total);

  const apply = (next: Partial<CatalogListState> & { page?: number }) => {
    const s = { ...state, ...next };
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    if (s.kind) p.set("kind", s.kind);
    if (s.source) p.set("source", s.source);
    if (s.archived !== "active") p.set("arch", s.archived);
    // Cualquier cambio de filtro vuelve a la página 1.
    const nextPage = next.page ?? 1;
    if (nextPage > 1) p.set("page", String(nextPage));
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Freshest `apply` for the debounce timer (never fire with stale filters).
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    setQ(state.q);
  }, [state.q]);

  useEffect(() => {
    if (q === state.q) return;
    const t = setTimeout(() => applyRef.current({ q }), 350);
    return () => clearTimeout(t);
  }, [q, state.q]);

  const activeCount =
    (state.q ? 1 : 0) + (state.kind ? 1 : 0) + (state.source ? 1 : 0) + (state.archived !== "active" ? 1 : 0);
  const clearAll = () => {
    setQ("");
    apply({ q: "", kind: "", source: "", archived: "active" });
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* ── Toolbar ───────────────────────────────────────────────────── */}
      <Card style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 260px", minWidth: 200 }}>
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
            className={ctl.field}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            style={{
              width: "100%",
              padding: "8px 12px 8px 32px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.1)",
              background: "rgba(255,255,255,0.95)",
              fontSize: 13,
              color: "var(--navy-900)",
            }}
          />
        </div>
        {entity === "payer" && (
          <Select
            label="Tipo"
            value={state.kind}
            onChange={(v) => apply({ kind: v })}
            options={[{ v: "", l: "Todo tipo" }, ...PAYER_KIND_OPTIONS.map((o) => ({ v: o.value, l: o.label }))]}
          />
        )}
        <Select
          label="Fuente"
          value={state.source}
          onChange={(v) => apply({ source: v })}
          options={[{ v: "", l: "Toda fuente" }, ...SOURCE_OPTIONS.map((o) => ({ v: o.value, l: o.label }))]}
        />
        <Select
          label="Estado"
          value={state.archived}
          onChange={(v) => apply({ archived: v as CatalogListState["archived"] })}
          options={[
            { v: "active", l: "Activas" },
            { v: "archived", l: "Archivadas" },
            { v: "all", l: "Todas" },
          ]}
        />
        {activeCount > 0 && (
          <button type="button" onClick={clearAll} style={linkBtn}>
            Limpiar filtros ({activeCount})
          </button>
        )}
      </Card>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: entity === "specialty" ? 720 : 900 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: colsFor(entity),
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid rgba(15,30,51,0.07)",
                background: "rgba(246,249,253,0.6)",
              }}
            >
              <Head>Nombre</Head>
              {entity !== "specialty" && <Head>{copy.detailHead}</Head>}
              {entity !== "specialty" && <Head>{copy.codeHead}</Head>}
              <Head>Fuente</Head>
              <Head>Uso</Head>
              <Head align="right">Acciones</Head>
            </div>
            {rows.length === 0 ? (
              <div style={{ padding: "44px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
                  {activeCount > 0 ? "Nada coincide con los filtros." : copy.empty}
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4 }}>
                  {activeCount > 0
                    ? "Probá con otra búsqueda o quitá algún filtro."
                    : "El catálogo se carga con scripts/catalog-import.ts (lo corre Martin)."}
                </div>
              </div>
            ) : (
              rows.map((r) => <Row key={r.id} entity={entity} r={r} onEdit={() => setEditingId(r.id)} />)
            )}
          </div>
        </div>
      </Card>

      {/* ── Pager ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {total === 0 ? "Sin resultados" : `Mostrando ${from}–${to} de ${total}`}
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <PagerBtn disabled={page <= 1} onClick={() => apply({ page: page - 1 })} label="Página anterior">
            <IconChevL size={14} />
          </PagerBtn>
          <span className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)", minWidth: 92, textAlign: "center" }}>
            Página {page} / {pageCount}
          </span>
          <PagerBtn disabled={page >= pageCount} onClick={() => apply({ page: page + 1 })} label="Página siguiente">
            <IconChevR size={14} />
          </PagerBtn>
        </div>
      </div>

      {editingId && <CatalogDrawer entity={entity} id={editingId} onClose={() => setEditingId(null)} />}
    </div>
  );
}

/* ── Row ─────────────────────────────────────────────────────────────── */

function Row({ entity, r, onEdit }: { entity: CatalogEntityKind; r: CatalogAdminRow; onEdit: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();

  const toggleArchive = () => {
    start(async () => {
      const res = await setCatalogArchived({ entity, id: r.id, archived: !r.archived });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(r.archived ? "Restaurada" : "Archivada", {
        description: r.archived ? undefined : "Ya no aparece en los buscadores de los consultorios.",
      });
    });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: colsFor(entity),
        gap: 12,
        padding: "11px 16px",
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.045)",
        opacity: r.archived ? 0.62 : pending ? 0.55 : 1,
        transition: "opacity 0.12s ease",
      }}
    >
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
          title={r.name}
        >
          {r.name}
          {r.archived && <Badge>archivada</Badge>}
        </div>
        <div
          style={{ fontSize: 11, color: "var(--navy-400)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={r.aliases.join(" · ")}
        >
          {r.aliases.length ? `También: ${r.aliases.slice(0, 3).join(" · ")}${r.aliases.length > 3 ? ` +${r.aliases.length - 3}` : ""}` : <span className="k-mono">{r.slug}</span>}
        </div>
      </div>
      {entity !== "specialty" && (
        <div style={{ fontSize: 12, color: "var(--navy-700)" }}>{r.detail ?? <Muted />}</div>
      )}
      {entity !== "specialty" && (
        <div className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {r.code ?? <Muted />}
        </div>
      )}
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 12, color: "var(--navy-700)" }}>{SOURCE_LABEL[r.source] ?? r.source}</span>
        <span style={{ fontSize: 10.5, color: r.curatedAt ? "var(--sky-700)" : "var(--navy-300)" }}>
          {r.curatedAt ? `Curada ${formatARDate(r.curatedAt)}` : `Oficial ${formatARDate(r.sourceDate)}`}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: "var(--navy-500)", display: "grid", gap: 1 }}>
        {r.usage.map((u) => (
          <span key={u.label}>
            <strong style={{ color: u.count ? "var(--navy-900)" : "var(--navy-300)" }}>{u.count}</strong> {u.label}
          </span>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
        <button type="button" onClick={onEdit} style={editBtn}>
          Editar
        </button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={pending}
          style={{ ...linkBtn, color: "var(--navy-400)", cursor: pending ? "not-allowed" : "pointer" }}
        >
          {r.archived ? "Restaurar" : "Archivar"}
        </button>
      </div>
    </div>
  );
}

/* ── Small pieces ────────────────────────────────────────────────────── */

function Muted() {
  return <span style={{ color: "var(--navy-300)" }}>—</span>;
}

export function Badge({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </span>
  );
}

const headStyle: React.CSSProperties = {
  // PF1.2 (C-PF5.6): rótulo de tabla `nowrap` y navy-500 (navy-300 no llegaba a AA). 11 px y no `--fs-xs`: con
  // las columnas fijas, «PRESCRIPCIÓN» en mayúsculas a 12 px pasaba los 96 px de su columna.
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-500)",
  whiteSpace: "nowrap",
};

function Head({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return <span style={{ ...headStyle, textAlign: align }}>{children}</span>;
}

const linkBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--sky-700)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  padding: "6px 4px",
};

const editBtn: React.CSSProperties = {
  border: "1px solid rgba(15,30,51,0.12)",
  background: "rgba(255,255,255,0.9)",
  borderRadius: 8,
  padding: "5px 10px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <select
      className={ctl.field}
      aria-label={label}
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
