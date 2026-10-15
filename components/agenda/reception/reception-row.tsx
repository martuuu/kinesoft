"use client";

import type { ReactNode } from "react";
import { IconActivity, IconBell, IconCheck, IconClock, IconUsers, IconX } from "@/components/ui/icons";
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
import { stateTagText, undoHint, waitText } from "@/lib/reception-view-state";
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
// de Recepción (demorado, en sala, llamado, en atención) usan los tokens
// `--rc-*` de globals.css (SV10b): antes eran literales acá y /sala, la grilla
// y esta tabla tienen que pintar el mismo estado igual. El llamado es sky
// sólido con texto blanco para separarse a simple vista de En sala (lime
// pálido) y de Por llegar (sky pálido). El ausente conserva el borde punteado
// para no confundirse con "demorado" (mismo ámbar, distinto borde e ícono).
const STATE_STYLE: Record<ReceptionState, StateStyle> = {
  "por-llegar": { icon: <IconClock size={11} stroke={2.4} />, bg: "var(--st-confirmed-bg)", fg: "var(--st-confirmed-fg)" },
  demorado: { icon: <IconClock size={11} stroke={2.6} />, bg: "var(--rc-late-bg)", fg: "var(--rc-late-fg)", border: "1px solid var(--rc-late-border)" },
  "en-sala": { icon: <IconUsers size={11} stroke={2.4} />, bg: "var(--rc-insala-bg)", fg: "var(--rc-insala-fg)" },
  llamado: { icon: <IconBell size={11} stroke={2.4} />, bg: "var(--rc-called-bg)", fg: "var(--rc-called-fg)" },
  "en-atencion": { icon: <IconActivity size={11} stroke={2.4} />, bg: "var(--rc-attending-bg)", fg: "var(--rc-attending-fg)" },
  atendido: { icon: <IconCheck size={11} stroke={3} />, bg: "var(--st-completed-bg)", fg: "var(--st-completed-fg)" },
  ausente: { icon: <IconX size={11} stroke={2.6} />, bg: "var(--st-noshow-bg)", fg: "var(--st-noshow-fg)", border: "1px dashed rgba(154,91,0,0.4)" },
  cancelado: { icon: <IconX size={11} stroke={2.6} />, bg: "var(--st-cancelled-bg)", fg: "var(--st-cancelled-fg)" },
};

export function ReceptionStateTag({
  entry,
}: {
  // `calledMinutes` (SV10b): sin él el tag del llamado dice "Llamado" a secas.
  entry: Pick<ReceptionEntry<BookingDTO>, "state" | "waitingMinutes" | "lateMinutes" | "calledMinutes">;
}) {
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

/**
 * La acción principal de la fila (botón lleno): la primera de
 * `allowedTransitions` que avanza el turno. En sala → «Llamar» (y «En
 * atención» queda secundario: entrar sin llamar es la excepción); llamado →
 * «En atención»; en atención → «Atendido»; por llegar → «Llegó». Fuera de hoy
 * (`visibleActions` saca Llamar/En atención) cae en «Atendido». «Ausente» y
 * «Deshacer» nunca son primarios.
 */
function primaryAction(actions: ReadonlyArray<ReceptionAction>): ReceptionAction | undefined {
  return actions.find((a) => a !== "deshacer" && a !== "ausente");
}

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
  const primary = primaryAction(actions);
  // SV10b: quién opera ESTA fila. `canOperate` del DTO (S07sb) = full ||
  // `agenda.operateAll`: el profesional en las suyas, la Secretaria/OWNER/ADMIN
  // en todas (SV-D2: la Secretaria llama en nombre del profesional). Sin el
  // campo (proyecciones viejas) se asume operable; el server decide igual.
  const operable = b.canOperate !== false;

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
        {!cancelled && operable ? (
          <div className="rcp-actions">
            {actions.map((a) => (
              <button
                key={a}
                type="button"
                className={a === "deshacer" ? "rcp-btn rcp-btn-ghost" : a === primary ? "rcp-btn rcp-btn-primary" : "rcp-btn"}
                disabled={pending}
                onClick={() => onAction(b, a)}
                aria-label={
                  a === "deshacer"
                    ? // SV10b: el destino sale de `undoTarget` (en atención vuelve a
                      // Llamado solo si hubo llamado), no de una tabla local.
                      `Deshacer (${undoHint(b, now) ?? "vuelve un paso"}): ${who}`
                    : `Marcar ${RECEPTION_ACTION_LABEL[a]}: ${who}`
                }
              >
                {RECEPTION_ACTION_LABEL[a]}
              </button>
            ))}
            {/* PL-F1c: acá había un «Cobrar» deshabilitado («Próximamente»). Se quitó por la regla de Martin del
                16-oct (nada de botones a medio hacer). El cobro desde recepción es C0 (Secretaria): vuelve cuando
                abra el drawer en el cobro del copago de verdad. */}
          </div>
        ) : (
          <span style={{ color: "var(--navy-300)" }}>—</span>
        )}
      </td>
      )}
    </tr>
  );
}
