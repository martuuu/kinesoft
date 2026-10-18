import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  OCCUPANCY_TABS,
  OCCUPANCY_TAB_LABEL,
  PAST_WEEK_OPTIONS,
  UPCOMING_WEEK_OPTIONS,
  type OccupancyCell,
  type OccupancyTable,
  type OccupancyView as OccupancyViewData,
} from "@/lib/agenda-occupancy";
import styles from "./occupancy.module.css";

/**
 * [AS-3h] Agenda → Ocupación (plan §23.9). Server-safe: sin `"use client"` ni hooks, así la página entera es 0 kB de JS
 * propio (ruta aparte de /agenda: no suma a su first load). Los filtros son un `<form method="get">` nativo y las
 * pestañas son links; todo funciona sin JavaScript.
 *
 * Accesibilidad: cada tabla con `<caption>`, `th scope`, el NÚMERO en cada celda (el color nunca es el único canal)
 * y «en el tope» con una marca no cromática (triángulo + borde) más el texto para el lector de pantalla. A < 640 px
 * la tabla se reemplaza por una lista por día (CSS, sin estado).
 */
export function OccupancyView({ data }: { data: OccupancyViewData }) {
  const { params, scope } = data;
  const weekOptions = params.tab === "pasado" ? PAST_WEEK_OPTIONS : UPCOMING_WEEK_OPTIONS;
  const team = scope.kind === "team";
  const proParam = team && scope.practitionerId ? scope.practitionerId : null;
  const hrefFor = (tab: string) => {
    const q = new URLSearchParams({ tab });
    if (proParam) q.set("pro", proParam);
    return `/agenda/ocupacion?${q.toString()}`;
  };
  const hasCap = data.cap != null && params.tab === "proximo";

  return (
    <div className={styles.root}>
      <nav aria-label="Pestañas de ocupación">
        <div className={styles.tabs}>
          {OCCUPANCY_TABS.map((t) => (
            <Link
              key={t}
              href={hrefFor(t)}
              className={styles.tab}
              aria-current={t === params.tab ? "page" : undefined}
            >
              {OCCUPANCY_TAB_LABEL[t]}
            </Link>
          ))}
        </div>
      </nav>

      <form method="get" action="/agenda/ocupacion" className={styles.filters} aria-label="Filtros de ocupación">
        <input type="hidden" name="tab" value={params.tab} />
        {team && (
          <div className={styles.field}>
            <label className="k-label" htmlFor="occ-pro">
              Profesional
            </label>
            <select id="occ-pro" name="pro" className="k-input" defaultValue={scope.practitionerId ?? ""}>
              <option value="">Todos los profesionales</option>
              {data.practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className={styles.field}>
          <label className="k-label" htmlFor="occ-weeks">
            {params.tab === "pasado" ? "Semanas completas" : "Próximas semanas"}
          </label>
          <select id="occ-weeks" name="semanas" className="k-input" defaultValue={String(params.weeks)}>
            {weekOptions.map((w) => (
              <option key={w} value={w}>
                {w === 1 ? "1 semana" : `${w} semanas`}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="ghost">
          Ver
        </Button>
      </form>

      {scope.kind === "none" ? (
        <p className={styles.notice}>No tenés una agenda propia para mirar.</p>
      ) : (
        <>
          <p className={styles.notice}>
            {subjectLine(data)} {params.tab === "pasado" ? PAST_NOTE : UPCOMING_NOTE}
            {team && scope.practitionerId == null && params.tab === "proximo"
              ? " El tope por intervalo es de cada profesional: elegí uno para verlo."
              : ""}
          </p>
          {data.truncated && (
            <p className={styles.notice} role="status">
              Hay demasiados turnos en este período: los números pueden quedar cortos. Probá con menos semanas.
            </p>
          )}
          <Legend hasCap={hasCap} intervalMin={data.cap?.intervalMin ?? null} />
          {data.tables.map((t) => (
            <OccupancyTableCard key={t.id} table={t} average={params.tab === "pasado"} />
          ))}
        </>
      )}
    </div>
  );
}

const PAST_NOTE =
  "Cada celda es el promedio de turnos por semana que empezaron ese día a esa hora (sin cancelados ni reservas online vencidas sin pagar).";
const UPCOMING_NOTE =
  "Cada celda es la cantidad de turnos ya dados que empiezan ese día a esa hora (sin cancelados ni reservas online vencidas sin pagar).";

function subjectLine(d: OccupancyViewData): string {
  if (d.scope.kind === "own") return "Tu agenda.";
  return d.practitionerName ? `Agenda de ${d.practitionerName}.` : "Todo el equipo.";
}

function Legend({ hasCap, intervalMin }: { hasCap: boolean; intervalMin: number | null }) {
  return (
    <ul className={styles.legend} aria-label="Referencias">
      <li>
        <span className={`${styles.swatch} ${styles.l0}`} aria-hidden="true" /> Sin turnos
      </li>
      <li>
        <span className={`${styles.swatch} ${styles.l1}`} aria-hidden="true" />
        <span className={`${styles.swatch} ${styles.l3}`} aria-hidden="true" />
        <span className={`${styles.swatch} ${styles.l5}`} aria-hidden="true" /> De menos a más turnos
      </li>
      {hasCap && (
        <li>
          <span className={`${styles.swatch} ${styles.cap}`} aria-hidden="true" />
          <span aria-hidden="true">▲</span>{" "}
          {intervalMin === 60 ? "En el tope (turnos / tope)" : `Con intervalos de ${intervalMin} min en el tope`}
        </li>
      )}
    </ul>
  );
}

function cellClass(c: OccupancyCell): string {
  return `${styles[`l${c.level}`]}${c.atCap ? ` ${styles.cap}` : ""}`;
}

function CellContent({ c }: { c: OccupancyCell }) {
  return (
    <>
      {c.text}
      {c.atCap && (
        <>
          <span className={styles.mark} aria-hidden="true">
            ▲
          </span>
          <span className="k-sr-only"> ({c.note ?? "en el tope"})</span>
        </>
      )}
    </>
  );
}

function OccupancyTableCard({ table, average }: { table: OccupancyTable; average: boolean }) {
  const unit = (v: number, text: string) =>
    average ? `${text} por semana` : v === 1 ? "1 turno" : `${text.split("/")[0]} turnos`;
  return (
    <section>
      <Card className={`${styles.card} ${styles.desktop}`}>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <caption>{table.caption}</caption>
            <thead>
              <tr>
                <th scope="col">Hora</th>
                {table.columns.map((c) => (
                  <th key={c.key} scope="col">
                    <abbr title={c.label} style={{ textDecoration: "none" }}>
                      {c.short}
                    </abbr>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.hour}>
                  <th scope="row">{r.label}</th>
                  {r.cells.map((c, i) => (
                    <td key={table.columns[i].key} className={cellClass(c)} title={c.note ?? undefined}>
                      <CellContent c={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className={styles.list}>
        <p className={styles.notice}>{table.caption}</p>
        {table.columns.map((col, i) => {
          const items = table.rows.filter((r) => r.cells[i].value > 0);
          return (
            <Card key={col.key} className={styles.day}>
              <h3>{col.label}</h3>
              {items.length === 0 ? (
                <p className={styles.empty}>Sin turnos</p>
              ) : (
                <ul>
                  {items.map((r) => {
                    const c = r.cells[i];
                    return (
                      <li key={r.hour} className={cellClass(c)}>
                        <span>{r.label}</span>
                        <span>
                          {unit(c.value, c.text)}
                          {c.text.includes("/") ? ` de ${c.text.split("/")[1]}` : ""}
                          {c.atCap && (
                            <>
                              <span className={styles.mark} aria-hidden="true">
                                ▲
                              </span>
                              <span className="k-sr-only"> ({c.note ?? "en el tope"})</span>
                            </>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
