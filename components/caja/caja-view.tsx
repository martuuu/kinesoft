import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { IconChevL, IconChevR } from "@/components/ui/icons";
import { cajaHref } from "@/lib/caja-logic";
import { CAJA_PATH, type CajaPageData, type CajaScopeKind, type CollectedMethod, type PractitionerSettlement, type ShareFlow } from "@/lib/caja-types";
import { PAYMENT_METHOD_LABEL, PAYMENT_METHOD_UNKNOWN } from "@/lib/payment-method";
import { REVENUE_SOURCE_SHORT_LABEL, type RevenueShareRuleView, type RevenueSource } from "@/lib/revenue-share-types";
import { formatSharePct } from "@/lib/revenue-share-logic";
import { formatARS, formatDateAR } from "@/lib/format";
import { cn } from "@/lib/cn";
import styles from "./caja.module.css";

/**
 * /caja (CF2 · P.2, sesión P-U2; plan §29 D-CF2-16/17): lo cobrado por profesional en el día o el mes, con lo que cada
 * uno destina y recibe por el reparto, y en el Día los medios de pago y las reglas que rigieron.
 *
 * Server-safe (sin `"use client"` ni hooks): la página server la pinta con el `CajaPageData` que armó `loadCajaPage`,
 * YA proyectado al scope (`projectCajaForScope`): esta vista no filtra plata, solo decide qué columnas y qué navegación
 * mostrar según `data.scope`. Cambiar de día o de mes es un link (o un form GET con `<input type=date|month>`): no hay
 * action nueva ni JS de cliente, y la URL es la fuente de verdad (`?vista=dia|mes&fecha=…&mes=…`, `cajaHref`).
 *
 *   - `desk` (Secretaria): «Cobrado hoy», sin Obra social ni Mes ni selector (D-CF2-16: solo hoy). Ve Destina/Recibe.
 *   - `own` (Profesional): su fila sola, con «de quién» recibe; sin fila de totales (repetiría la suya).
 *   - `tenant`: todo, con fila de totales.
 *
 * Un solo markup para desktop y mobile: bajo 768 px la `<table>` pasa a una tarjeta por profesional por CSS (molde de
 * /cobros), así el lector de pantalla no lee filas duplicadas. Las filas en $0 se ven (el roster las trae): que un
 * profesional no haya cobrado es un dato, no un hueco.
 */

export const CAJA_COPY = {
  title: "Caja",
  description: {
    desk: "Cobrado hoy por profesional: copagos y cobros online, con lo que cada uno destina y recibe.",
    own: "Lo que cobraste y lo que recibís de otros profesionales del consultorio.",
    tenant: "Lo cobrado por profesional: copagos, cobros online y obra social, con lo que cada uno destina y recibe.",
  } satisfies Record<Exclude<CajaScopeKind, "none">, string>,
  deskEyebrow: "Cobrado hoy",
  emptyToday: "Todavía no hay cobros registrados hoy.",
  emptyDay: "No hay cobros registrados ese día.",
  emptyThisMonth: "Todavía no hay cobros registrados este mes.",
  emptyMonth: "No hay cobros registrados en ese mes.",
  methodsTitle: "Por medio de pago",
  methodsEmpty: "Sin cobros con medio de pago en el día.",
  methodsHint: "La obra social no tiene medio de pago: no suma acá.",
  rulesTitle: "Reparto vigente",
  rulesEmpty: "Nadie destina un porcentaje de lo cobrado en este día.",
  tableCaption: "Cobrado por profesional",
} as const;

const TZ = "America/Argentina/Buenos_Aires";

/** Fuentes en la frase del reparto («sobre copagos y cobros online»). */
const SOURCE_IN_SENTENCE: Record<RevenueSource, string> = {
  manual: "copagos",
  online: "cobros online",
  insurer: "obra social",
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** «lunes, 2 de noviembre» del día AR (el inicio del período es la medianoche AR de ese día). */
function dayLabel(startIso: string): string {
  return capitalize(new Date(startIso).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ }));
}

const monthLabel = (startIso: string) => capitalize(formatDateAR(startIso, "monthYear"));

function joinEs(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}

const methodLabel = (m: CollectedMethod) => (m === "UNKNOWN" ? PAYMENT_METHOD_UNKNOWN : PAYMENT_METHOD_LABEL[m]);
const cobros = (n: number) => (n === 0 ? "Sin cobros" : n === 1 ? "1 cobro" : `${n} cobros`);

function emptyCopy(data: CajaPageData): string {
  const { view, isCurrent } = data.period;
  if (view === "mes") return isCurrent ? CAJA_COPY.emptyThisMonth : CAJA_COPY.emptyMonth;
  return isCurrent ? CAJA_COPY.emptyToday : CAJA_COPY.emptyDay;
}

// ─── Encabezado y navegación ─────────────────────────────────────────────────

function PeriodNav({ data }: { data: CajaPageData }) {
  const p = data.period;
  const label = p.view === "mes" ? monthLabel(p.startIso) : dayLabel(p.startIso);
  const updated = p.isCurrent ? `Actualizado a las ${formatDateAR(data.computedAt, "time")}` : null;

  if (!p.canNavigate) {
    return (
      <div className={styles.toolbar}>
        <div className={styles.periodBlock}>
          <h2 className={styles.periodLabel}>Hoy, {label.toLowerCase()}</h2>
          {updated ? <p className={styles.updated}>{updated}</p> : null}
        </div>
      </div>
    );
  }

  const isMonth = p.view === "mes";
  const unit = isMonth ? "Mes" : "Día";
  return (
    <nav className={styles.toolbar} aria-label="Período de la caja">
      <div className={styles.segmented} role="group" aria-label="Vista">
        <Link href={cajaHref("dia")} className={styles.segment} aria-current={isMonth ? undefined : "page"}>
          Día
        </Link>
        <Link href={cajaHref("mes", p.monthKey)} className={styles.segment} aria-current={isMonth ? "page" : undefined}>
          Mes
        </Link>
      </div>

      <div className={styles.stepper}>
        {p.prev ? (
          <Link href={cajaHref(p.view, p.prev)} className={styles.step} aria-label={`${unit} anterior`}>
            <IconChevL size={18} />
          </Link>
        ) : null}
        <div className={styles.periodBlock}>
          <h2 className={styles.periodLabel}>{label}</h2>
          {updated ? <p className={styles.updated}>{updated}</p> : null}
        </div>
        {/* Al futuro no se avanza: todavía no hay nada cobrado ahí. */}
        {p.next && !p.isCurrent ? (
          <Link href={cajaHref(p.view, p.next)} className={styles.step} aria-label={`${unit} siguiente`}>
            <IconChevR size={18} />
          </Link>
        ) : (
          <span className={cn(styles.step, styles.stepOff)} aria-hidden="true">
            <IconChevR size={18} />
          </span>
        )}
      </div>

      <div className={styles.jumpRow}>
        {!p.isCurrent ? (
          <Link href={cajaHref(p.view)} className={styles.todayLink}>
            {isMonth ? "Este mes" : "Hoy"}
          </Link>
        ) : null}
        {/* GET a /caja: el navegador arma `?vista=…&fecha=…` (o `mes=`), lo mismo que `cajaHref`. Sin JS. */}
        <form action={CAJA_PATH} method="get" className={styles.jump}>
          <input type="hidden" name="vista" value={p.view} />
          <label className={styles.jumpField}>
            <span className="k-sr-only">{isMonth ? "Elegí un mes" : "Elegí un día"}</span>
            {isMonth ? (
              <input type="month" name="mes" defaultValue={p.monthKey} className={cn("k-input", styles.jumpInput)} />
            ) : (
              <input type="date" name="fecha" defaultValue={p.dayKey ?? undefined} className={cn("k-input", styles.jumpInput)} />
            )}
          </label>
          <Button type="submit" variant="ghost" size="sm">
            Ver
          </Button>
        </form>
      </div>
    </nav>
  );
}

// ─── Tabla por profesional ───────────────────────────────────────────────────

function Flows({ flows, prefix }: { flows: readonly ShareFlow[]; prefix: "a" | "de" }) {
  if (flows.length === 0) return null;
  return (
    <span className={styles.flows}>
      {flows.map((f) => (
        <span key={f.practitionerId} className={styles.flow}>
          {prefix} {f.practitionerName}
          {flows.length > 1 ? ` · ${formatARS(f.cents)}` : null}
        </span>
      ))}
    </span>
  );
}

function Amount({ cents, label, className }: { cents: number; label: string; className?: string }) {
  return (
    <td className={cn(styles.num, className)} data-label={label} data-zero={cents === 0 ? "" : undefined}>
      {formatARS(cents)}
    </td>
  );
}

function SettlementRow({ row, sources }: { row: PractitionerSettlement; sources: readonly RevenueSource[] }) {
  return (
    <tr>
      <th scope="row" className={styles.cellName}>
        <span className={styles.name}>{row.practitionerName}</span>
        <span className={styles.meta}>{cobros(row.count)}</span>
      </th>
      {sources.map((s) => (
        <Amount key={s} cents={row.bySource[s]} label={REVENUE_SOURCE_SHORT_LABEL[s]} className={styles.cellSource} />
      ))}
      <Amount cents={row.gross} label="Total" className={styles.cellTotal} />
      <td className={cn(styles.num, styles.cellShare)} data-label="Destina" data-zero={row.given === 0 ? "" : undefined}>
        {formatARS(row.given)}
        <Flows flows={row.givenTo} prefix="a" />
      </td>
      <td className={cn(styles.num, styles.cellShare)} data-label="Recibe" data-zero={row.received === 0 ? "" : undefined}>
        {formatARS(row.received)}
        <Flows flows={row.receivedFrom} prefix="de" />
      </td>
      <Amount cents={row.net} label="Neto" className={styles.cellNet} />
    </tr>
  );
}

function SettlementTable({ data }: { data: CajaPageData }) {
  const { settlement, sources } = data;
  const showTotals = data.scope !== "own" && settlement.rows.length > 0;
  const t = settlement.totals;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="k-sr-only">{CAJA_COPY.tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">Profesional</th>
            {sources.map((s) => (
              <th key={s} scope="col" className={styles.num}>{REVENUE_SOURCE_SHORT_LABEL[s]}</th>
            ))}
            <th scope="col" className={styles.num}>Total</th>
            <th scope="col" className={styles.num}>Destina</th>
            <th scope="col" className={styles.num}>Recibe</th>
            <th scope="col" className={styles.num}>Neto</th>
          </tr>
        </thead>
        <tbody>
          {settlement.rows.map((r) => (
            <SettlementRow key={r.practitionerId} row={r} sources={sources} />
          ))}
        </tbody>
        {showTotals ? (
          <tfoot>
            <tr className={styles.totalsRow}>
              <th scope="row" className={styles.cellName}>
                <span className={styles.name}>Total</span>
                <span className={styles.meta}>{cobros(t.count)}</span>
              </th>
              {sources.map((s) => (
                <Amount key={s} cents={t.bySource[s]} label={REVENUE_SOURCE_SHORT_LABEL[s]} className={styles.cellSource} />
              ))}
              <Amount cents={t.gross} label="Total" className={styles.cellTotal} />
              <Amount cents={t.given} label="Destina" className={styles.cellShare} />
              <Amount cents={t.received} label="Recibe" className={styles.cellShare} />
              <Amount cents={t.net} label="Neto" className={styles.cellNet} />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

// ─── Día: medios y reparto ───────────────────────────────────────────────────

function Methods({ data }: { data: CajaPageData }) {
  return (
    <section className={styles.panel} aria-labelledby="caja-methods">
      <h2 id="caja-methods" className={styles.panelTitle}>{CAJA_COPY.methodsTitle}</h2>
      {data.methods.length === 0 ? (
        <p className={styles.panelEmpty}>{CAJA_COPY.methodsEmpty}</p>
      ) : (
        <ul className={styles.methods}>
          {data.methods.map((m) => (
            <li key={m.method} className={styles.method}>
              <span className={styles.methodName}>
                {methodLabel(m.method)}
                <span className={styles.meta}>{cobros(m.count)}</span>
              </span>
              <span className={styles.methodAmount}>{formatARS(m.cents)}</span>
            </li>
          ))}
        </ul>
      )}
      {data.sources.includes("insurer") ? <p className={styles.panelHint}>{CAJA_COPY.methodsHint}</p> : null}
    </section>
  );
}

function ruleTiming(r: RevenueShareRuleView, periodStartIso: string): string {
  const parts: string[] = [];
  // Solo si arrancó DENTRO del día que se mira (una regla de hace meses no lleva «desde»).
  if (r.effectiveFrom > periodStartIso) parts.push(`desde las ${formatDateAR(r.effectiveFrom, "time")}`);
  if (r.effectiveTo) parts.push(`hasta las ${formatDateAR(r.effectiveTo, "time")}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function Rules({ data }: { data: CajaPageData }) {
  // La Secretaria no ve la OS: de una regla solo se nombran las fuentes que el scope muestra, y una regla que solo
  // tocara la OS no aparece (no hay plata visible que se mueva por ella).
  const rules = data.rules
    .map((r) => ({ r, sources: data.sources.filter((s) => r.sources[s]) }))
    .filter((x) => x.sources.length > 0);
  return (
    <section className={styles.panel} aria-labelledby="caja-rules">
      <h2 id="caja-rules" className={styles.panelTitle}>{CAJA_COPY.rulesTitle}</h2>
      {rules.length === 0 ? (
        <p className={styles.panelEmpty}>{CAJA_COPY.rulesEmpty}</p>
      ) : (
        <ul className={styles.rules}>
          {rules.map(({ r, sources }) => (
            <li key={r.id} className={styles.rule}>
              <strong>{r.giverName}</strong> destina <strong>{formatSharePct(r.shareBps)}</strong> a{" "}
              <strong>{r.receiverName}</strong> sobre {joinEs(sources.map((s) => SOURCE_IN_SENTENCE[s]))}
              {ruleTiming(r, data.period.startIso)}.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Vista ───────────────────────────────────────────────────────────────────

export function CajaView({ data }: { data: CajaPageData }) {
  const scope = data.scope === "none" ? "tenant" : data.scope;
  const t = data.settlement.totals;
  const empty = t.gross === 0 && t.given === 0 && t.received === 0;
  const isDay = data.period.view === "dia";
  return (
    <div className={styles.page} data-scope={data.scope}>
      <PageHeader
        eyebrow={scope === "desk" ? CAJA_COPY.deskEyebrow : undefined}
        title={CAJA_COPY.title}
        description={CAJA_COPY.description[scope]}
      />
      <PeriodNav data={data} />

      {empty ? (
        <p className={styles.empty} role="status">
          {emptyCopy(data)}
        </p>
      ) : null}

      {data.settlement.rows.length > 0 ? <SettlementTable data={data} /> : null}

      {isDay ? (
        <div className={styles.panels}>
          <Methods data={data} />
          <Rules data={data} />
        </div>
      ) : null}
    </div>
  );
}
