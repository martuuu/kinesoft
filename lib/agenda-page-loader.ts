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
 *
 * CF2 (§29 D-CF2-7, brief A.4/A.5) — vista Mes (`?view=month`, la página pasa `monthRange` = `monthGridRange`): las
 * tx 1 y 3 NO corren (un mes de filas de turnos eran ~600 kB para pintar un número por celda) y en su lugar va UNA tx
 * con el resumen (`loadAgendaMonthSummaryInTx`, la misma de `getAgendaMonthSummary`): ≤ 2 tx en total con el
 * bootstrap. `bookings` = [] y `availability` = null; el cliente del Mes pinta `month`. Sin `monthRange`, la Semana
 * corre EXACTAMENTE como antes (mismas sentencias, mismo payload; `month` = null). Lo fija
 * `tests/integration/cf2-agenda-month-loader.test.ts`.
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
import type { Capability } from "@/lib/capabilities";
import { mpConnectMode, type MpConnectMode, type WhatsappMode } from "@/lib/env";
import { roomsEnabled } from "@/lib/tenant-modules";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { displayMemberName } from "@/lib/display-name";
import { addDays, dayWindow } from "@/lib/availability/day";
import type { DayKey } from "@/lib/availability/types";
import { agendaRowToDTO, encodeAgendaWire, type AgendaWireBooking } from "@/lib/agenda-wire";
import { logger } from "@/lib/logger";
import { tenantWhatsAppActiveFor } from "@/lib/whatsapp/active-internal";
import type { AgendaMonthSummary } from "@/lib/agenda-month-types";
import { AgendaMonthQuery } from "@/lib/agenda-month-schemas";
import { loadAgendaMonthSummaryInTx } from "@/lib/agenda-month-internal";

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

/**
 * T5 (TP-2h, §25.12 «`onlineMoney` con 0 sentencias»): lo que la agenda necesita saber de cobros online para decidir
 * si ofrece «Generar link de pago» en el drawer, sin leer nada de la base. `listAgendaBookings` está a un techo de
 * sentencias (§25.2 #5): la seña y el «pagado online» de cada turno ya viajan en el cable (`od`/`po`, TP-2e); acá va
 * solo lo que sale del entorno y de las capabilities que el Actor ya trae.
 *   - `enabled`: el modo de cobros online no está apagado (`MP_CONNECT_MODE ≠ off`). Apagado → no hay links.
 *   - `canLink`: además, el viewer puede cobrar (`billing.collect`, o `billing.collectOwn` con profesional propio:
 *     el chequeo fino por turno sigue siendo `canCollectCopago` en la UI y en la action). Soporte nunca.
 * La cuenta y la delegación NO se miran acá (serían sentencias): las resuelve `getPaymentLinkSuggestions` al abrir el
 * drawer del link, que devuelve el motivo si falta algo.
 */
export type AgendaOnlineMoney = { enabled: boolean; canLink: boolean };

export function agendaOnlineMoneyFor(
  caps: ReadonlySet<Capability | string>,
  actor: Pick<Actor, "support" | "practitionerId">,
  mode: MpConnectMode = mpConnectMode()
): AgendaOnlineMoney {
  const enabled = mode !== "off";
  const collects = caps.has("billing.collect") || (caps.has("billing.collectOwn") && actor.practitionerId != null);
  return { enabled, canLink: enabled && !actor.support && collects };
}

export type AgendaPageData = AgendaBootstrap & {
  /** Turnos de la semana en el cable compacto (`lib/agenda-wire.ts`); el cliente los decodifica con el mismo catálogo. */
  bookings: AgendaWireBooking[];
  /** Preferencias de agenda tal como están guardadas (la página las cruza con lo que existe hoy). */
  agendaView: AgendaViewPrefs;
  capabilities: string[];
  availability: AgendaAvailability | null;
  onlineMoney: AgendaOnlineMoney;
  /**
   * WA-S7 (T6 §26.5): el consultorio manda WhatsApp = `WHATSAPP_MODE` no está en `off` y tiene una cuenta ACTIVE de
   * ese mismo modo (`agendaWhatsAppFor`). La agenda lo usa para montar la sección WhatsApp del drawer (WA-U2). El badge
   * «Confirmó» / «Pidió cancelar» de la card NO depende de esto: sale del cable (`rp`), que solo existe si el paciente
   * respondió. Con el modo `off`: false sin ninguna query.
   */
  whatsapp: boolean;
  /**
   * CF2 (brief A.4): resumen de la vista Mes (conteos y candado por día y profesional), solo si la página pidió el mes
   * (`monthRange`) y el viewer tiene `agenda.viewAll` (la misma puerta que `getAgendaMonthSummary`). En Semana, Día,
   * Lista y Recepción: null.
   */
  month: AgendaMonthSummary | null;
};

/** CF2: rango de la grilla del Mes (`monthGridRange(dayKey)` → `{ from, to }`: lunes a domingo, ≤ 42 días). */
export type AgendaMonthRange = { from: DayKey; to: DayKey };

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
 * WA-S7: ¿el consultorio manda WhatsApp? El modo de la cuenta tiene que ser el vigente: una cuenta `fake` con el env en
 * `live` (o al revés) no manda nada (el outbox re-chequea `mode === whatsappMode()`, C-WA7), así que la agenda no
 * ofrece lo que no va a salir. Solo ACTIVE: una cuenta en SETUP o REAUTH_REQUIRED no manda.
 *
 * WA-U2 (handoff de WA-S7/WA-S1): lee la cuenta cacheada (`getLiveAccountCached`, tag `whatsappAccount(tenantId)`, la
 * misma que usan el hook post-commit y la cola): 0 sentencias en caliente. Por eso va FUERA de la tx del bootstrap (lee
 * por `prismaService` en un miss: no tiene sentido tener la tx abierta esperándola) y en paralelo con el resto. Con el
 * modo `off` corta ANTES de llamar: cero queries extra (C-WA). Si falla, la agenda de hoy no depende de WhatsApp:
 * false y log.
 *
 * ZF2: la regla vive en `lib/whatsapp/active-internal.ts` (variante `channel`). La sección del drawer ofrece el
 * recordatorio A MANO, que no depende de los switches de avisos automáticos: por eso no es la variante `notices`.
 */
export async function agendaWhatsAppFor(tenantId: string, mode?: WhatsappMode): Promise<boolean> {
  return tenantWhatsAppActiveFor(tenantId, "channel", { mode, logEvent: "agenda.bootstrap.whatsappAccount_failed" });
}

/**
 * Carga de `/agenda` para la semana que arranca en `monday` (DayKey AR). La página resuelve el Actor antes y le pasa
 * los mismos argumentos que usa para pintar (`monday` de `weekStartKey`, `?patient=`).
 */
export async function loadAgendaPage(
  actor: Actor,
  args: { monday: DayKey; patientId?: string | null; monthRange?: AgendaMonthRange | null }
): Promise<AgendaPageData> {
  const { monday } = args;
  const sunday = addDays(monday, 6);
  // CF2: en Mes no se leen los turnos ni la disponibilidad de la semana (ver la cabecera).
  const isMonth = args.monthRange != null;

  // Capabilities del Actor: sin query (la membresía viene en la foto del Actor, PL-1e).
  const capsP = capabilitiesForActor(actor).catch((e) => {
    logger.warn("agenda.bootstrap.getCapabilities_failed", { err: errMsg(e) });
    return new Set<string>() as ReadonlySet<string>;
  });
  // tx 1. Proyección liviana (B4.1): todos los profesionales y sedes de la semana; los chips y la sede filtran en el
  // cliente.
  const bookingsP = isMonth
    ? Promise.resolve([] as Awaited<ReturnType<typeof listAgendaBookings>>)
    : listAgendaBookings({ from: dayWindow(monday).start, to: dayWindow(sunday).end });
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
    if (isMonth) return null;
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

  // CF2, tx 2 del Mes (en lugar de la 1 y la 3). Misma sede que la disponibilidad (la guardada, si sigue existiendo;
  // si no, todas). En su PROPIA tx y no al final del bootstrap: una sentencia que falla en sedes/salas deja esa tx
  // abortada y el resumen fallaría con ella. Falla SUELTA, como la disponibilidad: el Mes muestra el estado vacío y el
  // resto de la página (chips, sedes, catálogo) sigue. El rango se valida con el MISMO zod que la action (lunes,
  // ≤ 42 días): la página lo arma con `monthGridRange`, pero sin tope un rango mal armado pediría años de turnos.
  const monthP: Promise<AgendaMonthSummary | null> = !isMonth
    ? Promise.resolve(null)
    : Promise.all([prefsP, bootP, capsP]).then(async ([prefs, boot, caps]) => {
        if (!caps.has("agenda.viewAll")) return null;
        const locationId = boot.locations.some((l) => l.id === prefs.locationId) ? prefs.locationId : null;
        const parsed = AgendaMonthQuery.safeParse({ ...args.monthRange, locationId });
        if (!parsed.success) {
          logger.warn("agenda.bootstrap.monthRange_invalid", { from: args.monthRange?.from, to: args.monthRange?.to });
          return null;
        }
        const q = { from: parsed.data.from, to: parsed.data.to, locationId: parsed.data.locationId ?? null };
        try {
          return await runWithRls(actor.tenantId, (tx) => loadAgendaMonthSummaryInTx(tx, actor, q));
        } catch (e) {
          logger.warn("agenda.bootstrap.getAgendaMonthSummary_failed", { err: errMsg(e) });
          return null;
        }
      });

  // WA-U2: cuenta de WhatsApp cacheada, fuera de toda tx (ver `agendaWhatsAppFor`).
  const whatsappP = agendaWhatsAppFor(actor.tenantId);

  const [rows, boot, agendaView, caps, availability, whatsapp, month] = await Promise.all([
    bookingsP,
    bootP,
    prefsP,
    capsP,
    availabilityP,
    whatsappP,
    monthP,
  ]);
  return {
    ...boot,
    // El catálogo del cable es EXACTAMENTE el que viaja en las props (`services`, `locations` e `insurers`, este
    // último para `oi`, el filtro por obra social de AS-2o): el cliente decodifica con esas mismas listas.
    bookings: encodeAgendaWire(rows.map(agendaRowToDTO), {
      services: boot.services,
      locations: boot.locations,
      insurers: boot.insurers,
    }),
    agendaView,
    capabilities: [...caps],
    availability,
    onlineMoney: agendaOnlineMoneyFor(caps, actor),
    whatsapp,
    month,
  };
}
