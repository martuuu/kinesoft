"use client";

/**
 * PF2-c (C-PF8): borde cliente de `/agenda`. Recibe los turnos de la semana en el cable compacto
 * (`lib/agenda-wire.ts`, ≤ 400 kB la semana del fixture de volumen) y se los pasa a `AgendaClient` como el
 * `BookingDTO[]` de siempre, decodificados con el MISMO catálogo (`services`, `locations`) con el que el loader los
 * codificó. `AgendaClient` no cambia: `expandPlanFields`, las vistas, el drawer y el optimistic lock (`updatedAt`)
 * reciben exactamente lo de antes.
 *
 * `useMemo` por identidad de `wireBookings`: cada render del server (navegación, `router.refresh()`) trae un array
 * nuevo y da un `bookings` nuevo, igual que antes; un re-render del cliente no lo cambia (la agenda compara
 * `props.bookings` por identidad para descartar un refetch en vuelo).
 */
import { useMemo } from "react";
import { AgendaClient, type Props as AgendaClientProps } from "@/components/agenda/agenda-client";
import { decodeAgendaWire, type AgendaWireBooking } from "@/lib/agenda-wire";

export function AgendaFromWire({
  wireBookings,
  ...props
}: Omit<AgendaClientProps, "bookings"> & { wireBookings: AgendaWireBooking[] }) {
  const { services, locations } = props;
  const bookings = useMemo(
    () => decodeAgendaWire(wireBookings, { services, locations: locations ?? [] }),
    [wireBookings, services, locations]
  );
  return <AgendaClient {...props} bookings={bookings} />;
}
