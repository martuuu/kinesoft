"use client";

import type { ReactNode } from "react";
import { IconActivity, IconCheck, IconClock, IconUsers, IconX } from "@/components/ui/icons";
import { PractitionerBadge } from "@/components/agenda/grid/practitioner-badge";
import { bookingPlanMarks } from "@/components/agenda/grid/booking-card";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import {
  RECEPTION_ACTION_LABEL,
  RECEPTION_STATE_LABEL,
  type ReceptionAction,
  type ReceptionEntry,
  type ReceptionState,
} from "@/lib/reception-state";
import { stateTagText, waitText } from "@/lib/reception-view-state";
import { ARCHIVED_ROOM_LABEL, fmtHour, type BookingDTO } from "../agenda-utils";

/**
 * Una fila del modo Recepción (B4.5). Es un `<tr>` de la tabla de
 * `ReceptionView`; debajo de 640 px el CSS de la vista la convierte en card
 * (cada celda con su `data-label` como rótulo).
 *
 * Color nunca es el único canal (AGENTS §5): el estado lleva ícono + texto,
 * el profesional va con iniciales + nombre, y el servicio con su punto de
 * color + nombre escrito.
 *
 * SR: `room` decide la columna "Sala". `undefined` = la vista no la muestra
 * (consultorio sin salas: la fila es la de siempre); `null` = columna presente
 * y el turno sin sala ("—"); `{ name }` = la sala, como texto. Con `null` y un
 * `roomId` en el turno (sala fuera del catálogo), "Sala archivada" (SRZ B5).
 */

type StateStyle = { icon: ReactNode; bg: string; fg: string; border?: string };

// Fondo = estado, igual que en la grilla. Los estados que también son un
// BookingStatus (por llegar = confirmado, atendido = hecho, ausente,
// cancelado) usan la paleta única `--st-*` del `StatusTag` (P0-S04b), así
// "Ausente" es el mismo ámbar en Recepción, Lista, drawer y perfil. Los propios
// de Recepción (demorado, en sala, en atención) no tienen BookingStatus y
// quedan con sus tonos; el ausente conserva el borde punteado para no
// confundirse con "demorado" (mismo ámbar, distinto borde e ícono).
const STATE_STYLE: Record<ReceptionState, StateStyle> = {
  "por-llegar": { icon: <IconClock size={11} stroke={2.4} />, bg: "var(--st-confirmed-bg)", fg: "var(--st-confirmed-fg)" },
  demorado: { icon: <IconClock size={11} stroke={2.6} />, bg: "rgba(255,176,32,0.2)", fg: "#9A5B00", border: "1px solid rgba(154,91,0,0.35)" },
  "en-sala": { icon: <IconUsers size={11} stroke={2.4} />, bg: "rgba(200,245,100,0.45)", fg: "var(--navy-900)" },
  "en-atencion": { icon: <IconActivity size={11} stroke={2.4} />, bg: "var(--navy-900)", fg: "#fff" },
  atendido: { icon: <IconCheck size={11} stroke={3} />, bg: "var(--st-completed-bg)", fg: "var(--st-completed-fg)" },
  ausente: { icon: <IconX size={11} stroke={2.6} />, bg: "var(--st-noshow-bg)", fg: "var(--st-noshow-fg)", border: "1px dashed rgba(154,91,0,0.4)" },
  cancelado: { icon: <IconX size={11} stroke={2.6} />, bg: "var(--st-cancelled-bg)", fg: "var(--st-cancelled-fg)" },
};

export function ReceptionStateTag({ entry }: { entry: Pick<ReceptionEntry<BookingDTO>, "state" | "waitingMinutes" | "lateMinutes"> }) {
  const s = STATE_STYLE[entry.state];
  return (
    <span
      className="rcp-tag"
      data-state={entry.state}
      title={RECEPTION_STATE_LABEL[entry.state]}
      style={{ background: s.bg, color: s.fg, border: s.border ?? "1px solid transparent" }}
    >
      <span aria-hidden>{s.icon}</span>
      {stateTagText(entry)}
    </span>
  );
}

/** Qué pasa con el estado tras "Deshacer", para el aria-label del botón. */
const UNDO_HINT: Partial<Record<ReceptionState, string>> = {
  "en-sala": "vuelve a Por llegar",
  "en-atencion": "vuelve a En sala",
  atendido: "vuelve al estado anterior",
  ausente: "vuelve al estado anterior",
};

export function ReceptionRow({
  entry,
  actions,
  practitioner,
  now,
  canOperate,
  pending,
  onAction,
  onOpen,
  room,
}: {
  entry: ReceptionEntry<BookingDTO>;
  /** Acciones a mostrar (ya filtradas por día con `visibleActions`). */
  actions: ReceptionAction[];
  practitioner: { name: string; initials: string } | null;
  now: Date;
  /** false → sin columna de acciones (la vista muestra el aviso de solo lectura). */
  canOperate: boolean;
  /** Hay una action en vuelo para esta fila: botones deshabilitados. */
  pending: boolean;
  onAction: (b: BookingDTO, action: ReceptionAction) => void;
  onOpen: (b: BookingDTO) => void;
  room?: { name: string } | null;
}) {
  const b = entry.row;
  const time = fmtHour(new Date(b.scheduledFor));
  const guest = b.patientId == null;
  const who = `${b.patientName}, ${time}`;
  const wait = waitText(b, entry.state, now);
  const cancelled = entry.state === "cancelado";
  const plan = bookingPlanMarks(b);

  return (
    <tr
      className="rcp-row"
      data-state={entry.state}
      data-highlight={entry.highlight || undefined}
      aria-busy={pending || undefined}
      style={{ opacity: cancelled ? 0.55 : pending ? 0.75 : 1 }}
    >
      <td data-label="Hora" className="rcp-time k-mono">
        {time}
      </td>
      <th scope="row" data-label="Paciente" className="rcp-patient">
        <button
          type="button"
          className="rcp-link"
          onClick={() => onOpen(b)}
          aria-label={`Abrir el turno de ${who}`}
        >
          {b.patientName}
        </button>
        {guest && <span className="rcp-guest">Invitado</span>}
        {b.isOverbooked && <span className="rcp-guest">Sobreturno</span>}
        {/* Planes (S19a): chip `Kine · 3/10` (sin título, también para la
            Secretaria) o "Fuera de plan" con el pill de texto de la fila,
            punteado para distinguirlo de Invitado/Sobreturno. */}
        {plan.chip && <DisciplineChip {...plan.chip} size="xs" style={{ marginLeft: 6, verticalAlign: "middle" }} />}
        {plan.outOfPlan && (
          <span className="rcp-guest" data-badge="fuera-de-plan" style={{ borderStyle: "dashed" }}>
            Fuera de plan
          </span>
        )}
      </th>
      <td data-label="Servicio">
        <span className="rcp-service">
          <span
            aria-hidden
            className="rcp-dot"
            style={{ background: b.serviceColor ?? SERVICE_COLOR_FALLBACK }}
          />
          <span className="rcp-ellipsis">{b.serviceName}</span>
        </span>
      </td>
      <td data-label="Profesional">
        {practitioner ? (
          <span className="rcp-service">
            <PractitionerBadge initials={practitioner.initials} name={practitioner.name} size={24} decorative />
            <span className="rcp-ellipsis">{practitioner.name}</span>
          </span>
        ) : (
          <span style={{ color: "var(--navy-300)" }}>—</span>
        )}
      </td>
      {room !== undefined && (
        <td data-label="Sala">
          {room ? (
            <span className="rcp-ellipsis" style={{ display: "inline-block", maxWidth: 160, color: "var(--navy-700)", verticalAlign: "middle" }}>
              {room.name}
            </span>
          ) : typeof b.roomId === "string" ? (
            // SRZ B5: el turno tiene sala pero no está en el catálogo (archivada,
            // solo turnos pasados). "—" diría "sin sala", que es otra cosa.
            <span style={{ color: "var(--navy-500)" }}>{ARCHIVED_ROOM_LABEL}</span>
          ) : (
            <span style={{ color: "var(--navy-300)" }}>—</span>
          )}
        </td>
      )}
      <td data-label="Estado">
        <ReceptionStateTag entry={entry} />
      </td>
      <td data-label="Espera" className="k-mono rcp-wait">
        {wait ?? <span style={{ color: "var(--navy-300)" }}>—</span>}
      </td>
      {canOperate && (
      <td data-label="Acciones" className="rcp-actions-cell">
        {!cancelled ? (
          <div className="rcp-actions">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                className={a === "deshacer" ? "rcp-btn rcp-btn-ghost" : a === "llego" || a === "atendido" ? "rcp-btn rcp-btn-primary" : "rcp-btn"}
                disabled={pending}
                onClick={() => onAction(b, a)}
                aria-label={
                  a === "deshacer"
                    ? `Deshacer (${UNDO_HINT[entry.state] ?? "vuelve un paso"}): ${who}`
                    : `Marcar ${RECEPTION_ACTION_LABEL[a]}: ${who}`
                }
              >
                {RECEPTION_ACTION_LABEL[a]}
              </button>
            ))}
            {/* Cobro desde recepción: C0 (Secretaria). Visible para que se sepa
                que viene; aria-disabled en vez de disabled para que el tooltip
                se vea al pasar el mouse. */}
            <button
              type="button"
              className="rcp-btn rcp-btn-ghost"
              aria-disabled="true"
              title="Próximamente"
              aria-label={`Cobrar (próximamente): ${who}`}
              onClick={(e) => e.preventDefault()}
              style={{ cursor: "not-allowed", opacity: 0.55 }}
            >
              Cobrar
            </button>
          </div>
        ) : (
          <span style={{ color: "var(--navy-300)" }}>—</span>
        )}
      </td>
      )}
    </tr>
  );
}
