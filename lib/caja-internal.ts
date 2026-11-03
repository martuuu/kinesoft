import "server-only";
/**
 * Caja por profesional (CF2 · P.2, plan §29: D-CF2-16..19) · la SQL y el loader de `/caja`. Server-only.
 *
 * La lógica (scope, período, liquidación con reparto, medios, proyección) es pura y vive en `lib/caja-logic.ts`; acá
 * solo la transacción y LAS DOS sentencias:
 *   1. `collectedGroupsInTx`: lo cobrado en `[start, end)` agrupado por (profesional, fuente, medio, día AR, regla de
 *      reparto vigente AL COBRAR). La reusa la tarjeta «Cobrado hoy» del Inicio (`lib/dashboard.ts`, scope `desk`).
 *   2. `revenueSharesForPeriodInTx`: las reglas que tocan el período («Reparto vigente»).
 *
 * PARIDAD con Ingresos: los predicados de cada fuente son LITERALMENTE los de `revenueAmountsInTx` (`lib/dashboard.ts`,
 * que no se toca): MP legado por `Payment.createdAt`; `OnlineCharge` PAID por `approvedAt` al profesional de la CARGA
 * (inmutable); copago manual PAID por `copagoPaidAt` NETO de las señas vistas al cobrar (el LATERAL `d`, C-TP10 +
 * enmienda TP-ZF1 M1), sin el turno con `Payment` legado ni el pagado total online por el webhook; OS por
 * `insurerPaidAt` × el arancel de la cobertura vigente del paciente (la de id mayor) resuelto AL LEER (D-CF2-19).
 * Σ grupos = lo que muestra el widget de Ingresos, tenant y por profesional (`tests/integration/cf2-caja.test.ts`
 * `[CF2-PS2-2]`). Si se cambia un predicado acá, se cambia allá (y al revés).
 *
 * Fechas: las columnas son `timestamp(3)` sin zona en UTC. Los bordes viajan como ISO y se pasan a la hora de pared
 * UTC (`::timestamptz AT TIME ZONE 'UTC'`, molde de `revenueAmountsInTx`): un `Date` crudo dependería del TimeZone de
 * la sesión. El día AR del cobro es `("at" - INTERVAL '3 hours')::date` (−3 fijo, convención de
 * `lib/agenda-occupancy-internal.ts`): un cobro de las 23:30 AR es de ESE día aunque en UTC ya sea el siguiente.
 *
 * Reparto: `LEFT JOIN LATERAL` a la regla del profesional al que se atribuye el cobro con `effectiveFrom ≤ at <
 * COALESCE(effectiveTo, ∞)` (D-CF2-18: vigencia por INSTANTE). Un cambio de regla a las 13:00 deja lo de antes con la
 * vieja y lo de 13:00:00.000 en adelante con la nueva; nunca reescribe lo ya cobrado.
 *
 * Seguridad: `"tenantId" = $t` a mano en CADA rama y en la regla (en prod la conexión es BYPASSRLS: es la única
 * barrera). Scope `own`: la SQL trae lo del actor y, de quien le destina, SOLO los grupos cuya regla lo tiene como
 * receptor sobre esa fuente (lo necesario para calcular lo que recibe); `buildCajaPageData` → `projectCajaForScope`
 * deja únicamente la fila del actor, así que el bruto ajeno nunca sale del server.
 */
import { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Capability } from "@/lib/capabilities";
import { listPractitioners } from "@/lib/bookings";
import { displayMemberName, displayUserName } from "@/lib/display-name";
import { toARDateKey } from "@/lib/datetime-ar";
import { buildCajaPageData, cajaPeriodFor, cajaScopeFor, cajaSourcesFor, parseCajaSearchParams } from "@/lib/caja-logic";
import type { CajaPageData, CajaRosterEntry, CollectedGroup, CollectedMethod } from "@/lib/caja-types";
import type { RevenueShareRuleView, RevenueSource } from "@/lib/revenue-share-types";

/** `[start, end)` en instantes reales (de `cajaPeriodFor` o `dayWindow`). */
export type CajaRange = { start: Date; end: Date };
/** Los `searchParams` de la página (o un `URLSearchParams`): lo que acepta `parseCajaSearchParams`. */
export type CajaSearchParamsInput = Parameters<typeof parseCajaSearchParams>[0];

type GroupRow = {
  practitionerId: string;
  practitionerFullName: string | null;
  source: RevenueSource;
  method: string | null;
  dayKey: string;
  amountCents: bigint | number;
  count: number;
  ruleId: string | null;
  receiverPractitionerId: string | null;
  receiverFullName: string | null;
  shareBps: number | null;
  appliesManual: boolean | null;
  appliesOnline: boolean | null;
  appliesInsurer: boolean | null;
};

/**
 * Lo cobrado en `range`, agrupado (ver cabecera). UNA sentencia: CTE `UNION ALL` de las 4 fuentes → regla vigente por
 * LATERAL → nombres → `GROUP BY`.
 *
 *   - `includeInsurer: false` (Secretaria, D-CF2-16): la rama de OS ni se evalúa (`false AND …`): el arancel no se lee.
 *   - `practitionerId` (scope `own`): lo cobrado por él + lo que otro le destina (regla con él de receptor que APLICA
 *     a esa fuente). `null`/ausente = todo el consultorio.
 *   - Montos en 0 no forman grupo (un copago de $0 marcado cobrado o una OS «Particular»: no hay plata que contar y
 *     inflaban la cantidad de cobros); no cambian ninguna suma, así que la paridad sigue.
 *   - `sum(...)::bigint`: un grupo es de UN día, pero un `int` se desborda en $21,4 M; se convierte a `number` acá.
 */
export async function collectedGroupsInTx(
  tx: DbClient,
  tenantId: string,
  range: CajaRange,
  opts: { includeInsurer: boolean; practitionerId?: string | null },
): Promise<CollectedGroup[]> {
  const $t = tenantId;
  const $me = opts.practitionerId ?? null;
  const $ins = opts.includeInsurer;
  const S = Prisma.sql`(${range.start.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const E = Prisma.sql`(${range.end.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  const rows = await tx.$queryRaw<GroupRow[]>`
    WITH items AS (
      SELECT b."practitionerId" AS "pid", 'online'::text AS "source", 'MERCADO_PAGO'::text AS "method",
             p."createdAt" AS "at", p."amountCents"::bigint AS "cents"
        FROM "Payment" p JOIN "Booking" b ON b."id" = p."bookingId"
       WHERE b."tenantId" = ${$t} AND p."status" = 'PAID' AND p."createdAt" >= ${S} AND p."createdAt" < ${E}
      UNION ALL
      SELECT c."practitionerId", 'online', 'MERCADO_PAGO', c."approvedAt", c."amountCents"::bigint
        FROM "OnlineCharge" c
       WHERE c."tenantId" = ${$t} AND c."status" = 'PAID' AND c."approvedAt" >= ${S} AND c."approvedAt" < ${E}
      UNION ALL
      SELECT b."practitionerId", 'manual', COALESCE(b."copagoPaymentMethod"::text, 'UNKNOWN'), b."copagoPaidAt",
             GREATEST(0, COALESCE(b."copagoCents", 0) - COALESCE(d."cents", 0))::bigint
        FROM "Booking" b
        LEFT JOIN LATERAL (SELECT sum(c."amountCents") AS "cents" FROM "OnlineCharge" c
           WHERE c."tenantId" = b."tenantId" AND c."bookingId" = b."id" AND c."kind" = 'DEPOSIT'
             AND (c."status" = 'PAID' OR (c."status" = 'REFUNDED' AND c."refundedAt" > b."copagoPaidAt"))
             AND c."settledAt" <= b."copagoPaidAt") d ON true
       WHERE b."tenantId" = ${$t} AND b."paymentStatus" = 'PAID'
         AND b."copagoPaidAt" >= ${S} AND b."copagoPaidAt" < ${E}
         AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."bookingId" = b."id" AND p."status" = 'PAID')
         AND NOT COALESCE(b."copagoPaymentMethod" = 'MERCADO_PAGO' AND b."copagoCollectedById" IS NULL, false)
      UNION ALL
      SELECT b."practitionerId", 'insurer', NULL::text, b."insurerPaidAt", COALESCE(f."cents", 0)::bigint
        FROM "Booking" b
        LEFT JOIN LATERAL (
          SELECT CASE WHEN i."id" IS NOT NULL AND NOT i."isParticular" THEN i."fixedFeeCents" ELSE 0 END AS "cents"
            FROM "Coverage" cv
            JOIN "Patient" pt ON pt."id" = cv."patientId" AND pt."tenantId" = ${$t}
            LEFT JOIN "Insurer" i ON i."id" = cv."insurerId" AND i."tenantId" = ${$t}
           WHERE cv."patientId" = b."patientId"
           ORDER BY cv."id" DESC LIMIT 1) f ON true
       WHERE ${$ins}::boolean AND b."tenantId" = ${$t} AND b."patientId" IS NOT NULL
         AND b."insurerPaidAt" >= ${S} AND b."insurerPaidAt" < ${E}
    )
    SELECT x."pid" AS "practitionerId", u."fullName" AS "practitionerFullName", x."source", x."method",
           to_char((x."at" - INTERVAL '3 hours')::date, 'YYYY-MM-DD') AS "dayKey",
           sum(x."cents")::bigint AS "amountCents", count(*)::int AS "count",
           r."id" AS "ruleId", r."receiverPractitionerId", ru."fullName" AS "receiverFullName",
           r."shareBps", r."appliesManual", r."appliesOnline", r."appliesInsurer"
      FROM items x
      LEFT JOIN LATERAL (
        SELECT s."id", s."receiverPractitionerId", s."shareBps", s."appliesManual", s."appliesOnline", s."appliesInsurer"
          FROM "PractitionerRevenueShare" s
         WHERE s."tenantId" = ${$t} AND s."giverPractitionerId" = x."pid"
           AND s."effectiveFrom" <= x."at" AND (s."effectiveTo" IS NULL OR x."at" < s."effectiveTo")
         ORDER BY s."effectiveFrom" DESC LIMIT 1) r ON true
      LEFT JOIN "Practitioner" pr ON pr."id" = x."pid"
      LEFT JOIN "UserProfile" u ON u."id" = pr."userId"
      LEFT JOIN "Practitioner" rp ON rp."id" = r."receiverPractitionerId"
      LEFT JOIN "UserProfile" ru ON ru."id" = rp."userId"
     WHERE x."cents" > 0
       AND (${$me}::text IS NULL OR x."pid" = ${$me}
            OR (r."receiverPractitionerId" = ${$me}
                AND CASE x."source" WHEN 'manual' THEN r."appliesManual" WHEN 'online' THEN r."appliesOnline" ELSE r."appliesInsurer" END))
     GROUP BY x."pid", u."fullName", x."source", x."method", (x."at" - INTERVAL '3 hours')::date,
              r."id", r."receiverPractitionerId", ru."fullName", r."shareBps", r."appliesManual", r."appliesOnline", r."appliesInsurer"
     ORDER BY 5, 1, 3, 4, 8`;
  return rows.map((r) => ({
    practitionerId: r.practitionerId,
    practitionerName: displayMemberName(r.practitionerFullName),
    source: r.source,
    method: r.method as CollectedMethod | null,
    dayKey: r.dayKey,
    amountCents: Number(r.amountCents),
    count: r.count,
    ruleId: r.ruleId,
    receiverPractitionerId: r.receiverPractitionerId,
    receiverName: r.receiverPractitionerId ? displayMemberName(r.receiverFullName) : null,
    shareBps: r.shareBps,
    appliesManual: r.appliesManual,
    appliesOnline: r.appliesOnline,
    appliesInsurer: r.appliesInsurer,
  }));
}

type RuleRow = {
  id: string;
  giverPractitionerId: string;
  giverFullName: string | null;
  receiverPractitionerId: string;
  receiverFullName: string | null;
  shareBps: number;
  appliesManual: boolean;
  appliesOnline: boolean;
  appliesInsurer: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdById: string | null;
  createdByFullName: string | null;
  createdByExists: boolean;
  closedById: string | null;
  closedByFullName: string | null;
  closedByExists: boolean;
};

/**
 * «Reparto vigente»: las reglas que rigieron en algún instante de `range` (`effectiveFrom < end` y `effectiveTo`
 * nulo o `> start`), de la más nueva a la más vieja. UNA sentencia con los nombres resueltos. «Creada/cerrada por»
 * se resuelve por la membresía DEL consultorio (CF2-ZF3, ZA-5; mismo criterio que `listRevenueSharesInTx`): quien ya
 * no es miembro (se fue, o el superadmin que cerró una al deshabilitar a alguien) queda `null`; antes el JOIN directo
 * a `UserProfile` mostraba su nombre aunque fuera de otro consultorio. `(userId, tenantId)` es único: no duplica filas.
 * Con `practitionerId`
 * (scope `own`), solo las que lo tienen de un lado o del otro (`projectRulesForScope` lo vuelve a filtrar).
 */
export async function revenueSharesForPeriodInTx(
  tx: DbClient,
  tenantId: string,
  range: CajaRange,
  opts: { practitionerId?: string | null } = {},
): Promise<RevenueShareRuleView[]> {
  const $t = tenantId;
  const $me = opts.practitionerId ?? null;
  const rows = await tx.$queryRaw<RuleRow[]>`
    SELECT s."id", s."giverPractitionerId", gu."fullName" AS "giverFullName",
           s."receiverPractitionerId", ru."fullName" AS "receiverFullName",
           s."shareBps", s."appliesManual", s."appliesOnline", s."appliesInsurer", s."effectiveFrom", s."effectiveTo",
           s."createdById", cu."fullName" AS "createdByFullName", (cu."id" IS NOT NULL) AS "createdByExists",
           s."closedById", ku."fullName" AS "closedByFullName", (ku."id" IS NOT NULL) AS "closedByExists"
      FROM "PractitionerRevenueShare" s
      LEFT JOIN "Practitioner" gp ON gp."id" = s."giverPractitionerId"
      LEFT JOIN "UserProfile" gu ON gu."id" = gp."userId"
      LEFT JOIN "Practitioner" rp ON rp."id" = s."receiverPractitionerId"
      LEFT JOIN "UserProfile" ru ON ru."id" = rp."userId"
      LEFT JOIN "Membership" cm ON cm."tenantId" = s."tenantId" AND cm."userId" = s."createdById"
      LEFT JOIN "UserProfile" cu ON cu."id" = cm."userId"
      LEFT JOIN "Membership" km ON km."tenantId" = s."tenantId" AND km."userId" = s."closedById"
      LEFT JOIN "UserProfile" ku ON ku."id" = km."userId"
     WHERE s."tenantId" = ${$t}
       AND s."effectiveFrom" < (${range.end.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       AND (s."effectiveTo" IS NULL OR s."effectiveTo" > (${range.start.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
       AND (${$me}::text IS NULL OR s."giverPractitionerId" = ${$me} OR s."receiverPractitionerId" = ${$me})
     ORDER BY s."effectiveFrom" DESC, s."id"`;
  return rows.map((r) => ({
    id: r.id,
    giverPractitionerId: r.giverPractitionerId,
    giverName: displayMemberName(r.giverFullName),
    receiverPractitionerId: r.receiverPractitionerId,
    receiverName: displayMemberName(r.receiverFullName),
    shareBps: r.shareBps,
    sources: { manual: r.appliesManual, online: r.appliesOnline, insurer: r.appliesInsurer },
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo ? r.effectiveTo.toISOString() : null,
    createdByName: r.createdByExists ? displayUserName(r.createdByFullName) : null,
    closedByName: r.closedByExists ? displayUserName(r.closedByFullName) : null,
  }));
}

/**
 * Profesionales para las filas en $0: `listPractitioners()` (cacheado por tenant, tag `practitioners`; en la carga
 * caliente no cuesta sentencias). Se filtra por el tenant del actor por las dudas: la lista sale del actor de la
 * SESIÓN y este loader recibe el actor por parámetro.
 */
async function cajaRoster(actor: Actor): Promise<CajaRosterEntry[]> {
  const list = await listPractitioners();
  return list
    .filter((p) => p.tenantId === actor.tenantId)
    .map((p) => ({ practitionerId: p.id, practitionerName: displayMemberName(p.user?.fullName) }));
}

/**
 * Datos de `/caja` para el actor (D-CF2-16/17). `null` = scope `none` (la página redirige a `/dashboard`); el soporte
 * es SIEMPRE `none` aunque el caller le pase otras caps (BO2-E: no ve la plata de un consultorio ajeno).
 *
 * `caps` = las del miembro (`memberCapabilitiesForActor(actor)`, que al soporte ya le saca `billing.*`). `sp` = los
 * `searchParams` de la página (`?vista=dia|mes&fecha=…&mes=…`; lo inválido abre hoy). La Secretaria siempre ve hoy.
 *
 * Costo: UNA `runWithRls` con 2 sentencias (grupos + reglas), en paralelo con el roster cacheado. Sin `none` no se
 * consulta nada. Reloj: `now` del server; el día AR sale de `toARDateKey` (nunca del host).
 */
export async function loadCajaPage(
  actor: Actor,
  caps: ReadonlySet<Capability>,
  sp: CajaSearchParamsInput,
): Promise<CajaPageData | null> {
  const scope = actor.support ? ({ kind: "none" } as const) : cajaScopeFor(caps, actor.practitionerId);
  if (scope.kind === "none") return null;
  const now = new Date();
  const period = cajaPeriodFor(parseCajaSearchParams(sp), toARDateKey(now), scope);
  if (!period) return null;
  const range = { start: period.start, end: period.end };
  const includeInsurer = cajaSourcesFor(scope).includes("insurer");
  const practitionerId = scope.kind === "own" ? scope.practitionerId : null;
  const tenantId = actor.tenantId;
  const [roster, { groups, rules }] = await Promise.all([
    cajaRoster(actor),
    runWithRls(tenantId, async (tx) => {
      const groups = await collectedGroupsInTx(tx, tenantId, range, { includeInsurer, practitionerId });
      const rules = await revenueSharesForPeriodInTx(tx, tenantId, range, { practitionerId });
      return { groups, rules };
    }),
  ]);
  // `own`: si el actor no está en el roster (suspendido: no es reservable), su fila igual aparece en $0.
  const fullRoster =
    practitionerId && !roster.some((e) => e.practitionerId === practitionerId)
      ? [...roster, { practitionerId, practitionerName: actor.practitionerName }]
      : roster;
  return buildCajaPageData({ scope, period, groups, roster: fullRoster, rules, now });
}
