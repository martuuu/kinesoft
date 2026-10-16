import "server-only";
/**
 * PF2-c (C-PF8): todo lo que `/agenda` lee, en ≤ 3 transacciones.
 *
 * Antes (PF-0b, `PERF_TIMING`): 8 tx por carga, una por lectura (`listServices`, `listPractitioners`,
 * `listInsurers`, `getTenantSettings`, `listLocations`, `listRoomOptions`, `listPatients`, más turnos y
 * disponibilidad), cada una con su BEGIN/set_config/COMMIT. Con un pool chico se serializaban y una lenta tiraba
 * P2028 al resto (AUDIT `runwithrls-interactive-tx-per-read`).
 *
 * Ahora:
 *   1. `listAgendaBookings` (lib/bookings.ts, no se toca: su tx propia, en paralelo con la 2).
 *   2. Bootstrap en UNA tx (`loadAgendaBootstrapInTx`): servicios, profesionales, obras sociales, horario del
 *      consultorio, sedes, salas y el paciente del deep-link. En serie (una conexión), cada uno una sentencia.
 *   3. `getAgendaAvailability` (el motor; depende de la sede guardada en las preferencias y de las sedes).
 * Las preferencias (`getUserPreferences`) no abren tx (`UserPreferences` no tiene RLS: una sentencia suelta).
 *
 * Qué se dejó de leer:
 *   - `listPatients()` (el directorio entero, ~135 ms con 1.000 pacientes y un Seq Scan de Booking, AUDIT
 *     `agenda-loads-full-patient-directory`): el picker del modal ya busca en el server (`searchPatientsForBooking`)
 *     y la lista solo servía para encontrar el paciente del deep-link (`?patient=`), que ahora se lee por id.
 *   - Columnas que la página no pasa al cliente (`user: true` entero de cada profesional, conteos de coberturas de
 *     cada obra social, `Tenant` entero).
 *
 * Sin `unstable_cache` acá: servicios/profesionales/obras sociales estaban cacheados (0 tx en caliente), pero en
 * frío eran 3 tx más y el contrato es ≤ 3 siempre. Dentro de la tx son 3 sentencias chicas por índice
 * (`tenantId`) en la misma conexión; si en misma región el total empeorara, D-PF-J manda separarlo.
 *
 * Fallas: como antes, sedes, salas, preferencias, capabilities y disponibilidad fallan SUELTAS (default y log):
 * la agenda de hoy no depende de ellas. Sedes y salas van AL FINAL de la tx y con catch: una sentencia que falla
 * deja la tx abortada en Postgres, pero lo ya leído está en memoria y el COMMIT de una tx abortada es un ROLLBACK
 * (es solo lectura: no hay nada que perder). Lo demás (servicios, profesionales, obras sociales, horario) sigue
 * siendo duro: si falla, la página falla como antes.
 *
 * Seguridad: `where: { tenantId }` a mano en cada query (en prod la conexión es BYPASSRLS). Las capabilities se
 * resuelven del Actor (sin query): sin `agenda.viewAll` no hay sedes (antes `listLocations` tiraba y la página
 * caía a `[]`); sin el módulo `salas`, sin catálogo de salas (como `listRoomOptions`).
 */
import type { DbClient } from "@/lib/rls";
import { runWithRls } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Discipline } from "@/lib/plans-constants";
import type { RoomOption } from "@/lib/rooms-types";
import { ROOM_ORDER } from "@/lib/rooms-read";
import type { AgendaViewPrefs } from "@/lib/preferences-constants";
import { DEFAULT_AGENDA_VIEW_PREFS } from "@/lib/preferences-constants";
import type { AgendaAvailability } from "@/lib/availability-actions-types";
import { listAgendaBookings } from "@/lib/bookings";
import { getAgendaAvailability } from "@/lib/availability-actions";
import { getUserPreferences } from "@/lib/preferences";
import { capabilitiesForActor } from "@/lib/authz";
import { roomsEnabled } from "@/lib/tenant-modules";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { displayMemberName } from "@/lib/display-name";
import { addDays, dayWindow } from "@/lib/availability/day";
import type { DayKey } from "@/lib/availability/types";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import { encodeAgendaWire, type AgendaWireBooking } from "@/lib/agenda-wire";
import { logger } from "@/lib/logger";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Un id de paciente del deep-link más largo que esto no es un id (cuid = 25): no se consulta. */
const DEEP_LINK_ID_MAX = 64;

export type AgendaServiceOption = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  color: string | null;
  discipline: Discipline | null;
};
export type AgendaLocationOption = { id: string; name: string; isPrimary: boolean };

export type AgendaBootstrap = {
  services: AgendaServiceOption[];
  practitioners: { id: string; name: string }[];
  insurers: { id: string; name: string }[];
  /** El paciente del deep-link (`?patient=`) si existe en el tenant y no está archivado; si no, vacío. */
  patients: { id: string; name: string }[];
  businessHours: { start: number; end: number; slotMinutes: number };
  locations: AgendaLocationOption[];
  rooms: RoomOption[];
};

export type AgendaPageData = AgendaBootstrap & {
  /** Turnos de la semana en el cable compacto (`lib/agenda-wire.ts`); el cliente los decodifica con el mismo catálogo. */
  bookings: AgendaWireBooking[];
  /** Preferencias de agenda tal como están guardadas (la página las cruza con lo que existe hoy). */
  agendaView: AgendaViewPrefs;
  capabilities: string[];
  availability: AgendaAvailability | null;
};

/**
 * Lecturas del bootstrap sobre una tx ya abierta. Cada una replica el `where`/orden del lector de antes
 * (`listServices`, `listPractitioners`, `listInsurers({ onlyActive: true })`, `getTenantSettings`, `listLocations`,
 * `listRoomOptions`) con solo las columnas que la página usa; el test de PF2-c compara contra esos lectores.
 */
export async function loadAgendaBootstrapInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<string>,
  opts: { patientId?: string | null } = {}
): Promise<AgendaBootstrap> {
  const tenantId = actor.tenantId;
  const services = await tx.service.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, durationMin: true, priceCents: true, color: true, discipline: true },
  });
  const practitioners = await tx.practitioner.findMany({
    where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
    orderBy: { createdAt: "asc" },
    select: { id: true, user: { select: { fullName: true } } },
  });
  // `isParticular` se filtra en la query (antes en la página): la obra social "Particular" no va al select del modal.
  const insurers = await tx.insurer.findMany({
    where: { tenantId, active: true, isParticular: false },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { businessHoursStart: true, businessHoursEnd: true, agendaSlotMinutes: true },
  });
  const deepLinkId = opts.patientId && opts.patientId.length <= DEEP_LINK_ID_MAX ? opts.patientId : null;
  // Mismo universo que el picker (`searchPatientsForBooking`) y que el `listPatients()` de antes: del tenant y no
  // archivado. Un id ajeno o archivado → el modal abre sin paciente, como antes (no estaba en la lista).
  const patient = deepLinkId
    ? await tx.patient.findFirst({
        where: { tenantId, id: deepLinkId, archivedAt: null },
        select: { id: true, firstName: true, lastName: true },
      })
    : null;

  let locations: AgendaLocationOption[] = [];
  if (caps.has("agenda.viewAll")) {
    try {
      locations = await tx.location.findMany({
        where: { tenantId, active: true },
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, isPrimary: true },
      });
    } catch (e) {
      logger.warn("agenda.bootstrap.listLocations_failed", { err: errMsg(e) });
    }
  }
  let rooms: RoomOption[] = [];
  if (roomsEnabled(actor.entitlements)) {
    try {
      rooms = await tx.room.findMany({
        where: { tenantId, active: true, location: { tenantId, active: true } },
        // Mismo orden que `listRoomOptions` y Configuración: un solo `ROOM_ORDER` (lib/rooms-read.ts).
        orderBy: ROOM_ORDER,
        select: { id: true, locationId: true, name: true, kind: true, capacity: true },
      });
    } catch (e) {
      logger.warn("agenda.bootstrap.listRoomOptions_failed", { err: errMsg(e) });
    }
  }

  return {
    services,
    practitioners: practitioners.map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) })),
    insurers,
    patients: patient ? [{ id: patient.id, name: `${patient.firstName} ${patient.lastName}` }] : [],
    businessHours: {
      start: tenant.businessHoursStart,
      end: tenant.businessHoursEnd,
      slotMinutes: tenant.agendaSlotMinutes,
    },
    locations,
    rooms,
  };
}

/**
 * Carga de `/agenda` para la semana que arranca en `monday` (DayKey AR). La página resuelve el Actor antes y le pasa
 * los mismos argumentos que usa para pintar (`monday` de `weekStartKey`, `?patient=`).
 */
export async function loadAgendaPage(
  actor: Actor,
  args: { monday: DayKey; patientId?: string | null }
): Promise<AgendaPageData> {
  const { monday } = args;
  const sunday = addDays(monday, 6);

  // Capabilities del Actor: sin query (la membresía viene en la foto del Actor, PL-1e).
  const capsP = capabilitiesForActor(actor).catch((e) => {
    logger.warn("agenda.bootstrap.getCapabilities_failed", { err: errMsg(e) });
    return new Set<string>() as ReadonlySet<string>;
  });
  // tx 1. Proyección liviana (B4.1): todos los profesionales y sedes de la semana; los chips y la sede filtran en el
  // cliente.
  const bookingsP = listAgendaBookings({ from: dayWindow(monday).start, to: dayWindow(sunday).end });
  const prefsP = getUserPreferences()
    .then((p) => p.agendaView)
    .catch((e) => {
      logger.warn("agenda.bootstrap.getUserPreferences_failed", { err: errMsg(e) });
      return { ...DEFAULT_AGENDA_VIEW_PREFS };
    });
  // tx 2.
  const bootP = capsP.then((caps) =>
    runWithRls(actor.tenantId, (tx) => loadAgendaBootstrapInTx(tx, actor, caps, { patientId: args.patientId }))
  );
  // tx 3. La disponibilidad depende de la sede guardada: arranca apenas están las prefs y las sedes, en paralelo
  // con los turnos. Sede guardada que ya no existe (archivada) → todas.
  const availabilityP = Promise.all([prefsP, bootP]).then(async ([prefs, boot]) => {
    const locationId = boot.locations.some((l) => l.id === prefs.locationId) ? prefs.locationId : null;
    try {
      const res = await getAgendaAvailability({ from: monday, to: sunday, locationId });
      if (!res.ok) {
        logger.warn("agenda.bootstrap.getAgendaAvailability_failed", { err: res.error });
        return null;
      }
      return res.data;
    } catch (e) {
      logger.warn("agenda.bootstrap.getAgendaAvailability_failed", { err: errMsg(e) });
      return null;
    }
  });

  const [rows, boot, agendaView, caps, availability] = await Promise.all([
    bookingsP,
    bootP,
    prefsP,
    capsP,
    availabilityP,
  ]);
  return {
    ...boot,
    // El catálogo del cable es EXACTAMENTE el que viaja en las props (`services`, `locations`): el cliente
    // decodifica con esas mismas listas.
    bookings: encodeAgendaWire(rows.map(toBookingDTO), { services: boot.services, locations: boot.locations }),
    agendaView,
    capabilities: [...caps],
    availability,
  };
}
