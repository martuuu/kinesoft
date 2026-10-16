/**
 * BO3-E · visor del registro de Plataforma (`/plataforma/auditoria`). Sin "use client": los filtros son un
 * `<form method="get">` (la URL es la fuente de verdad, se puede compartir un filtro, sin JS para filtrar) y «Cargar
 * más» es un link con el cursor de la última fila. No acumula filas en el cliente: la página siguiente reemplaza a la
 * actual y «Volver a los más recientes» saca el cursor. Con cursor (y no offset) no se repiten ni se saltean filas
 * aunque entren eventos nuevos mientras se mira.
 *
 * Del payload se muestran CLAVES (qué se tocó) y solo los valores de la allowlist de `sanitizeAuditPayload`
 * (enums, booleanos, contadores): el resto sale como `clave` sin valor. El DTO ya viene así de
 * `listPlatformAudit`; esta vista no tiene forma de ver otra cosa.
 *
 * La tabla tiene scroll horizontal propio (`overflowX: auto` + `minWidth`): en 360 px no scrollea la página.
 * MB-1f (C-MB3): bajo 768 cada fila es una card con rótulos (`data-label`) y los filtros van en el Drawer
 * «Filtros (n)»; los chips de consultorio/usuario quedan a la vista.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { formatDateAR } from "@/lib/format";
import { FiltersDrawer } from "@/components/plataforma/filters-drawer";
import { activeFilterCount } from "@/components/plataforma/filters-logic";
import table from "@/components/plataforma/responsive-table.module.css";
import { auditHref, type PlatformAuditFilters, type PlatformAuditPage, type PlatformAuditRow } from "@/lib/platform-audit-logic";

/** Grupos de acciones (prefijos de `platform.*`) para el filtro. El visor filtra por prefijo. */
export const AUDIT_ACTION_GROUPS: Array<{ value: string; label: string }> = [
  { value: "platform.tenant", label: "Consultorios" },
  // Las acciones de equipo se auditan como `platform.<acción del núcleo>` (`lib/team-internal.ts`).
  { value: "platform.membership", label: "Miembros de equipos" },
  { value: "platform.invitation", label: "Invitaciones" },
  { value: "platform.user", label: "Usuarios" },
  { value: "platform.superadmin", label: "Superadmins" },
  { value: "platform.repair", label: "Reparaciones" },
  { value: "platform.support", label: "Soporte" },
  { value: "platform.catalog", label: "Catálogo global" },
];

const COLS = "150px minmax(200px,1.3fr) minmax(170px,1fr) minmax(150px,1fr) minmax(220px,1.6fr)";
const TABLE_VARS = { "--pt-cols": COLS, "--pt-min-w": "960px" } as CSSProperties;

const inputStyle: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
  minWidth: 0,
  width: "100%",
};

const linkStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--sky-700)" };

function Head({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--navy-500)", whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

function hasFilters(f: PlatformAuditFilters): boolean {
  return Boolean(f.action || f.tenantId || f.actorEmail || f.targetUserId || f.from || f.to);
}

function Filters({ filters }: { filters: PlatformAuditFilters }) {
  const groupValues = AUDIT_ACTION_GROUPS.map((g) => g.value);
  // Una acción exacta que vino de un link (no es uno de los grupos) se conserva como opción propia.
  const custom = filters.action && !groupValues.includes(filters.action) ? filters.action : null;
  return (
    <form
      method="get"
      action="/plataforma/auditoria"
      role="search"
      aria-label="Filtros de auditoría"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
        gap: 8,
        alignItems: "end",
      }}
    >
      {/* Los filtros por consultorio y por usuario llegan desde los links de las filas; se conservan al refiltrar. */}
      {filters.tenantId && <input type="hidden" name="tenantId" value={filters.tenantId} />}
      {filters.targetUserId && <input type="hidden" name="targetUserId" value={filters.targetUserId} />}
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--navy-500)" }}>
        Acción
        <select name="action" defaultValue={filters.action ?? ""} style={inputStyle}>
          <option value="">Todas</option>
          {AUDIT_ACTION_GROUPS.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
          {custom && <option value={custom}>{custom}</option>}
        </select>
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--navy-500)" }}>
        Quién lo hizo
        <input
          type="search"
          name="actorEmail"
          defaultValue={filters.actorEmail ?? ""}
          placeholder="Email del superadmin"
          maxLength={254}
          style={inputStyle}
        />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--navy-500)" }}>
        Desde
        <input type="date" name="from" defaultValue={filters.from ?? ""} style={inputStyle} />
      </label>
      <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--navy-500)" }}>
        Hasta
        <input type="date" name="to" defaultValue={filters.to ?? ""} style={inputStyle} />
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button type="submit" variant="primary">
          Filtrar
        </Button>
        {hasFilters(filters) && (
          <Link href="/plataforma/auditoria" style={linkStyle}>
            Limpiar
          </Link>
        )}
      </div>
    </form>
  );
}

/** Chips de los filtros que no tienen campo (consultorio, usuario), con su «Quitar». */
function ScopeChips({ filters, tenantName }: { filters: PlatformAuditFilters; tenantName: string | null }) {
  if (!filters.tenantId && !filters.targetUserId) return null;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
      {filters.tenantId && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Tag tone="sky">Consultorio: {tenantName ?? filters.tenantId}</Tag>
          <Link href={auditHref({ ...filters, tenantId: undefined })} className={table.chip} style={linkStyle}>
            Quitar
          </Link>
        </span>
      )}
      {filters.targetUserId && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <Tag tone="sky">Usuario afectado: {filters.targetUserId}</Tag>
          <Link href={auditHref({ ...filters, targetUserId: undefined })} className={table.chip} style={linkStyle}>
            Quitar
          </Link>
        </span>
      )}
    </div>
  );
}

function PayloadKeys({ row }: { row: PlatformAuditRow }) {
  if (row.payload.length === 0) return <span style={{ color: "var(--navy-300)" }}>—</span>;
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} data-testid="audit-payload">
      {row.payload.map((p) => (
        <span
          key={p.key}
          style={{
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            padding: "2px 6px",
            borderRadius: 6,
            background: "rgba(15,30,51,0.05)",
            color: "var(--navy-700)",
          }}
        >
          {p.value === null ? p.key : `${p.key}: ${p.value}`}
        </span>
      ))}
    </div>
  );
}

function Row({ r, filters }: { r: PlatformAuditRow; filters: PlatformAuditFilters }) {
  return (
    <div
      role="row"
      className={table.row}
      style={{
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid rgba(15,30,51,0.05)",
        alignItems: "start",
        fontSize: 13,
        color: "var(--navy-700)",
      }}
    >
      <div style={{ fontVariantNumeric: "tabular-nums" }}>
        <div style={{ fontWeight: 600 }}>{formatDateAR(r.createdAt, "short")}</div>
        <div style={{ fontSize: 12, color: "var(--navy-300)" }}>{formatDateAR(r.createdAt, "time")}</div>
      </div>
      <div data-label="Acción" style={{ minWidth: 0 }}>
        <Link
          href={auditHref({ ...filters, action: r.action, cursor: undefined })}
          title="Ver solo esta acción"
          style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--navy-900)", overflowWrap: "anywhere" }}
        >
          {r.action}
        </Link>
      </div>
      <div data-label="Quién" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {r.actorEmail ?? <span style={{ color: "var(--navy-300)" }}>Script o cron</span>}
      </div>
      <div data-label="Consultorio / usuario" className={table.wide} style={{ minWidth: 0, display: "grid", gap: 2 }}>
        {r.tenant ? (
          <span>
            <Link
              href={`/plataforma/consultorios/${encodeURIComponent(r.tenant.id)}`}
              style={{ fontWeight: 600, color: "var(--navy-900)" }}
            >
              {r.tenant.name}
            </Link>{" "}
            <Link
              href={auditHref({ ...filters, tenantId: r.tenant.id, cursor: undefined })}
              style={{ fontSize: 12, color: "var(--sky-700)" }}
            >
              filtrar
            </Link>
          </span>
        ) : (
          <span style={{ color: "var(--navy-300)" }}>Global</span>
        )}
        {r.targetUserId && (
          <span style={{ fontSize: 12 }}>
            <Link href={`/plataforma/usuarios/${encodeURIComponent(r.targetUserId)}`} style={{ color: "var(--sky-700)" }}>
              Ver usuario
            </Link>{" "}
            ·{" "}
            <Link
              href={auditHref({ ...filters, targetUserId: r.targetUserId, cursor: undefined })}
              style={{ color: "var(--sky-700)" }}
            >
              filtrar
            </Link>
          </span>
        )}
      </div>
      <div data-label="Qué cambió" className={table.wide}>
        <PayloadKeys row={r} />
      </div>
    </div>
  );
}

export function AuditView({ page, filters }: { page: PlatformAuditPage; filters: PlatformAuditFilters }) {
  const tenantName = filters.tenantId ? page.rows.find((r) => r.tenant?.id === filters.tenantId)?.tenant?.name ?? null : null;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card className={table.tapScope} style={{ padding: 16, display: "grid", gap: 10 }}>
        <FiltersDrawer
          count={activeFilterCount([filters.action, filters.actorEmail, filters.from, filters.to])}
          aside={
            hasFilters(filters) ? (
              <Link href="/plataforma/auditoria" className={table.chip} style={linkStyle}>
                Limpiar
              </Link>
            ) : null
          }
        >
          <Filters filters={filters} />
        </FiltersDrawer>
        <ScopeChips filters={filters} tenantName={tenantName} />
      </Card>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className={table.scroller} style={TABLE_VARS}>
          <div role="table" aria-label="Registro de Plataforma" className={table.inner}>
            <div
              role="row"
              className={table.head}
              style={{
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid rgba(15,30,51,0.08)",
              }}
            >
              <Head>Cuándo</Head>
              <Head>Acción</Head>
              <Head>Quién</Head>
              <Head>Consultorio / usuario</Head>
              <Head>Qué cambió</Head>
            </div>
            {page.rows.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13.5, color: "var(--navy-500)" }}>
                {hasFilters(filters) ? "No hay eventos con estos filtros." : "Todavía no hay eventos registrados."}
              </div>
            ) : (
              page.rows.map((r) => <Row key={r.id} r={r} filters={filters} />)
            )}
          </div>
        </div>
      </Card>
      <nav
        aria-label="Más eventos"
        style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}
      >
        <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
          Se muestran los valores solo de plan, estado, rol, tipo y contadores; del resto, qué campo se tocó.
        </span>
        <span style={{ display: "flex", gap: 16 }}>
          {filters.cursor && (
            <Link href={auditHref({ ...filters, cursor: undefined })} className={table.chip} style={linkStyle}>
              Volver a los más recientes
            </Link>
          )}
          {page.nextCursor && (
            <Link href={auditHref(filters, page.nextCursor)} className={table.chip} style={linkStyle}>
              Cargar más antiguos →
            </Link>
          )}
        </span>
      </nav>
    </div>
  );
}
