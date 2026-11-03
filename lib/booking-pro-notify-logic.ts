/**
 * [CF2 · T-SE] Piezas puras del aviso al profesional cuando entra un turno online (plan §29, D-CF2-11). Las usan el
 * envío (`lib/booking-pro-notify-internal.ts`, server-only) y la plantilla del mail (`lib/email/templates-bookings.ts`).
 * Puro: ni red, ni env, ni Prisma (lo importan los tests y el script de diagnóstico).
 *
 * Qué datos viajan y por qué:
 *  - Push: «Nuevo turno online · lun 3/11 · 10:30 · {Consultorio}», SIN el nombre del paciente. La notificación se ve
 *    en la pantalla bloqueada del celular: la lee cualquiera que lo tenga en la mano. Por eso `bookingPushPayload` ni
 *    siquiera recibe al paciente (un cambio futuro no lo puede colar por descuido).
 *  - Mail: solo «Juan P.» (`patientShortName`), día, hora, duración y sede. Nada de servicio (puede ser clínico), DNI,
 *    teléfono, mail ni notas: el buzón lo lee cualquiera con acceso y viaja por proveedores de terceros.
 *  - Día y hora en hora argentina con `lib/datetime-ar.ts`: en Vercel el host es UTC, y un turno de las 23:30 AR
 *    (02:30 UTC del día siguiente) con `getDay`/`getHours` diría «mar 3/11 02:30» y abriría la agenda del día que no es.
 */
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import type { PushPayload } from "@/lib/web-push-types";

/**
 * Lo que el server manda al service worker (`public/sw.js`, handler `push`): ES el `PushPayload` del sender
 * (`lib/web-push-types.ts`, puro y sin imports, así que este módulo sigue sin arrastrar nada). Alias y no copia: si el
 * contrato del SW cambia, el aviso del turno no puede quedar con la forma vieja sin que `tsc` lo diga.
 */
export type BookingPushPayload = PushPayload;

/** Controles, saltos y separadores de línea → espacio; espacios colapsados. El nombre lo escribe el paciente. */
function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/** Recorta a `max` caracteres (por code point, para no partir un emoji o una letra compuesta) con «…». */
function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * «Juan P.»: el PRIMER nombre y la inicial del primer apellido. Solo el primer nombre a propósito (D-CF2-11 pide lo
 * mínimo para reconocer el turno; «María José Pérez» queda «María P.»). Sin nombre → «P.»; sin nada → «Paciente».
 * Un salto o un control en el nombre corta ahí la palabra: el turnero es público y el texto termina en un asunto.
 */
export function patientShortName(first: string | null | undefined, last: string | null | undefined): string {
  const firstWord = oneLine(first).split(" ")[0] ?? "";
  const lastInitial = Array.from(oneLine(last))[0]?.toLocaleUpperCase("es-AR") ?? "";
  const initial = lastInitial ? `${lastInitial}.` : "";
  return [firstWord, initial].filter(Boolean).join(" ") || "Paciente";
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Link relativo a la agenda del día del turno, en la vista del día (`?date=` lo lee `app/(app)/agenda/page.tsx` con
 * `parseDayKeyParam`; `view=timeline` es un `AgendaView` de `lib/agenda-client-state.ts`). Una clave que no tiene la
 * forma exacta cae a `/agenda`: nunca se arma un query con texto de afuera. El mail le antepone la URL de la app.
 */
export function bookingAgendaUrl(dayKey: string): string {
  return DAY_KEY_RE.test(dayKey) ? `/agenda?date=${dayKey}&view=timeline` : "/agenda";
}

const DOW_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** Día y hora AR del turno: `{ dayKey: "2026-11-09", dayLabel: "lun 9/11", time: "10:30" }`. */
export function bookingWhenAR(d: Date): { dayKey: string; dayLabel: string; time: string } {
  const dayKey = toARDateKey(d);
  const [, month, day] = dayKey.split("-").map(Number);
  const minutes = toARMinutes(d);
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { dayKey, dayLabel: `${DOW_ES[toARDow(d)]} ${day}/${month}`, time };
}

/** Techo del nombre del consultorio en el cuerpo del push: Android corta la línea igual, y el SW recorta a 160. */
const PUSH_TENANT_MAX = 80;

/**
 * Payload del push. `bookingId` (opcional) da un `tag` estable por turno: si el aviso sale dos veces (reintento del
 * webhook de Mercado Pago), el segundo reemplaza al primero en vez de apilar dos notificaciones iguales.
 */
export function bookingPushPayload(p: {
  tenantName: string;
  scheduledFor: Date;
  bookingId?: string | null;
}): BookingPushPayload {
  const { dayKey, dayLabel, time } = bookingWhenAR(p.scheduledFor);
  const tenant = clip(oneLine(p.tenantName), PUSH_TENANT_MAX);
  const payload: BookingPushPayload = {
    title: "Nuevo turno online",
    body: [dayLabel, time, tenant].filter(Boolean).join(" · "),
    url: bookingAgendaUrl(dayKey),
  };
  if (p.bookingId) payload.tag = `booking-${p.bookingId}`;
  return payload;
}
