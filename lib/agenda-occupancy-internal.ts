import "server-only";
/**
 * [AS-3h] Lectura de Agenda → Ocupación (plan §23.9). La lógica (scope, ventanas, promedio, tope, niveles) es pura y
 * vive en `lib/agenda-occupancy.ts`; acá solo la sesión, la transacción y LA sentencia.
 *
 * Una transacción (`runWithRls`) con:
 *   1. el tope y el horario del consultorio (una fila de `Tenant`);
 *   2. los profesionales: todos los reservables si el actor ve al equipo (selector), o solo el suyo;
 *   3. UNA sentencia agregada sobre `Booking` por pestaña (`COUNT(*) GROUP BY` del bucket AR).
 * No se traen turnos para contarlos en JS: con 12 semanas de un consultorio grande serían miles de filas por carga.
 *
 * El bucket AR va con −3 FIJO (`"scheduledFor" - INTERVAL '3 hours'`; la columna es `timestamp` sin zona en UTC):
 * Argentina no tiene horario de verano desde 2009 y `lib/datetime-ar.ts` asume lo mismo (`AR_OFFSET`). Un
 * `AT TIME ZONE 'America/Argentina/Buenos_Aires'` daría lo mismo hoy, pero −3 es lo que usa el resto del motor, y si
 * algún día cambiara tiene que cambiar todo junto.
 *
 * Reservas públicas impagas (AUDIT §5.18): la regla de vencimiento es `isHoldingCapacity` y vive en JS (reconoce la
 * reserva pública por el formato de la `idempotencyKey`, que no se replica en SQL). La sentencia devuelve SUELTAS solo
 * las filas que podrían haber vencido (PENDING, UNPAID/FAILED, con paciente y creadas hace más de 30 min respecto de
 * `now`); todo lo demás retiene cupo seguro y va agregado. Mismo `now` en el filtro y en `isHoldingCapacity`.
 *
 * Seguridad: `"tenantId" = ${tenantId}` a mano (en prod la conexión es BYPASSRLS). El profesional del filtro sale de
 * `resolveOccupancyScope`: el que no ve al equipo mira SIEMPRE el suyo, y el `?pro=` de quien sí lo ve se valida
 * contra los profesionales reservables del consultorio (un id ajeno cae a «Todos»). Las claves de paciente y de turno
 * se usan acá adentro y no salen en el DTO.
 */
import { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { displayMemberName } from "@/lib/display-name";
import { toARDateKey } from "@/lib/datetime-ar";
import { PENDING_PUBLIC_HOLD_MS } from "@/lib/booking-capacity";
import { effectiveIntervalCap } from "@/lib/availability/interval-cap";
import {
  OCCUPANCY_ROW_LIMIT,
  buildPastTable,
  buildUpcomingTables,
  canSeeTeamOccupancy,
  occupancyWindow,
  resolveOccupancyScope,
  type OccupancyParams,
  type OccupancySqlRow,
  type OccupancyView,
} from "@/lib/agenda-occupancy";

type RawRow = {
  day: string | null;
  dow: number;
  hour: number;
  q: number | null;
  n: number;
  status: string | null;
  paymentStatus: string | null;
  createdAt: Date | null;
  patientId: string | null;
  idempotencyKey: string | null;
};

const PRAC_SELECT = {
  id: true,
  bookingCapMode: true,
  bookingCapCount: true,
  bookingCapIntervalMin: true,
  user: { select: { fullName: true } },
} as const;

export async function loadAgendaOccupancy(
  actor: Actor,
  params: OccupancyParams,
  now: Date = new Date()
): Promise<OccupancyView> {
  const caps = await capabilitiesForActor(actor);
  const team = canSeeTeamOccupancy(caps);
  const tenantId = actor.tenantId;
  const win = occupancyWindow(params.tab, params.weeks, toARDateKey(now));
  const past = params.tab === "pasado";

  return runWithRls(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { bookingCapCount: true, bookingCapIntervalMin: true, businessHoursStart: true, businessHoursEnd: true },
    });
    // IAM-4a: el id propio pasa por una variable con nombre (el guard prohíbe `clave: actor.practitionerId` crudo); acá
    // solo se usa en la rama donde existe.
    const ownPractitionerId = actor.practitionerId;
    const pracs = team
      ? await tx.practitioner.findMany({
          where: bookablePractitionerWhere(tenantId, { includeDisabledFilter: true }),
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: PRAC_SELECT,
        })
      : ownPractitionerId
        ? await tx.practitioner.findMany({ where: { tenantId, id: ownPractitionerId }, select: PRAC_SELECT })
        : [];

    const scope = resolveOccupancyScope(
      caps,
      actor.practitionerId,
      params.pro,
      pracs.map((p) => p.id)
    );
    const base = { params, scope, truncated: false };
    if (scope.kind === "none") {
      return { ...base, practitioners: [], practitionerName: null, cap: null, tables: [] };
    }
    const selected = scope.practitionerId ? (pracs.find((p) => p.id === scope.practitionerId) ?? null) : null;
    const cap = selected
      ? effectiveIntervalCap(
          { mode: selected.bookingCapMode, count: selected.bookingCapCount, intervalMin: selected.bookingCapIntervalMin },
          { count: tenant.bookingCapCount, intervalMin: tenant.bookingCapIntervalMin }
        )
      : null;

    const fromIso = win.from.toISOString();
    const toIso = win.to.toISOString();
    const holdCutoffIso = new Date(now.getTime() - PENDING_PUBLIC_HOLD_MS).toISOString();
    const pracId = scope.practitionerId;
    // «Lo que pasó» agrupa por día de la semana × hora; «Lo que viene», por fecha × hora × cuarto de hora (el tope de
    // 15/30 se arma sumando cuartos en `upcomingCell`).
    const dayCol = past ? Prisma.sql`NULL::text` : Prisma.sql`to_char(l, 'YYYY-MM-DD')`;
    const qCol = past ? Prisma.sql`NULL::int` : Prisma.sql`(EXTRACT(MINUTE FROM l)::int / 15)`;
    const groupBy = past ? Prisma.sql`GROUP BY 2, 3` : Prisma.sql`GROUP BY 1, 2, 3, 4`;
    // Una sentencia: CTE + UNION ALL. El `LIMIT` es la red por si las reservas públicas viejas sin pagar fueran miles.
    const raw = await tx.$queryRaw<RawRow[]>`
      WITH b AS (
        SELECT ("scheduledFor" - INTERVAL '3 hours') AS l,
               "status"::text AS status, "paymentStatus"::text AS ps, "createdAt", "patientId", "idempotencyKey",
               ("status" = 'PENDING' AND "paymentStatus"::text IN ('UNPAID', 'FAILED') AND "patientId" IS NOT NULL
                 AND "createdAt" < (${holdCutoffIso}::timestamptz AT TIME ZONE 'UTC')) AS maybe_expired
          FROM "Booking"
         WHERE "tenantId" = ${tenantId}
           AND "status" <> 'CANCELLED'
           AND "scheduledFor" >= (${fromIso}::timestamptz AT TIME ZONE 'UTC')
           AND "scheduledFor" <  (${toIso}::timestamptz AT TIME ZONE 'UTC')
           AND (${pracId}::text IS NULL OR "practitionerId" = ${pracId}::text)
      )
      (SELECT ${dayCol} AS day, EXTRACT(ISODOW FROM l)::int AS dow, EXTRACT(HOUR FROM l)::int AS hour, ${qCol} AS q,
              COUNT(*)::int AS n, NULL::text AS status, NULL::text AS "paymentStatus", NULL::timestamp(3) AS "createdAt",
              NULL::text AS "patientId", NULL::text AS "idempotencyKey"
         FROM b WHERE NOT maybe_expired ${groupBy})
      UNION ALL
      (SELECT ${dayCol}, EXTRACT(ISODOW FROM l)::int, EXTRACT(HOUR FROM l)::int, ${qCol},
              1, status, ps, "createdAt", "patientId", "idempotencyKey"
         FROM b WHERE maybe_expired)
      LIMIT ${OCCUPANCY_ROW_LIMIT + 1}`;

    const truncated = raw.length > OCCUPANCY_ROW_LIMIT;
    const rows: OccupancySqlRow[] = (truncated ? raw.slice(0, OCCUPANCY_ROW_LIMIT) : raw).map((r) => ({
      day: r.day,
      dow: r.dow,
      hour: r.hour,
      q: r.q,
      n: r.n,
      hold:
        r.status != null
          ? {
              status: r.status,
              paymentStatus: r.paymentStatus ?? "",
              createdAt: r.createdAt ?? new Date(0),
              patientId: r.patientId,
              idempotencyKey: r.idempotencyKey ?? "",
            }
          : null,
    }));

    const businessHours = { start: tenant.businessHoursStart, end: tenant.businessHoursEnd };
    const tables = past
      ? [buildPastTable(rows, { weeks: params.weeks, now, fromKey: win.fromKey, toKey: win.toKey, businessHours })]
      : buildUpcomingTables(rows, { weeks: params.weeks, now, fromKey: win.fromKey, cap, businessHours });

    return {
      ...base,
      truncated,
      practitioners: team ? pracs.map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) })) : [],
      practitionerName: selected ? displayMemberName(selected.user.fullName) : null,
      cap,
      tables,
    };
  });
}
