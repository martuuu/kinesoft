"use client";

import { memo, useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { fmtHour, roomNameOf, type BookingDTO } from "@/components/agenda/agenda-utils";
import { toARMinutes } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { fmtMinutes } from "@/lib/reception-view-state";
import { filterByQuery } from "@/lib/sala-board-state";
import {
  attendingEntries,
  cashEntries,
  chronological,
  minutesSince,
  minutesUntil,
  nowLineIndex,
  pastScheduled,
  scrollAnchorIndex,
  soonEntries,
  waitFill,
  waitingEntries,
  type DeskEntry,
} from "@/lib/reception-desk-state";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { DESK_COMPACT_MAX, DESK_STACK_MAX } from "./desk-css";
import { DeskMenu, DeskPrimaryAction, DeskStateTag, deskRowLabel, useDeskActions } from "./desk-actions";
import { DeskStrip } from "./desk-strip";

/*
 * B · «Flujo» (RX-2b, brief RX §1.3 y §4.4; prototipo `design_source/vx0/recepcion.html` `boardB`).
 *
 *   ┌ Hoy ───────┐┌ franja de profesionales (DeskStrip) ─────────────────┐
 *   │ 09 h       │├ Llegan pronto ┬ Sala de espera ┬ Por cobrar        ┤
 *   │ 09:00 …    ││ tickets       │ tickets        │ (o En atención)   │
 *   │ ── 10:42 ──││ (scroll       │ (scroll        │ (scroll           │
 *   │ 11:00 …    ││  propio)      │  propio)       │  propio)          │
 *   └────────────┘└───────────────┴────────────────┴───────────────────┘
 *
 * Qué decide esta cara y por qué:
 *   - Línea de tiempo «Hoy» CRONOLÓGICA (`chronological`: hora, profesional, id), no la de `sortForReception` (que
 *     pone «en atención» arriba): la Secretaria lee el día como el día. Sin cancelados (no son trabajo de la
 *     recepción; misma base que el total de los KPIs). La marca de «ahora» va antes del primer turno que empieza
 *     ahora o después (`nowLineIndex`); si ya no quedan, al final. Al abrir, scroll a 3 turnos antes de la marca
 *     (`scrollAnchorIndex`), una sola vez por día: después no se le mueve la lista a quien la está leyendo.
 *   - Carriles: «Llegan pronto» = demorados + por llegar en ≤ 30' (`soonEntries`); «Sala de espera» = llamados
 *     primero y después por orden de LLEGADA (`waitingEntries`); el tercero es «Por cobrar» con el total
 *     (`cashEntries`) SOLO con `billing.manage` (RX-D4: la Secretaria no cobra). Para quien no cobra, el tercero es
 *     «En atención» (quién está en cada box y hace cuánto).
 *   - Ticket de la sala: además de la primaria («Llamar»), «En atención» como secundaria (saltear el llamado: el
 *     paciente entra directo porque el box estaba libre). Solo si el rol la permite (`salaActions`). En compacto se
 *     esconde (sigue en el menú ⋯): a 1024 no entran tres botones en un carril de ~200 px.
 *   - Buscador y franja FILTRAN las cuatro listas (prototipo `visible()`). Sin resaltado en la línea de tiempo:
 *     con la búsqueda activa TODAS las filas visibles coinciden (el filtro ya sacó las otras), así que pintarlas
 *     de lima era pintar toda la lista (RX-Z #8).
 *   - Densidad (40-60 turnos, reloj cada 30 s): filas y tickets van memoizados por una firma de lo que pintan
 *     (`flowRowSig`, mismo patrón que `deskRowSig` de A). Las acciones leen el contexto del shell y se refrescan
 *     solas (RX-Z #10).
 *   - Acciones: `DeskPrimaryAction` y `DeskMenu` (conectadas por el shell con `DeskActionsProvider`): esta cara no
 *     recibe callbacks. La única acción propia es la secundaria, que llama al mismo `run` del shell (toast con
 *     «Deshacer» incluido).
 *
 * Color (AGENTS §5): la barra lateral del ticket y el punto de la línea de tiempo son el SERVICIO; el fondo es el
 * estado (llamado azul, demorado ámbar); el profesional va con iniciales, nunca con color.
 *
 * PD-13: se lee nombre, hora, obra social, sobreturno, sala, servicio (color) y copago. Nunca `title`, `notes`,
 * `description` ni `patientCondition` (el render test pasa filas con esos campos llenos).
 */

/** Ancho del sidebar colapsado: el fallback por viewport (sin container queries) suma esto, igual que DESK_CSS. */
const SIDEBAR_PX = 64;

const COMPACT_RULES = `
.desk-flow { grid-template-columns: 236px minmax(0, 1fr); }
.desk-flow .desk-pro { grid-template-columns: minmax(0, 1fr); padding: 8px 10px; }
.desk-flow .desk-pro .desk-av { display: none; }
.desk-flow-sec { display: none; }
.desk-tk { padding: 8px 8px 8px 12px; gap: 6px; }
.desk-tk-late-txt { display: none; }
.desk-tk-a .desk-act { padding: 0 8px; }
.desk-tl-row .desk-av-sm { display: none; }
`;

/*
 * 1024 con el sidebar abierto deja ~764 px de contenedor (RX-Z #9): con 236 px de «Hoy» los tres carriles quedan
 * de ~160 px y los nombres se cortan a 6 letras. Entre 720 y 860 el día baja a 200 px (las iniciales ya no están
 * en la fila: siguen en el texto para lector de pantalla). A 200 px un tag «Demorado 27'» deja el nombre en una
 * letra (re-captura de RX-Z): el tag baja a una segunda línea debajo del nombre. Las aclaraciones de texto de los
 * carriles («30 min», «por entrada») se esconden; el total de «Por cobrar» no.
 */
const NARROW_MAX = 860;
const NARROW_RULES = `
.desk-flow { grid-template-columns: 200px minmax(0, 1fr); }
.desk-tl-row { grid-template-columns: 40px minmax(0, 1fr); row-gap: 2px; padding: 4px 6px; }
.desk-tl-s { grid-column: 2; }
.desk-tl-s:empty { display: none; }
.desk-flow-sub[data-hint=true] { display: none; }
`;

const STACK_RULES = `
.desk-flow { display: flex; flex-direction: column; height: auto; }
.desk-flow-main { display: contents; }
.desk-flow-lanes { display: flex; flex-direction: column; }
.desk-flow-day { order: 5; max-height: 60vh; }
.desk-flow-lane .desk-flow-scroll { overflow: visible; }
.desk-tl-row { min-height: 44px; grid-template-columns: 44px minmax(0, 1fr) auto; padding: 0 6px; }
.desk-tl-s { grid-column: auto; }
.desk-flow-sec { display: inline-flex; }
`;

export const DESK_FLOW_CSS = `
.desk-flow { display: grid; grid-template-columns: 272px minmax(0, 1fr); gap: 12px; height: 100%; min-height: 0; min-width: 0; }
.desk-flow-main { display: flex; flex-direction: column; gap: 12px; min-height: 0; min-width: 0; }
.desk-flow-main .desk-strip { flex: 0 0 auto; }
.desk-flow-lanes { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.desk-flow-card { display: flex; flex-direction: column; min-height: 0; min-width: 0; overflow: hidden; background: var(--card-bg); border-radius: 14px; border: 1px solid rgba(15,30,51,0.07); box-shadow: 0 1px 2px rgba(15,30,51,0.04); }
.desk-flow-h { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 10px 12px 10px 14px; border-bottom: 1px solid rgba(15,30,51,0.06); }
.desk-flow-h h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; white-space: nowrap; }
.desk-flow-count { display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 999px; background: rgba(15,30,51,0.06); font-size: 12px; font-weight: 700; color: var(--navy-700); font-variant-numeric: tabular-nums; }
.desk-flow-sub { margin-left: auto; font-size: 12px; color: var(--navy-500); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk-flow-sub b { color: var(--navy-900); font-weight: 650; }
.desk-flow-scroll { position: relative; flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.desk-flow-empty { padding: 20px 14px; color: var(--navy-500); font-size: 13px; text-align: center; list-style: none; }

.desk-tl { list-style: none; margin: 0; padding: 4px 6px; }
.desk-tl-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 36px; padding: 0 6px; border-radius: 8px; font-size: 13px; }
.desk-tl-row:hover { background: var(--bg-panel); }
.desk-tl-t { font-size: 12px; color: var(--navy-500); }
.desk-tl-n { display: flex; gap: 6px; align-items: center; min-width: 0; }
.desk-tl-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: var(--navy-900); }
.desk-tl-row[data-past=true] .desk-tl-name { color: var(--navy-500); font-weight: 500; }
.desk-tl-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.desk-tl-row .desk-tag { height: 20px; font-size: 11px; padding: 0 7px; }
.desk-tl-hour { min-height: 26px; padding: 8px 6px 0; font-size: 11px; font-weight: 650; line-height: 1; color: var(--navy-400); text-transform: uppercase; letter-spacing: 0.06em; }
.desk-tl-now { position: relative; height: 2px; margin: 10px 0; background: var(--now-line); }
.desk-tl-now span { position: absolute; left: 0; top: -9px; height: 18px; padding: 0 6px; border-radius: 6px; background: var(--now-line); color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; }
.desk-av-sm { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 9px; font-weight: 700; letter-spacing: 0.02em; background: transparent; color: var(--navy-700); box-shadow: inset 0 0 0 1px rgba(15,30,51,0.2); }

.desk-flow-lane .desk-flow-scroll { margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 8px; list-style: none; }
.desk-tk { flex-shrink: 0; position: relative; overflow: hidden; display: grid; gap: 8px; padding: 10px 10px 10px 14px; border-radius: 12px; border: 1px solid rgba(15,30,51,0.08); background: var(--card-bg); }
.desk-tk-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 4px; }
.desk-tk[data-state=llamado] { background: var(--bg-panel); border-color: var(--rc-called-bg); box-shadow: inset 0 0 0 1px var(--rc-called-bg); }
.desk-tk[data-state=demorado] { background: var(--rc-late-bg); border-color: var(--rc-late-border); }
.desk-tk-h { display: flex; align-items: center; gap: 8px; min-width: 0; }
.desk-tk-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 650; color: var(--navy-900); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk-tk-time { font-size: 13px; font-weight: 500; color: var(--navy-700); }
.desk-tk-amount { font-size: 15px; font-weight: 600; color: var(--navy-900); }
.desk-tk-m { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; font-size: 12px; color: var(--navy-500); }
.desk-tk-room { white-space: nowrap; }
.desk-tk-meta { flex-wrap: nowrap; }
.desk-tk-pro { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desk-tk-meta .desk-tk-room { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.desk-tk-end { margin-left: auto; }
.desk-tk-m .desk-tag { height: 20px; font-size: 11px; padding: 0 7px; }
.desk-flag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 6px; font-size: 11px; font-weight: 650; background: var(--st-pending-bg); color: var(--st-pending-fg); }
.desk-tk-wait { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-size: 12px; color: var(--navy-500); }
.desk-tk-wait b { font-size: 15px; font-weight: 600; line-height: 1; color: var(--navy-900); }
.desk-tk[data-late-wait=true] .desk-tk-wait b, .desk-tk-late-txt { color: var(--rc-late-fg); }
.desk-tk-late-txt { font-weight: 600; }
.desk-meter { height: 4px; border-radius: 2px; background: rgba(15,30,51,0.06); overflow: hidden; }
.desk-meter i { display: block; height: 100%; border-radius: 2px; background: var(--lime-500); }
.desk-meter[data-late=true] i { background: var(--rc-late-fg); }
.desk-tk-a { display: flex; gap: 6px; align-items: center; min-width: 0; }
.desk-tk-a .desk-act { flex: 1 1 0; min-width: 0; }
.desk-tk-a .desk-act[data-kind=more] { flex: 0 0 36px; }
.desk-tk-a .desk-paid { flex: 1 1 0; }

@container desk (max-width: ${DESK_COMPACT_MAX}px) {${COMPACT_RULES}}
@container desk (max-width: ${NARROW_MAX}px) {${NARROW_RULES}}
@container desk (max-width: ${DESK_STACK_MAX}px) {${STACK_RULES}}
@supports not (container-type: inline-size) {
  @media (max-width: ${DESK_COMPACT_MAX + SIDEBAR_PX}px) {${COMPACT_RULES}}
  @media (max-width: ${NARROW_MAX + SIDEBAR_PX}px) {${NARROW_RULES}}
  @media (max-width: ${DESK_STACK_MAX + SIDEBAR_PX}px) {${STACK_RULES}}
}

@keyframes desk-flow-just { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--lime-400) 60%, transparent); } to { box-shadow: 0 0 0 8px color-mix(in srgb, var(--lime-400) 0%, transparent); } }
@media (prefers-reduced-motion: no-preference) {
  .desk-tk[data-just=true] { animation: desk-flow-just 600ms ease-out 1; }
}
@media (prefers-reduced-motion: reduce) {
  .desk-tk[data-just=true] { animation: none; }
}
`;

// ── Lógica de la línea de tiempo (pura, exportada para el test) ──────────────

export type FlowTimelineItem<E> =
  | { kind: "hour"; key: string; hour: number }
  | { kind: "now"; key: "now" }
  | { kind: "row"; key: string; entry: E; anchor: boolean };

/**
 * Ítems de la línea de tiempo: separador por hora AR («09 h»), la marca de «ahora» antes del primer turno que
 * empieza ahora o después (al final si ya no quedan; nada si el día está vacío) y las filas. `anchor` = la fila a
 * la que se scrollea al abrir (3 turnos antes de la marca). Las horas son del reloj AR (`toARMinutes`), nunca del
 * host: un turno a las 23:30 AR en un host UTC sigue siendo «23 h».
 */
export function flowTimeline<E extends { row: BookingDTO }>(sorted: ReadonlyArray<E>, now: Date): FlowTimelineItem<E>[] {
  const out: FlowTimelineItem<E>[] = [];
  if (sorted.length === 0) return out;
  const nowIdx = nowLineIndex(sorted, now);
  const anchorIdx = scrollAnchorIndex(nowIdx);
  let lastHour = -1;
  sorted.forEach((e, i) => {
    if (i === nowIdx) out.push({ kind: "now", key: "now" });
    const h = Math.floor(toARMinutes(e.row.scheduledFor) / 60);
    if (h !== lastHour) {
      out.push({ kind: "hour", key: `h${h}`, hour: h });
      lastHour = h;
    }
    out.push({ kind: "row", key: e.row.id, entry: e, anchor: i === anchorIdx });
  });
  if (nowIdx === -1) out.push({ kind: "now", key: "now" });
  return out;
}

/** «Particular» paga la sesión entera; con obra social, el copago. */
function cashKind(obraSocial: string | null | undefined): "Sesión" | "Copago" {
  return !obraSocial || obraSocial.trim().toLowerCase() === "particular" ? "Sesión" : "Copago";
}

// ── Componente ───────────────────────────────────────────────────────────────

export type ProInfo = { name: string; initials: string };

/**
 * B · «Flujo» (C-RX5). Ver la cabecera del archivo.
 */
export function DeskFlow({
  live,
  query,
  proFilter,
  onProFilter,
}: {
  live: SalaLive;
  query: string;
  proFilter: string | null;
  onProFilter(id: string | null): void;
}): JSX.Element {
  const now = live.clock;
  const canCollect = live.viewer.canCollect;

  const pros = useMemo(() => {
    const m = new Map<string, ProInfo>();
    for (const p of live.practitioners) m.set(p.id, { name: p.name, initials: p.initials });
    return m;
  }, [live.practitioners]);
  const proOf = (id: string): ProInfo => pros.get(id) ?? { name: "Profesional", initials: "?" };

  const trimmed = query.trim();
  const visible = useMemo(() => {
    const hits = new Set(filterByQuery(live.rows, trimmed).map((r) => r.id));
    return live.entries.filter(
      (e) => e.state !== "cancelado" && hits.has(e.row.id) && (proFilter == null || e.row.practitionerId === proFilter)
    );
  }, [live.entries, live.rows, trimmed, proFilter]);

  const timeline = useMemo(() => flowTimeline(chronological(visible), now), [visible, now]);
  const soon = useMemo(() => soonEntries(visible, now), [visible, now]);
  const waiting = useMemo(() => waitingEntries(visible, now), [visible, now]);
  const cash = useMemo(() => (canCollect ? cashEntries(visible) : null), [visible, canCollect]);
  const attending = useMemo(() => (canCollect ? [] : attendingEntries(visible, now)), [visible, now, canCollect]);
  const done = visible.filter((e) => e.state === "atendido" || e.state === "ausente").length;

  // Scroll inicial a la marca de «ahora» (3 turnos de contexto), una vez por día y con datos: un re-render del
  // reloj (cada 30 s) no le mueve la lista a quien está leyendo.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const hasRows = timeline.length > 0;
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || live.loading || !hasRows || scrolledFor.current === live.dayKey) return;
    scrolledFor.current = live.dayKey;
    const anchor = box.querySelector<HTMLElement>("[data-anchor=true]");
    box.scrollTop = anchor ? anchor.offsetTop - 4 : box.scrollHeight;
  }, [live.dayKey, live.loading, hasRows]);

  const loadingText = "Cargando los turnos de hoy…";
  const dayEmpty = live.loading
    ? loadingText
    : trimmed
      ? `Ningún turno de hoy coincide con «${trimmed}».`
      : proFilter
        ? "Este profesional no tiene turnos hoy."
        : "Hoy no hay turnos.";
  const empty = (text: string) => (live.loading ? loadingText : text);

  const ids = useId();
  const tlId = `${ids}-tl`;

  const view = (e: DeskEntry, minutes: number | null, extra: Partial<Pick<FlowView, "late" | "anchor" | "just">> = {}): FlowView => ({
    pro: proOf(e.row.practitionerId),
    room: roomNameOf(live.roomById, e.row),
    minutes,
    late: extra.late ?? false,
    anchor: extra.anchor ?? false,
    just: extra.just ?? false,
  });
  const ticket = (kind: TicketKind, e: DeskEntry, v: FlowView) => (
    <FlowTicket key={e.row.id} sig={flowRowSig(e, v)} kind={kind} entry={e} view={v} />
  );

  return (
    <div className="desk-face desk-flow" data-face="flow">
      <style>{DESK_FLOW_CSS}</style>

      <section className="desk-flow-card desk-flow-day" aria-labelledby={tlId}>
        <div className="desk-flow-h">
          <h2 id={tlId}>Hoy</h2>
          <span className="desk-flow-count">{visible.length}</span>
          <span className="desk-flow-sub">{done} terminados</span>
        </div>
        <div className="desk-flow-scroll" ref={scrollRef}>
          {timeline.length === 0 ? (
            <p className="desk-flow-empty">{dayEmpty}</p>
          ) : (
            <ul className="desk-tl" role="list">
              {timeline.map((it) => {
                if (it.kind === "hour") {
                  return (
                    <li key={it.key} className="desk-tl-hour" aria-hidden="true">
                      {String(it.hour).padStart(2, "0")} h
                    </li>
                  );
                }
                if (it.kind === "now") {
                  const t = fmtHour(now);
                  return (
                    <li key="now" className="desk-tl-now" data-now={t} aria-label={`Ahora, ${t}`}>
                      <span className="desk-mono" aria-hidden="true">
                        {t}
                      </span>
                    </li>
                  );
                }
                const v = view(it.entry, null, { anchor: it.anchor });
                return <TimelineRow key={it.key} sig={flowRowSig(it.entry, v)} entry={it.entry} view={v} />;
              })}
            </ul>
          )}
        </div>
      </section>

      <div className="desk-flow-main">
        <DeskStrip live={live} proFilter={proFilter} onProFilter={onProFilter} />

        <div className="desk-flow-lanes">
          <Lane id={`${ids}-soon`} title="Llegan pronto" sub="30 min" count={soon.length} emptyText={empty("No llega nadie en la próxima media hora.")}>
            {soon.map((e) =>
              ticket("soon", e, view(e, e.state === "demorado" ? null : Math.max(0, minutesUntil(e.row, now)), { just: live.pulseIds.has(e.row.id) }))
            )}
          </Lane>

          <Lane id={`${ids}-sala`} title="Sala de espera" sub="por llegada" count={waiting.length} emptyText={empty("Nadie en la sala por ahora.")}>
            {waiting.map((e) =>
              ticket("wait", e, view(e, minutesSince(e.row.arrivedAt, now), { late: pastScheduled(e, now), just: live.pulseIds.has(e.row.id) }))
            )}
          </Lane>

          {cash ? (
            <Lane
              id={`${ids}-cash`}
              title="Por cobrar"
              sub={cash.entries.length > 0 ? <b className="desk-mono">{formatARS(cash.totalCents)}</b> : null}
              count={cash.entries.length}
              emptyText={empty("No hay cobros pendientes.")}
            >
              {cash.entries.map((e) => ticket("cash", e, view(e, null)))}
            </Lane>
          ) : (
            <Lane id={`${ids}-att`} title="En atención" sub="por entrada" count={attending.length} emptyText={empty("Nadie en atención por ahora.")}>
              {attending.map((e) => ticket("attend", e, view(e, minutesSince(e.row.attendingAt, now))))}
            </Lane>
          )}
        </div>
      </div>
    </div>
  );
}

function Lane({
  id,
  title,
  sub,
  count,
  emptyText,
  children,
}: {
  id: string;
  title: string;
  sub: ReactNode;
  count: number;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <section className="desk-flow-card desk-flow-lane" aria-labelledby={id}>
      <div className="desk-flow-h">
        <h2 id={id}>{title}</h2>
        <span className="desk-flow-count">{count}</span>
        {sub ? (
          <span className="desk-flow-sub" data-hint={typeof sub === "string" || undefined}>
            {sub}
          </span>
        ) : null}
      </div>
      <ul className="desk-flow-scroll" role="list">
        {count === 0 ? <li className="desk-flow-empty">{emptyText}</li> : children}
      </ul>
    </section>
  );
}

// ── Filas y tickets memoizados ───────────────────────────────────────────────

/**
 * Lo que una fila o un ticket pinta además de la entrada: derivado del catálogo (profesional, sala), del reloj
 * (`minutes`: hasta el turno, de espera o en el box; `late`: ya pasó la hora) o de la cara (`anchor`, `just`).
 */
export type FlowView = { pro: ProInfo; room: string | null; minutes: number | null; late: boolean; anchor: boolean; just: boolean };

type TicketKind = "soon" | "wait" | "cash" | "attend";

/**
 * Firma de lo que la fila o el ticket pinta (RX-Z #10, mismo patrón que `deskRowSig` de A): si no cambia, no
 * re-renderiza con cada tick del reloj (30 s) ni con cada cambio de otra fila. Incluye `updatedAt` (lo usa el
 * optimistic lock de las acciones), los minutos que muestra el tag de estado y lo derivado (`FlowView`). Nada
 * clínico (PD-13): lo que no se pinta no entra. Los botones (`DeskPrimaryAction`, `DeskMenu`, secundaria) leen el
 * contexto del shell y se refrescan solos cuando cambia lo suyo (`pendingIds`).
 */
export function flowRowSig(e: DeskEntry, v: FlowView): string {
  const r = e.row;
  return [
    r.id,
    r.updatedAt,
    r.status,
    r.scheduledFor,
    r.durationMin,
    r.arrivedAt ?? "",
    r.calledAt ?? "",
    r.attendingAt ?? "",
    r.patientName,
    r.serviceColor ?? "",
    r.isOverbooked ? "o" : "",
    r.obraSocial ?? "",
    r.copagoCents,
    r.paymentStatus ?? "",
    r.practitionerId,
    r.canOperate ? "c" : "",
    e.state,
    e.waitingMinutes ?? "",
    e.lateMinutes ?? "",
    e.calledMinutes ?? "",
    e.salaActions.join(","),
    v.pro.name,
    v.pro.initials,
    v.room ?? "",
    v.minutes ?? "",
    v.late ? "l" : "",
    v.anchor ? "a" : "",
    v.just ? "j" : "",
  ].join("|");
}

const sameSig = (a: { sig: string }, b: { sig: string }) => a.sig === b.sig;

const TimelineRow = memo(function TimelineRow({ entry: e, view: v }: { sig: string; entry: DeskEntry; view: FlowView }) {
  const b = e.row;
  return (
    <li
      className="desk-tl-row"
      data-row={b.id}
      data-past={e.state === "atendido" || e.state === "ausente" || undefined}
      data-anchor={v.anchor || undefined}
    >
      <span className="desk-tl-t desk-mono">{fmtHour(new Date(b.scheduledFor))}</span>
      <span className="desk-tl-n">
        <span className="desk-tl-dot" aria-hidden="true" style={{ background: b.serviceColor ?? SERVICE_COLOR_FALLBACK }} />
        <span className="desk-tl-name">{b.patientName}</span>
        <span className="desk-av-sm" aria-hidden="true">
          {v.pro.initials}
        </span>
        <span className="desk-sr">, con {v.pro.name}</span>
      </span>
      <span className="desk-tl-s">{e.state === "por-llegar" ? null : <DeskStateTag entry={e} />}</span>
    </li>
  );
}, sameSig);

/**
 * Profesional y sala del ticket, en UNA línea: «· sala» va en un solo span sin corte (el separador nunca queda
 * colgado) y, si no entra, se recortan con «…» el nombre y la sala en vez de bajar la sala a una línea propia.
 */
function FlowMeta({ pro, room }: { pro: ProInfo; room: string | null }) {
  return (
    <div className="desk-tk-m desk-tk-meta">
      <span className="desk-av-sm" aria-hidden="true">
        {pro.initials}
      </span>
      <span className="desk-tk-pro">{pro.name}</span>
      {room ? (
        <span className="desk-tk-room">
          <span aria-hidden="true">·</span> {room}
        </span>
      ) : null}
    </div>
  );
}

const FlowTicket = memo(function FlowTicket({ kind, entry: e, view: v }: { sig: string; kind: TicketKind; entry: DeskEntry; view: FlowView }) {
  const b = e.row;
  const head = (right: ReactNode) => (
    <div className="desk-tk-h">
      <span className="desk-tk-name">{b.patientName}</span>
      {right}
    </div>
  );
  const time = <span className="desk-tk-time desk-mono">{fmtHour(new Date(b.scheduledFor))}</span>;
  const meta = <FlowMeta pro={v.pro} room={v.room} />;
  let content: ReactNode;
  if (kind === "soon") {
    content = (
      <>
        {head(time)}
        {meta}
        <div className="desk-tk-m">
          {b.obraSocial ? <span>{b.obraSocial}</span> : null}
          {b.isOverbooked ? <span className="desk-flag">Sobreturno</span> : null}
          <span className="desk-tk-end">
            {e.state === "demorado" ? <DeskStateTag entry={e} /> : <span className="desk-mono">en {fmtMinutes(v.minutes ?? 0)}</span>}
          </span>
        </div>
      </>
    );
  } else if (kind === "wait") {
    const w = v.minutes ?? 0;
    content = (
      <>
        {head(time)}
        {meta}
        <div className="desk-tk-wait">
          {e.state === "llamado" ? <DeskStateTag entry={e} /> : null}
          <span>
            Espera <b className="desk-mono">{fmtMinutes(w)}</b>
          </span>
          {v.late ? <span className="desk-tk-late-txt">· pasó la hora</span> : null}
        </div>
        <div className="desk-meter" data-late={v.late || undefined} aria-hidden="true">
          <i style={{ width: `${Math.round(waitFill(w) * 100)}%` }} />
        </div>
      </>
    );
  } else if (kind === "cash") {
    const end = new Date(new Date(b.scheduledFor).getTime() + b.durationMin * 60_000);
    content = (
      <>
        {head(<span className="desk-tk-amount desk-mono">{formatARS(b.copagoCents)}</span>)}
        <div className="desk-tk-m">
          {b.obraSocial ? <span>{b.obraSocial}</span> : null}
          <span>
            {cashKind(b.obraSocial)} · terminó {fmtHour(end)}
          </span>
        </div>
        {meta}
      </>
    );
  } else {
    content = (
      <>
        {head(time)}
        {meta}
        <div className="desk-tk-wait">
          <span>
            En atención <b className="desk-mono">{fmtMinutes(v.minutes ?? 0)}</b>
          </span>
        </div>
      </>
    );
  }
  return (
    <li className="desk-tk" data-row={b.id} data-state={e.state} data-late-wait={(kind === "wait" && v.late) || undefined} data-just={v.just || undefined}>
      <span className="desk-tk-bar" aria-hidden="true" style={{ background: b.serviceColor ?? SERVICE_COLOR_FALLBACK }} />
      {content}
      <div className="desk-tk-a">
        <DeskPrimaryAction entry={e} />
        {kind === "wait" ? <AttendNow entry={e} /> : null}
        <DeskMenu entry={e} />
      </div>
    </li>
  );
}, sameSig);

/**
 * «En atención» secundaria del ticket de sala (prototipo `act-attend sec`): saltear el llamado. Solo en «en sala»
 * (en «llamado» ya es la primaria) y si el rol la permite.
 */
function AttendNow({ entry }: { entry: DeskEntry }) {
  const api = useDeskActions();
  if (entry.state !== "en-sala" || !entry.salaActions.includes("en-atencion")) return null;
  return (
    <button
      type="button"
      className="desk-act desk-flow-sec"
      data-kind="attend"
      aria-label={`En atención: ${deskRowLabel(entry.row)}`}
      disabled={api.pendingIds.has(entry.row.id)}
      onClick={() => api.run(entry, "en-atencion")}
    >
      En atención
    </button>
  );
}
