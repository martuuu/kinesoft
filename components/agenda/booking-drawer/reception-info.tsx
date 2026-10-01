"use client";

import { Tag } from "@/components/ui/tag";
import { Row } from "./billing-rows";
import type { DrawerBooking } from "./types";

/** "HH:MM" en hora AR (el drawer corre en el browser del staff, cualquier TZ). */
function arTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/** Solo links https (el server ya lo valida en el alta; esto evita pintar un
 *  `javascript:` si algún día llega un dato viejo o mal cargado). */
function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Filas extra del turno que trae B2/B3 (B5.7): sede, telemedicina, sobreturno y
 * estado de recepción. Todo opcional: si el DTO no trae el campo, la fila no
 * aparece (la agenda los suma en B4.3; hasta entonces el drawer se ve igual).
 * Fragmento dentro de la tarjeta de detalle, como `BillingRows`.
 */
export function ReceptionInfo({ booking }: { booking: DrawerBooking }) {
  const url = safeUrl(booking.telemedicineUrl);
  // Atendido: ya no está "en atención"; queda la hora de llegada como dato.
  const reception =
    booking.attendingAt && booking.status !== "COMPLETED"
      ? `En atención desde las ${arTime(booking.attendingAt)}`
      : booking.arrivedAt
        ? `Llegó a las ${arTime(booking.arrivedAt)}`
        : null;
  return (
    <>
      {booking.locationName && <Row label="Sede">{booking.locationName}</Row>}
      {booking.isTelemedicine && (
        <Row label="Modalidad">
          Telemedicina
          {url && (
            <>
              {" · "}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--sky-700)", fontWeight: 700 }}
              >
                Abrir videollamada
              </a>
            </>
          )}
        </Row>
      )}
      {booking.isOverbooked && (
        <Row label="Cupo">
          <Tag tone="soft">Sobreturno</Tag>
        </Row>
      )}
      {reception && <Row label="Recepción">{reception}</Row>}
    </>
  );
}
