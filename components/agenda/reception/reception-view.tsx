"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { markReceptionAction } from "@/lib/bookings";
import { dayKeyOf } from "@/lib/availability/day";
import { RECEPTION_ACTION_LABEL, sortForReception, type ReceptionAction } from "@/lib/reception-state";
import {
  RECEPTION_FILTERS,
  beginReceptionAction,
  bookingsOfDay,
  commitReceptionAction,
  filterEntries,
  isStaleError,
  mergeReceptionOverrides,
  receptionCounters,
  receptionEntriesForDay,
  rollbackReceptionAction,
  stateTagText,
  visibleActions,
  type ReceptionFilter,
  type ReceptionOverrides,
} from "@/lib/reception-view-state";
import { roomNameOf, type BookingDTO } from "../agenda-utils";
import { ReceptionRow } from "./reception-row";
import { noteLocalReception } from "@/lib/arrival-local-notes";
import { useAttendedNoteToast } from "./use-attended-note-toast";

/**
 * Modo Recepción de la agenda (B4.5, plan §11.3 punto 4): la lista del día de
 * TODOS los profesionales visibles, pensada para la Secretaria con la sala de
 * espera llena. Orden de `sortForReception` (en atención arriba, después
 * cronológico, cancelados al final), filtros rápidos, contadores y las
 * acciones de `allowedTransitions` con `markReceptionAction` (B4.1).
 *
 * Contrato con el padre (B4.3, `agenda-client.tsx`):
 * - `bookings`: los del día (si vienen más días se filtran por `dayKey`), ya
 *   filtrados por profesional/sede. Proyección liviana (`listAgendaBookings`):
 *   sin `arrivedAt`/`attendingAt` todo se ve "por llegar".
 * - `now`: el reloj del padre (que lo refresca cada minuto). Igual la vista
 *   tiene su propio tic de 60 s para que los minutos de espera avancen aunque
 *   el padre no re-renderice.
 * - `onChanged(b)`: se llama con la fila NUEVA después de cada acción OK (el
 *   padre la reemplaza en su estado), y con la fila VIEJA cuando la action
 *   devuelve "El turno cambió en otra sesión" (`opts.stale`): en ese caso el
 *   padre tiene que traer la versión vigente, porque esa respuesta NO revalida.
 *   En el OK no hace falta re-listar: la action hace `revalidatePath` y su
 *   respuesta ya trae el árbol RSC nuevo (PF-0d, sin `router.refresh()`).
 *   Recomendado: en los dos casos reemplazar la fila y re-listar en segundo
 *   plano; el override local se descarta solo cuando llega una versión igual
 *   o más nueva (`mergeReceptionOverrides`).
 * - `canOperate=false` (sin `agenda.reception`): solo lectura, sin columna de
 *   acciones. El server lo hace cumplir igual. Con `canOperate`, cada fila
 *   además respeta el `canOperate` del DTO (SV10b): el profesional opera (y
 *   llama) las suyas; la Secretaria/OWNER/ADMIN, todas.
 * - SV10b: «Llamar» en las filas en sala; `onChanged` recibe la fila con el
 *   `calledAt` que devolvió el server (`commitReceptionAction`).
 * - `roomById` (SR): catálogo de salas del consultorio. La columna "Sala"
 *   aparece solo si tiene entradas; sin salas la tabla es la de siempre. A
 *   diferencia de las tarjetas no depende de `showRoomOnCards`: en la tabla
 *   una columna no agrega ruido y la Secretaria la usa para mandar al
 *   paciente al consultorio.
 * - RX-1f: fuera de hoy (día AR) no hay «demorado» ni minutos que corran
 *   (`receptionEntriesForDay`, hallazgo G1), y con `canOperate` arriba va el
 *   link «Abrir escritorio de Recepción» → /sala.
 * - EV2-3c: `clinicalNoteViewer` ({ practitionerId, canReadClinical =
 *   `caps.has("clinical.read")` }): al marcar «Atendido» en un turno propio el
 *   profesional ve el toast «Cargar evolución» (`useAttendedNoteToast`). Sin
 *   la prop (o la Secretaria, sin `clinical.read`) no hay toast.
 */
export function ReceptionView({
  dayKey,
  bookings,
  practitioners,
  now,
  canOperate,
  onOpenBooking,
  onChanged,
  roomById = null,
  clinicalNoteViewer = null,
}: {
  dayKey: string;
  bookings: BookingDTO[];
  practitioners: { id: string; name: string; initials: string }[];
  now: Date;
  canOperate: boolean;
  onOpenBooking: (b: BookingDTO) => void;
  onChanged: (b: BookingDTO, opts?: { stale?: boolean }) => void;
  roomById?: Readonly<Record<string, { name: string }>> | null;
  clinicalNoteViewer?: { practitionerId: string | null; canReadClinical: boolean } | null;
}) {
  const toast = useToast();
  const offerNote = useAttendedNoteToast(clinicalNoteViewer);
  const [filter, setFilter] = useState<ReceptionFilter>("todos");
  const [announce, setAnnounce] = useState("");

  // Reloj: el `now` del padre, más un tic propio cada 60 s (ver cabecera).
  const nowMs = now.getTime();
  const [clock, setClock] = useState(() => new Date(nowMs));
  useEffect(() => setClock(new Date(nowMs)), [nowMs]);
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Overrides optimistas. El ref es la copia sincrónica: el doble click entre
  // dos renders tiene que ver la action en vuelo.
  const [overrides, setOverridesState] = useState<ReceptionOverrides>({});
  const overridesRef = useRef<ReceptionOverrides>(overrides);
  const setOverrides = (next: ReceptionOverrides) => {
    overridesRef.current = next;
    setOverridesState(next);
  };

  const dayBookings = useMemo(() => bookingsOfDay(bookings, dayKey), [bookings, dayKey]);
  const merged = useMemo(() => mergeReceptionOverrides(dayBookings, overrides), [dayBookings, overrides]);
  // Poda: el padre ya trajo la versión nueva de una fila confirmada.
  useEffect(() => {
    if (merged.overrides !== overrides) setOverrides(merged.overrides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged.overrides]);

  // [RX-1f] G1: fuera de hoy no hay demora (ni minutos de sala que corran).
  const entries = useMemo(() => receptionEntriesForDay(merged.rows, clock, dayKey), [merged.rows, clock, dayKey]);
  const counters = useMemo(() => receptionCounters(entries), [entries]);
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const byPractitioner = useMemo(() => new Map(practitioners.map((p) => [p.id, p])), [practitioners]);
  const isToday = dayKey === dayKeyOf(clock);
  const showRoom = roomById != null && Object.keys(roomById).length > 0;

  async function handleAction(b: BookingDTO, action: ReceptionAction) {
    // SV10b: misma regla que la fila (no muestra botones si `canOperate` del
    // DTO es false); el server lo vuelve a chequear.
    if (!canOperate || b.canOperate === false) return;
    const begun = beginReceptionAction(overridesRef.current, b, action, new Date());
    if (!begun.ok) {
      toast.error(begun.error);
      return;
    }
    setOverrides(begun.overrides);
    const after = sortForReception([begun.optimistic], new Date())[0];
    setAnnounce(`${b.patientName}: ${after ? stateTagText(after) : RECEPTION_ACTION_LABEL[action]}`);

    let res: Awaited<ReturnType<typeof markReceptionAction>>;
    try {
      res = await markReceptionAction(b.id, action, b.updatedAt);
    } catch {
      res = { ok: false, error: "No pudimos guardar el cambio. Revisá la conexión y reintentá." };
    }

    if (res.ok) {
      // SV11b: esta pestaña hizo la acción; los avisos no se la repiten.
      noteLocalReception(b.id, res.data);
      const done = commitReceptionAction(overridesRef.current, b.id, res.data);
      setOverrides(done.overrides);
      if (done.booking) {
        onChanged(done.booking);
        offerNote(action, done.booking);
      }
      return;
    }
    const back = rollbackReceptionAction(overridesRef.current, b.id);
    setOverrides(back.overrides);
    setAnnounce(`${b.patientName}: no se guardó el cambio.`);
    if (isStaleError(res.error)) {
      toast.warning("El turno cambió en otra sesión", {
        description: `Actualizamos la lista con lo último de ${b.patientName}. Revisalo y reintentá.`,
      });
      onChanged(back.previous ?? b, { stale: true });
    } else {
      toast.error(res.error);
    }
  }

  const dayLabel = new Date(`${dayKey}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });

  return (
    <section className="rcp" aria-labelledby="rcp-title">
      <style>{RECEPTION_CSS}</style>

      <h2 id="rcp-title" className="rcp-sr">
        Recepción · {dayLabel}
      </h2>

      {/* [RX-1f] Puente al escritorio de Recepción (/sala). Mismo gate que la
          página: módulo `salaEspera` + `agenda.reception`. Es exactamente
          `canOperate` (agenda-client: `canReception = caps.has("agenda.reception")
          && waitingRoomOn`), y sin el módulo esta vista ni se monta. */}
      {canOperate && (
        <div className="rcp-head">
          <Link href="/sala" className="rcp-desk-link">
            Abrir escritorio de Recepción <span aria-hidden>→</span>
          </Link>
        </div>
      )}

      <div className="rcp-counters" role="group" aria-label="Resumen del día">
        <Counter label="En sala ahora" value={String(counters.enSala)} hint={counters.enAtencion ? `${counters.enAtencion} en atención` : undefined} />
        {/* SV10b: subconjunto de "En sala ahora" (siguen en la sala de espera
            hasta que pasan al box), por eso no se resta de ese número. */}
        <Counter label="Llamados" value={String(counters.llamados)} />
        <Counter label="Demorados" value={String(counters.demorados)} warn={counters.demorados > 0} />
        <Counter label="Atendidos" value={`${counters.atendidos}/${counters.total}`} />
      </div>

      <div className="rcp-filters" role="group" aria-label="Filtrar turnos">
        {RECEPTION_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="rcp-chip"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {f.label} <span className="rcp-chip-n">{counters.byFilter[f.id]}</span>
          </button>
        ))}
      </div>

      {!canOperate && (
        <p className="rcp-note" role="note">
          Solo lectura: tu usuario no puede marcar llegadas ni atenciones.
        </p>
      )}
      {canOperate && !isToday && (
        <p className="rcp-note" role="note">
          Este día no es hoy: «Llegó», «Llamar» y «En atención» solo se marcan en los turnos del día.
        </p>
      )}

      <div aria-live="polite" className="rcp-sr">
        {announce}
      </div>

      {shown.length === 0 ? (
        <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          {entries.length === 0 ? "No hay turnos para este día." : "No hay turnos con este filtro."}
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <table className="rcp-table">
            <caption className="rcp-sr">
              Turnos del {dayLabel}, {RECEPTION_FILTERS.find((f) => f.id === filter)?.label.toLowerCase()}
            </caption>
            <thead>
              <tr>
                <th scope="col">Hora</th>
                <th scope="col">Paciente</th>
                <th scope="col">Servicio</th>
                <th scope="col">Profesional</th>
                {showRoom && <th scope="col">Sala</th>}
                <th scope="col">Estado</th>
                <th scope="col">Espera</th>
                {canOperate && (
                  <th scope="col" style={{ textAlign: "right" }}>
                    Acciones
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <ReceptionRow
                  key={e.row.id}
                  entry={e}
                  actions={visibleActions(e.actions, isToday)}
                  practitioner={byPractitioner.get(e.row.practitionerId) ?? null}
                  now={clock}
                  canOperate={canOperate}
                  pending={!!overrides[e.row.id]?.pending}
                  onAction={handleAction}
                  onOpen={onOpenBooking}
                  room={showRoom ? roomOf(roomById, e.row) : undefined}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

function roomOf(roomById: Readonly<Record<string, { name: string }>> | null, b: BookingDTO): { name: string } | null {
  const name = roomNameOf(roomById, b);
  return name ? { name } : null;
}

function Counter({ label, value, hint, warn = false }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rcp-counter" data-warn={warn || undefined}>
      <div className="rcp-counter-label">{label}</div>
      <div className="rcp-counter-value k-mono">{value}</div>
      {hint && <div className="rcp-counter-hint">{hint}</div>}
    </div>
  );
}

// CSS local de la vista (mismo patrón que `payers-editor.tsx`): la tabla pasa
// a cards debajo de 640 px. Tokens del design system, sin colores nuevos.
const RECEPTION_CSS = `
.rcp { display: grid; gap: 12px; }
.rcp-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.rcp-head { display: flex; justify-content: flex-end; }
.rcp-desk-link { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--sky-700); border: 1px solid rgba(15,30,51,0.12); background: var(--card-bg); text-decoration: none; }
.rcp-desk-link:hover { border-color: var(--sky-700); }
.rcp-desk-link:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 2px; }
.rcp-counters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.rcp-counter { background: var(--card-bg); border: 1px solid rgba(15,30,51,0.06); border-radius: var(--r-md); padding: 10px 14px; }
.rcp-counter[data-warn] { border-color: rgba(154,91,0,0.35); background: rgba(255,176,32,0.08); }
.rcp-counter-label { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--navy-300); }
.rcp-counter-value { font-size: 22px; font-weight: 700; color: var(--navy-900); line-height: 1.2; }
.rcp-counter-hint { font-size: 11px; color: var(--navy-500); }
.rcp-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.rcp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600; border: 1px solid rgba(15,30,51,0.12); background: #fff; color: var(--navy-700); cursor: pointer; }
.rcp-chip[aria-pressed="true"] { background: var(--navy-900); border-color: var(--navy-900); color: #fff; }
.rcp-chip-n { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 11px; opacity: 0.75; }
.rcp-note { margin: 0; font-size: 12.5px; color: var(--navy-500); }
.rcp-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rcp-table thead th { padding: 12px 14px; text-align: left; font-size: 10px; font-weight: 700; color: var(--navy-300); letter-spacing: 0.06em; text-transform: uppercase; border-bottom: 1px solid rgba(15,30,51,0.06); }
.rcp-row > td, .rcp-row > th { padding: 10px 14px; border-bottom: 1px solid rgba(15,30,51,0.04); vertical-align: middle; text-align: left; font-weight: inherit; }
.rcp-row[data-highlight] { background: rgba(255,176,32,0.07); box-shadow: inset 3px 0 0 #E59A00; }
.rcp-time { font-weight: 700; color: var(--navy-700); white-space: nowrap; }
.rcp-patient { min-width: 140px; }
.rcp-link { background: none; border: none; padding: 0; font: inherit; font-weight: 600; color: var(--navy-900); cursor: pointer; text-align: left; }
.rcp-link:hover { text-decoration: underline; }
.rcp-guest { margin-left: 6px; font-size: 10px; font-weight: 700; color: var(--navy-500); border: 1px solid rgba(15,30,51,0.15); border-radius: 999px; padding: 1px 6px; white-space: nowrap; }
.rcp-service { display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 220px; color: var(--navy-700); }
.rcp-dot { width: 10px; height: 10px; border-radius: 999px; flex-shrink: 0; }
.rcp-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rcp-tag { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.rcp-wait { font-size: 12px; color: var(--navy-700); white-space: nowrap; }
.rcp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.rcp-btn { display: inline-flex; align-items: center; padding: 6px 11px; min-height: 32px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid rgba(15,30,51,0.14); background: #fff; color: var(--navy-900); cursor: pointer; white-space: nowrap; }
.rcp-btn-primary { background: var(--sky-700); border-color: var(--sky-700); color: #fff; }
.rcp-btn-ghost { background: transparent; color: var(--navy-700); }
.rcp-btn:disabled { opacity: 0.5; cursor: progress; }
.rcp-btn:focus-visible, .rcp-chip:focus-visible, .rcp-link:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 2px; }

@media (max-width: 639px) {
  .rcp-counters { gap: 6px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rcp-counter { padding: 8px 10px; }
  .rcp-counter-value { font-size: 18px; }
  .rcp-table, .rcp-table tbody { display: block; }
  .rcp-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .rcp-row { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 12px 14px; border-bottom: 1px solid rgba(15,30,51,0.06); }
  .rcp-row > td, .rcp-row > th { display: block; padding: 0; border: none; }
  .rcp-row > .rcp-time { grid-column: 1; font-size: 15px; }
  .rcp-row > .rcp-patient { grid-column: 2; }
  .rcp-row > td:not(.rcp-time) { grid-column: 1 / -1; }
  .rcp-row > td:not(.rcp-time):not(.rcp-actions-cell)::before { content: attr(data-label) " · "; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--navy-300); }
  .rcp-actions { justify-content: flex-start; margin-top: 6px; }
  .rcp-btn { min-height: 40px; padding: 8px 14px; }
}
`;
