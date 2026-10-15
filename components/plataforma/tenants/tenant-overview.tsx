/**
 * [EV0-P3] Resumen de /plataforma (plan §15.4): total de consultorios, matriz
 * tipo × plan, trials por vencer (≤ 7 días desde BO3-B, vencidos incluidos), altas
 * con el onboarding sin terminar y cuántos tienen los turnos online activos.
 * Presentacional puro: los datos vienen de `getPlatformOverview()` en la página.
 *
 * BO3-B suma los conteos por estado del consultorio (activos / suspendidos / de
 * baja), cada uno con link a la lista ya filtrada, y los accesos a Consultorios,
 * Usuarios y Salud.
 */
import Link from "next/link";
import type { TenantPlan, TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import { TENANT_PLAN_VALUES, TENANT_VERTICAL_VALUES } from "@/lib/platform-tenants-schemas";
import {
  PLATFORM_TRIAL_WARNING_DAYS,
  type PlatformOverview,
  type PlatformVerticalPlanCount,
} from "@/lib/platform-tenants-types";
import { formatDateAR } from "@/lib/format";
import { TENANT_STATUS_VALUES } from "@/lib/platform-tenants-schemas";
import {
  TENANT_STATUS_PLURAL,
  formatDayKeyAR,
  tenantHref,
  trialDaysLabel,
} from "@/components/plataforma/tenants/labels";

export type VerticalPlanMatrix = {
  cells: Record<TenantVertical, Record<TenantPlan, number>>;
  rowTotals: Record<TenantVertical, number>;
  colTotals: Record<TenantPlan, number>;
};

/** `byVerticalPlan` solo trae combinaciones con ≥ 1 consultorio: acá se completan los ceros. */
export function verticalPlanMatrix(groups: PlatformVerticalPlanCount[]): VerticalPlanMatrix {
  const zeroPlans = () =>
    Object.fromEntries(TENANT_PLAN_VALUES.map((p) => [p, 0])) as Record<TenantPlan, number>;
  const cells = Object.fromEntries(TENANT_VERTICAL_VALUES.map((v) => [v, zeroPlans()])) as VerticalPlanMatrix["cells"];
  const rowTotals = Object.fromEntries(TENANT_VERTICAL_VALUES.map((v) => [v, 0])) as Record<TenantVertical, number>;
  const colTotals = zeroPlans();
  for (const g of groups) {
    if (!cells[g.vertical] || cells[g.vertical][g.plan] === undefined) continue;
    cells[g.vertical][g.plan] += g.count;
    rowTotals[g.vertical] += g.count;
    colTotals[g.plan] += g.count;
  }
  return { cells, rowTotals, colTotals };
}

function Stat({ label, value, hint, href }: { label: string; value: number; hint?: string; href?: string }) {
  const body = (
    <>
      <EyebrowLabel>{label}</EyebrowLabel>
      <div className="k-display" style={{ fontSize: 30, fontWeight: 700, marginTop: 6, color: "var(--navy-900)" }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 2 }}>{hint}</div>}
    </>
  );
  return (
    <Card style={{ padding: 18 }}>
      {href ? (
        <Link href={href} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}

/** Lista de consultorios filtrada por estado del consultorio (`?tenantStatus=`). */
export function statusListHref(status: string): string {
  return `/plataforma/consultorios?tenantStatus=${encodeURIComponent(status)}`;
}

const QUICK_LINKS = [
  { href: "/plataforma/consultorios", label: "Consultorios", hint: "Lista, alta y ciclo de vida" },
  { href: "/plataforma/usuarios", label: "Usuarios", hint: "Cuentas, accesos y superadmins" },
  { href: "/plataforma/salud", label: "Salud", hint: "Inconsistencias para reparar" },
] as const;

const cell: React.CSSProperties = { padding: "10px 12px", textAlign: "right", fontVariantNumeric: "tabular-nums" };

function Matrix({ groups }: { groups: PlatformVerticalPlanCount[] }) {
  const m = verticalPlanMatrix(groups);
  const total = TENANT_VERTICAL_VALUES.reduce((a, v) => a + m.rowTotals[v], 0);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 520, borderCollapse: "collapse", fontSize: 13, color: "var(--navy-700)" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(15,30,51,0.07)" }}>
            <th scope="col" style={{ ...cell, textAlign: "left" }}>
              <EyebrowLabel as="span">Tipo</EyebrowLabel>
            </th>
            {TENANT_PLAN_VALUES.map((p) => (
              <th key={p} scope="col" style={cell}>
                <EyebrowLabel as="span">{PLAN_LABEL[p]}</EyebrowLabel>
              </th>
            ))}
            <th scope="col" style={cell}>
              <EyebrowLabel as="span">Total</EyebrowLabel>
            </th>
          </tr>
        </thead>
        <tbody>
          {TENANT_VERTICAL_VALUES.map((v) => (
            <tr key={v} style={{ borderBottom: "1px solid rgba(15,30,51,0.05)" }}>
              <th scope="row" style={{ ...cell, textAlign: "left", fontWeight: 600 }}>
                {VERTICAL_LABEL[v]}
              </th>
              {TENANT_PLAN_VALUES.map((p) => (
                <td key={p} style={{ ...cell, color: m.cells[v][p] === 0 ? "var(--navy-200)" : undefined }}>
                  {m.cells[v][p]}
                </td>
              ))}
              <td style={{ ...cell, fontWeight: 700 }}>{m.rowTotals[v]}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" style={{ ...cell, textAlign: "left", fontWeight: 700 }}>
              Total
            </th>
            {TENANT_PLAN_VALUES.map((p) => (
              <td key={p} style={{ ...cell, fontWeight: 700 }}>
                {m.colTotals[p]}
              </td>
            ))}
            <td style={{ ...cell, fontWeight: 700 }}>{total}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ListCard({
  title,
  count,
  shown,
  empty,
  children,
}: {
  title: string;
  count: number;
  shown: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <Card style={{ padding: 18, minWidth: 0 }}>
      <h2 className="k-display" style={{ fontSize: 17, margin: 0, fontWeight: 700 }}>
        {title} <span style={{ color: "var(--navy-300)", fontWeight: 600 }}>· {count}</span>
      </h2>
      {count === 0 ? (
        <p style={{ fontSize: 13, color: "var(--navy-300)", marginBottom: 0 }}>{empty}</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 2 }}>{children}</ul>
      )}
      {count > shown && (
        <p style={{ fontSize: 12, color: "var(--navy-300)", marginBottom: 0 }}>
          Se muestran {shown} de {count}.
        </p>
      )}
    </Card>
  );
}

const itemStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid rgba(15,30,51,0.05)",
  fontSize: 13,
};

export function PlatformOverviewView({ overview }: { overview: PlatformOverview }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))", gap: 12 }}>
        <Stat label="Consultorios" value={overview.totalTenants} />
        <Stat
          label="Trials por vencer"
          value={overview.trialsEndingSoonCount}
          hint={`En ${PLATFORM_TRIAL_WARNING_DAYS} días o vencidos`}
        />
        <Stat label="Altas sin terminar" value={overview.onboardingPendingCount} />
        <Stat label="Turnos online activos" value={overview.publicBookingEnabledCount} />
      </div>

      <section aria-label="Por estado del consultorio">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(170px, 100%), 1fr))", gap: 12 }}>
          {TENANT_STATUS_VALUES.map((st) => (
            <Stat key={st} label={TENANT_STATUS_PLURAL[st]} value={overview.byStatus[st]} href={statusListHref(st)} />
          ))}
        </div>
      </section>

      <Card style={{ padding: 18 }}>
        <h2 className="k-display" style={{ fontSize: 17, margin: "0 0 8px", fontWeight: 700 }}>
          Por tipo y plan
        </h2>
        <Matrix groups={overview.byVerticalPlan} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 12 }}>
        <ListCard
          title="Trials por vencer"
          count={overview.trialsEndingSoonCount}
          shown={overview.trialsEndingSoon.length}
          empty={`Ningún trial vence en los próximos ${PLATFORM_TRIAL_WARNING_DAYS} días.`}
        >
          {overview.trialsEndingSoon.map((t) => (
            <li key={t.id} style={itemStyle}>
              <span style={{ minWidth: 0 }}>
                <Link href={tenantHref(t.id)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
                  {t.name}
                </Link>
                <span style={{ display: "block", fontSize: 12, color: "var(--navy-300)" }}>
                  {VERTICAL_LABEL[t.vertical]} · {PLAN_LABEL[t.plan]} · {formatDayKeyAR(t.trialEndsOn)}
                </span>
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontWeight: 700,
                  fontSize: 12.5,
                  color: t.daysLeft < 0 ? "#9F1F1F" : t.daysLeft <= 3 ? "var(--st-noshow-fg)" : "var(--navy-500)",
                }}
              >
                {trialDaysLabel(t.daysLeft)}
              </span>
            </li>
          ))}
        </ListCard>

        <ListCard
          title="Altas sin terminar"
          count={overview.onboardingPendingCount}
          shown={overview.onboardingPending.length}
          empty="Todas las altas terminaron el onboarding."
        >
          {overview.onboardingPending.map((t) => (
            <li key={t.id} style={itemStyle}>
              <span style={{ minWidth: 0 }}>
                <Link href={tenantHref(t.id)} style={{ fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
                  {t.name}
                </Link>
                <span style={{ display: "block", fontSize: 12, color: "var(--navy-300)" }}>
                  {VERTICAL_LABEL[t.vertical]} · {PLAN_LABEL[t.plan]}
                </span>
              </span>
              <span style={{ flexShrink: 0, fontSize: 12.5, color: "var(--navy-500)" }}>
                Alta {formatDateAR(t.createdAt, "short")}
              </span>
            </li>
          ))}
        </ListCard>
      </div>

      <nav aria-label="Accesos" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(200px, 100%), 1fr))", gap: 12 }}>
        {QUICK_LINKS.map((l) => (
          <Link key={l.href} href={l.href} style={{ textDecoration: "none" }}>
            <Card style={{ padding: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--sky-700)" }}>{l.label} →</div>
              <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 2 }}>{l.hint}</div>
            </Card>
          </Link>
        ))}
      </nav>
    </div>
  );
}
