import "server-only";
import { z } from "zod";
import type { DbClient } from "@/lib/rls";
import { addDays, dayKeyToDbDate, dayWindow, dbDateToDayKey, isDayKey } from "@/lib/availability/day";
import {
  BOOKING_LOOKBACK_MIN,
  FALLBACK_TENANT_HOURS,
  FALLBACK_WORKING_DOWS,
  MINUTES_PER_DAY,
  NO_LOCATION_ID,
  type AvailabilityBooking,
  type AvailabilityInput,
  type DayKey,
  type Dow,
  type PractitionerPayerRule,
  type PractitionerServiceRule,
  type PractitionerTemplate,
  type RoomBlock,
  type ScheduleExceptionInput,
  type ScheduleRange,
  type ScheduleTemplateRange,
  type ServiceInfo,
  type TimeBlockInput,
} from "@/lib/availability/types";

/**
 * Loader del motor de disponibilidad (B-pre B2.2). Es el ÚNICO módulo de
 * `lib/availability*` que habla con la base: arma un `AvailabilityInput` del
 * contrato (`lib/availability/types.ts`) y el motor puro no consulta nada más.
 *
 * `db` inyectado, dos canales:
 *   • el `tx` de `runWithRls(tenantId, …)` (agenda, modal, batch, Planes);
 *   • `prismaService` (turnero público: no hay Actor ni GUC de tenant).
 * Por eso CADA query lleva `where: { tenantId }` explícito: en el canal de
 * servicio (y en prod hoy, donde la conexión del app tiene BYPASSRLS) ese
 * `where` es la única barrera entre consultorios. Los ids de entrada
 * (profesionales, servicio, sede, paciente) se filtran contra el tenant: un id
 * ajeno no trae nada (no tira error — el caller ya validó lo que muestra).
 *
 * NO es "use server": lo llaman las actions/route handlers con su `db`.
 */

/** Sin sede principal (tenant creado entre el deploy de M-agenda y B2.3, o
 *  sede principal borrada): las franjas sintetizadas y los turnos con
 *  `locationId` null llevan este id. Fuente única en `types.ts`; se
 *  re-exporta acá para quien ya lo importaba del loader. */
export { NO_LOCATION_ID };

/**
 * Lo que devuelve el loader: el `AvailabilityInput` del contrato (unificado
 * por el integrador de B2: `primaryLocationId: string | null` ya es contrato),
 * con `practitionerPayers` SIEMPRE cargado (en el contrato es opcional para
 * los callers puros).
 */
export type LoadedAvailabilityInput = Omit<AvailabilityInput, "bookings" | "roomBlocks"> & {
  practitionerPayers: ReadonlyArray<PractitionerPayerRule>;
  /** SR: el loader siempre trae la sala del turno (null = sin sala), así el
   *  resultado entra directo en `roomOccupancyAt`. */
  bookings: ReadonlyArray<AvailabilityBooking & { roomId: string | null }>;
  /** SR (§17.5): siempre cargado (`[]` = ninguno). */
  roomBlocks: ReadonlyArray<RoomBlock>;
};

export type LoadAvailabilityParams = {
  tenantId: string;
  /** Sin pasar = todos los profesionales con membresía ACEPTADA. Pasado = esos
   *  ids, filtrados contra el tenant (un id ajeno se descarta). `[]` = ninguno. */
  practitionerIds?: ReadonlyArray<string>;
  /** Acota `services` y `practitionerServices` a ese servicio. NO acota los
   *  turnos: el solape del paciente y la ocupación del profesional cruzan
   *  servicios. */
  serviceId?: string;
  /** Acota franjas (plantilla y CUSTOM_HOURS) y bloqueos a esa sede. NO acota
   *  los turnos: el profesional no puede estar en dos sedes a la vez. */
  locationId?: string;
  /** Suma los turnos de este paciente (cualquier profesional) para que el motor
   *  detecte duplicado / paciente-superpuesto, como el batch de hoy
   *  (`lib/bookings.ts` multi-turno: OR practitioner+service | patient). */
  patientId?: string;
  /** Ventana en días AR, inclusive en ambos extremos. */
  from: DayKey;
  to: DayKey;
};

// Día AR ↔ instante y `@db.Date` ↔ DayKey: SOLO los helpers de
// `lib/availability/day.ts` (integrador B2: el loader tenía copias privadas).
// `@db.Date` llega como medianoche UTC → `dbDateToDayKey` (slice UTC); los
// instantes de la ventana salen de `dayWindow` (medianoche AR).

function assertDayKey(label: string, key: string): void {
  // `isDayKey` rechaza también "2026-02-30" (Date lo corre al 02/03 en silencio).
  if (!isDayKey(key)) {
    throw new Error(`loadAvailabilityInputs: ${label} inválido (${key}); se espera YYYY-MM-DD`);
  }
}

/** Horario del tenant en minutos; si está fuera de rango o invertido, el
 *  default 8-19 (el backfill tampoco le generó franjas a ese tenant). */
function tenantHoursOf(t: { businessHoursStart: number; businessHoursEnd: number }) {
  const startMin = t.businessHoursStart * 60;
  const endMin = t.businessHoursEnd * 60;
  if (
    Number.isInteger(startMin) &&
    Number.isInteger(endMin) &&
    startMin >= 0 &&
    startMin < endMin &&
    endMin <= MINUTES_PER_DAY
  ) {
    return { startMin, endMin };
  }
  return { startMin: FALLBACK_TENANT_HOURS.startMin, endMin: FALLBACK_TENANT_HOURS.endMin };
}

// `ScheduleException.ranges` es JSON: se valida al escribir (B2.4a), pero el
// loader no confía — una excepción CUSTOM_HOURS con JSON roto se trata como
// día SIN franjas (cerrar de más es recuperable; abrir de más da turnos que no
// se pueden atender). `locationId` ausente/null = sede principal.
// SR (M4): `roomId` ausente/null = sin sala. Un `roomId` con forma inválida se
// toma como "sin sala" (`.catch(null)`) en vez de tumbar la excepción entera:
// la sala solo decide la sala por defecto, no si el día abre. Que la sala sea
// del tenant, de esa sede y activa lo valida el write-path del turno
// (`lockActiveRoomInTx`, SR1d → bad-room), no el loader.
const ExceptionRangesJson = z.array(
  z.object({
    startMin: z.number().int().min(0).max(MINUTES_PER_DAY),
    endMin: z.number().int().min(0).max(MINUTES_PER_DAY),
    locationId: z.string().nullish(),
    roomId: z.string().min(1).max(64).nullish().catch(null),
  })
);

function isDow(n: number): n is Dow {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

export async function loadAvailabilityInputs(
  db: DbClient,
  params: LoadAvailabilityParams
): Promise<LoadedAvailabilityInput> {
  const { from, to } = params;
  assertDayKey("from", from);
  assertDayKey("to", to);
  if (from > to) throw new Error(`loadAvailabilityInputs: from (${from}) > to (${to})`);
  return loadForRuns(db, params, [{ from, to }]);
}

/** Tope de días distintos de `loadAvailabilityInputsForDays`. Un plan tiene
 *  ≤ `PLAN_MAX_SESSIONS` (60) filas; aunque cada una sume días de sugerencia,
 *  400 sobra. Es una red contra un caller que pase una lista sin acotar: cada
 *  tramo no contiguo es un término más en los OR de 3 queries. */
export const FOR_DAYS_MAX = 400;

export type LoadAvailabilityForDaysParams = Omit<LoadAvailabilityParams, "from" | "to"> & {
  /** Días AR a cargar (sin orden ni unicidad requeridos; no vacío). */
  days: ReadonlyArray<DayKey>;
};

/**
 * Lo que devuelve `loadAvailabilityInputsForDays`: el mismo input, con
 * `from`/`to` = primer y último día pedido y `days` = los días cargados
 * (ordenados, sin repetir). OJO: excepciones, bloqueos y turnos están SOLO
 * para `days` (+ el lookback de cada tramo). El motor no mira `from`/`to`, así
 * que clasificar o buscar hueco en un día que NO está en `days` daría "libre"
 * de más: el caller tiene que acotarse a `days` (p. ej. `nextFreeSlot` con
 * `until` dentro del tramo cargado).
 */
export type LoadedAvailabilityInputForDays = LoadedAvailabilityInput & {
  days: ReadonlyArray<DayKey>;
};

/**
 * Loader por días sueltos (P0.1 S07L, para el preview y el commit de Planes).
 *
 * Por qué no `loadAvailabilityInputs(min..max)`: un plan mensual ×20 cubre
 * ~20 meses; la ventana contigua traería todos los turnos, bloqueos y
 * excepciones de esos 600 días para mirar 20. Acá los días se agrupan en
 * tramos contiguos y cada query de ventana (excepciones, bloqueos, turnos)
 * lleva un OR de tramos: la cantidad de queries es la MISMA que la ventana
 * contigua (constante, no crece con los días) y las filas, solo las de los
 * días pedidos.
 *
 * Contrato (test `availability-loader-days`): para cualquier lista de días,
 * el resultado es el de `loadAvailabilityInputs(min, max)` con excepciones,
 * bloqueos y turnos filtrados a los que tocan algún día pedido (turnos: con
 * el lookback de `BOOKING_LOOKBACK_MIN` antes del inicio de cada tramo, igual
 * que la ventana). Plantillas, servicios, reglas y coberturas, idénticos.
 */
export async function loadAvailabilityInputsForDays(
  db: DbClient,
  params: LoadAvailabilityForDaysParams
): Promise<LoadedAvailabilityInputForDays> {
  const { days: rawDays, ...rest } = params;
  if (rawDays.length === 0) throw new Error("loadAvailabilityInputsForDays: days vacío");
  for (const d of rawDays) {
    if (!isDayKey(d)) {
      throw new Error(`loadAvailabilityInputsForDays: día inválido (${d}); se espera YYYY-MM-DD`);
    }
  }
  // DayKey "YYYY-MM-DD" ordena lexicográficamente igual que por fecha.
  const days = Array.from(new Set(rawDays)).sort();
  if (days.length > FOR_DAYS_MAX) {
    throw new Error(`loadAvailabilityInputsForDays: ${days.length} días (máx. ${FOR_DAYS_MAX})`);
  }
  const runs: DayRun[] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d;
    else runs.push({ from: d, to: d });
  }
  const input = await loadForRuns(
    db,
    { ...rest, from: days[0], to: days[days.length - 1] },
    runs
  );
  return { ...input, days };
}

/** Tramo de días AR contiguos, inclusive en ambos extremos. */
type DayRun = { from: DayKey; to: DayKey };

/**
 * Cuerpo común. `runs` ordenados, disjuntos y no adyacentes (o uno solo =
 * la ventana contigua de siempre: con un tramo los `where` son EXACTAMENTE los
 * de antes de S07L, así `loadAvailabilityInputs` no cambia ni de plan de query).
 * `params.from`/`to` = primer y último día (poda de vigencias de plantillas).
 */
async function loadForRuns(
  db: DbClient,
  params: LoadAvailabilityParams,
  runs: ReadonlyArray<DayRun>
): Promise<LoadedAvailabilityInput> {
  const { tenantId, serviceId, locationId, patientId, from, to } = params;
  const single = runs.length === 1;

  const windowStart = dayWindow(from).start;
  const windowEnd = dayWindow(to).end; // exclusivo
  const bookingsFrom = new Date(windowStart.getTime() - BOOKING_LOOKBACK_MIN * 60_000);
  const runWindows = runs.map((r) => {
    const start = dayWindow(r.from).start;
    return {
      start,
      end: dayWindow(r.to).end,
      bookingsFrom: new Date(start.getTime() - BOOKING_LOOKBACK_MIN * 60_000),
      fromDb: dayKeyToDbDate(r.from),
      toDb: dayKeyToDbDate(r.to),
    };
  });

  // ── Fase 1: tenant + resolución de ids de entrada contra el tenant ────────
  const requestedIds = params.practitionerIds ? Array.from(new Set(params.practitionerIds)) : null;
  const [tenant, practitioners, primary, serviceOk, locationOk, patientOk] = await Promise.all([
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, businessHoursStart: true, businessHoursEnd: true },
    }),
    requestedIds && requestedIds.length === 0
      ? Promise.resolve([] as { id: string }[])
      : db.practitioner.findMany({
          where: requestedIds
            ? { tenantId, id: { in: requestedIds } }
            : {
                tenantId,
                // Mismo criterio que `listPractitioners`: `removeMember` borra la
                // membresía pero deja la fila Practitioner (historial).
                user: { memberships: { some: { tenantId, acceptedAt: { not: null } } } },
              },
          select: { id: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
    db.location.findFirst({
      where: { tenantId, isPrimary: true },
      select: { id: true },
    }),
    serviceId
      ? db.service.findFirst({ where: { tenantId, id: serviceId }, select: { id: true } })
      : Promise.resolve(null),
    locationId
      ? db.location.findFirst({ where: { tenantId, id: locationId }, select: { id: true } })
      : Promise.resolve(null),
    patientId
      ? db.patient.findFirst({ where: { tenantId, id: patientId }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (!tenant) throw new Error("loadAvailabilityInputs: tenant inexistente");

  const tenantHours = tenantHoursOf(tenant);
  const primaryLocationId = primary?.id ?? null;
  const resolveLocation = (id: string | null | undefined): string =>
    id ?? primaryLocationId ?? NO_LOCATION_ID;
  // Sede pedida pero ajena/inexistente → no matchea nada (sin franjas ni bloqueos).
  const locationFilter: string | null = locationId ? (locationOk ? locationOk.id : "!sede-ajena") : null;
  const inLocation = (loc: string) => locationFilter === null || loc === locationFilter;
  // Servicio pedido pero ajeno → sin servicios ni reglas.
  const serviceFilter = serviceId ? (serviceOk ? serviceOk.id : null) : undefined;
  const serviceUnknown = serviceFilter === null;

  const pracIds = practitioners.map((p) => p.id);
  const hasPracs = pracIds.length > 0;
  const fromDb = dayKeyToDbDate(from);
  const toDb = dayKeyToDbDate(to);

  // ── Fase 2: todo lo demás, en paralelo (con un `tx` Prisma lo encola) ──────
  const bookingScope = [
    ...(hasPracs ? [{ practitionerId: { in: pracIds } }] : []),
    ...(patientOk ? [{ patientId: patientOk.id }] : []),
  ];
  const [schedules, exceptions, blocks, bookings, pracServices, services, pracPayers] = await Promise.all([
    hasPracs
      ? db.practitionerSchedule.findMany({
          where: { tenantId, practitionerId: { in: pracIds } },
          select: {
            practitionerId: true,
            locationId: true,
            dow: true,
            startMin: true,
            endMin: true,
            validFrom: true,
            validUntil: true,
            roomId: true, // SR: columna escalar, misma sentencia
            location: { select: { active: true } },
          },
          orderBy: [{ dow: "asc" }, { startMin: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
    db.scheduleException.findMany({
      where: {
        tenantId,
        ...(single
          ? { date: { gte: fromDb, lte: toDb } }
          : { AND: [{ OR: runWindows.map((w) => ({ date: { gte: w.fromDb, lte: w.toDb } })) }] }),
        OR: [{ practitionerId: null }, ...(hasPracs ? [{ practitionerId: { in: pracIds } }] : [])],
      },
      select: { id: true, practitionerId: true, date: true, kind: true, ranges: true, reason: true },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    }),
    db.timeBlock.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(single ? { startsAt: { lt: windowEnd }, endsAt: { gt: windowStart } } : {}),
        AND: [
          ...(single
            ? []
            : [{ OR: runWindows.map((w) => ({ startsAt: { lt: w.end }, endsAt: { gt: w.start } })) }]),
          { OR: [{ practitionerId: null }, ...(hasPracs ? [{ practitionerId: { in: pracIds } }] : [])] },
          ...(locationFilter !== null
            ? [{ OR: [{ locationId: null }, { locationId: locationFilter }] }]
            : []),
        ],
      },
      select: {
        id: true,
        practitionerId: true,
        locationId: true,
        startsAt: true,
        endsAt: true,
        allDay: true,
        reason: true,
        groupId: true,
        // SR (§17.5): un bloqueo de SALA tiene `practitionerId` null por CHECK
        // y entra por el `practitionerId: null` de arriba; se separa abajo (sin
        // otra sentencia) para que no bloquee a "todos".
        roomId: true,
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    }),
    bookingScope.length
      ? db.booking.findMany({
          where: {
            tenantId,
            status: { not: "CANCELLED" },
            ...(single
              ? { scheduledFor: { gte: bookingsFrom, lt: windowEnd } }
              : {
                  AND: [
                    { OR: runWindows.map((w) => ({ scheduledFor: { gte: w.bookingsFrom, lt: w.end } })) },
                  ],
                }),
            OR: bookingScope,
          },
          select: {
            id: true,
            scheduledFor: true,
            durationMin: true,
            status: true,
            paymentStatus: true,
            createdAt: true,
            patientId: true,
            idempotencyKey: true,
            practitionerId: true,
            serviceId: true,
            locationId: true,
            roomId: true, // SR: ocupación de sala / vista "Por sala"
          },
          orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
        })
      : Promise.resolve([]),
    hasPracs && !serviceUnknown
      ? db.practitionerService.findMany({
          where: {
            tenantId,
            practitionerId: { in: pracIds },
            ...(serviceFilter ? { serviceId: serviceFilter } : {}),
          },
          select: {
            practitionerId: true,
            serviceId: true,
            enabled: true,
            visibility: true,
            durationMin: true,
            minLeadMinutes: true,
            maxLeadDays: true,
            concurrencyOverride: true,
            maxConcurrent: true,
          },
          orderBy: [{ practitionerId: "asc" }, { serviceId: "asc" }],
        })
      : Promise.resolve([]),
    serviceUnknown
      ? Promise.resolve([])
      : db.service.findMany({
          where: { tenantId, ...(serviceFilter ? { id: serviceFilter } : {}) },
          // `practitionerId` (dueño) decide el default sin fila PS (types.ts).
          select: { id: true, durationMin: true, maxConcurrent: true, practitionerId: true },
          orderBy: { id: "asc" },
        }),
    // Coberturas por profesional (handoff de B2.1b). Sin fila = activa: lo
    // resuelve el motor (`acceptsInsurer`), no se sintetizan filas acá.
    hasPracs
      ? db.practitionerPayer.findMany({
          where: { tenantId, practitionerId: { in: pracIds } },
          select: { practitionerId: true, insurerId: true, active: true, insurer: { select: { isParticular: true } } },
          orderBy: [{ practitionerId: "asc" }, { insurerId: "asc" }],
        })
      : Promise.resolve([]),
  ]);

  // ── Plantillas (+ fallback) ───────────────────────────────────────────────
  const byPrac = new Map<string, typeof schedules>();
  for (const s of schedules) {
    const list = byPrac.get(s.practitionerId) ?? [];
    list.push(s);
    byPrac.set(s.practitionerId, list);
  }
  const templates: PractitionerTemplate[] = pracIds.map((practitionerId) => {
    const rows = byPrac.get(practitionerId) ?? [];
    if (rows.length === 0) {
      // Red de seguridad permanente (bpre-design §B): sin franjas → horario del
      // tenant lun-sáb en la sede principal, la regla de suggest y del turnero
      // de hoy. Se decide sobre TODAS sus filas (cualquier vigencia/sede): si
      // configuró algo, se respeta aunque hoy no le abra ningún día.
      const loc = resolveLocation(null);
      return {
        practitionerId,
        isFallback: true,
        ranges: inLocation(loc)
          ? FALLBACK_WORKING_DOWS.map((dow) => ({
              dow,
              startMin: tenantHours.startMin,
              endMin: tenantHours.endMin,
              locationId: loc,
              validFrom: null,
              validUntil: null,
            }))
          : [],
      };
    }
    const ranges: ScheduleTemplateRange[] = [];
    for (const r of rows) {
      // Sede dada de baja: sus franjas no ofrecen turnos.
      if (!r.location.active || !inLocation(r.locationId) || !isDow(r.dow)) continue;
      const validFrom = r.validFrom ? dbDateToDayKey(r.validFrom) : null;
      const validUntil = r.validUntil ? dbDateToDayKey(r.validUntil) : null;
      // Poda de vigencias que no tocan la ventana (el motor igual las filtra por día).
      if (validFrom && validFrom > to) continue;
      if (validUntil && validUntil < from) continue;
      // `roomId` solo si la franja tiene sala: la forma de una franja sin sala
      // no cambia (y `normalize`/`scheduledRanges` la descartan igual, §5.27).
      ranges.push({
        dow: r.dow,
        startMin: r.startMin,
        endMin: r.endMin,
        locationId: r.locationId,
        ...(r.roomId != null ? { roomId: r.roomId } : {}),
        validFrom,
        validUntil,
      });
    }
    return { practitionerId, isFallback: false, ranges };
  });

  // ── Excepciones ───────────────────────────────────────────────────────────
  const exceptionInputs: ScheduleExceptionInput[] = exceptions.map((e) => {
    let ranges: ScheduleRange[] | null = null;
    if (e.kind === "CUSTOM_HOURS") {
      const parsed = ExceptionRangesJson.safeParse(e.ranges);
      ranges = parsed.success
        ? parsed.data
            .filter((r) => r.startMin < r.endMin)
            .map((r) => ({
              startMin: r.startMin,
              endMin: r.endMin,
              locationId: resolveLocation(r.locationId),
              ...(r.roomId != null ? { roomId: r.roomId } : {}),
            }))
            .filter((r) => inLocation(r.locationId))
        : [];
    }
    return {
      id: e.id,
      practitionerId: e.practitionerId,
      date: dbDateToDayKey(e.date),
      kind: e.kind,
      ranges,
      reason: e.reason,
    };
  });

  // SR (§17.5): un TimeBlock con `roomId` NO es un bloqueo de profesional (su
  // `practitionerId` null acá significaría "todos"): sale de `blocks` y va a
  // `roomBlocks`, que solo leen la ocupación de sala y la vista "Por sala".
  // Se pasan `startsAt`/`endsAt` tal cual (sin la expansión de `allDay` de
  // `ranges.ts`): es lo que compara `countRoomOverlapsInTx` (SR1d) en SQL, y la
  // agenda y el write-path tienen que decir lo mismo.
  const blockInputs: TimeBlockInput[] = [];
  const roomBlocks: RoomBlock[] = [];
  for (const { roomId, ...b } of blocks) {
    if (roomId != null) {
      roomBlocks.push({ id: b.id, roomId, startsAt: b.startsAt, endsAt: b.endsAt, reason: b.reason });
    } else {
      blockInputs.push(b);
    }
  }

  const bookingInputs: Array<AvailabilityBooking & { roomId: string | null }> = bookings.map((b) => ({
    id: b.id,
    scheduledFor: b.scheduledFor,
    durationMin: b.durationMin,
    status: b.status,
    paymentStatus: b.paymentStatus,
    createdAt: b.createdAt,
    patientId: b.patientId,
    idempotencyKey: b.idempotencyKey,
    practitionerId: b.practitionerId,
    serviceId: b.serviceId,
    locationId: resolveLocation(b.locationId),
    roomId: b.roomId,
  }));

  const practitionerServices: PractitionerServiceRule[] = pracServices.map((ps) => ({ ...ps }));
  const serviceInfos: ServiceInfo[] = services.map((s) => ({ ...s }));
  // Particular no se puede destildar (B2.4b `setPractitionerPayers`): aunque una
  // fila vieja diga inactiva, el motor la ve activa.
  const practitionerPayers: PractitionerPayerRule[] = pracPayers.map((p) => ({
    practitionerId: p.practitionerId,
    insurerId: p.insurerId,
    active: p.insurer.isParticular ? true : p.active,
  }));

  return {
    tenantId,
    from,
    to,
    primaryLocationId,
    tenantHours,
    templates,
    exceptions: exceptionInputs,
    blocks: blockInputs,
    roomBlocks,
    bookings: bookingInputs,
    practitionerServices,
    services: serviceInfos,
    practitionerPayers,
  };
}
