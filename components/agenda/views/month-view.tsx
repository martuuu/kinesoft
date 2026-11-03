"use client";

/**
 * CF2 (§29 D-CF2-7, brief A.4) — vista Mes de la agenda: por día, cuántos turnos tienen los profesionales elegidos y
 * el estado del día (bloqueado, en parte, sin atención). Sin pacientes (D-CF2-7) y sin candado accionable: el clic en
 * un día lo abre en Día, y ahí está el candado de siempre.
 *
 * Datos: `getAgendaMonthSummary` (un resumen compacto por profesional, ≤ 24 kB) en vez de 6 semanas de turnos. Si el
 * `initial` del loader no es de esta grilla y esta sede (navegó de mes, cambió la sede), se pide acá. Los chips filtran
 * en el cliente (el resumen viaja por profesional) y vuelven sus conteos por `onCounts`.
 *
 * Realtime: como la Semana (`agenda-client`), `messagesTouchRange` sobre el rango de la grilla + un coalescer (uno en
 * vuelo, uno pendiente) y `onResync`. A diferencia de la Semana, un mensaje `availability` NO necesita
 * `router.refresh()`: el candado viene en el mismo resumen, así que también se re-pide (y `messagesTouchRange` ya lo
 * cuenta como «toca»). Un re-pedido en vivo no muestra «cargando» ni error: queda lo que se ve hasta el próximo aviso.
 *
 * Se carga con `next/dynamic` CON SSR desde `view-chunks.ts` (lo hace AG2): así la action queda registrada en el
 * manifiesto del server (lección CF-RT) y el first load de /agenda no suma este módulo.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PractitionerBadge } from "../grid/practitioner-badge";
import { useRealtime } from "@/components/providers/realtime-provider";
import { getAgendaMonthSummary } from "@/lib/agenda-month";
import { createRefetchCoalescer, messagesTouchRange, monthGridRange } from "@/lib/agenda-client-state";
import {
  MONTH_WEEKDAY_SHORT,
  monthGridModel,
  monthLabel,
  monthPractitionerCounts,
  monthSummaryMatches,
  type MonthCellModel,
  type MonthGridModel,
  type MonthViewPractitioner,
} from "@/lib/agenda-month-view-state";
import type { DayKey } from "@/lib/availability/types";
import type { AgendaMonthSummary } from "@/lib/agenda-month-types";
import styles from "./month-view.module.css";

export type MonthViewProps = {
  /** Resumen que trajo el loader (`?view=month`); null o de otro rango/sede = se pide al montar. */
  initial: AgendaMonthSummary | null;
  /** Día ancla (`?date=`): define el mes. */
  anchorDayKey: DayKey;
  /** Hoy AR (anillo). */
  todayKey: DayKey;
  /** `[]` = «Todos». */
  selectedPractitionerIds: ReadonlyArray<string>;
  /** En el orden de los chips (iniciales del desglose). */
  practitioners: ReadonlyArray<MonthViewPractitioner>;
  /** Sede elegida (null = todas). Cambiarla re-pide. */
  locationId: string | null;
  /** «Ausentes» ocultos en Opciones de vista (`!visibility.showNoShow`). */
  hideNoShow: boolean;
  /** `agendaPrefs.agendaShowSaturday` / `agendaShowSunday`. */
  showSaturday: boolean;
  showSunday: boolean;
  /** Clic en un día → abrirlo en Día. */
  onPickDay: (dayKey: DayKey) => void;
  /** Turnos por profesional en los días del mes (para los chips). Se llama cada vez que cambia el resumen. */
  onCounts?: (counts: Record<string, number>) => void;
};

const LOAD_ERROR = "No pudimos cargar el mes. Revisá la conexión y probá de nuevo.";

/** Glifo de candado NO interactivo (mismo dibujo que la tira, `week-strip.tsx`: allá es privado). */
function LockGlyph({ status }: { status: "locked" | "partial" }) {
  return (
    <span data-month-lock-glyph={status} className={styles.glyph} aria-hidden="true">
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        <rect x="5" y="11" width="14" height="10" rx="2.5" fill={status === "locked" ? "currentColor" : "none"} />
        {status === "partial" && <path d="M5 16h14v2.5A2.5 2.5 0 0 1 16.5 21h-9A2.5 2.5 0 0 1 5 18.5Z" fill="currentColor" />}
      </svg>
    </span>
  );
}

/**
 * ZB-10: glifo de «Sin atención» (círculo tachado). Antes solo bloqueado/parcial tenían glifo y, en mobile, la palabra
 * se oculta por ancho: el día sin atención quedaba marcado solo por el gris del fondo (canal cromático).
 */
function OffGlyph() {
  return (
    <span data-month-off-glyph="" className={styles.glyph} aria-hidden="true">
      <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable="false">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M6 18 18 6" />
      </svg>
    </span>
  );
}

function MonthCell({ cell, onPickDay }: { cell: MonthCellModel; onPickDay: (k: DayKey) => void }) {
  const { lock } = cell;
  return (
    <button
      type="button"
      className={styles.cell}
      data-day-key={cell.key}
      data-day-status={lock.status}
      data-in-month={cell.inMonth ? "true" : "false"}
      data-today={cell.isToday ? "" : undefined}
      aria-current={cell.isToday ? "date" : undefined}
      aria-label={cell.ariaLabel}
      title={cell.title}
      onClick={() => onPickDay(cell.key)}
    >
      {/* Todo lo visual es aria-hidden: el aria-label del botón ya lo dice entero (cantidad, desglose, estado). */}
      <span className={styles.top} aria-hidden="true">
        <span className={styles.num}>{cell.day}</span>
        {(lock.status === "locked" || lock.status === "partial") && <LockGlyph status={lock.status} />}
        {lock.status === "off" && <OffGlyph />}
      </span>
      {cell.count > 0 && (
        <span className={styles.count} data-month-count={cell.count} aria-hidden="true">
          <strong>{cell.count}</strong>
          <span className={styles.word}>{cell.count === 1 ? " turno" : " turnos"}</span>
        </span>
      )}
      {lock.status === "locked" && (
        <span className={styles.state} aria-hidden="true">
          Bloqueado
        </span>
      )}
      {lock.status === "off" && (
        <span className={styles.state} aria-hidden="true">
          Sin atención
        </span>
      )}
      {cell.perPractitioner.length > 0 && (
        <span className={styles.people} aria-hidden="true">
          {cell.perPractitioner.map((p) => (
            <span key={p.id} className={styles.person}>
              <PractitionerBadge initials={p.initials} name={p.name} size={18} decorative />
              <span className={styles.personCount}>{p.count}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/**
 * La grilla, SIN hooks (la prueba el render test recorriendo el árbol). Encabezado de días + una fila por semana.
 * `--month-cols` = columnas visibles (5-7, según sáb/dom en prefs).
 */
export function MonthGrid({
  model,
  monthKey,
  onPickDay,
}: {
  model: MonthGridModel;
  monthKey: string;
  onPickDay: (dayKey: DayKey) => void;
}) {
  const cols = { ["--month-cols" as string]: model.columns.length } as CSSProperties;
  return (
    <div className={styles.grid} style={cols} role="group" aria-label={monthLabel(monthKey)} data-month-grid>
      <div className={styles.head} aria-hidden="true">
        {model.columns.map((d) => (
          <span key={d} className={styles.headDay}>
            {MONTH_WEEKDAY_SHORT[d]}
          </span>
        ))}
      </div>
      {model.weeks.map((week) => (
        <div key={week[0]?.key ?? "w"} className={styles.week}>
          {week.map((cell) => (
            <MonthCell key={cell.key} cell={cell} onPickDay={onPickDay} />
          ))}
        </div>
      ))}
    </div>
  );
}

function MonthSkeleton({ columns }: { columns: number }) {
  const cols = { ["--month-cols" as string]: columns } as CSSProperties;
  return (
    <div className={styles.grid} style={cols} aria-busy="true" data-month-loading>
      <span className="k-skel-sr" role="status">
        Cargando el mes…
      </span>
      {Array.from({ length: 5 }, (_, w) => (
        <div key={w} className={styles.week} aria-hidden="true">
          {Array.from({ length: columns }, (_, d) => (
            <span key={d} className={`k-skel ${styles.skelCell}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function MonthView(props: MonthViewProps) {
  const { initial, anchorDayKey, todayKey, selectedPractitionerIds, practitioners, locationId, hideNoShow } = props;
  const range = useMemo(() => monthGridRange(anchorDayKey), [anchorDayKey]);
  const want = useMemo(() => ({ from: range.from, to: range.to, locationId }), [range.from, range.to, locationId]);
  const wantKey = `${want.from}|${want.to}|${want.locationId ?? ""}`;

  // Lo pedido acá le gana al `initial` mientras el `initial` sea el MISMO con que se pidió: un `router.refresh()` del
  // padre trae un resumen más nuevo y lo pedido se descarta solo (mismo patrón que `live` en `agenda-client`).
  const [fetched, setFetched] = useState<{ base: AgendaMonthSummary | null; data: AgendaMonthSummary } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const fromFetch = fetched && fetched.base === initial && monthSummaryMatches(fetched.data, want) ? fetched.data : null;
  const fromInitial = monthSummaryMatches(initial, want) ? initial : null;
  const summary = fromFetch ?? fromInitial;

  // Lo último, para los callbacks del canal (se registran una vez).
  const liveRef = useRef({ want, initial, hasSummary: summary != null });
  useEffect(() => {
    liveRef.current = { want, initial, hasSummary: summary != null };
  });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    const { want: w, initial: base } = liveRef.current;
    const key = `${w.from}|${w.to}|${w.locationId ?? ""}`;
    let res: Awaited<ReturnType<typeof getAgendaMonthSummary>> | null = null;
    try {
      res = await getAgendaMonthSummary({ from: w.from, to: w.to, locationId: w.locationId });
    } catch {
      res = null;
    }
    // Mientras volaba, el usuario cambió de mes o de sede (o salió otro pedido): esta respuesta ya no corresponde.
    if (my !== seq.current) return;
    if (res && res.ok && monthSummaryMatches(res.data, w)) {
      setFetched({ base, data: res.data });
      setFailure(null);
      return;
    }
    // Un re-pedido en vivo que falla no tapa lo que se ve: el error solo se muestra si no hay nada que mostrar.
    if (!liveRef.current.hasSummary) setFailure({ key, message: res && !res.ok ? res.error : LOAD_ERROR });
  }, []);

  // Falta el resumen de esta grilla/sede → pedirlo (al montar, al cambiar de mes o de sede).
  const missing = summary == null;
  useEffect(() => {
    if (missing) void load();
  }, [missing, wantKey, load]);

  const { subscribe, onResync } = useRealtime();
  useEffect(() => {
    const coalescer = createRefetchCoalescer(load);
    const offBatch = subscribe((batch) => {
      const w = liveRef.current.want;
      // `availability` (candado, bloqueos, franjas) cuenta como «toca»: el estado del día viene en el mismo resumen.
      if (messagesTouchRange(batch, { fromKey: w.from, toKey: w.to })) coalescer.request();
    });
    // Reconexión, pestaña que vuelve o polling: se pudieron perder mensajes → el mes otra vez.
    const offResync = onResync(() => coalescer.request());
    return () => {
      offBatch();
      offResync();
      coalescer.dispose();
    };
  }, [subscribe, onResync, load]);

  // Conteos de los chips: los del mes, en la sede elegida.
  const onCountsRef = useRef(props.onCounts);
  useEffect(() => {
    onCountsRef.current = props.onCounts;
  });
  const counts = useMemo(
    () => (summary ? monthPractitionerCounts(summary, { monthKey: range.monthKey, hideNoShow }) : null),
    [summary, range.monthKey, hideNoShow]
  );
  useEffect(() => {
    if (counts) onCountsRef.current?.(counts);
  }, [counts]);

  const model = useMemo(
    () =>
      summary
        ? monthGridModel(summary, {
            monthKey: range.monthKey,
            todayKey,
            selectedIds: selectedPractitionerIds,
            practitioners,
            hideNoShow,
            showSaturday: props.showSaturday,
            showSunday: props.showSunday,
          })
        : null,
    [summary, range.monthKey, todayKey, selectedPractitionerIds, practitioners, hideNoShow, props.showSaturday, props.showSunday]
  );

  const columns = 5 + (props.showSaturday ? 1 : 0) + (props.showSunday ? 1 : 0);
  const shownFailure = !summary && failure && failure.key === wantKey ? failure : null;

  return (
    <Card className={styles.card} data-month-view>
      {model ? (
        <>
          {model.monthTotal === 0 && (
            <p className={styles.note} role="status">
              No hay turnos en {monthLabel(range.monthKey)}
              {selectedPractitionerIds.length > 0 ? " para los profesionales elegidos" : ""}.
            </p>
          )}
          <MonthGrid model={model} monthKey={range.monthKey} onPickDay={props.onPickDay} />
        </>
      ) : shownFailure ? (
        <div className={styles.error} role="alert">
          <p>{shownFailure.message}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFailure(null);
              void load();
            }}
          >
            Reintentar
          </Button>
        </div>
      ) : (
        <MonthSkeleton columns={columns} />
      )}
    </Card>
  );
}
