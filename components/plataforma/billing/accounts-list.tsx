/**
 * Lista de cuentas de /plataforma → Facturación (PL-3c). Sin "use client": la vista rápida son links y plan, estado
 * y búsqueda un `<form method="get">` (la URL es la fuente de verdad, como Consultorios y Mensajes; no hace falta JS
 * para filtrar ni paginar).
 *
 * La tabla scrollea sola en horizontal (`overflowX: auto` + `minWidth`) y la primera columna queda fija: a 390 px no
 * scrollea la página entera. El estado contable va en texto (Tag + leyenda), nunca solo en color.
 *
 * MB-1f (C-MB3): bajo 768 cada fila es una card con rótulos (`data-label`) y plan, estado y búsqueda van en el Drawer
 * «Filtros (n)»; la vista rápida (chips) queda a la vista, a 44 px.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { formatDateAR } from "@/lib/format";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import type { PlatformAccountRow } from "@/lib/platform-billing-types";
import { SUBSCRIPTION_STATUS_LABEL, formatDayKeyAR, tenantTabHref } from "@/components/plataforma/tenants/labels";
import {
  BILLING_PATH,
  VIEW_FILTERS,
  accountStateOf,
  accountsHref,
  balanceText,
  hasAccountFilters,
  priceText,
  viewParam,
  type AccountsQuery,
} from "@/components/plataforma/billing/billing-logic";
import { FiltersDrawer } from "@/components/plataforma/filters-drawer";
import { activeFilterCount } from "@/components/plataforma/filters-logic";
import table from "@/components/plataforma/responsive-table.module.css";

const COLS = "minmax(200px,1.4fr) 110px 150px 130px 120px 130px minmax(150px,1fr)";
const MIN_WIDTH = 1060;
// Mismo sticky que la lista de Consultorios (`table.sticky`; PF1.2 P5: el fondo de la celda fija es el de su fila).
// MB-1f: columnas y ancho mínimo como variables para que bajo 768 la fila pase a card.
const TABLE_VARS = { "--pt-cols": COLS, "--pt-min-w": `${MIN_WIDTH}px` } as CSSProperties;

function Head({ children, align }: { children: ReactNode; align?: "right" }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--navy-500)", whiteSpace: "nowrap",
        textAlign: align,
      }}
    >
      {children}
    </div>
  );
}

const STATUS_OPTIONS = (["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"] as const).map((s) => ({ value: s, label: SUBSCRIPTION_STATUS_LABEL[s] }));

const selectStyle: CSSProperties = {
  padding: "9px 12px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.96)",
  fontSize: 13.5,
  color: "var(--navy-900)",
  minWidth: 0,
};

function Filters({ query }: { query: AccountsQuery }) {
  const base = { view: query.view, plan: query.plan, status: query.status, q: query.q };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div role="group" aria-label="Vista" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {VIEW_FILTERS.map((o) => {
          const active = o.value === query.view;
          return (
            <Link
              key={o.value}
              href={accountsHref({ ...base, view: o.value })}
              aria-current={active ? "true" : undefined}
              className={table.chip}
              style={{
                textDecoration: "none",
                padding: "6px 12px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                color: active ? "#fff" : "var(--navy-700)",
                background: active ? "var(--sky-700)" : "rgba(15,30,51,0.05)",
              }}
            >
              {o.label}
            </Link>
          );
        })}
      </div>
      <FiltersDrawer
        count={activeFilterCount([query.q, query.plan, query.status])}
        title="Buscar y filtrar"
        aside={
          hasAccountFilters(query) ? (
            <Link href={BILLING_PATH} className={table.chip} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
              Limpiar
            </Link>
          ) : null
        }
      >
      <form method="get" action={BILLING_PATH} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {viewParam(query.view) && <input type="hidden" name="ver" value={viewParam(query.view)!} />}
        <input
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="Buscar por nombre o slug"
          aria-label="Buscar consultorio"
          style={{ ...selectStyle, flex: "1 1 200px" }}
        />
        <select name="plan" defaultValue={query.plan} aria-label="Plan" style={selectStyle}>
          <option value="">Todos los planes</option>
          {SAAS_PLANS.map((p) => (
            <option key={p} value={p}>
              {SAAS_PLAN_LABEL[p]}
            </option>
          ))}
        </select>
        <select name="estado" defaultValue={query.status} aria-label="Estado de la suscripción" style={selectStyle}>
          <option value="">Todos los estados</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Button type="submit" variant="ghost">
          Filtrar
        </Button>
        {hasAccountFilters(query) && (
          <Link href={BILLING_PATH} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
            Limpiar
          </Link>
        )}
      </form>
      </FiltersDrawer>
    </div>
  );
}

function Row({ r }: { r: PlatformAccountRow }) {
  const state = accountStateOf(r);
  const price = priceText(r);
  return (
    <div
      data-account={r.tenantId}
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
        <Link
          href={tenantTabHref(r.tenantId, "facturacion")}
          style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none", overflowWrap: "anywhere" }}
        >
          {r.name}
        </Link>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontFamily: "var(--font-mono)" }}>{r.slug}</div>
      </div>
      <div data-label="Plan" style={{ fontWeight: 600 }}>{SAAS_PLAN_LABEL[r.saasPlan]}</div>
      <div data-label="Precio">
        <div style={{ fontVariantNumeric: "tabular-nums" }}>{price.text}</div>
        {price.custom && <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>A medida</div>}
      </div>
      <div data-label="Saldo" style={{ fontVariantNumeric: "tabular-nums", fontWeight: r.balanceCents > 0 ? 700 : 500, color: r.balanceCents > 0 ? "var(--navy-900)" : undefined }}>
        {balanceText(r.balanceCents)}
        {r.openCharges > 0 && (
          <div style={{ fontSize: 11.5, fontWeight: 500, color: "var(--navy-500)" }}>
            {r.openCharges === 1 ? "1 cargo pendiente" : `${r.openCharges} cargos pendientes`}
          </div>
        )}
      </div>
      <div data-label="Próximo cargo">{r.nextChargeOn ? formatDayKeyAR(r.nextChargeOn) : <span style={{ color: "var(--navy-300)" }}>—</span>}</div>
      <div data-label="Último pago">{r.lastPaymentAt ? formatDateAR(r.lastPaymentAt, "short") : <span style={{ color: "var(--navy-300)" }}>Sin pagos</span>}</div>
      <div data-label="Estado" className={table.wide} style={{ display: "grid", gap: 4, justifyItems: "start" }}>
        {/* PL-Z (FX5): «N cargos vencidos» es lo único urgente de la lista y con `Tag` sky se perdía entre los demás.
            Ámbar + negrita + `role="status"`; no hay token `--warn-*` en globals.css, va el literal. */}
        {state.urgent ? (
          <span role="status" className="k-tag" style={{ background: "var(--warn-bg)", color: "var(--warn-fg)", fontWeight: 700 }}>
            {state.label}
          </span>
        ) : (
          <Tag tone={state.tone}>{state.label}</Tag>
        )}
        <span style={{ fontSize: 11.5, color: "var(--navy-500)" }}>Suscripción: {SUBSCRIPTION_STATUS_LABEL[r.subscriptionStatus].toLowerCase()}</span>
        {r.pendingReviews > 0 && (
          <span data-pending-review style={{ fontSize: 11.5, fontWeight: 700, color: "var(--sky-700)" }}>
            {r.pendingReviews === 1 ? "1 comprobante a revisar" : `${r.pendingReviews} comprobantes a revisar`}
          </span>
        )}
      </div>
    </div>
  );
}

export function AccountsList({
  rows,
  nextCursor,
  query,
}: {
  rows: readonly PlatformAccountRow[];
  nextCursor: string | null;
  query: AccountsQuery;
}) {
  const filtered = hasAccountFilters(query);
  const base = { view: query.view, plan: query.plan, status: query.status, q: query.q };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card className={table.tapScope} style={{ padding: 16 }}>
        <Filters query={query} />
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className={table.scroller} style={TABLE_VARS}>
          <div className={table.inner}>
            <div
              className={table.head}
              style={{
                gap: 12,
                padding: "10px 16px",
                borderBottom: "1px solid rgba(15,30,51,0.07)",
                background: "var(--bg-panel)",
              }}
            >
              <div className={table.sticky}>
                <Head>Consultorio</Head>
              </div>
              <Head>Plan</Head>
              <Head>Precio</Head>
              <Head>Saldo</Head>
              <Head>Próximo cargo</Head>
              <Head>Último pago</Head>
              <Head>Estado</Head>
            </div>
            {rows.length === 0 ? (
              <div style={{ padding: "44px 20px", textAlign: "center" }}>
                <div style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
                  {query.cursor ? "No hay más cuentas." : filtered ? "Ninguna cuenta coincide con los filtros." : "Todavía no hay consultorios."}
                </div>
              </div>
            ) : (
              rows.map((r) => <Row key={r.tenantId} r={r} />)
            )}
          </div>
        </div>
      </Card>

      {(query.cursor || nextCursor) && (
        <nav aria-label="Paginación" style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          {query.cursor ? (
            <Link href={accountsHref(base)} className={table.chip} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
              ← Volver al principio
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link href={accountsHref(base, nextCursor)} className={table.chip} style={{ fontSize: 13, fontWeight: 600, color: "var(--sky-700)" }}>
              Siguiente →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
