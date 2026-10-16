/**
 * [EV0-P3] Lista de consultorios de /plataforma (plan §15.4). Sin "use client":
 * los filtros son un `<form method="get">` que escribe los searchParams y la
 * página (server component) vuelve a pedir `listPlatformTenants`. Así la URL es
 * la fuente de verdad (se puede compartir un filtro) y no hace falta JS para
 * filtrar ni paginar.
 *
 * La tabla tiene scroll horizontal propio (`overflowX: auto` + `minWidth`) para
 * que en mobile no scrollee la página entera. "Miembros" y "Creado" viven solo
 * en el detalle: con 10 columnas la grilla (~1370px) pasaba el `minWidth` y se
 * cortaba (revisión EV0).
 *
 * BO3-B: filtro y columna del estado del CONSULTORIO (`Tenant.status`: activo,
 * suspendido, de baja) con el modo de acceso que aplican hoy los cortes
 * (`effectiveAccessMode`), y los usuarios del plan por tipo (PL-1d). La columna
 * de la suscripción pasa a llamarse «Suscripción» para no chocar con «Estado».
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import {
  SUBSCRIPTION_STATUS_VALUES,
  SAAS_PLAN_VALUES,
  TENANT_STATUS_VALUES,
  TENANT_VERTICAL_VALUES,
} from "@/lib/platform-tenants-schemas";
import type { PlatformTenantPage, PlatformTenantRow } from "@/lib/platform-tenants-types";
import {
  ACCESS_MODE_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
  TENANT_STATUS_LABEL,
  TENANT_STATUS_TONE,
  formatDayKeyAR,
  seatLimitLabel,
  tenantHref,
} from "@/components/plataforma/tenants/labels";
import { AutoSubmitSelect } from "@/components/plataforma/tenants/auto-submit-select";
import { FiltersDrawer } from "@/components/plataforma/filters-drawer";
import { activeFilterCount } from "@/components/plataforma/filters-logic";
import styles from "./tenant-list.module.css";
import table from "@/components/plataforma/responsive-table.module.css";

/** Filtros normalizados ("" = sin filtro), como los parsea `PlatformTenantListQuery`. */
export type TenantListQuery = {
  q: string;
  vertical: string;
  plan: string;
  status: string;
  /** BO3-B: estado del consultorio. Opcional para no romper a quien arma la query sin él. */
  tenantStatus?: string;
  page: number;
};

function hasFilters(q: TenantListQuery): boolean {
  return !!(q.q || q.vertical || q.plan || q.status || q.tenantStatus);
}

const LIST_PATH = "/plataforma/consultorios";

/** URL de la lista con los filtros activos; sin keys vacías ni `page=1`. */
export function buildListHref(query: TenantListQuery, page: number): string {
  const sp = new URLSearchParams();
  if (query.q) sp.set("q", query.q);
  if (query.vertical) sp.set("vertical", query.vertical);
  if (query.plan) sp.set("plan", query.plan);
  if (query.status) sp.set("status", query.status);
  if (query.tenantStatus) sp.set("tenantStatus", query.tenantStatus);
  if (page > 1) sp.set("page", String(page));
  const s = sp.toString();
  return s ? `${LIST_PATH}?${s}` : LIST_PATH;
}

// Suma de mínimos (1180) + 8 gaps de 12 + padding 32 = 1308 → `minWidth` 1310.
const COLS = "minmax(200px,1.6fr) 120px 150px 110px 150px 90px 100px minmax(180px,1.2fr) 80px";
const MIN_WIDTH = 1310;
// MB-1f: columnas y ancho mínimo como variables (`responsive-table.module.css`): bajo 768 la fila pasa a card.
const TABLE_VARS = { "--pt-cols": COLS, "--pt-min-w": `${MIN_WIDTH}px` } as CSSProperties;

/**
 * BO-Z C6: la tabla scrollea en horizontal (1310 px) y en un celular, al ir a «Suscripción» o «Titular», se perdía de
 * qué consultorio era la fila. La primera columna queda fija a la izquierda (sticky dentro del `overflowX`) con un
 * filete a la derecha. PF1.2 (P5): su fondo es el de su fila. MB-1f: bajo 768 la fila es una card (sin scroll de
 * costado) y cada celda lleva su rótulo en `data-label`.
 */
function Head({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <div className={styles.head} style={align ? { textAlign: align } : undefined}>
      {children}
    </div>
  );
}

function Filters({ query }: { query: TenantListQuery }) {
  const active = hasFilters(query);
  const count = activeFilterCount([query.q, query.vertical, query.plan, query.status, query.tenantStatus]);
  return (
    <FiltersDrawer
      count={count}
      title="Buscar y filtrar"
      aside={
        active ? (
          <Link href={LIST_PATH} className={table.chip} style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--sky-700)" }}>
            Limpiar filtros
          </Link>
        ) : null
      }
    >
      <FiltersForm query={query} active={active} />
    </FiltersDrawer>
  );
}

function FiltersForm({ query, active }: { query: TenantListQuery; active: boolean }) {
  return (
    <form method="get" action={LIST_PATH} role="search" className={styles.filters}>
      <div className={styles.searchRow}>
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="Buscar por nombre o slug"
          aria-label="Buscar por nombre o slug"
          maxLength={120}
          className={`k-input ${styles.control} ${styles.search}`}
        />
        <div className={styles.searchActions}>
          <Button type="submit" variant="primary" size="md">
            Buscar
          </Button>
          {active && (
            <Link href={LIST_PATH} style={{ fontSize: "var(--fs-sm)", fontWeight: 600, color: "var(--sky-700)" }}>
              Limpiar filtros
            </Link>
          )}
        </div>
      </div>
      <div className={styles.selects}>
        <AutoSubmitSelect name="vertical" defaultValue={query.vertical} aria-label="Tipo" className={`k-input ${styles.control}`}>
          <option value="">Todos los tipos</option>
          {TENANT_VERTICAL_VALUES.map((v) => (
            <option key={v} value={v}>
              {VERTICAL_LABEL[v]}
            </option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="plan" defaultValue={query.plan} aria-label="Plan" className={`k-input ${styles.control}`}>
          <option value="">Todos los planes</option>
          {SAAS_PLAN_VALUES.map((v) => (
            <option key={v} value={v}>
              {SAAS_PLAN_LABEL[v]}
            </option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect
          name="tenantStatus"
          defaultValue={query.tenantStatus ?? ""}
          aria-label="Estado del consultorio"
          className={`k-input ${styles.control}`}
        >
          <option value="">Todos los estados</option>
          {TENANT_STATUS_VALUES.map((v) => (
            <option key={v} value={v}>
              {TENANT_STATUS_LABEL[v]}
            </option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect
          name="status"
          defaultValue={query.status}
          aria-label="Estado de la suscripción"
          className={`k-input ${styles.control}`}
        >
          <option value="">Todas las suscripciones</option>
          {SUBSCRIPTION_STATUS_VALUES.map((v) => (
            <option key={v} value={v}>
              {SUBSCRIPTION_STATUS_LABEL[v]}
            </option>
          ))}
        </AutoSubmitSelect>
      </div>
    </form>
  );
}

function YesNo({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? "var(--lime-700)" : "var(--navy-400)" }}>
      {on ? yes : no}
    </span>
  );
}

function Row({ r }: { r: PlatformTenantRow }) {
  return (
    <div
      className={table.row}
      style={{
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
        alignItems: "center",
        fontSize: 13,
        color: "var(--navy-700)",
      }}
    >
      <div className={table.sticky} style={{ minWidth: 0, alignSelf: "stretch", display: "grid", alignContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Link href={tenantHref(r.id)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
            {r.name}
          </Link>
          {r.isPlatformHome && <Tag tone="lime">Plataforma</Tag>}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-400)", fontFamily: "var(--font-mono)" }}>{r.slug}</div>
      </div>
      <div data-label="Estado" style={{ display: "grid", gap: 3, justifyItems: "start" }}>
        <Tag tone={TENANT_STATUS_TONE[r.status]}>{TENANT_STATUS_LABEL[r.status]}</Tag>
        <span style={{ fontSize: 11.5, color: "var(--navy-400)" }}>
          Acceso: {ACCESS_MODE_LABEL[r.effectiveAccessMode].toLowerCase()}
        </span>
      </div>
      <div data-label="Tipo">{VERTICAL_LABEL[r.vertical]}</div>
      <div data-label="Plan y cupo">
        <div style={{ fontWeight: 600 }}>{SAAS_PLAN_LABEL[r.saasPlan]}</div>
        <div style={{ fontSize: 12, color: "var(--navy-400)" }}>{seatLimitLabel(r)}</div>
      </div>
      <div data-label="Suscripción">
        <div>{SUBSCRIPTION_STATUS_LABEL[r.subscriptionStatus]}</div>
        {r.trialEndsOn && (
          <div style={{ fontSize: 12, color: "var(--navy-400)" }}>Prueba hasta {formatDayKeyAR(r.trialEndsOn)}</div>
        )}
      </div>
      <div data-label="Turnos online">
        <YesNo on={r.publicBookingEnabled} yes="Activo" no="Apagado" />
      </div>
      <div data-label="Onboarding">
        <YesNo on={r.onboardingCompleted} yes="Completo" no="Pendiente" />
      </div>
      <div data-label="Titular" className={table.wide} style={{ minWidth: 0, fontSize: 12.5, overflowWrap: "anywhere" }}>
        {/* VX0-b (decisión 19): nombre del titular; el email abajo, rotulado (nunca como nombre). */}
        {r.ownerNames.length > 0 ? (
          <>
            <div>{r.ownerNames.join(", ")}</div>
            <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>Email: {r.ownerEmails.join(", ")}</div>
          </>
        ) : (
          <span style={{ color: "var(--navy-400)" }}>—</span>
        )}
      </div>
      <div data-label="Pacientes" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.patientCount}</div>
    </div>
  );
}

function Pagination({ page, query }: { page: PlatformTenantPage; query: TenantListQuery }) {
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  if (pages <= 1) return null;
  const linkStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--sky-700)" };
  return (
    <nav
      aria-label="Paginación"
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}
    >
      <span style={{ fontSize: 13, color: "var(--navy-500)" }}>
        Página {page.page} de {pages}
      </span>
      <span style={{ display: "flex", gap: 16 }}>
        {page.page > 1 && (
          <Link href={buildListHref(query, page.page - 1)} className={table.chip} style={linkStyle}>
            ← Anterior
          </Link>
        )}
        {page.page < pages && (
          <Link href={buildListHref(query, page.page + 1)} className={table.chip} style={linkStyle}>
            Siguiente →
          </Link>
        )}
      </span>
    </nav>
  );
}

export function TenantList({ page, query }: { page: PlatformTenantPage; query: TenantListQuery }) {
  const filtered = hasFilters(query);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ padding: 16 }}>
        <Filters query={query} />
      </Card>

      <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
        {page.total === 1 ? "1 consultorio" : `${page.total} consultorios`}
        {filtered ? " con estos filtros" : ""}
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className={table.scroller} style={TABLE_VARS}>
          <div className={table.inner}>
            <div className={`${table.head} ${styles.headRow}`} style={{ gap: 12, padding: "10px 16px" }}>
              <div className={table.sticky}>
                <Head>Consultorio</Head>
              </div>
              <Head>Estado</Head>
              <Head>Tipo</Head>
              <Head>Plan y cupo</Head>
              <Head>Suscripción</Head>
              <Head>Turnos online</Head>
              <Head>Onboarding</Head>
              <Head>Titular</Head>
              <Head align="right">Pacientes</Head>
            </div>
            {page.rows.length === 0 ? (
              <div style={{ padding: "44px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
                  {filtered ? "Nada coincide con los filtros." : "Todavía no hay consultorios."}
                </div>
                {filtered && (
                  <div style={{ fontSize: 12, color: "var(--navy-400)", marginTop: 4 }}>
                    Probá con otra búsqueda o quitá algún filtro.
                  </div>
                )}
              </div>
            ) : (
              page.rows.map((r) => <Row key={r.id} r={r} />)
            )}
          </div>
        </div>
      </Card>

      <Pagination page={page} query={query} />
    </div>
  );
}
