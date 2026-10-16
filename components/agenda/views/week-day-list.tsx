"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { toARDateKey } from "@/lib/datetime-ar";
import { dowOfDayKey } from "@/lib/availability/day";
import { paymentHoldState } from "@/lib/agenda-filters";
import { highlightState, type AgendaHighlight } from "@/lib/agenda-highlight";
import type { AggregatedDayLock } from "@/lib/agenda-client-state";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { StatusTag } from "@/components/ui/status-tag";
import { fmtHour, roomNameOf, type BookingDTO } from "../agenda-utils";
import { PractitionerBadge } from "../grid/practitioner-badge";
import { PlanMarks, bookingStatusTone } from "../grid/booking-card";
import styles from "./views.module.css";

/** Nombre del día por índice de la semana (0 = lunes). Fijo y no `toLocaleDateString`: el ICU de Node y el del
 *  navegador no abrevian igual y el SSR de esta lista tiene que hidratar sin diferencias. */
const DAY_NAMES = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

/** Corte de la Semana como lista (MB-1a): el mismo de la barra inferior y de `.desktopOnly` del shell. */
const MOBILE_QUERY = "(max-width: 767px)";


/**
 * Semana en el celular (MB-1a, C-MB3 / MB-D10): lista agrupada por día en vez de 7 columnas de ~50 px donde no se
 * leía ningún turno (`pf1z-review-b/agenda-semana-390.png`). Mismo dato que la grilla (los turnos visibles de la
 * semana, los mismos días según Apariencia) y sin vista nueva en la URL: `agenda-client` dibuja la grilla y la lista
 * y el CSS elige (`.weekGrid` ≥ 768, `.weekList` < 768). Va en su propio chunk (`next/dynamic`, precargado en
 * idle como la Semana): no suma al first load de /agenda.
 *
 * Fila compacta hora · paciente · servicio con la regla de color de AGENTS §5: barra lateral = servicio, fondo =
 * estado (`bookingStatusTone`, el de la card del Día), opacidad = resaltado de la leyenda. Profesional con iniciales
 * (canal no cromático) solo con más de uno en pantalla; el estado además en texto (`StatusTag`).
 *
 * La tira de días de arriba sigue siendo la navegación: tocar un día en la Semana remonta la vista con ese día y la
 * lista lo trae a la vista (solo en el celular; en escritorio la lista está oculta y no se mueve nada).
 */
export function WeekDayList({
  weekDays,
  showSaturday,
  showSunday,
  bookings,
  onEdit,
  highlight,
  practitionerById,
  roomById,
  dayLocks,
  renderDayLock,
  anchorDayKey,
  now,
}: {
  weekDays: ReadonlyArray<string>;
  /** Fin de semana visible (Apariencia), igual que la grilla y la tira. */
  showSaturday: boolean;
  showSunday: boolean;
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  highlight: AgendaHighlight | null;
  /** Iniciales por profesional (las de `agenda-client`); null = uno solo en pantalla, sin iniciales. */
  practitionerById: Readonly<Record<string, { initials: string; name: string }>> | null;
  roomById: Readonly<Record<string, { name: string }>> | null;
  dayLocks?: Readonly<Record<string, AggregatedDayLock | undefined>>;
  renderDayLock?: (dayKey: string) => ReactNode;
  /** Día ancla de la agenda: su grupo se marca y, en el celular, se trae a la vista al montar. */
  anchorDayKey?: string | null;
  now?: Date;
}) {
  const clock = now ?? new Date();
  const byDay = useMemo(() => {
    const m = new Map<string, BookingDTO[]>();
    for (const b of bookings) {
      const k = toARDateKey(b.scheduledFor);
      const list = m.get(k);
      if (list) list.push(b);
      else m.set(k, [b]);
    }
    for (const list of m.values()) list.sort((a, z) => a.scheduledFor.localeCompare(z.scheduledFor));
    return m;
  }, [bookings]);

  const visibleDays = [0, 1, 2, 3, 4];
  if (showSaturday) visibleDays.push(5);
  if (showSunday) visibleDays.push(6);

  const anchorRef = useRef<HTMLElement | null>(null);
  const firstVisible = weekDays[0];
  useEffect(() => {
    // Solo si la lista es la que se ve (< 768) y el ancla no es el primer día: en escritorio está oculta y un
    // scrollIntoView movería la página igual.
    if (!anchorRef.current || !anchorDayKey || anchorDayKey === firstVisible) return;
    if (typeof window.matchMedia !== "function" || !window.matchMedia(MOBILE_QUERY).matches) return;
    anchorRef.current.scrollIntoView({ block: "start" });
  }, [anchorDayKey, firstVisible]);

  return (
    <div className={styles.weekList} data-week-list>
      {visibleDays.map((dayIdx) => {
        const key = weekDays[dayIdx];
        if (!key) return null;
        const list = byDay.get(key) ?? [];
        const active = list.filter((b) => b.status !== "CANCELLED").length;
        const lock = dayLocks?.[key];
        const isAnchor = key === anchorDayKey;
        // El nombre sale del DayKey (no del índice) para que nombre y número nunca discrepen, como en la grilla.
        const name = DAY_NAMES[(dowOfDayKey(key) + 6) % 7];
        const headingId = `week-list-${key}`;
        return (
          <section
            key={key}
            ref={isAnchor ? (el) => { anchorRef.current = el; } : undefined}
            aria-labelledby={headingId}
            aria-current={isAnchor ? "date" : undefined}
            data-day-status={lock?.status}
            className={styles.wlDay}
          >
            <div className={styles.wlHead}>
              <h2 id={headingId} className={styles.wlTitle}>
                {name} {Number(key.slice(8, 10))}
              </h2>
              <span className={styles.wlCount}>
                {active} {active === 1 ? "turno" : "turnos"}
              </span>
              {renderDayLock?.(key)}
            </div>
            {lock?.status === "locked" && (
              <p className={styles.wlNote}>Bloqueado{lock.detail ? `: ${lock.detail}` : ""}</p>
            )}
            {list.length === 0 ? (
              lock?.status === "locked" ? null : <p className={styles.wlNote}>Sin turnos</p>
            ) : (
              <ul className={styles.wlRows}>
                {list.map((b) => {
                  const tone = bookingStatusTone(b.status, paymentHoldState(b, clock) === "vencida");
                  const hl = highlightState(highlight, b);
                  const isCancelled = b.status === "CANCELLED";
                  const prac = practitionerById?.[b.practitionerId] ?? null;
                  const roomName = roomNameOf(roomById, b);
                  const sub = [b.serviceName, roomName, b.isOverbooked ? "Sobreturno" : null].filter(Boolean).join(" · ");
                  return (
                    <li key={b.id}>
                      <button
                        type="button"
                        onClick={() => onEdit(b)}
                        data-week-list-row
                        data-highlight={hl === "none" ? undefined : hl}
                        className={styles.wlRow}
                        style={{
                          background: tone.background,
                          border: tone.border,
                          borderLeft: `4px solid ${b.serviceColor ?? SERVICE_COLOR_FALLBACK}`,
                          opacity: isCancelled ? 0.6 : hl === "dimmed" ? 0.45 : 1,
                        }}
                      >
                        <span className={`k-mono ${styles.wlHour}`}>{fmtHour(new Date(b.scheduledFor))}</span>
                        <span className={styles.wlMain}>
                          <span className={styles.wlPatient}>
                            <span className={styles.wlName} style={isCancelled ? { textDecoration: "line-through" } : undefined}>
                              {b.patientName}
                            </span>
                            <PlanMarks b={b} />
                          </span>
                          <span className={styles.wlService}>{sub}</span>
                        </span>
                        {prac && <PractitionerBadge initials={prac.initials} name={prac.name} size={22} />}
                        <StatusTag s={b.status} hold={paymentHoldState(b, clock)} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
