"use client";

import type { ReactNode } from "react";
import { Tag } from "@/components/ui/tag";
import { dayKeyOf } from "@/lib/availability/day";
import { Row } from "./billing-rows";
import type { DrawerBooking } from "./types";

/** "HH:MM" en hora AR (el drawer corre en el browser del staff, cualquier TZ). */
function arTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
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
 * Texto de la fila «Recepción». Atendido: ya no está "en atención"; queda la hora de llegada como dato.
 *
 * HF-2c: «En sala de espera desde las 10:42» (y «Llamado a las …» con el llamado) solo si el turno es de HOY (día
 * AR) y sigue esperando: con el «Llegó» ahora en el drawer, decir solo «Llegó a las» no contestaba la pregunta de
 * la Secretaria («¿sigue en la sala?»). Una llegada de otro día no sigue esperando (H-LL2: «En sala» se arrastraba
 * a días anteriores), así que ahí queda el dato histórico «Llegó a las …».
 */
function receptionText(b: DrawerBooking, now: Date): string | null {
  const waiting =
    !!b.arrivedAt &&
    !b.attendingAt &&
    (b.status === "PENDING" || b.status === "CONFIRMED") &&
    dayKeyOf(new Date(b.scheduledFor)) === dayKeyOf(now);
  if (waiting && b.calledAt) return `Llamado a las ${arTime(b.calledAt)} · en sala desde las ${arTime(b.arrivedAt!)}`;
  if (waiting) return `En sala de espera desde las ${arTime(b.arrivedAt!)}`;
  if (b.attendingAt && b.status !== "COMPLETED") return `En atención desde las ${arTime(b.attendingAt)}`;
  return b.arrivedAt ? `Llegó a las ${arTime(b.arrivedAt)}` : null;
}

/**
 * Filas extra del turno que trae B2/B3 (B5.7): sede, telemedicina, sobreturno y
 * estado de recepción. Todo opcional: si el DTO no trae el campo, la fila no
 * aparece (la agenda los suma en B4.3; hasta entonces el drawer se ve igual).
 * Fragmento dentro de la tarjeta de detalle, como `BillingRows`.
 *
 * SR-U5b: `room` = la fila "Sala" (`RoomRow`), justo debajo de la sede. La arma
 * `index.tsx` porque "Cambiar" necesita el estado y la llamada al server; para
 * quien no opera el turno la fila es de solo lectura. Ausente (sin salas en la
 * sede ni en el turno) = el detalle queda como antes de SR.
 */
export function ReceptionInfo({ booking, room }: { booking: DrawerBooking; room?: ReactNode }) {
  const url = safeUrl(booking.telemedicineUrl);
  const reception = receptionText(booking, new Date());
  return (
    <>
      {booking.locationName && <Row label="Sede">{booking.locationName}</Row>}
      {room}
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
