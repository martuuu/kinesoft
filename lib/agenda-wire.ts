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
 * [AS-2o] T3e-2o (plan §23.9): `insurerKey` (filtro por obra social) viaja como `oi` SOLO si el catálogo trae
 * `insurers` (el de la página, que ya viaja en las props para el modal): se DERIVA de lo que el turno ya manda
 * (`deriveInsurerKey`: nombre de la OS contra el catálogo, invitado, acceso y `canOperate`) y viaja solo cuando la
 * derivación no lo reproduce: índice en el catálogo, `-1` = "particular", `null` o el id de una OS fuera del
 * catálogo (inactiva). Por qué derivar y no un default: con el fixture de volumen el cable estaba a 16 bytes del
 * presupuesto (317.033/317.049) y la mitad de los turnos son de una OS; un `"oi":0` por turno eran ~3,5 kB.
 * Sin `insurers` en el catálogo (un caller viejo), `insurerKey` viaja con su nombre completo y, al decodificar, un
 * `oi` sin catálogo se descarta: la clave queda AUSENTE (= "no sé", el filtro nunca la esconde), nunca inventada.
 *
 * T5 (C-TP10, §25.8 «Agenda»): la plata online del turno viaja AL FINAL de `FIELDS`, así solo crecen las filas
 * afectadas y el fixture de volumen (sin cobros online) da el MISMO cable byte a byte:
 *  - `od` = `onlineDepositCents` (Σ de señas PAID), solo si es > 0;
 *  - `po` = `paidOnline` (pagado entero por un cobro online), solo si es true.
 * Compactas como las de C9/SR/SV (sin `dflt`): `agendaRowToDTO` las pone en el DTO SOLO cuando no son neutras, así el
 * DTO de un turno sin plata online es idéntico al de antes de T5 (y al de `toBookingDTO`). Ausente = 0 / false.
 *
 * WA-S7 (T6 §26.5, WA-D21): la respuesta del paciente por WhatsApp viaja como `rp` = "c" («Confirmó») | "x" («Pidió
 * cancelar»), AL FINAL de `FIELDS` (después de `od`/`po`) y ausente cuando no hay respuesta (o es de otro horario: la
 * regla vive en `patientReplyOf`, en el server). El brief la llamaba `pr`, pero `pr` ya es `practitionerId`: gana el
 * código. Como `od`/`po`, `agendaRowToDTO` pone `patientReply` en el DTO solo cuando no es null, así la semana sin
 * respuestas da el mismo cable byte a byte (`pf2-agenda-budget`, 317.049). Un `rp` desconocido se descarta.
 *
 * Isomórfico (sin `server-only` ni `"use client"`): lo usan el loader de la página y el borde cliente.
 */
import { toBookingDTO, type BookingDTO } from "@/components/agenda/agenda-utils";
import type { AgendaBookingRow, PatientReply } from "@/lib/bookings-types";

/** Lo que el cliente ya recibe aparte (props `services` y `locations` de la agenda). */
export type AgendaWireCatalog = {
  services: ReadonlyArray<{ id: string; name: string; color: string | null }>;
  locations: ReadonlyArray<{ id: string; name: string; isPrimary: boolean }>;
  /** [AS-2o] Obras sociales de la página (activas, sin Particular). El MISMO array al codificar y al decodificar. */
  insurers?: ReadonlyArray<{ id: string; name: string }>;
};

/** Un turno en el cable: claves cortas (`FIELDS`) más, si las hubiera, claves nuevas con su nombre completo. */
export type AgendaWireBooking = Record<string, unknown>;

type InsurerLookup = {
  ids: ReadonlyArray<string>;
  index: ReadonlyMap<string, number>;
  /** Nombre → id, solo nombres que no se repiten en el catálogo (uno repetido no se puede derivar). */
  byName: ReadonlyMap<string, string>;
};

type Lookup = {
  service: ReadonlyMap<string, { name: string; color: string | null }>;
  location: ReadonlyMap<string, string>;
  primaryName: string | undefined;
  insurers: InsurerLookup | undefined;
};

/**
 * `BookingDTO` declara la plata online de T5 (`onlineDepositCents`/`paidOnline`, C-TP10) desde TP-3c y la respuesta
 * del paciente por WhatsApp (`patientReply`, WA-S7) desde WA-U2: el cable ya no suma campos propios. Alias y no
 * reemplazo para no tocar los callers que lo nombran.
 */
export type AgendaWireDTO = BookingDTO;
type WireDTO = AgendaWireDTO;

type Field = {
  key: keyof WireDTO;
  wire: string;
  dflt?: unknown;
  derive?: (dto: Partial<BookingDTO>, l: Lookup) => unknown;
  /** Valor del DTO ↔ valor en el cable (`dec` → `undefined` = basura: la clave queda ausente). */
  enc?: (v: unknown) => unknown;
  dec?: (w: unknown) => unknown;
};

// WA-S7: una letra por respuesta (`rp`); al decodificar, cualquier otra cosa se descarta (nunca se inventa un badge).
const REPLY_WIRE: Readonly<Record<PatientReply, string>> = { confirmed: "c", cancel_requested: "x" };
const REPLY_OF_WIRE: Readonly<Record<string, PatientReply>> = { c: "confirmed", x: "cancel_requested" };

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
  // T3 (C-AS2): medio del cobro del copago. Default null: solo crecen las filas pagadas (la semana es casi toda sin
  // cobrar). Va acá porque `toBookingDTO` lo arma después de `clinicalHidden` (el orden de claves es contrato).
  { key: "copagoPaymentMethod", wire: "pm", dflt: null },
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
  // T5 (C-TP10): al final y compactas (ausentes cuando son neutras, ver `agendaRowToDTO`): un turno sin plata online
  // no suma bytes ni claves.
  { key: "onlineDepositCents", wire: "od" },
  { key: "paidOnline", wire: "po" },
  // WA-S7: al final y compacta (ausente sin respuesta vigente, ver `agendaRowToDTO`).
  {
    key: "patientReply",
    wire: "rp",
    enc: (v) => REPLY_WIRE[v as PatientReply] ?? v,
    dec: (w) => (typeof w === "string" ? REPLY_OF_WIRE[w] : undefined),
  },
];
const KNOWN = new Set<string>(FIELDS.map((f) => f.key));
// `oi` es corta aunque no esté en `FIELDS`: un `oi` que llega sin catálogo de obras sociales se descarta, no se
// cuela en el DTO como clave desconocida.
const INSURER_WIRE = "oi";
const SHORT = new Set<string>([...FIELDS.map((f) => f.wire), INSURER_WIRE]);
const PARTICULAR = "particular";
const PARTICULAR_WIRE = -1;

function insurerLookupOf(insurers: AgendaWireCatalog["insurers"]): InsurerLookup | undefined {
  if (!insurers) return undefined;
  const count = new Map<string, number>();
  for (const i of insurers) count.set(i.name, (count.get(i.name) ?? 0) + 1);
  return {
    ids: insurers.map((i) => i.id),
    index: new Map(insurers.map((i, n) => [i.id, n])),
    byName: new Map(insurers.filter((i) => count.get(i.name) === 1).map((i) => [i.name, i.id])),
  };
}

function lookupOf(catalog: AgendaWireCatalog): Lookup {
  return {
    service: new Map(catalog.services.map((s) => [s.id, { name: s.name, color: s.color }])),
    location: new Map(catalog.locations.map((l) => [l.id, l.name])),
    primaryName: catalog.locations.find((l) => l.isPrimary)?.name,
    insurers: insurerLookupOf(catalog.insurers),
  };
}

/**
 * [AS-2o] La `insurerKey` más probable a partir de lo que el turno ya trae (es compresión: si no acierta, el valor
 * viaja explícito y la ida y vuelta sigue exacta). Como lo arma `listAgendaBookings`:
 *  - invitado (sin paciente) → particular;
 *  - `obraSocial` = nombre (único) de una OS del catálogo → su id (`obraSocial` sale de `insurerRef.name`);
 *  - acceso `basic` sin poder operar = profesional sin acceso al paciente → null (no ve la cobertura; su
 *    `obraSocial` dice «Particular» por defecto). La Secretaria también viaja como `basic` (nivel `admin`), pero
 *    opera (`agenda.operateAll`): ella sí ve la cobertura;
 *  - el resto → particular.
 */
function deriveInsurerKey(dto: Partial<BookingDTO>, ins: InsurerLookup): string | null {
  if (dto.patientId == null) return PARTICULAR;
  const byName = dto.obraSocial != null ? ins.byName.get(dto.obraSocial) : undefined;
  if (byName) return byName;
  return dto.patientAccess === "basic" && dto.canOperate === false ? null : PARTICULAR;
}

function encodeInsurerKey(v: string | null, ins: InsurerLookup): unknown {
  if (v === null) return null;
  if (v === PARTICULAR) return PARTICULAR_WIRE;
  return ins.index.get(v) ?? v;
}

/** `undefined` = no se puede resolver (índice fuera del catálogo): la clave queda ausente (nunca se esconde). */
function decodeInsurerKey(w: unknown, ins: InsurerLookup): string | null | undefined {
  if (w === null) return null;
  if (w === PARTICULAR_WIRE) return PARTICULAR;
  if (typeof w === "number") return ins.ids[w];
  return typeof w === "string" ? w : undefined;
}

/**
 * [AS-2o] Fila de `listAgendaBookings` → DTO con `insurerKey` (al final; ausente si la fila no la trae). Es
 * `toBookingDTO` más la clave del filtro por obra social; lo usan el loader de la página y el refetch en vivo de la
 * agenda, así las dos listas son intercambiables. Si `toBookingDTO` la sumara al final, este spread no cambia nada.
 */
export function agendaRowToDTO(row: AgendaBookingRow): AgendaWireDTO {
  // T5: la plata online va DESPUÉS de las claves de `toBookingDTO` y ANTES de `insurerKey`, el mismo orden en que
  // `decodeOne` las rearma (FIELDS → `oi`): la ida y vuelta conserva el orden de claves (contrato del cable). Solo
  // cuando no son neutras: una seña ≤ 0 o no entera no es una seña (misma defensa que `bookingMoneyBadge`).
  const od = row.onlineDepositCents;
  const dto: WireDTO = {
    ...toBookingDTO(row),
    ...(typeof od === "number" && Number.isInteger(od) && od > 0 ? { onlineDepositCents: od } : {}),
    ...(row.paidOnline === true ? { paidOnline: true } : {}),
    // WA-S7: solo con respuesta vigente (null/ausente = nada: el DTO de siempre).
    ...(row.patientReply === "confirmed" || row.patientReply === "cancel_requested" ? { patientReply: row.patientReply } : {}),
  };
  return row.insurerKey === undefined ? dto : { ...dto, insurerKey: row.insurerKey };
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
    out[f.wire] = f.enc ? f.enc(v) : v;
  }
  const ins = l.insurers;
  if (ins && src.insurerKey !== undefined) {
    const v = src.insurerKey as string | null;
    if (deriveInsurerKey(dto, ins) !== v) out[INSURER_WIRE] = encodeInsurerKey(v, ins);
  }
  for (const k of Object.keys(src)) if (!KNOWN.has(k) && !(ins && k === "insurerKey")) out[k] = src[k];
  return out;
}

function decodeOne(w: AgendaWireBooking, l: Lookup): AgendaWireDTO {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (f.wire in w) {
      const v = f.dec ? f.dec(w[f.wire]) : w[f.wire];
      if (v !== undefined) out[f.key] = v;
    } else if ("dflt" in f) out[f.key] = f.dflt;
    else if (f.derive) {
      // Se deriva con lo ya decodificado (serviceId/locationId van antes en `FIELDS`).
      const d = f.derive(out as Partial<BookingDTO>, l);
      if (d !== undefined) out[f.key] = d;
    }
  }
  const ins = l.insurers;
  if (ins) {
    // Después de `FIELDS`: la derivación lee paciente, `obraSocial`, acceso y `canOperate` ya decodificados.
    const k = INSURER_WIRE in w ? decodeInsurerKey(w[INSURER_WIRE], ins) : deriveInsurerKey(out as Partial<BookingDTO>, ins);
    if (k !== undefined) out.insurerKey = k;
  }
  for (const k of Object.keys(w)) if (!SHORT.has(k)) out[k] = w[k];
  return out as AgendaWireDTO;
}

/** Server: DTO de la proyección liviana (`toBookingDTO` de `listAgendaBookings`) → cable. */
export function encodeAgendaWire(dtos: ReadonlyArray<BookingDTO>, catalog: AgendaWireCatalog): AgendaWireBooking[] {
  const l = lookupOf(catalog);
  return dtos.map((d) => encodeOne(d, l));
}

/** Cliente: cable → el mismo `BookingDTO` que antes (con el MISMO catálogo que usó `encodeAgendaWire`). */
export function decodeAgendaWire(wire: ReadonlyArray<AgendaWireBooking>, catalog: AgendaWireCatalog): AgendaWireDTO[] {
  const l = lookupOf(catalog);
  return wire.map((w) => decodeOne(w, l));
}
