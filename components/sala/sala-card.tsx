"use client";

import { memo } from "react";
import { m } from "framer-motion";
import { arrivalPulse } from "@/lib/motion";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { RECEPTION_ACTION_LABEL, type ReceptionAction } from "@/lib/reception-state";
import { stateTagText, undoHint, waitText } from "@/lib/reception-view-state";
import { SALA_BAND_LABEL, primarySalaAction, salaEntryKey, type SalaEntry } from "@/lib/sala-board-state";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { bookingPlanMarks } from "@/components/agenda/grid/booking-card";
import { PractitionerBadge } from "@/components/agenda/grid/practitioner-badge";
import { fmtHour } from "@/components/agenda/agenda-utils";

export type SalaCardContext =
  | { kind: "practitioner"; name: string; initials: string }
  | { kind: "room"; name: string }
  | null;

type SalaCardProps = {
  entry: SalaEntry;
  now: Date;
  /** Lo que la columna no dice: el profesional (vista Por sala) o la sala (Por profesional). */
  context: SalaCardContext;
  pending: boolean;
  /** `arrivedAt` de una llegada recién vista (anillo una vez); null = sin pulso. */
  pulseKey: string | null;
  onAction: (entry: SalaEntry, action: ReceptionAction) => void;
};

/**
 * Card de un paciente en `/sala` (SV10a, plan §18.5). Mismos canales que la
 * agenda (AGENTS §5): barra lateral = color del servicio, fondo = estado
 * (`--rc-*`), y el profesional o la sala por un canal NO cromático (iniciales
 * o texto). El estado además va escrito («En sala 8'», «Llamado 2'»): el color
 * nunca es el único canal.
 *
 * PD-13: la card solo lee datos administrativos (hora, nombre, servicio,
 * plan sin título, invitado/sobreturno, espera). El DTO ya llega sin lo
 * clínico (`toSalaWire` en el server), y acá tampoco se lee.
 *
 * Anillo de llegada (FX2a · M1): es un `<m.span>` hermano, superpuesto y
 * `aria-hidden`, con `key={pulseKey}`: lo que se remonta en cada llegada es el
 * anillo, NO la card. Antes la key estaba en la card y remontarla le sacaba
 * el foco a quien la estaba operando con teclado. Va fuera de la card porque
 * la card tiene `overflow: hidden` (la barra del servicio) y recortaría la
 * sombra que se expande 8 px; el `<li>` es `position: relative` y lo ancla.
 *
 * La card lleva `data-booking-id` y `tabIndex=-1`: después de una acción el
 * cliente enfoca su botón primario nuevo (o la card, si no le quedan acciones).
 */
function SalaCardImpl({ entry, now, context, pending, pulseKey, onAction }: SalaCardProps) {
  const b = entry.row;
  const time = fmtHour(new Date(b.scheduledFor));
  const marks = bookingPlanMarks(b);
  const wait = waitText(b, entry.state, now);
  const primary = primarySalaAction(entry.state);
  const actions = entry.salaActions;
  const ordered = [
    ...actions.filter((a) => a === primary),
    ...actions.filter((a) => a !== primary && a !== "deshacer"),
    ...actions.filter((a) => a === "deshacer"),
  ];

  return (
    <>
      {pulseKey ? (
        <m.span
          key={pulseKey}
          aria-hidden="true"
          className="sala-ring k-arrival-ring"
          variants={arrivalPulse}
          initial="rest"
          animate="pulse"
        />
      ) : null}
      <div
        className="sala-card"
        role="group"
        aria-label={`${SALA_BAND_LABEL[entry.band]}: ${b.patientName}, ${time}`}
        tabIndex={-1}
        data-booking-id={b.id}
        data-state={entry.state}
        data-band={entry.band}
        aria-busy={pending || undefined}
      >
        <span className="sala-card-bar" aria-hidden="true" style={{ background: b.serviceColor ?? SERVICE_COLOR_FALLBACK }} />
        <div className="sala-card-top">
          <span className="sala-card-time k-mono">{time}</span>
          <span className="sala-card-tag">{stateTagText(entry)}</span>
        </div>
        <div className="sala-card-name">{b.patientName}</div>
        <div className="sala-card-meta">
          <span className="sala-card-service" title={b.serviceName}>
            {b.serviceName}
          </span>
          {marks.chip && (
            <DisciplineChip discipline={marks.chip.discipline} ordinal={marks.chip.ordinal} totalLive={marks.chip.totalLive} />
          )}
          {b.patientId === null && <span className="sala-pill">Invitado</span>}
          {b.isOverbooked && <span className="sala-pill">Sobreturno</span>}
        </div>
        {(context || wait) && (
          <div className="sala-card-foot">
            {context?.kind === "practitioner" && (
              <span className="sala-card-ctx">
                <PractitionerBadge initials={context.initials} name={context.name} size={22} />
              </span>
            )}
            {context?.kind === "room" && <span className="sala-card-ctx sala-card-room">{context.name}</span>}
            {wait && <span className="sala-card-wait k-mono">{wait}</span>}
          </div>
        )}
        {ordered.length > 0 && (
          <div className="sala-card-actions">
            {ordered.map((a) => {
              const kind = a === primary ? "primary" : a === "deshacer" ? "ghost" : "secondary";
              const hint = a === "deshacer" ? undoHint(b, now) : null;
              const label =
                a === "deshacer"
                  ? `Deshacer${hint ? ` (${hint})` : ""}: ${b.patientName}, ${time}`
                  : `${RECEPTION_ACTION_LABEL[a]}: ${b.patientName}, ${time}`;
              return (
                <button
                  key={a}
                  type="button"
                  className="sala-btn"
                  data-kind={kind}
                  aria-label={label}
                  disabled={pending}
                  onClick={() => onAction(entry, a)}
                >
                  {RECEPTION_ACTION_LABEL[a]}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function sameContext(a: SalaCardContext, b: SalaCardContext): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.name !== b.name) return false;
  return a.kind !== "practitioner" || b.kind !== "practitioner" || a.initials === b.initials;
}

/**
 * FX2a · M5: la card se re-renderiza solo si cambió algo que pinta. Ojo con
 * `entry`: es un objeto nuevo en cada `buildBoard`, pero el `onClick` lo
 * captura; con la misma firma, la entry vieja y la nueva son equivalentes
 * para `handleAction` (que además relee la fila vigente por id).
 */
function sameCard(prev: SalaCardProps, next: SalaCardProps): boolean {
  return (
    prev.pending === next.pending &&
    prev.pulseKey === next.pulseKey &&
    prev.onAction === next.onAction &&
    sameContext(prev.context, next.context) &&
    (prev.entry === next.entry || salaEntryKey(prev.entry, prev.now) === salaEntryKey(next.entry, next.now))
  );
}

export const SalaCard = memo(SalaCardImpl, sameCard);
