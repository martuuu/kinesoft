"use server";

/**
 * Lectura de turnos de /sala (FX2a, PD-13 en el re-pedido).
 *
 * Por qué una action propia y no `listAgendaBookings` directo desde el cliente:
 * el bootstrap de la página ya pasaba los DTO por `toSalaRow` en el server, pero
 * el re-pedido en vivo llamaba a `listAgendaBookings` desde el browser, así que
 * a OWNER/PRACTITIONER (con `clinical.read`) les volvían a viajar `title`,
 * `description` y `notes` en cada lote realtime, aunque la card no los pintara.
 * Acá la proyección (`toSalaWire`) se hace en el server: esas claves no salen.
 *
 * Gate = el de la página: módulo `salaEspera` y capability `agenda.reception`
 * (BILLING → error). El recorte por profesional (sin `agenda.viewAll`, solo
 * los propios) y el `tenantId` a mano los hace `listAgendaBookings`, que se
 * reusa entero para no duplicar la query ni su regla de visibilidad.
 */
import { z } from "zod";
import { assertModule, requireCapability } from "@/lib/authz";
import { listAgendaBookings } from "@/lib/bookings";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import { toSalaWire, type SalaWireRow } from "@/lib/sala-board-state";

/**
 * El tablero pide UN día AR (24 h; `dayWindow`). Se acepta hasta 36 h de
 * margen y no más: esta action no es un export de la agenda.
 */
const MAX_WINDOW_MS = 36 * 60 * 60 * 1000;

const SalaBookingsQuery = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: "Rango inválido." })
  .refine((q) => q.to.getTime() - q.from.getTime() <= MAX_WINDOW_MS, { message: "La sala muestra un solo día." });

export async function listSalaBookings(raw: { from: Date | string; to: Date | string }): Promise<SalaWireRow[]> {
  const { actor } = await requireCapability("agenda.reception", "No tenés acceso a la sala de espera.");
  assertModule(actor, "salaEspera");
  const q = SalaBookingsQuery.parse(raw);
  const rows = await listAgendaBookings({ from: q.from, to: q.to, includeCancelled: false });
  return rows.map((r) => toSalaWire(toBookingDTO(r)));
}
