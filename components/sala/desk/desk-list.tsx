"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { fmtHour, roomNameOf, type BookingDTO } from "@/components/agenda/agenda-utils";
import { formatARS } from "@/lib/format";
import { DUR, EASE_OUT } from "@/lib/motion";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { fmtMinutes, waitText } from "@/lib/reception-view-state";
import { filterByQuery, type SalaPractitioner } from "@/lib/sala-board-state";
import {
  attendingEntries,
  cashEntries,
  chronological,
  deskFilters,
  matchesDeskFilter,
  minutesSince,
  minutesUntil,
  nowLineIndex,
  pastScheduled,
  scrollAnchorIndex,
  soonEntries,
  waitFill,
  waitingEntries,
  type DeskEntry,
  type DeskFilter,
} from "@/lib/reception-desk-state";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { DESK_COMPACT_MAX, DESK_STACK_MAX } from "./desk-css";
import { DeskStrip } from "./desk-strip";
import { DeskMenu, DeskPrimaryAction, DeskStateTag } from "./desk-actions";

/**
 * A · «Lista y panel» (RX-2a, brief RX §1.2, prototipo `boardA()` de `design_source/vx0/recepcion.html`).
 *
 *   - Arriba, a todo el ancho, la franja de profesionales (`DeskStrip`; clic = filtro de uno, C-RX5 `proFilter`).
 *   - A la izquierda, «Turnos de hoy»: la tabla del día en orden CRONOLÓGICO (`chronological`, como se lee el día),
 *     con chips de filtro (`deskFilters`: «Por cobrar» solo con `billing.manage`) y la línea de «ahora» entre el
 *     último turno que ya empezó y el primero que falta. Al abrir, la tabla scrollea sola a la línea con 3 turnos de
 *     contexto (`scrollAnchorIndex`), una sola vez: después el scroll es de quien la usa.
 *   - A la derecha, el panel: «Sala de espera» (llamados primero, después por llegada), «Próximos 30 min» y la
 *     tercera card según el rol: «Por cobrar» con el total pendiente (quien cobra, RX-D4) o «En atención» (el resto:
 *     quién está en cada box y hace cuánto).
 *
 * Qué filtra qué (igual que el prototipo): la búsqueda y el profesional filtran la tabla Y el panel; el chip, solo
 * la tabla; el contador de cada chip cuenta con el profesional pero sin la búsqueda (así el número no salta al
 * tipear). La línea de «ahora» solo va en «Todos»: en un filtro, los turnos no son contiguos y la línea mentiría.
 *
 * Acciones: `DeskPrimaryAction` / `DeskMenu` / `DeskStateTag` (desk-actions.tsx) se conectan solas al shell por
 * contexto; acá no hay callbacks de acción.
 *
 * Densidad (40-60 turnos, reloj cada 30 s): las filas van memoizadas por una firma de lo que pintan (`deskRowSig`);
 * sin timers por fila, el reloj es el único de `useSalaLive`.
 *
 * Color (AGENTS §5): la barra es el servicio (inline, el color literal del servicio como en las cards de la
 * agenda), el tag es el estado y el profesional va con iniciales en un avatar neutro (canal no cromático).
 *
 * PD-13: se lee nombre, hora, servicio, profesional, sala, obra social, copago y cobro. Nunca `title`, `notes`,
 * `description` ni `patientCondition` (el render test pasa filas con esos campos llenos).
 */
export function DeskList(p: {
  live: SalaLive;
  query: string;
  proFilter: string | null;
  onProFilter(id: string | null): void;
}): JSX.Element {
  const { live, query, proFilter, onProFilter } = p;
  const viewer = live.viewer;
  const now = live.clock;
  const [filterState, setFilter] = useState<DeskFilter>("todos");
  // Sin `billing.manage` el chip «Por cobrar» no existe: un filtro que quedó apretado (cambio de rol en caliente) no
  // puede dejar la tabla filtrada por algo invisible.
  const filter: DeskFilter = filterState === "por-cobrar" && !viewer.canCollect ? "todos" : filterState;

  const proById = useMemo(() => new Map(live.practitioners.map((x) => [x.id, x])), [live.practitioners]);

  // Profesional (franja) → base de los contadores de los chips.
  const byPro = useMemo(
    () => (proFilter ? live.entries.filter((e) => e.row.practitionerId === proFilter) : live.entries),
    [live.entries, proFilter]
  );
  // + búsqueda → base de la tabla y del panel.
  const visible = useMemo(() => {
    if (!query.trim()) return byPro;
    const hits = new Set(filterByQuery(byPro.map((e) => e.row), query).map((r) => r.id));
    return byPro.filter((e) => hits.has(e.row.id));
  }, [byPro, query]);

  const chips = useMemo(
    () =>
      deskFilters(viewer.canCollect).map((f) => ({
        ...f,
        count: byPro.filter((e) => matchesDeskFilter(e, f.id)).length,
      })),
    [byPro, viewer.canCollect]
  );

  const sorted = useMemo(() => chronological(visible.filter((e) => matchesDeskFilter(e, filter))), [visible, filter]);
  const showNow = filter === "todos" && sorted.length > 0;
  const nowIdx = showNow ? nowLineIndex(sorted, now) : -1;
  const anchor = showNow ? scrollAnchorIndex(nowIdx) : -1;

  // ── Auto-scroll a la línea de «ahora», una vez ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (scrolledRef.current || !showNow) return;
    const sc = scrollRef.current;
    if (!sc) return;
    scrolledRef.current = true;
    // En una columna la tabla no scrollea adentro (scroll de página): no se mueve nada.
    if (sc.scrollHeight <= sc.clientHeight) return;
    if (anchor < 0) {
      sc.scrollTop = sc.scrollHeight;
      return;
    }
    const target = sc.querySelector<HTMLElement>("[data-anchor]");
    if (!target) return;
    const head = sc.querySelector("thead");
    const off = head ? head.getBoundingClientRect().height : 0;
    sc.scrollTop = Math.max(0, target.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - off);
  }, [showNow, anchor]);

  const pro = (id: string): SalaPractitioner => proById.get(id) ?? { id, name: "Profesional", initials: "?" };

  const total = live.rows.filter((r) => r.status !== "CANCELLED").length;
  const emptyText =
    live.loading && live.rows.length === 0
      ? "Cargando los turnos de hoy…"
      : total === 0
        ? "Hoy no hay turnos."
        : query.trim()
          ? `Ningún turno de hoy coincide con «${query.trim()}».`
          : "No hay turnos con este filtro.";

  const rowsMarkup: JSX.Element[] = [];
  const nowLine = (
    <tr key="now" className="dl-now" data-now-line="">
      <td colSpan={8}>
        <div className="dl-now-rule">
          <span className="desk-mono">{fmtHour(now)}</span>
        </div>
        <span className="desk-sr">Ahora, {fmtHour(now)}</span>
      </td>
    </tr>
  );
  sorted.forEach((e, i) => {
    if (showNow && i === nowIdx) rowsMarkup.push(nowLine);
    const pr = pro(e.row.practitionerId);
    const room = roomNameOf(live.roomById, e.row);
    const late = pastScheduled(e, now);
    const wait = deskWaitText(e, now);
    rowsMarkup.push(
      <DeskListRow
        key={e.row.id}
        sig={deskRowSig(e, { pro: pr, room, late, wait, anchor: i === anchor, just: live.pulseIds.has(e.row.id) })}
        entry={e}
        pro={pr}
        room={room}
        late={late}
        wait={wait}
        anchor={i === anchor}
        just={live.pulseIds.has(e.row.id)}
      />
    );
  });
  if (showNow && nowIdx < 0) rowsMarkup.push(nowLine);

  return (
    <div className="desk-face desk-list dl" data-face="list">
      <style>{DESK_LIST_CSS}</style>
      <DeskStrip live={live} proFilter={proFilter} onProFilter={onProFilter} />

      <section className="dl-card dl-day" aria-labelledby="dl-h-day">
        <div className="dl-card-h">
          <h2 id="dl-h-day">Turnos de hoy</h2>
          <div className="dl-chips" role="group" aria-label="Filtrar turnos">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className="dl-chip"
                data-filter={c.id}
                data-warn={(c.id === "demorados" || c.id === "por-cobrar") && c.count > 0 ? "true" : undefined}
                aria-pressed={filter === c.id}
                onClick={() => setFilter(c.id)}
              >
                {c.label} <span className="dl-n">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="dl-scroll" ref={scrollRef}>
          {sorted.length > 0 ? (
            <table className="dl-table">
              <caption className="desk-sr">Turnos de hoy</caption>
              <thead>
                <tr>
                  <th className="c-time" scope="col">
                    Hora
                  </th>
                  <th className="c-pat" scope="col">
                    Paciente
                  </th>
                  <th className="c-svc" scope="col">
                    Servicio
                  </th>
                  <th className="c-pro" scope="col">
                    <span className="desk-sr">Profesional</span>
                    <span aria-hidden="true">Prof.</span>
                  </th>
                  <th className="c-room" scope="col">
                    Sala
                  </th>
                  <th className="c-state" scope="col">
                    Estado
                  </th>
                  <th className="c-wait" scope="col">
                    Espera
                  </th>
                  <th className="c-act" scope="col">
                    <span className="desk-sr">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>{rowsMarkup}</tbody>
            </table>
          ) : (
            <p className="dl-empty">{emptyText}</p>
          )}
        </div>
      </section>

      <aside className="dl-side" aria-label={viewer.canCollect ? "Sala, próximos y cobros" : "Sala, próximos y en atención"}>
        <WaitingCard entries={visible} now={now} pro={pro} roomById={live.roomById} />
        <SoonCard entries={visible} now={now} pro={pro} />
        {viewer.canCollect ? (
          <CashCard entries={visible} pro={pro} />
        ) : (
          <AttendingCard entries={visible} now={now} pro={pro} roomById={live.roomById} />
        )}
      </aside>
    </div>
  );
}

// ── Fila de la tabla ─────────────────────────────────────────────────────────

type RowView = { pro: SalaPractitioner; room: string | null; late: boolean; wait: string | null; anchor: boolean; just: boolean };

/**
 * Firma de lo que la fila pinta (para el memo): si no cambia, la fila no re-renderiza con cada tick del reloj. Los
 * botones (`DeskPrimaryAction`, `DeskMenu`) leen el contexto del shell y se refrescan solos cuando cambia lo suyo.
 */
export function deskRowSig(e: DeskEntry, v: RowView): string {
  const r = e.row;
  return [
    r.id,
    r.updatedAt,
    r.status,
    r.scheduledFor,
    r.arrivedAt ?? "",
    r.calledAt ?? "",
    r.attendingAt ?? "",
    r.patientName,
    r.serviceName,
    r.serviceColor ?? "",
    r.isOverbooked ? "o" : "",
    r.obraSocial ?? "",
    r.copagoCents,
    r.paymentStatus ?? "",
    r.practitionerId,
    e.state,
    e.waitingMinutes ?? "",
    e.lateMinutes ?? "",
    e.calledMinutes ?? "",
    e.salaActions.join(","),
    v.pro.name,
    v.pro.initials,
    v.room ?? "",
    v.late ? "l" : "",
    v.wait ?? "",
    v.anchor ? "a" : "",
    v.just ? "j" : "",
  ].join("|");
}

/**
 * [RX-Z FX-A] Columna «Espera»: `waitText` salvo el «esperó 0'» de quien pasó al box sin esperar (llegada y entrada
 * en el mismo minuto, típico de «En atención» directo desde «Por llegar»): ese 0 no es un dato, es la falta de sala
 * de espera, y se lee «—» como el resto de las filas sin espera.
 */
export function deskWaitText(e: Pick<DeskEntry, "row" | "state">, now: Date): string | null {
  const b = e.row;
  if ((e.state === "en-atencion" || e.state === "atendido") && b.arrivedAt && b.attendingAt) {
    const waited = Math.floor((new Date(b.attendingAt).getTime() - new Date(b.arrivedAt).getTime()) / 60_000);
    if (waited <= 0) return null;
  }
  return waitText(b, e.state, now);
}

function ServiceBar({ row, small = false }: { row: Pick<BookingDTO, "serviceColor">; small?: boolean }) {
  return (
    <i
      className="dl-svc-bar"
      data-small={small ? "true" : undefined}
      aria-hidden="true"
      style={{ background: row.serviceColor ?? SERVICE_COLOR_FALLBACK }}
    />
  );
}

const DeskListRow = memo(
  function DeskListRow({ entry: e, pro, room, late, wait, anchor, just }: { sig: string; entry: DeskEntry } & RowView) {
    const b = e.row;
    const past = e.state === "atendido" || e.state === "ausente";
    return (
      <tr
        className="dl-row"
        data-row={b.id}
        data-past={past ? "true" : undefined}
        data-anchor={anchor ? "true" : undefined}
        data-just={just ? "true" : undefined}
      >
        <td className="c-time">
          <span className="dl-time desk-mono">{fmtHour(new Date(b.scheduledFor))}</span>
        </td>
        <td className="c-pat">
          <div className="dl-pat">
            <span className="dl-name" title={b.patientName}>{b.patientName}</span>
            <span className="dl-sub">
              {/* Primero: la sublínea corta con overflow y las iniciales son lo que la Secretaria escanea. */}
              <span className="dl-sub-pro" title={pro.name}>
                <span aria-hidden="true">{pro.initials}</span>
                <span className="desk-sr">{pro.name}</span>
              </span>
              <span className="dl-sub-svc">
                <ServiceBar row={b} small />
                <span>{b.serviceName}</span>
              </span>
              {b.obraSocial ? <span className="dl-os">{b.obraSocial}</span> : null}
              {b.isOverbooked ? <span className="dl-flag">Sobreturno</span> : null}
              {room ? <span className="dl-sub-room">{room}</span> : null}
            </span>
          </div>
        </td>
        <td className="c-svc">
          <span className="dl-svc">
            <ServiceBar row={b} />
            <span>{b.serviceName}</span>
          </span>
        </td>
        <td className="c-pro">
          <span className="dl-av" title={pro.name} aria-label={pro.name} role="img">
            {pro.initials}
          </span>
        </td>
        <td className="c-room">{room ?? <span aria-hidden="true">—</span>}</td>
        <td className="c-state">
          <DeskStateTag entry={e} />
        </td>
        <td className="c-wait">
          <span className="dl-wait desk-mono" data-late={late ? "true" : undefined} title={late ? "Ya pasó la hora del turno" : undefined}>
            {wait ?? "—"}
          </span>
        </td>
        <td className="c-act">
          <span className="desk-acts">
            <DeskPrimaryAction entry={e} />
            <DeskMenu entry={e} />
          </span>
        </td>
      </tr>
    );
  },
  (a, b) => a.sig === b.sig
);

// ── Panel ────────────────────────────────────────────────────────────────────

function PanelCard({
  id,
  title,
  count,
  note,
  extra,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  note?: string;
  /** Va a la derecha del header (el total de «Por cobrar»): a 680 de alto un footer le comía la única fila visible. */
  extra?: JSX.Element | null;
  empty: string;
  children: JSX.Element[];
}) {
  return (
    <section className="dl-card dl-panel" data-card={id} aria-labelledby={`dl-h-${id}`}>
      <div className="dl-card-h">
        <h2 id={`dl-h-${id}`}>{title}</h2>
        <span className="dl-count">{count}</span>
        {note ? <span className="dl-note">{note}</span> : null}
        {extra ?? null}
      </div>
      <div className="dl-scroll">
        {children.length > 0 ? (
          <ul className="dl-items" role="list">
            {children}
          </ul>
        ) : (
          <p className="dl-empty">{empty}</p>
        )}
      </div>
    </section>
  );
}

type ProOf = (id: string) => SalaPractitioner;

function WaitingCard({
  entries,
  now,
  pro,
  roomById,
}: {
  entries: ReadonlyArray<DeskEntry>;
  now: Date;
  pro: ProOf;
  roomById: SalaLive["roomById"];
}) {
  const list = waitingEntries(entries, now);
  return (
    <PanelCard id="wait" title="Sala de espera" count={list.length} note="por orden de llegada" empty="Nadie en la sala por ahora.">
      {list.map((e) => {
        const b = e.row;
        const late = pastScheduled(e, now);
        const called = e.state === "llamado";
        // [RX-Z FX-A] Desde la llegada, también para el LLAMADO: `waitingMinutes` no viene en ese estado (el tag
        // muestra los minutos desde el llamado) y la card decía «0' espera» con el paciente 20' en la sala.
        const w = e.waitingMinutes ?? minutesSince(b.arrivedAt, now);
        const room = roomNameOf(roomById, b);
        return (
          <li key={b.id} className="dl-it dl-wt" data-row={b.id} data-called={called ? "true" : undefined} data-late={late ? "true" : undefined}>
            <div className="dl-it-txt">
              <div className="dl-it-name" title={b.patientName}>{b.patientName}</div>
              <div className="dl-it-meta">
                <span className="desk-mono">{fmtHour(new Date(b.scheduledFor))}</span> · {pro(b.practitionerId).name}
                {called ? (
                  <>
                    {" · "}
                    <span className="dl-called">llamado {fmtMinutes(e.calledMinutes ?? 0)}</span>
                  </>
                ) : late ? (
                  <>
                    {" · "}
                    <span className="dl-lt">pasó la hora</span>
                  </>
                ) : room ? (
                  <> · {room}</>
                ) : null}
              </div>
            </div>
            <div className="dl-wt-wait">
              <b className="desk-mono">{fmtMinutes(w)}</b>
              <span>espera</span>
            </div>
            <span className="desk-acts">
              <DeskPrimaryAction entry={e} />
            </span>
            <span className="dl-meter" data-late={late ? "true" : undefined} aria-hidden="true">
              <i style={{ width: `${Math.round(waitFill(w) * 100)}%` }} />
            </span>
          </li>
        );
      })}
    </PanelCard>
  );
}

function SoonCard({ entries, now, pro }: { entries: ReadonlyArray<DeskEntry>; now: Date; pro: ProOf }) {
  const list = soonEntries(entries, now);
  return (
    <PanelCard id="soon" title="Próximos 30 min" count={list.length} empty="No llega nadie en la próxima media hora.">
      {list.map((e) => {
        const b = e.row;
        const lateTxt = e.state === "demorado";
        return (
          <li key={b.id} className="dl-it" data-row={b.id} data-late={lateTxt ? "true" : undefined}>
            <div className="dl-it-txt">
              <div className="dl-it-name" title={b.patientName}>
                {b.patientName}
                {b.isOverbooked ? <span className="dl-flag">Sobreturno</span> : null}
              </div>
              <div className="dl-it-meta">
                <span className="desk-mono">{fmtHour(new Date(b.scheduledFor))}</span> ·{" "}
                {lateTxt ? (
                  <span className="dl-lt">demorado {fmtMinutes(e.lateMinutes ?? Math.max(0, -minutesUntil(b, now)))}</span>
                ) : (
                  <>en {fmtMinutes(Math.max(0, minutesUntil(b, now)))}</>
                )}{" "}
                · {pro(b.practitionerId).name}
              </div>
            </div>
            <span className="desk-acts">
              <DeskPrimaryAction entry={e} />
            </span>
          </li>
        );
      })}
    </PanelCard>
  );
}

function CashCard({ entries, pro }: { entries: ReadonlyArray<DeskEntry>; pro: ProOf }) {
  const { entries: list, totalCents } = cashEntries(entries);
  return (
    <PanelCard
      id="cash"
      title="Por cobrar"
      count={list.length}
      empty="No hay cobros pendientes."
      extra={
        list.length > 0 ? (
          <span className="dl-cash-total">
            <span className="desk-sr">Total pendiente: </span>
            <b className="desk-mono">{formatARS(totalCents)}</b>
          </span>
        ) : null
      }
    >
      {list.map((e) => {
        const b = e.row;
        const what = !b.obraSocial || b.obraSocial === "Particular" ? "Sesión particular" : `Copago ${b.obraSocial}`;
        return (
          <li key={b.id} className="dl-it dl-cash" data-row={b.id}>
            <div className="dl-it-txt">
              <div className="dl-it-name" title={b.patientName}>{b.patientName}</div>
              <div className="dl-it-meta" title={`${what} · ${pro(b.practitionerId).name}`}>
                {what} · {pro(b.practitionerId).name}
              </div>
            </div>
            <span className="desk-acts">
              <span className="dl-amount desk-mono">{formatARS(b.copagoCents)}</span>
              <DeskPrimaryAction entry={e} />
            </span>
          </li>
        );
      })}
    </PanelCard>
  );
}

function AttendingCard({
  entries,
  now,
  pro,
  roomById,
}: {
  entries: ReadonlyArray<DeskEntry>;
  now: Date;
  pro: ProOf;
  roomById: SalaLive["roomById"];
}) {
  const list = attendingEntries(entries, now);
  return (
    <PanelCard id="attending" title="En atención" count={list.length} empty="Nadie en atención por ahora.">
      {list.map((e) => {
        const b = e.row;
        const room = roomNameOf(roomById, b);
        const inside = b.attendingAt ? minutesSince(b.attendingAt, now) : null;
        return (
          <li key={b.id} className="dl-it dl-wt" data-row={b.id}>
            <div className="dl-it-txt">
              <div className="dl-it-name" title={b.patientName}>{b.patientName}</div>
              <div className="dl-it-meta">
                <span className="desk-mono">{fmtHour(new Date(b.scheduledFor))}</span> · {pro(b.practitionerId).name}
                {room ? <> · {room}</> : null}
              </div>
            </div>
            <div className="dl-wt-wait">
              {inside != null ? <b className="desk-mono">{fmtMinutes(inside)}</b> : null}
              <span>adentro</span>
            </div>
            <span className="desk-acts">
              <DeskPrimaryAction entry={e} />
            </span>
          </li>
        );
      })}
    </PanelCard>
  );
}

// ── CSS ──────────────────────────────────────────────────────────────────────

/*
 * Mismo patrón que `DESK_CSS`: un <style> con tokens, SIN `<`, `>`, comillas ni `&` (React los escapa adentro de
 * <style> en el HTML del server; un test lo fija), así que los selectores de atributo van sin comillas y nada de
 * `grid-template-areas`. Solo tokens de globals.css, sin colores literales: la línea de «ahora» usa `--now-line` (el
 * mismo token que la línea de la agenda, RX-Z; el ámbar de demora la confundía con un turno demorado).
 *
 * Alto (§4.4): `.dl` llena `.desk-body` (que ya calza en la ventana); la franja es `auto` y lo que se achica con
 * menos alto son la tabla y las cards del panel, que scrollean adentro. Ancho por container queries sobre `.desk`
 * (`container: desk`, desk-css.ts): wide todo; compact (≤ 1179) panel de 272, sin Servicio, Profesional, Sala ni
 * Espera (servicio, sala e iniciales pasan a la sublínea; la espera ya está en el tag «En sala 8'»); stack (≤ 719)
 * una columna con scroll de página, el panel arriba (la sala de espera primero) y la tabla en cards de tres líneas.
 *
 * [RX-Z FX-A] Por qué los anchos fijos del compact son esos: con `table-layout: fixed` y padding fuera del `width`
 * (content-box), a 1024 con el sidebar abierto las columnas fijas sumaban más que la tabla y Paciente quedaba en 0 px
 * (desaparecía el nombre). `box-sizing: border-box` en th/td + Profesional a la sublínea le devuelven ~200 px. Las
 * columnas que se esconden van a ancho 0 + `visibility: hidden` y NO con `display: none`: la fila de «ahora» tiene
 * `colSpan={8}` y con columnas en `display: none` la tabla fija creaba columnas fantasma vacías que se comían el
 * sobrante (la tabla ocupaba la mitad de la card y Paciente quedaba angosto).
 */
const EASE = `cubic-bezier(${EASE_OUT.join(",")})`;
const T_FAST = `${DUR.fast}s ${EASE}`;
const SIDEBAR_PX = 64;

const LIST_COMPACT = `
.dl { grid-template-columns: minmax(0, 1fr) 272px; }
.dl-table .c-svc, .dl-table .c-pro, .dl-table .c-room, .dl-table .c-wait { width: 0; padding: 0; overflow: hidden; visibility: hidden; }
.dl-sub-svc, .dl-sub-room, .dl-sub-pro { display: inline-flex; }
.dl-table .c-time { width: 52px; padding-left: 12px; }
.dl-table .c-state { width: 104px; }
.dl-table .c-act { width: 132px; }
.dl-card-h { flex-wrap: wrap; row-gap: 4px; }
.dl-chips { margin-left: 0; flex-wrap: wrap; row-gap: 4px; }
.dl-it.dl-wt { grid-template-columns: minmax(0, 1fr) auto; }
.dl-wt .desk-acts { grid-column: 1 / -1; }
.dl-it.dl-cash { grid-template-columns: minmax(0, 1fr); row-gap: 6px; }
.dl-cash .desk-acts { justify-content: space-between; }
.dl-panel .dl-it-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; overflow-wrap: anywhere; line-height: 1.25; }
`;

const LIST_STACK = `
.dl { height: auto; grid-template-columns: minmax(0, 1fr); grid-template-rows: none; }
.dl .desk-strip { grid-column: auto; }
.dl-side { order: 1; grid-template-rows: none; }
.dl-day { order: 2; }
.dl-card { min-height: auto; }
.dl-scroll { overflow: visible; }
.dl-panel .dl-scroll { max-height: none; }
.dl-chip { min-height: 44px; }
.dl-table, .dl-table tbody { display: block; }
.dl-table thead { display: none; }
.dl-table tbody { display: grid; gap: 8px; padding: 8px; }
.dl-row { display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; row-gap: 6px; padding: 8px; border-radius: 12px; border: 1px solid rgba(15,30,51,0.08); background: var(--card-bg); }
.dl-row td { display: block; height: auto; padding: 0; border: 0; width: auto; }
.dl-table .c-svc, .dl-table .c-room, .dl-table .c-wait { display: none; }
.dl-table .c-time { grid-column: 1; grid-row: 1; padding: 0; width: auto; }
.dl-table .c-pat { grid-column: 2 / 4; grid-row: 1; }
.dl-table .c-pro { display: block; visibility: visible; grid-column: 1; grid-row: 2; width: auto; }
.dl-sub-pro { display: none; }
.dl-table .c-state { grid-column: 2 / 4; grid-row: 2; width: auto; min-width: 0; }
.dl-table .c-act { grid-column: 1 / -1; grid-row: 3; width: auto; padding: 0; text-align: left; }
.dl-table .c-act .desk-acts { justify-content: flex-start; }
.dl-now { display: block; padding: 6px 0; }
.dl-now td { display: block; }
.dl-it { min-height: 44px; }
`;

export const DESK_LIST_CSS = `
.dl { height: 100%; min-height: 0; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) 344px; grid-template-rows: auto minmax(0, 1fr); gap: 12px; }
.dl .desk-strip { grid-column: 1 / -1; }

.dl-card { min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--card-bg); border-radius: 14px; border: 1px solid rgba(15,30,51,0.07); box-shadow: 0 1px 2px rgba(15,30,51,0.04); overflow: hidden; }
.dl-card-h { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 12px 8px 14px; border-bottom: 1px solid rgba(15,30,51,0.06); min-width: 0; }
.dl-card-h h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; color: var(--navy-900); }
.dl-count { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: rgba(15,30,51,0.06); font-size: 12px; font-weight: 700; color: var(--navy-700); font-variant-numeric: tabular-nums; }
.dl-note { margin-left: auto; font-size: 12px; color: var(--navy-500); white-space: nowrap; }
.dl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.dl-empty { margin: 0; padding: 20px 14px; color: var(--navy-500); font-size: 13px; text-align: center; }

.dl-chips { display: flex; gap: 4px; margin-left: 8px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.dl-chip { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; background: transparent; font: inherit; font-size: 13px; font-weight: 600; color: var(--navy-500); white-space: nowrap; cursor: pointer; transition: background-color ${T_FAST}, color ${T_FAST}; }
.dl-chip:hover { background: rgba(15,30,51,0.05); color: var(--navy-900); }
.dl-chip[aria-pressed=true] { background: var(--navy-900); color: var(--card-bg); }
.dl-n { font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.75; }
.dl-chip[data-warn=true] .dl-n { color: var(--rc-late-fg); opacity: 1; font-weight: 700; }
.dl-chip[data-warn=true][aria-pressed=true] .dl-n { color: var(--lime-300); }

.dl-table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; }
.dl-table th, .dl-table td { box-sizing: border-box; }
.dl-table th { position: sticky; top: 0; z-index: 2; background: var(--bg-panel); text-align: left; font-size: 11px; font-weight: 650; color: var(--navy-500); text-transform: uppercase; letter-spacing: 0.05em; padding: 8px; border-bottom: 1px solid rgba(15,30,51,0.07); white-space: nowrap; }
.dl-table td { padding: 4px 8px; height: 48px; border-bottom: 1px solid rgba(15,30,51,0.05); vertical-align: middle; color: var(--navy-900); }
.dl-row:hover td { background: var(--bg-panel); }
.dl-row[data-past=true] td { color: var(--navy-500); }
.dl-row[data-past=true] .dl-name { color: var(--navy-700); font-weight: 550; }
.dl-table .c-time { width: 64px; padding-left: 14px; }
.dl-table .c-svc { width: 18%; }
.dl-table .c-pro { width: 44px; }
.dl-table .c-room { width: 104px; }
.dl-table td.c-room { font-size: 13px; color: var(--navy-700); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-table .c-state { width: 128px; }
.dl-table .c-wait { width: 96px; }
.dl-table .c-act { width: 176px; text-align: right; padding-right: 10px; }
.dl-time { font-size: 14px; font-weight: 500; }
.dl-pat { display: grid; gap: 2px; min-width: 0; }
.dl-name { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--navy-900); }
.dl-sub { display: flex; gap: 6px; align-items: center; min-width: 0; overflow: hidden; font-size: 12px; color: var(--navy-500); white-space: nowrap; }
.dl-sub-svc, .dl-sub-room, .dl-sub-pro { display: none; align-items: center; gap: 6px; min-width: 0; }
.dl-sub-pro { flex-shrink: 0; height: 18px; padding: 0 5px; border-radius: 9px; background: rgba(15,30,51,0.07); font-size: 10px; font-weight: 700; letter-spacing: 0.02em; color: var(--navy-700); }
.dl-sub-svc span { overflow: hidden; text-overflow: ellipsis; }
.dl-os { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11px; font-weight: 600; color: var(--navy-500); background: rgba(15,30,51,0.05); white-space: nowrap; }
.dl-flag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11px; font-weight: 650; color: var(--navy-900); border: 1px dashed rgba(15,30,51,0.3); white-space: nowrap; }
.dl-svc { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; color: var(--navy-700); }
.dl-svc span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-svc-bar { display: block; flex-shrink: 0; width: 4px; height: 22px; border-radius: 2px; }
.dl-svc-bar[data-small=true] { height: 14px; }
.dl-av { width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 10px; font-weight: 700; letter-spacing: 0.02em; background: rgba(15,30,51,0.07); color: var(--navy-700); }
.dl-wait { display: block; font-size: 13px; color: var(--navy-700); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-wait[data-late=true] { color: var(--rc-late-fg); font-weight: 650; }

.dl-now td { height: 0; padding: 0; border: 0; position: relative; }
.dl-now-rule { position: relative; height: 0; border-top: 2px solid var(--now-line); }
.dl-now-rule span { position: absolute; left: 10px; top: -10px; height: 18px; padding: 0 6px; border-radius: 6px; background: var(--now-line); color: var(--card-bg); font-size: 11px; font-weight: 700; line-height: 18px; }

@keyframes dl-pulse { from { box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--lime-400) 60%, transparent); } to { box-shadow: inset 0 0 0 999px transparent; } }
.dl-row[data-just=true] td { animation: dl-pulse 600ms ${EASE} 1; }

.dl-side { min-height: 0; min-width: 0; display: grid; grid-template-rows: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.dl-panel .dl-scroll { min-height: 56px; }
.dl-items { list-style: none; margin: 0; padding: 4px; display: grid; gap: 2px; align-content: start; }
.dl-it { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 8px 8px 10px; border-radius: 10px; position: relative; }
.dl-it:hover { background: var(--bg-panel); }
.dl-it.dl-wt { grid-template-columns: minmax(0, 1fr) auto auto; padding-bottom: 11px; }
.dl-it-txt { min-width: 0; }
.dl-it-name { display: flex; gap: 6px; align-items: center; font-weight: 650; font-size: 14px; color: var(--navy-900); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-it-meta { margin-top: 2px; font-size: 12px; color: var(--navy-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dl-it[data-called=true] { background: var(--rc-insala-bg); box-shadow: inset 3px 0 0 var(--rc-called-bg); }
.dl-it[data-late=true] .dl-lt, .dl-lt { color: var(--rc-late-fg); font-weight: 650; }
.dl-called { color: var(--rc-called-bg); font-weight: 650; }
.dl-wt-wait { display: grid; justify-items: end; line-height: 1.1; }
.dl-wt-wait b { font-size: 16px; font-weight: 600; color: var(--navy-900); }
.dl-wt-wait span { font-size: 11px; color: var(--navy-500); }
.dl-it[data-late=true] .dl-wt-wait b { color: var(--rc-late-fg); }
.dl-meter { position: absolute; left: 10px; right: 10px; bottom: 3px; height: 3px; border-radius: 2px; background: rgba(15,30,51,0.06); overflow: hidden; }
.dl-meter i { display: block; height: 100%; border-radius: 2px; background: var(--lime-500); }
.dl-meter[data-late=true] i { background: var(--rc-late-fg); }
.dl-amount { font-size: 14px; font-weight: 600; color: var(--navy-900); white-space: nowrap; }
.dl-cash-total { margin-left: auto; white-space: nowrap; }
.dl-cash-total b { font-size: 15px; font-weight: 650; color: var(--navy-900); }

@container desk (max-width: ${DESK_COMPACT_MAX}px) {${LIST_COMPACT}}
@container desk (max-width: ${DESK_STACK_MAX}px) {${LIST_STACK}}
@supports not (container-type: inline-size) {
  @media (max-width: ${DESK_COMPACT_MAX + SIDEBAR_PX}px) {${LIST_COMPACT}}
  @media (max-width: ${DESK_STACK_MAX + SIDEBAR_PX}px) {${LIST_STACK}}
}

@media (prefers-reduced-motion: reduce) {
  .dl-chip { transition: none; }
  .dl-row[data-just=true] td { animation: none; }
}
`;
