"use client";

/**
 * HF-2c (H-LL1, D-HF1/PL-D6): «Llegó» · «En atención» · «Deshacer» en el drawer del turno, para TODOS los planes.
 *
 * Por qué acá: en Individual y Consultorio no había dónde marcar la llegada. La vista Recepción y `/sala` son de la
 * Sala de Espera (Clínica / Libre; `app/(app)/agenda/page.tsx` ni resuelve la vista sin el módulo), las tarjetas
 * solo muestran el estado y el drawer solo tenía las acciones de estado del turno. El server sí lo permitía:
 * `markReceptionAction` solo gatea «Llamar» por `salaEspera` (`lib/bookings.ts`, bloque PL-2f).
 *
 * Reglas (las mismas que el server; esto solo evita ofrecer un botón que va a rebotar):
 * - capability `agenda.reception` (BILLING no la tiene) y `canOperate` del turno (`bookingDrawerAccess`);
 * - solo turnos de HOY, día AR (`dayKeyOf`): el server rechaza Llegó / Llamar / En atención fuera de hoy, y un
 *   Deshacer de ayer desde el drawer no tiene a quién servirle;
 * - las transiciones salen de `allowedTransitions` (`lib/reception-state.ts`), sin «Atendido» / «Ausente» (ya
 *   están en «Cambiar estado», `./status-actions`) y con «Deshacer» solo desde en sala, llamado o en atención:
 *   deshacer un Atendido / Ausente desde acá competiría con «Cambiar estado» por el mismo estado;
 * - «Llamar» solo con el módulo `salaEspera` (sin él no hay pantalla de la sala a la que llamar).
 *
 * Pieza controlada (B1.5b): no llama al server. La llamada, el lock optimista y el toast con «Deshacer» viven en
 * `./index.tsx`, como el resto de las mutaciones del drawer.
 */
import { Button, type ButtonVariant } from "@/components/ui/button";
import type { Capability } from "@/lib/capabilities";
import { dayKeyOf } from "@/lib/availability/day";
import {
  RECEPTION_ACTION_LABEL,
  allowedTransitions,
  receptionState,
  type ReceptionAction,
  type ReceptionState,
} from "@/lib/reception-state";
import { undoHint } from "@/lib/reception-view-state";
import type { DrawerBooking } from "./types";

/** Estados desde los que el drawer ofrece «Deshacer» (ver cabecera). */
const UNDO_FROM: ReadonlySet<ReceptionState> = new Set(["en-sala", "llamado", "en-atencion"]);

export type DrawerReceptionContext = {
  caps: ReadonlySet<Capability>;
  /** `bookingDrawerAccess(...).canOperate`. */
  canOperate: boolean;
  /** El consultorio tiene `salaEspera` (Clínica / Libre): habilita «Llamar». */
  waitingRoom: boolean;
  now: Date;
};

type ReceptionRow = Pick<
  DrawerBooking,
  "id" | "scheduledFor" | "durationMin" | "status" | "arrivedAt" | "calledAt" | "attendingAt" | "patientId"
> &
  Partial<Pick<DrawerBooking, "paymentStatus">> & { publicReservation?: boolean };

/** Acciones de recepción que muestra el drawer, en el orden de `allowedTransitions`. Puro (lo cubre el render test). */
export function drawerReceptionActions(b: ReceptionRow, ctx: DrawerReceptionContext): ReceptionAction[] {
  if (!ctx.caps.has("agenda.reception") || !ctx.canOperate) return [];
  if (dayKeyOf(new Date(b.scheduledFor)) !== dayKeyOf(ctx.now)) return [];
  const state = receptionState(b, ctx.now);
  return allowedTransitions(state).filter((a) => {
    if (a === "llego" || a === "en-atencion") return true;
    if (a === "llamar") return ctx.waitingRoom;
    if (a === "deshacer") return UNDO_FROM.has(state);
    return false; // atendido / ausente: «Cambiar estado»
  });
}

/** Primer nombre para el toast («Marcaste la llegada de Martina»); un guest sin nombre cae a «el paciente». */
export function receptionFirstName(patientName: string | null | undefined): string {
  return patientName?.trim().split(/\s+/)[0] || "el paciente";
}

/** Título del toast de éxito. `deshacer` no ofrece otro «Deshacer» (el caller no le pone acción). */
export function receptionToastTitle(action: ReceptionAction, patientName: string | null | undefined): string {
  const name = receptionFirstName(patientName);
  switch (action) {
    case "llego":
      return `Marcaste la llegada de ${name}`;
    case "en-atencion":
      return `${name} pasó a atención`;
    case "llamar":
      return `Llamaste a ${name}`;
    case "deshacer":
      return "Listo, lo deshiciste";
    default:
      return "Turno actualizado";
  }
}

const VARIANT: Partial<Record<ReceptionAction, ButtonVariant>> = {
  // Lima = «en sala» (el color establecido de la llegada); el resto, secundarias para no competir con el pie.
  llego: "lime",
  "en-atencion": "primary",
};

export function ReceptionActions({
  booking,
  actions,
  pending,
  now,
  onAction,
}: {
  booking: ReceptionRow;
  actions: readonly ReceptionAction[];
  pending: boolean;
  now: Date;
  onAction: (action: ReceptionAction) => void;
}) {
  if (actions.length === 0) return null;
  return (
    <div role="group" aria-label="Recepción" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
      {actions.map((a) => {
        const hint = a === "deshacer" ? undoHint(booking, now) : null;
        return (
          <Button
            key={a}
            type="button"
            size="sm"
            variant={VARIANT[a] ?? "ghost"}
            data-reception-action={a}
            disabled={pending}
            aria-label={hint ? `${RECEPTION_ACTION_LABEL[a]} (${hint})` : undefined}
            title={hint ?? undefined}
            onClick={() => onAction(a)}
          >
            {RECEPTION_ACTION_LABEL[a]}
          </Button>
        );
      })}
    </div>
  );
}
