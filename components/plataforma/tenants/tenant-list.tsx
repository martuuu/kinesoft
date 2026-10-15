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
 * (`effectiveAccessMode`), y el cupo de profesionales bajo el plan. La columna
 * de la suscripción pasa a llamarse «Suscripción» para no chocar con «Estado».
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import {
  SUBSCRIPTION_STATUS_VALUES,
  TENANT_PLAN_VALUES,
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

const selectStyle: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
  minWidth: 0,
};

function Head({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--navy-300)",
        textAlign: align,
      }}
    >
      {children}
    </div>
  );
}

function Filters({ query }: { query: TenantListQuery }) {
  const active = hasFilters(query);
  return (
    <form
      method="get"
      action={LIST_PATH}
      role="search"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
        gap: 8,
        alignItems: "center",
      }}
    >
      <input
        type="search"
        name="q"
        defaultValue={query.q}
        placeholder="Buscar por nombre o slug"
        aria-label="Buscar por nombre o slug"
        maxLength={120}
        style={selectStyle}
      />
      <select name="vertical" defaultValue={query.vertical} aria-label="Tipo" style={selectStyle}>
        <option value="">Todos los tipos</option>
        {TENANT_VERTICAL_VALUES.map((v) => (
          <option key={v} value={v}>
            {VERTICAL_LABEL[v]}
          </option>
        ))}
      </select>
      <select name="plan" defaultValue={query.plan} aria-label="Plan" style={selectStyle}>
        <option value="">Todos los planes</option>
        {TENANT_PLAN_VALUES.map((v) => (
          <option key={v} value={v}>
            {PLAN_LABEL[v]}
          </option>
        ))}
      </select>
      <select
        name="tenantStatus"
        defaultValue={query.tenantStatus ?? ""}
        aria-label="Estado del consultorio"
        style={selectStyle}
      >
        <option value="">Activos, suspendidos y de baja</option>
        {TENANT_STATUS_VALUES.map((v) => (
          <option key={v} value={v}>
            {TENANT_STATUS_LABEL[v]}
          </option>
        ))}
      </select>
      <select name="status" defaultValue={query.status} aria-label="Estado de la suscripción" style={selectStyle}>
        <option value="">Todas las suscripciones</option>
        {SUBSCRIPTION_STATUS_VALUES.map((v) => (
          <option key={v} value={v}>
            {SUBSCRIPTION_STATUS_LABEL[v]}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button type="submit" variant="primary">
          Filtrar
        </Button>
        {active && (
          <Link href={LIST_PATH} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
            Limpiar
          </Link>
        )}
      </div>
    </form>
  );
}

function YesNo({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <span style={{ fontSize: 12.5, fontWeight: 600, color: on ? "var(--lime-700)" : "var(--navy-300)" }}>
      {on ? yes : no}
    </span>
  );
}

function Row({ r }: { r: PlatformTenantRow }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: COLS,
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
        alignItems: "center",
        fontSize: 13,
        color: "var(--navy-700)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Link href={tenantHref(r.id)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
            {r.name}
          </Link>
          {r.isPlatformHome && <Tag tone="lime">Plataforma</Tag>}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontFamily: "var(--font-mono)" }}>{r.slug}</div>
      </div>
      <div style={{ display: "grid", gap: 3, justifyItems: "start" }}>
        <Tag tone={TENANT_STATUS_TONE[r.status]}>{TENANT_STATUS_LABEL[r.status]}</Tag>
        <span style={{ fontSize: 11.5, color: "var(--navy-300)" }}>
          Acceso: {ACCESS_MODE_LABEL[r.effectiveAccessMode].toLowerCase()}
        </span>
      </div>
      <div>{VERTICAL_LABEL[r.vertical]}</div>
      <div>
        <div style={{ fontWeight: 600 }}>{PLAN_LABEL[r.plan]}</div>
        <div style={{ fontSize: 12, color: "var(--navy-300)" }}>{seatLimitLabel(r)}</div>
      </div>
      <div>
        <div>{SUBSCRIPTION_STATUS_LABEL[r.subscriptionStatus]}</div>
        {r.trialEndsOn && (
          <div style={{ fontSize: 12, color: "var(--navy-300)" }}>Trial hasta {formatDayKeyAR(r.trialEndsOn)}</div>
        )}
      </div>
      <div>
        <YesNo on={r.publicBookingEnabled} yes="Activo" no="Apagado" />
      </div>
      <div>
        <YesNo on={r.onboardingCompleted} yes="Completo" no="Pendiente" />
      </div>
      <div style={{ minWidth: 0, fontSize: 12.5, overflowWrap: "anywhere" }}>
        {r.ownerEmails.length > 0 ? r.ownerEmails.join(", ") : <span style={{ color: "var(--navy-300)" }}>—</span>}
      </div>
      <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.patientCount}</div>
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
          <Link href={buildListHref(query, page.page - 1)} style={linkStyle}>
            ← Anterior
          </Link>
        )}
        {page.page < pages && (
          <Link href={buildListHref(query, page.page + 1)} style={linkStyle}>
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
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: MIN_WIDTH }}>
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
              <Head>Consultorio</Head>
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
                  <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4 }}>
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
