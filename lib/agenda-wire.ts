/**
 * PF2-c (C-PF8): el CABLE de los turnos de la semana de `/agenda` (server → cliente).
 *
 * Por qué: el payload RSC de la semana pesaba ~800 kB en el fixture de volumen de A1 (`agendaPayloadBytes` =
 * 802.569 en `tests/perf/pf.json`, ~795 B por turno) y la meta es ≤ 400 kB. Todos los campos del `BookingDTO` los
 * usa algún componente (se revisó campo por campo), así que no hay nada que "no mandar": lo que sobraba era la
 * FORMA. Por turno, ~45 % eran nombres de claves y otro ~40 % valores neutros (`notes: null`, `isOverbooked:
 * false`, `canOperate: true`…) o repetidos del catálogo que el cliente YA recibe (`serviceName`/`serviceColor` del
 * servicio, `locationName` de la sede).
 *
 * El cable es un objeto con claves cortas, sin los valores por defecto y sin lo derivable del catálogo. El cliente
 * lo vuelve a `BookingDTO` con `decodeAgendaWire` ANTES de todo lo demás (`AgendaFromWire`, en la página), así
 * `AgendaClient`, `expandPlanFields`, las vistas y el drawer reciben exactamente el DTO de siempre. Contrato
 * (tests/unit/agenda-wire.test.ts y tests/integration/pf2-agenda-budget.test.ts): para toda fila de la proyección
 * liviana, `JSON.stringify(decode(encode(dto)))` === `JSON.stringify(dto)`, con el MISMO orden de claves (por si
 * algo compara serializado).
 *
 * Reglas, por campo (`FIELDS`, en el orden de `toBookingDTO`):
 *  - `dflt`: se omite si vale eso; al decodificar, ausente = ese valor. Solo para claves que la proyección liviana
 *    SIEMPRE trae (si una faltara, decodificar la inventaría: el test de ida y vuelta lo cubre).
 *  - `derive`: se omite si el catálogo (servicios y sedes que la página manda igual) reproduce el valor exacto;
 *    si no (servicio o sede fuera del catálogo, color distinto), viaja explícito, incluso `null`.
 *  - sin regla: viaja tal cual si está (las claves ya compactas de C9/SR/SV, `roomId`, `calledAt`, siguen
 *    ausentes cuando son neutras y `expandPlanFields` las expande como siempre).
 * Una clave del DTO que no esté en `FIELDS` (un campo nuevo) viaja con su nombre completo: nunca se pierde nada.
 *
 * Isomórfico (sin `server-only` ni `"use client"`): lo usan el loader de la página y el borde cliente.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/** Lo que el cliente ya recibe aparte (props `services` y `locations` de la agenda). */
export type AgendaWireCatalog = {
  services: ReadonlyArray<{ id: string; name: string; color: string | null }>;
  locations: ReadonlyArray<{ id: string; name: string; isPrimary: boolean }>;
};

/** Un turno en el cable: claves cortas (`FIELDS`) más, si las hubiera, claves nuevas con su nombre completo. */
export type AgendaWireBooking = Record<string, unknown>;

type Lookup = {
  service: ReadonlyMap<string, { name: string; color: string | null }>;
  location: ReadonlyMap<string, string>;
  primaryName: string | undefined;
};

type Field = {
  key: keyof BookingDTO;
  wire: string;
  dflt?: unknown;
  derive?: (dto: Partial<BookingDTO>, l: Lookup) => unknown;
};

/** `undefined` = el catálogo no lo sabe → el valor viaja explícito. */
const locationNameOf = (dto: Partial<BookingDTO>, l: Lookup) =>
  dto.locationId == null ? l.primaryName : l.location.get(dto.locationId);

// Claves cortas de 1-2 letras: ninguna choca con un nombre de campo del DTO (todos tienen ≥ 2 letras y ninguno de
// 2 coincide), así una clave nueva con nombre completo no se confunde con una corta.
const FIELDS: ReadonlyArray<Field> = [
  { key: "id", wire: "i" },
  { key: "scheduledFor", wire: "s" },
  { key: "durationMin", wire: "d" },
  { key: "status", wire: "st" },
  { key: "serviceId", wire: "sv" },
  { key: "serviceName", wire: "sn", derive: (dto, l) => (dto.serviceId ? l.service.get(dto.serviceId)?.name : undefined) },
  {
    key: "serviceColor",
    wire: "sc",
    derive: (dto, l) => (dto.serviceId && l.service.has(dto.serviceId) ? l.service.get(dto.serviceId)!.color : undefined),
  },
  { key: "practitionerId", wire: "pr" },
  { key: "patientId", wire: "p", dflt: null },
  { key: "patientName", wire: "n" },
  { key: "patientCondition", wire: "pc", dflt: null },
  { key: "obraSocial", wire: "o" },
  { key: "copagoCents", wire: "c" },
  { key: "updatedAt", wire: "u" },
  { key: "notes", wire: "nt", dflt: null },
  { key: "title", wire: "t", dflt: null },
  { key: "description", wire: "ds", dflt: null },
  { key: "patientAccess", wire: "a", dflt: "full" },
  { key: "paymentStatus", wire: "ps", dflt: "UNPAID" },
  { key: "createdAt", wire: "ca" },
  { key: "publicReservation", wire: "pu", dflt: false },
  { key: "isOverbooked", wire: "ob", dflt: false },
  { key: "arrivedAt", wire: "ar", dflt: null },
  { key: "attendingAt", wire: "at", dflt: null },
  { key: "locationId", wire: "l", dflt: null },
  { key: "locationName", wire: "ln", derive: locationNameOf },
  { key: "isTelemedicine", wire: "tm", dflt: false },
  { key: "telemedicineUrl", wire: "tu", dflt: null },
  { key: "clinicalHidden", wire: "ch", dflt: false },
  { key: "canOperate", wire: "co", dflt: true },
  { key: "clinicalWritable", wire: "cw", dflt: true },
  { key: "roomId", wire: "r" },
  { key: "calledAt", wire: "cl" },
  { key: "programId", wire: "pg" },
  { key: "sessionId", wire: "se" },
  { key: "pricedByPlan", wire: "pp" },
  { key: "plan", wire: "pl" },
  { key: "serviceDiscipline", wire: "sd" },
  { key: "patientActiveLinkedPlanDisciplines", wire: "pd" },
];
const KNOWN = new Set<string>(FIELDS.map((f) => f.key));
const SHORT = new Set<string>(FIELDS.map((f) => f.wire));

function lookupOf(catalog: AgendaWireCatalog): Lookup {
  return {
    service: new Map(catalog.services.map((s) => [s.id, { name: s.name, color: s.color }])),
    location: new Map(catalog.locations.map((l) => [l.id, l.name])),
    primaryName: catalog.locations.find((l) => l.isPrimary)?.name,
  };
}

function encodeOne(dto: BookingDTO, l: Lookup): AgendaWireBooking {
  const src = dto as Record<string, unknown>;
  const out: AgendaWireBooking = {};
  for (const f of FIELDS) {
    if (!(f.key in src)) continue;
    const v = src[f.key];
    if ("dflt" in f && v === f.dflt) continue;
    if (f.derive) {
      const d = f.derive(dto, l);
      if (d !== undefined && d === v) continue;
    }
    out[f.wire] = v;
  }
  for (const k of Object.keys(src)) if (!KNOWN.has(k)) out[k] = src[k];
  return out;
}

function decodeOne(w: AgendaWireBooking, l: Lookup): BookingDTO {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (f.wire in w) out[f.key] = w[f.wire];
    else if ("dflt" in f) out[f.key] = f.dflt;
    else if (f.derive) {
      // Se deriva con lo ya decodificado (serviceId/locationId van antes en `FIELDS`).
      const d = f.derive(out as Partial<BookingDTO>, l);
      if (d !== undefined) out[f.key] = d;
    }
  }
  for (const k of Object.keys(w)) if (!SHORT.has(k)) out[k] = w[k];
  return out as BookingDTO;
}

/** Server: DTO de la proyección liviana (`toBookingDTO` de `listAgendaBookings`) → cable. */
export function encodeAgendaWire(dtos: ReadonlyArray<BookingDTO>, catalog: AgendaWireCatalog): AgendaWireBooking[] {
  const l = lookupOf(catalog);
  return dtos.map((d) => encodeOne(d, l));
}

/** Cliente: cable → el mismo `BookingDTO` que antes (con el MISMO catálogo que usó `encodeAgendaWire`). */
export function decodeAgendaWire(wire: ReadonlyArray<AgendaWireBooking>, catalog: AgendaWireCatalog): BookingDTO[] {
  const l = lookupOf(catalog);
  return wire.map((w) => decodeOne(w, l));
}
