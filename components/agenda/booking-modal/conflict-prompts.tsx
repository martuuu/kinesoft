"use client";

/**
 * Prompts de confirmación que aparecen debajo del formulario del turno nuevo
 * (todos con `role="alert"` y el mismo `promptRef`, que `index.tsx` usa para
 * scrollearlos a la vista). Solo pintan: las acciones (re-llamar a
 * `createBooking`/`createBookingsBatch` con el flag de confirmación) las
 * resuelve `index.tsx`.
 *
 * - `BatchConflictPrompt`: preflight de Varias sesiones (sobreturnos / bloqueadas /
 *   fuera de horario / duplicados).
 * - `PatientOverlapPrompt`: el turno se cruza con otro del mismo paciente.
 * - `SamePatientPrompt`: el paciente ya tiene otro turno ese día (sin cruce).
 * - `ConflictPrompt`: el profesional ya tiene un turno → próximo libre o sobreturno.
 * - `BlockedPrompt` (B5.1): el horario cae sobre un bloqueo de agenda →
 *   "Cargar como sobreturno" (`allowBlocked`) / "Usar próximo libre" / "Volver".
 * - `OutOfHoursPrompt` (B5.1): fuera de la franja del profesional →
 *   "Cargar igual" (`allowOutOfHours`) / "Usar próximo libre" / "Volver".
 *
 * Orden en que el server los devuelve (lib/bookings.ts#createBooking):
 * bloqueado > fuera de horario > superposición del paciente > mismo día >
 * cupo. Uno confirmado puede destapar el siguiente; `index.tsx` acumula los
 * flags en el payload guardado (`withConfirmation`).
 */
import type { CSSProperties, MutableRefObject } from "react";
import { Button } from "@/components/ui/button";
import {
  countSessionStates,
  countsLine,
  describeSessionDate,
  sessionDateState,
} from "@/lib/sessions-mode-state";
import type {
  BatchConflictState,
  BlockedState,
  ConflictState,
  OutOfHoursState,
  PatientOverlapState,
  SamePatientState,
} from "./types";

type PromptRef = MutableRefObject<HTMLDivElement | null>;

/** "mar 09 mar 15:00" en hora AR (botón "Usar próximo libre" y listas). */
function fmtSlot(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

const WARN_BOX: CSSProperties = {
  padding: 14,
  borderRadius: 12,
  background: "rgba(255,176,32,0.14)",
  border: "1px solid rgba(255,176,32,0.45)",
  display: "grid",
  gap: 10,
};
const WARN_GHOST: CSSProperties = { color: "#7A4A00", borderColor: "rgba(122,74,0,0.3)" };

export function BatchConflictPrompt({
  promptRef,
  batchConflict,
  pending,
  onCreateAll,
  onCreateFreeOnly,
  onBack,
}: {
  promptRef: PromptRef;
  batchConflict: BatchConflictState;
  pending: boolean;
  /** Crear todas: libres + sobreturnos + bloqueadas como sobreturno (`allowOverbooking: true`). */
  onCreateAll: () => void;
  /** Crear solo las libres (`allowOverbooking: false`). */
  onCreateFreeOnly: () => void;
  onBack: () => void;
}) {
  const plan = batchConflict.plan;
  // Mismo vocabulario que el preview del modo Sesiones (B5.3,
  // `lib/sessions-mode-state`): estado principal por fecha (duplicado >
  // bloqueado > fuera de horario > sobreturno) y la línea de conteos.
  // B3.1: un bloqueo ya sube el status a "sobreturno" (cuenta en
  // `conflicted`); fuera de horario es solo aviso (decisión 2): esas fechas
  // cuentan como libres y se crean igual con cualquiera de los dos botones.
  const counts = countSessionStates(plan.dates);
  const line = countsLine(counts);
  const problems = plan.dates.filter((d) => sessionDateState(d) !== "libre");
  return (
    <div ref={promptRef} role="alert" style={WARN_BOX}>
      <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
        {problems.length} de {plan.requested} sesiones con aviso{line ? ` · ${line}` : ""}
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        {plan.free} se crean sin conflicto
        {counts["fuera-de-horario"] > 0 && " (incluye las fuera de horario: es solo un aviso)"}
        {plan.duplicates > 0 && ` · ${plan.duplicates} ya existen y no se pueden duplicar`}
        .
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--navy-500)",
          maxHeight: 120,
          overflowY: "auto",
          display: "grid",
          gap: 2,
        }}
      >
        {problems.map((d) => {
          const desc = describeSessionDate(d);
          return (
            <div key={d.iso}>
              <span className="k-mono">{fmtSlot(d.iso)}</span> · <strong>{desc.label}</strong>
              {desc.detail ? ` — ${desc.detail}` : ""}
              {desc.extra ? ` (${desc.extra.toLowerCase()})` : ""}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {plan.conflicted > 0 ? (
          <>
            <Button type="button" variant="primary" disabled={pending} onClick={onCreateAll}>
              Crear todas ({plan.free + plan.conflicted}, bloqueadas y sobreturnos como sobreturno)
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || plan.free === 0}
              onClick={onCreateFreeOnly}
              style={WARN_GHOST}
            >
              Crear solo las libres ({plan.free})
            </Button>
          </>
        ) : (
          // Sin sobreturnos ni bloqueos (solo fuera de horario y/o
          // duplicados): las dos opciones crearían lo mismo → un solo botón.
          <Button
            type="button"
            variant="primary"
            disabled={pending || plan.free === 0}
            onClick={onCreateFreeOnly}
          >
            Crear {plan.free === 1 ? "la sesión" : `las ${plan.free} sesiones`}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Volver atrás
        </Button>
      </div>
    </div>
  );
}

export function PatientOverlapPrompt({
  promptRef,
  patientOverlap,
  pending,
  onConfirm,
  onCancel,
}: {
  promptRef: PromptRef;
  patientOverlap: PatientOverlapState;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      ref={promptRef}
      role="alert"
      style={{
        padding: 14,
        borderRadius: 12,
        background: "rgba(31,79,190,0.08)",
        border: "1px solid rgba(31,79,190,0.28)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontSize: 13, color: "var(--sky-700)", fontWeight: 700 }}>
        Se superpone con otro turno del paciente
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        Ya tiene un turno a las{" "}
        {new Date(patientOverlap.existingISO).toLocaleString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        })}{" "}
        que se cruza con este horario. Puede ser intencional (dos servicios en
        paralelo). ¿Crear igual?
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={pending}>
          Sí, crear superpuesto
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

export function SamePatientPrompt({
  promptRef,
  samePatient,
  pending,
  onConfirm,
  onCancel,
}: {
  promptRef: PromptRef;
  samePatient: SamePatientState;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      ref={promptRef}
      role="alert"
      style={{
        padding: 14,
        borderRadius: 12,
        background: "rgba(31,79,190,0.08)",
        border: "1px solid rgba(31,79,190,0.28)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontSize: 13, color: "var(--sky-700)", fontWeight: 700 }}>
        Este paciente ya tiene {samePatient.count === 1 ? "un turno" : `${samePatient.count} turnos`} hoy
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        El primero es a las{" "}
        {new Date(samePatient.existingISO).toLocaleString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        })}
        . ¿Agregar otro turno para hoy?
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={pending}>
          Sí, agregar otro turno
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

export function ConflictPrompt({
  promptRef,
  conflict,
  pending,
  onUseSuggestedSlot,
  onForceOverbooking,
  onBack,
}: {
  promptRef: PromptRef;
  conflict: ConflictState;
  pending: boolean;
  /** Solo se ofrece si hay `nextFreeISO`. */
  onUseSuggestedSlot: () => void;
  onForceOverbooking: () => void;
  onBack: () => void;
}) {
  return (
    <div
      ref={promptRef}
      role="alert"
      style={{
        padding: 14,
        borderRadius: 12,
        background: "rgba(255,176,32,0.14)",
        border: "1px solid rgba(255,176,32,0.45)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
        ⚠ {conflict.practitionerName} ya tiene un turno en ese horario
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        Otros profesionales pueden tener turnos al mismo tiempo (varios kines en
        paralelo), pero el mismo kine no puede atender dos pacientes en simultáneo.
        Tenés dos opciones:
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {conflict.nextFreeISO && (
          <Button
            type="button"
            variant="primary"
            onClick={onUseSuggestedSlot}
            disabled={pending}
          >
            Usar próximo libre ·{" "}
            {new Date(conflict.nextFreeISO).toLocaleString("es-AR", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={onForceOverbooking}
          disabled={pending}
          style={{ color: "#7A4A00", borderColor: "rgba(122,74,0,0.3)" }}
        >
          Forzar sobreturno
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={pending}
        >
          Volver atrás
        </Button>
      </div>
    </div>
  );
}

/** Turno sobre un bloqueo de agenda (TimeBlock). Forzado queda como sobreturno. */
export function BlockedPrompt({
  promptRef,
  blocked,
  pending,
  onForce,
  onUseSuggestedSlot,
  onBack,
}: {
  promptRef: PromptRef;
  blocked: BlockedState;
  pending: boolean;
  /** Re-llamar con `allowBlocked: true`. */
  onForce: () => void;
  /** Solo se ofrece si hay `nextFreeISO`. */
  onUseSuggestedSlot: () => void;
  onBack: () => void;
}) {
  return (
    <div ref={promptRef} role="alert" style={WARN_BOX}>
      <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
        Este horario está bloqueado{blocked.reason ? `: ${blocked.reason}` : ""}
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        La agenda de {blocked.practitionerName} está bloqueada en ese horario. Si lo cargás igual,
        queda marcado como sobreturno.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {blocked.nextFreeISO && (
          <Button type="button" variant="primary" onClick={onUseSuggestedSlot} disabled={pending}>
            Usar próximo libre · {fmtSlot(blocked.nextFreeISO)}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onForce} disabled={pending} style={WARN_GHOST}>
          Cargar como sobreturno
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}

/** Turno fuera de la franja del profesional (o un día que no atiende). Solo aviso. */
export function OutOfHoursPrompt({
  promptRef,
  outOfHours,
  pending,
  onForce,
  onUseSuggestedSlot,
  onBack,
}: {
  promptRef: PromptRef;
  outOfHours: OutOfHoursState;
  pending: boolean;
  /** Re-llamar con `allowOutOfHours: true`. */
  onForce: () => void;
  /** Solo se ofrece si hay `nextFreeISO`. */
  onUseSuggestedSlot: () => void;
  onBack: () => void;
}) {
  return (
    <div ref={promptRef} role="alert" style={WARN_BOX}>
      <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
        Fuera del horario de {outOfHours.practitionerName}
      </div>
      <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
        Ese día u horario no está en su agenda de atención. Podés cargarlo igual (por ejemplo, un
        turno acordado aparte) o usar el próximo horario libre.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {outOfHours.nextFreeISO && (
          <Button type="button" variant="primary" onClick={onUseSuggestedSlot} disabled={pending}>
            Usar próximo libre · {fmtSlot(outOfHours.nextFreeISO)}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onForce} disabled={pending} style={WARN_GHOST}>
          Cargar igual
        </Button>
        <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
          Volver
        </Button>
      </div>
    </div>
  );
}
