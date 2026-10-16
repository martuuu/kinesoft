import "server-only";
/**
 * Zod de la proyección de la agenda y de la recepción (B4.1), fuera de `lib/bookings-types.ts` desde PF1-Z (D-PF5).
 *
 * Por qué: `bookings-types.ts` lo importan los componentes de la agenda (tipos, `RECEPTION_ACTIONS`, topes) y con
 * estos dos schemas adentro el JS inicial de /agenda cargaba zod entero (~13 kB gz, `--explain /agenda`). Solo los
 * usa `lib/bookings.ts` (server), así que van con `server-only`: si un componente vuelve a importarlos, el build falla.
 * Semántica sin cambios (se movió el código tal cual).
 */
import { z } from "zod";
import { AGENDA_BOOKINGS_MAX_DAYS, AGENDA_BOOKINGS_MAX_PRACTITIONERS, RECEPTION_ACTIONS } from "@/lib/bookings-types";

export const AgendaBookingsQuery = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    /** Vacío / ausente = todos los profesionales del tenant. */
    practitionerIds: z.array(z.string().min(1).max(64)).max(AGENDA_BOOKINGS_MAX_PRACTITIONERS).optional(),
    /** Ausente / null = todas las sedes. La principal incluye `locationId` null. */
    locationId: z.string().min(1).max(64).nullable().optional(),
    /**
     * SR: ausente / null = todas las salas; `"none"` = solo los turnos SIN sala
     * (filtro "Sin sala"; un id de sala es un cuid, nunca "none"); un id = esa
     * sala. Lo implementa SR3a en el `where`, sin queries nuevas.
     */
    roomId: z.union([z.literal("none"), z.string().min(1).max(64)]).nullable().optional(),
    /** Default true (la agenda muestra los cancelados tachados). */
    includeCancelled: z.boolean().optional(),
  })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: "Rango inválido." })
  .refine((q) => q.to.getTime() - q.from.getTime() <= AGENDA_BOOKINGS_MAX_DAYS * 86_400_000, {
    message: `El rango no puede superar ${AGENDA_BOOKINGS_MAX_DAYS} días.`,
  });
export type AgendaBookingsQueryInput = z.input<typeof AgendaBookingsQuery>;

export const ReceptionActionInput = z.object({
  bookingId: z.string().min(1).max(64),
  action: z.enum(RECEPTION_ACTIONS),
  /** Obligatorio: la recepción es justo donde dos personas tocan el mismo turno. */
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});
