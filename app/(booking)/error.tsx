"use client";

import { RouteError } from "@/components/ui/route-error";
import { BookingFrame } from "@/components/booking/booking-unavailable";

/**
 * [VX2-d2] Error del segmento `(booking)` (turnero y resultado del pago). `(booking)` no tiene layout: sin el marco,
 * el error quedaba suelto en una página en blanco. Va en el marco del turnero con la h1 de `RouteError` (el error ES la
 * página). El nombre del consultorio no se conoce acá, así que el marco muestra el logo de la app.
 */
export default function BookingError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <BookingFrame narrow>
      <RouteError kind="booking" headingAs="h1" {...props} title="No pudimos cargar la reserva" />
    </BookingFrame>
  );
}
