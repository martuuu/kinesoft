import type { BookingStatus, PaymentStatus } from "@prisma/client";
import { formatARS } from "@/lib/format";
import type { AgendaBookingRow, AgendaPlanFields, BookingRow } from "@/lib/bookings-types";
import type { Discipline } from "@/lib/plans-constants";

export type BookingDTO = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceId: string;
  serviceName: string;
  serviceColor: string | null;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  /** Obra social ("Particular" when uninsured/guest). */
  obraSocial: string;
  /** Copago per session in cents (insurer copago, or service price for particular). */
  copagoCents: number;
  /** Row version for optimistic concurrency (Booking.updatedAt, ISO). */
  updatedAt: string;
  notes: string | null;
  /** Per-turno mini-diagnosis title (agenda card). Null when unset. */
  title: string | null;
  /** Per-turno mini-diagnosis long description. Null when unset. */
  description: string | null;
  /**
   * Sprint 16: tells the agenda whether to expose the link-to-HC + the
   * diagnosis chip. `"basic"` shows the booking + name only; `"none"`
   * is a guest booking (no patient row yet).
   */
  patientAccess: "full" | "basic" | "none";
  /**
   * A2b-S-ui: cobro del turno + alta (ISO). Con los dos, la agenda distingue la
   * reserva pública impaga ("Pendiente de pago") de la vencida a los 30 min
   * ("Pendiente de pago · vencida", `isHoldingCapacity`). Opcionales: si el
   * server no los manda, la agenda muestra el estado de siempre.
   */
  paymentStatus?: PaymentStatus;
  createdAt?: string;
  /** Revisión A2: reserva del turnero público (`isPublicReservation`). */
  publicReservation?: boolean;
  /**
   * B4.1 (proyección liviana `listAgendaBookings`). Opcionales: la proyección
   * completa (`listBookingsInRange`) no los trae y los componentes tienen que
   * verse como antes sin ellos.
   */
  /** Sobreturno (reemplaza el prefijo "[SOBRETURNO]" de notes). */
  isOverbooked?: boolean;
  /** Recepción: llegó a la sala / pasó a atención (ISO). */
  arrivedAt?: string | null;
  attendingAt?: string | null;
  /**
   * SV (M5): la recepción lo llamó (ISO). En el cable viaja COMPACTO (como
   * `roomId`): solo si hay llamado, porque es un estado de segundos/minutos y
   * casi todas las filas de la semana lo tienen en null; sin la clave =
   * no llamado (`receptionState` trata undefined y null igual).
   */
  calledAt?: string | null;
  /** null = sede principal. */
  locationId?: string | null;
  /** Nombre de la sede (con `locationId` null, el de la principal). */
  locationName?: string | null;
  isTelemedicine?: boolean;
  telemedicineUrl?: string | null;
  /** Sin `clinical.read` o acceso básico: title/description/notas vienen null a propósito. */
  clinicalHidden?: boolean;
  /**
   * P0-S07u (E1): permisos por fila calculados en el server (`AgendaBookingRow`,
   * S07sb). `canOperate` = `canOperateBooking` (reprogramar, estado, cancelar);
   * `clinicalWritable` = `canWriteClinical` (título, descripción, notas, "Usar
   * como diagnóstico", "últimos turnos"). Opcionales: la proyección completa
   * (`listBookingsInRange`) no los trae y el drawer cae en `bookingDrawerAccess`,
   * que falla cerrado.
   */
  canOperate?: boolean;
  clinicalWritable?: boolean;
  /**
   * SR (salas): sala del turno. En el CABLE viaja compacta (como C9): solo si
   * es un id; `null` ("Sin sala") se omite, así un turno de un consultorio sin
   * salas no suma ni un byte. En el cliente `expandPlanFields` (vía
   * `expandRoomFields`) la devuelve a `null` en la proyección LIVIANA.
   *
   * Tres valores, a propósito:
   * - `string`: la sala (el nombre sale del catálogo del bootstrap,
   *   `roomNameOf`; el server no lo manda);
   * - `null`: "Sin sala", sabido (proyección liviana expandida);
   * - `undefined`: "no sé" (proyección completa `listBookingsInRange`, o un DTO
   *   sin expandir). El filtro de sala no lo descarta y `buildRoomColumns` lo
   *   pone en "Sin sala"; por eso la agenda SIEMPRE expande.
   */
  roomId?: string | null;
} & Partial<AgendaPlanFields>;
/*
 * C9 (Planes, PLANES.md §4) en el DTO: `programId`, `sessionId`,
 * `pricedByPlan`, `plan` (chip: disciplina, ordinal, total vivo y título, este
 * último null sin `clinical.read`), `serviceDiscipline` y
 * `patientActiveLinkedPlanDisciplines`. Todos OPCIONALES (patrón B4.1): la
 * proyección completa no los trae y los componentes tienen que verse como
 * antes sin ellos.
 *
 * En el cable viajan COMPACTOS (`toBookingDTO`) y en el cliente se EXPANDEN
 * (`expandPlanFields`): ver abajo. Quien lea C9 en la agenda (S19a/S19b/S19c)
 * lee el DTO ya expandido, con los neutros de vuelta.
 */

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Fila del server → DTO del cliente (fechas a ISO). Acepta las dos
 * proyecciones; los campos de B4.1 solo aparecen si la fila los trae (con la
 * completa quedan ausentes, no en null/false, para no afirmar "no llegó" o
 * "sede principal" sin saberlo).
 */
export function toBookingDTO(row: BookingRow | AgendaBookingRow): BookingDTO {
  const base: BookingDTO = {
    id: row.id,
    scheduledFor: row.scheduledFor.toISOString(),
    durationMin: row.durationMin,
    status: row.status,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    serviceColor: row.serviceColor,
    practitionerId: row.practitionerId,
    patientId: row.patientId,
    patientName: row.patientName,
    patientCondition: row.patientCondition,
    obraSocial: row.obraSocial,
    copagoCents: row.copagoCents,
    updatedAt: row.updatedAt.toISOString(),
    notes: row.notes,
    title: row.title,
    description: row.description,
    patientAccess: row.patientAccess,
    paymentStatus: row.paymentStatus,
    createdAt: row.createdAt.toISOString(),
    publicReservation: row.publicReservation,
  };
  if (!("isOverbooked" in row)) return base;
  return {
    ...base,
    isOverbooked: row.isOverbooked,
    arrivedAt: iso(row.arrivedAt),
    attendingAt: iso(row.attendingAt),
    locationId: row.locationId,
    locationName: row.locationName,
    isTelemedicine: row.isTelemedicine,
    telemedicineUrl: row.telemedicineUrl,
    clinicalHidden: row.clinicalHidden,
    ...serverPermissions(row),
    ...compactRoomField(row),
    ...compactCalledField(row),
    ...compactPlanFields(row),
  };
}

/**
 * SV: `calledAt` viaja solo si hay llamado (ver `BookingDTO.calledAt`). Se lee
 * por forma porque `AgendaBookingRow.calledAt` es opcional hasta SV05.
 */
function compactCalledField(row: object): Pick<BookingDTO, "calledAt"> {
  const c = (row as { calledAt?: unknown }).calledAt;
  return c instanceof Date ? { calledAt: c.toISOString() } : {};
}

/**
 * SR: `roomId` compacto en el cable (mismo criterio que C9, abajo): viaja solo
 * si es un id. Se lee por forma porque `AgendaBookingRow.roomId` es opcional
 * hasta que SR3a lo selecciona: sin la clave (o en null) no se emite nada.
 */
function compactRoomField(row: object): Pick<BookingDTO, "roomId"> {
  const r = row as { roomId?: unknown };
  return typeof r.roomId === "string" ? { roomId: r.roomId } : {};
}

/**
 * C9 compacto para el cable (handoff de ES2b/S12p, decisión del orquestador
 * en PLANES C9): un turno suelto pesaba 777 B en el DTO base y el bloque C9
 * neutro entero le sumaba +133 B (+17 %), contra un presupuesto de +5 % del
 * payload semanal medido sobre turnos SUELTOS. Así que se omiten los neutros:
 * `programId`/`sessionId`/`plan` null, `pricedByPlan` false y
 * `patientActiveLinkedPlanDisciplines` `[]`. Un suelto de un paciente sin plan
 * no suma ni un byte; los turnos de plan crecen (es información nueva).
 *
 * `serviceDiscipline` NO viaja nunca: es un dato del servicio, no del turno, y
 * el cliente ya tiene el catálogo de servicios (`services[].discipline`);
 * `expandPlanFields` lo resuelve de ahí.
 *
 * Se lee por forma (no por el tipo) para tolerar una fila sin C9 (la completa,
 * o un mock viejo): sin la clave, no se emite nada.
 */
function compactPlanFields(row: object): Partial<AgendaPlanFields> {
  const r = row as Partial<AgendaPlanFields>;
  const out: Partial<AgendaPlanFields> = {};
  if (typeof r.programId === "string") out.programId = r.programId;
  if (typeof r.sessionId === "string") out.sessionId = r.sessionId;
  if (r.pricedByPlan === true) out.pricedByPlan = true;
  if (r.plan) out.plan = r.plan;
  if (r.patientActiveLinkedPlanDisciplines && r.patientActiveLinkedPlanDisciplines.length > 0) {
    out.patientActiveLinkedPlanDisciplines = r.patientActiveLinkedPlanDisciplines;
  }
  return out;
}

/** Disciplina por servicio, solo de los servicios que la traen (clave presente). */
export type ServiceDisciplineMap = ReadonlyMap<string, Discipline | null>;

export function serviceDisciplineMap(
  services: readonly { id: string; discipline?: Discipline | null }[]
): ServiceDisciplineMap {
  const out = new Map<string, Discipline | null>();
  for (const s of services) if (s.discipline !== undefined) out.set(s.id, s.discipline);
  return out;
}

/**
 * Inversa de `compactPlanFields`, en el cliente: devuelve los neutros C9 a un
 * DTO de la proyección LIVIANA (la que trae `isOverbooked`; con la completa no
 * hay C9 y el DTO vuelve igual) y resuelve `serviceDiscipline` del catálogo.
 * Así `isOutOfPlan`, el chip y el resaltado ven `programId: null` (suelto) y
 * no `undefined` ("no sé"), que es lo que distinguen.
 *
 * Sin el servicio en el mapa (catálogo sin `discipline`), `serviceDiscipline`
 * queda ausente y `isOutOfPlan` da `false`: falla hacia no mostrar el aviso.
 * Nota: sin el módulo `planes` el server mandaba `serviceDiscipline: null`;
 * acá sale la del servicio, pero sin plan vinculado (`[]`) no cambia nada de lo
 * que se muestra.
 */
export function expandPlanFields(dto: BookingDTO, disciplines: ServiceDisciplineMap | null): BookingDTO {
  if (dto.isOverbooked === undefined) return dto;
  const out: BookingDTO = {
    ...dto,
    ...expandRoomFields(dto),
    programId: dto.programId ?? null,
    sessionId: dto.sessionId ?? null,
    pricedByPlan: dto.pricedByPlan ?? false,
    plan: dto.plan ?? null,
    patientActiveLinkedPlanDisciplines: dto.patientActiveLinkedPlanDisciplines ?? [],
  };
  if (dto.serviceDiscipline === undefined && disciplines?.has(dto.serviceId)) {
    out.serviceDiscipline = disciplines.get(dto.serviceId) ?? null;
  }
  return out;
}

/**
 * SR: inversa de `compactRoomField`, como parche para spread. En la proyección LIVIANA (la que trae
 * `isOverbooked`) un `roomId` ausente es "Sin sala" sabido → `null`. Tiene que
 * ser `null` y no `undefined`: el filtro de sala (`AGENDA_FILTER_DIMENSIONS.
 * roomId`) deja pasar `undefined` como "no sé", así que sin expandir el filtro
 * "Consultorio 2" mostraría también los turnos sin sala (y "Sin sala" no
 * encontraría ninguno). Con la completa (sin `isOverbooked`) no se toca: ahí
 * `undefined` es honesto. La llama `expandPlanFields`, que es el único punto
 * de entrada de los DTO a la agenda (`agenda-client`, props y overrides): por
 * eso no hace falta un segundo `map`.
 */
export function expandRoomFields(dto: BookingDTO): Pick<BookingDTO, "roomId"> {
  if (dto.isOverbooked === undefined) return {};
  return { roomId: dto.roomId ?? null };
}

/**
 * Rótulo de un turno cuya sala ya no está en el catálogo (SRZ B5). El catálogo
 * del bootstrap trae solo salas activas de sedes activas, y `archiveRoom`
 * rechaza salas con turnos futuros (SR-D8): esto aparece solo en turnos
 * pasados. Mismo texto que la fila Sala del drawer.
 */
export const ARCHIVED_ROOM_LABEL = "Sala archivada";

/**
 * Catálogo de nombres de sala + "Sala archivada" para los `roomId` de los
 * turnos que no están en él (SRZ B5, decisión del orquestador). Sin esto,
 * tarjetas, Lista y Recepción mostraban un turno de una sala archivada como
 * uno sin sala (nada, o "—"), mientras el drawer decía "Sala archivada". Se
 * resuelve en el catálogo y no en cada vista para que Día, Por profesional,
 * Semana, Lista y Recepción digan lo mismo sin tocar sus `roomNameOf`.
 * Sin ids desconocidos devuelve el MISMO objeto (no invalida memos).
 */
export function withArchivedRooms<M extends Readonly<Record<string, { name: string }>>>(
  roomById: M,
  bookings: ReadonlyArray<{ roomId?: string | null }>
): M | Record<string, { name: string }> {
  const has = (m: object, k: string) => Object.prototype.hasOwnProperty.call(m, k);
  let out: Record<string, { name: string }> | null = null;
  for (const b of bookings) {
    const id = b.roomId;
    if (typeof id !== "string" || has(out ?? roomById, id)) continue;
    out ??= { ...roomById };
    out[id] = { name: ARCHIVED_ROOM_LABEL };
  }
  return out ?? roomById;
}

/** Nombre de la sala del turno, del catálogo del cliente; null sin sala o si no está (archivada). */
export function roomNameOf(
  roomById: Readonly<Record<string, { name: string }>> | null | undefined,
  b: Pick<BookingDTO, "roomId">
): string | null {
  if (!roomById || typeof b.roomId !== "string") return null;
  return roomById[b.roomId]?.name ?? null;
}

/**
 * `canOperate` / `clinicalWritable` de la fila, solo si vienen. Se leen por
 * forma (no por el tipo) porque los agrega S07sb en `AgendaBookingRow` en la
 * misma ola: así compila antes y después. Ausentes (no `false`) cuando no
 * llegan, para que el drawer use su fallback y no confunda "no vino" con "no".
 */
function serverPermissions(row: object): Pick<BookingDTO, "canOperate" | "clinicalWritable"> {
  const r = row as { canOperate?: unknown; clinicalWritable?: unknown };
  const out: Pick<BookingDTO, "canOperate" | "clinicalWritable"> = {};
  if (typeof r.canOperate === "boolean") out.canOperate = r.canOperate;
  if (typeof r.clinicalWritable === "boolean") out.clinicalWritable = r.clinicalWritable;
  return out;
}

export const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

// ─────────────────────────────────────────────────────────────────────────────
// Agenda slot grid (day + week views)
//
// A "slot" is minutes-from-midnight in AR wall-clock. `Tenant.agendaSlotMinutes`
// picks the granularity: 60 → one row per hour, 30 → half-hour rows so a 13:30
// turno gets its own labelled row instead of being folded into 13:00.
// Pure + framework-free so the bucketing math is unit-testable (docs/TESTING.md
// capa 1) — it replaced the old column-packing algorithm the timeline used.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows of the grid, as minutes-from-midnight: [480, 510, 540…] for 8→19 @30. */
export function buildSlots(startHour: number, endHour: number, slotMinutes: number): number[] {
  const step = slotMinutes === 30 ? 30 : 60;
  const from = Math.max(0, Math.floor(startHour)) * 60;
  const to = Math.min(24, Math.floor(endHour)) * 60;
  const out: number[] = [];
  for (let m = from; m < to; m += step) out.push(m);
  // Degenerate windows (start >= end) still render one row so the day isn't blank.
  return out.length ? out : [from];
}

/** "13:30" for a slot expressed in minutes-from-midnight. */
export function slotLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Which slot a turno belongs to: floor to the granularity, then clamp into the
 * visible window. Returns the slot value (minutes-from-midnight) plus whether it
 * had to be clamped, so the caller can surface out-of-window turnos separately
 * instead of silently mixing them into the first/last row.
 */
export function slotOf(
  arMinutes: number,
  slots: number[],
  slotMinutes: number
): { slot: number; outOfRange: "before" | "after" | null } {
  const step = slotMinutes === 30 ? 30 : 60;
  const first = slots[0];
  const last = slots[slots.length - 1];
  const floored = Math.floor(arMinutes / step) * step;
  if (floored < first) return { slot: first, outOfRange: "before" };
  if (floored > last) return { slot: last, outOfRange: "after" };
  return { slot: floored, outOfRange: null };
}

/**
 * Slots covered by a turno AFTER its starting one — used to hint "continúa …"
 * on the rows a long turno runs through, which would otherwise look free.
 */
export function coveredSlots(
  startArMinutes: number,
  durationMin: number,
  slots: number[],
  slotMinutes: number
): number[] {
  const step = slotMinutes === 30 ? 30 : 60;
  const startSlot = Math.floor(startArMinutes / step) * step;
  const end = startArMinutes + Math.max(0, durationMin);
  const out: number[] = [];
  for (let s = startSlot + step; s < end; s += step) {
    if (s >= slots[0] && s <= slots[slots.length - 1]) out.push(s);
  }
  return out;
}

export function fmtHour(d: Date) {
  return d.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/** Cents → "$1.234" (AR pesos, no decimals). Delegates to the shared
 *  `formatARS` so the currency formatting has a single source of truth. */
export function fmtMoney(cents: number) {
  return formatARS(cents);
}

/**
 * Obra social name to display, or "" when the patient is particular /
 * uninsured. The literal words "Particular" / "Obra social" are never
 * shown — only the actual insurer name (OSDE, Galeno…) appears.
 */
export function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

/**
 * Compact billing line: "Servicio - OSDE - $Copago". The obra social
 * segment is dropped entirely when particular, so it never prints the
 * word "Particular" — just "Servicio - $Copago".
 */
export function billingLine(b: { serviceName: string; obraSocial: string; copagoCents: number }) {
  const os = osLabel(b.obraSocial);
  return [b.serviceName, os, fmtMoney(b.copagoCents)].filter(Boolean).join(" - ");
}
