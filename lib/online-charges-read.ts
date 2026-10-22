"use server";

/**
 * [TP-2h] Lecturas de cobros online para el staff (T5, contrato C-TP9 del plan §25): drawer del turno
 * (`getBookingOnlineCharges`), `/cobros` (`listOnlineCharges`) y Facturación del paciente (`listPatientOnlineCharges`).
 *
 * Patrón de siempre: `getActor()` → zod → `where: { tenantId }` A MANO en cada query (en prod la conexión tiene
 * BYPASSRLS: es la única barrera; `OnlineCharge` tiene RLS por consultorio en local) → `runWithRls`, una tx por lectura.
 *
 * Quién ve: el mismo criterio que quien COBRA (`canCollectCopago`, C-AS1): Secretaria, Admin, Facturación y Titular con
 * `billing.collect` ven todo; el profesional con `billing.collectOwn` solo los cobros imputados a él. Soporte no tiene
 * `billing.*` (BO2-E/T3): no ve plata de un consultorio ajeno. Un turno o paciente de otro consultorio da «no
 * encontrado», nunca una lista vacía «ok» (no se confirma que el id existe).
 *
 * El DTO lo arma `chargeViewOf` (lib/online-charges-view.ts, puro): sin `rawPayload`, `idempotencyKey`, preferencia ni
 * credencial; la URL del link solo para quien puede anularlo o reenviarlo. Sentencias: 2 en el drawer (turno + cobros),
 * 2 en la ficha, 2 en /cobros (página + resumen en un solo agregado).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getActor, type Actor } from "@/lib/session";
import { runWithRls, type DbClient } from "@/lib/rls";
import { capabilitiesForActor } from "@/lib/authz";
import { canCollectCopago, type Capability } from "@/lib/capabilities";
import { displayMemberName } from "@/lib/display-name";
import { env } from "@/lib/env";
import { CHARGE_STATUSES, type ListOnlineChargesResult, type OnlineChargeView } from "@/lib/online-payments-types";
import {
  chargeFlagsOf,
  chargePeriodRange,
  chargeViewOf,
  decodeChargesCursor,
  duplicatePaidIds,
  encodeChargesCursor,
  isChargePeriod,
  ONLINE_CHARGES_PAGE_SIZE,
  type OnlineChargeRow,
} from "@/lib/online-charges-view";
import type { ActionResult } from "@/lib/validation";

const NO_ACCESS = "No tenés permiso para ver los cobros online.";
const BOOKING_NOT_FOUND = "No encontramos el turno.";
const PATIENT_NOT_FOUND = "No encontramos al paciente.";
const BAD_FILTER = "Filtro inválido.";

const Id = z.string().trim().min(1).max(64);
const BookingInput = z.object({ bookingId: Id });
const PatientInput = z.object({ patientId: Id });
const ListInput = z.object({
  origin: z.enum(["TURNERO", "LINK"]).optional(),
  // «live» = lo que todavía se puede pagar (ACTIVE + AUTHORIZED), el filtro por default de /cobros (TP-3g).
  status: z.enum([...CHARGE_STATUSES, "live"]).optional(),
  period: z.string().trim().refine(isChargePeriod).optional(),
  practitionerId: Id.optional(),
  cursor: z.string().max(200).optional(),
});

/** El `select` exacto: nada de `rawPayload` entero (solo sus banderas), `idempotencyKey`, preferencia ni credencial. */
const CHARGE_SELECT = {
  id: true,
  origin: true,
  kind: true,
  status: true,
  practitionerId: true,
  bookingId: true,
  amountCents: true,
  concept: true,
  publicToken: true,
  createdAt: true,
  expiresAt: true,
  mpPaymentId: true,
  mpStatus: true,
  mpStatusDetail: true,
  paymentMethodId: true,
  paymentTypeId: true,
  installments: true,
  paidAmountCents: true,
  approvedAt: true,
  refundedAt: true,
  cancelledAt: true,
  rawPayload: true,
  mpAccount: { select: { kind: true } },
  practitioner: { select: { user: { select: { fullName: true } } } },
} satisfies Prisma.OnlineChargeSelect;

type ChargeRecord = Prisma.OnlineChargeGetPayload<{ select: typeof CHARGE_SELECT }>;

function rowOf(c: ChargeRecord): OnlineChargeRow {
  return {
    id: c.id,
    origin: c.origin,
    kind: c.kind,
    status: c.status,
    practitionerId: c.practitionerId,
    bookingId: c.bookingId,
    amountCents: c.amountCents,
    concept: c.concept,
    publicToken: c.publicToken,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    mpPaymentId: c.mpPaymentId,
    mpStatus: c.mpStatus,
    mpStatusDetail: c.mpStatusDetail,
    paymentMethodId: c.paymentMethodId,
    paymentTypeId: c.paymentTypeId,
    installments: c.installments,
    paidAmountCents: c.paidAmountCents,
    approvedAt: c.approvedAt,
    refundedAt: c.refundedAt,
    cancelledAt: c.cancelledAt,
    accountKind: c.mpAccount.kind,
    practitionerName: displayMemberName(c.practitioner.user.fullName) || null,
    // `rawPayload` muere acá: solo pasan dos booleanos.
    flags: chargeFlagsOf(c.rawPayload),
  };
}

/** URL de la app leída en cada llamada (los tests la cambian en caliente; `env` se congela al importar). */
function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || env.NEXT_PUBLIC_APP_URL;
}

/**
 * Alcance del viewer: todo el consultorio (`billing.collect`), solo lo suyo (`billing.collectOwn` con profesional
 * propio) o nada. Un actor sin profesional nunca tiene «lo suyo» (mismo cuidado que `canCollectCopago`).
 */
function scopeOf(caps: ReadonlySet<Capability>, actor: Actor): { all: true } | { all: false; practitionerId: string } | null {
  if (caps.has("billing.collect")) return { all: true };
  if (caps.has("billing.collectOwn") && actor.practitionerId) return { all: false, practitionerId: actor.practitionerId };
  return null;
}

function viewsOf(rows: ChargeRecord[], caps: ReadonlySet<Capability>, actor: Actor): OnlineChargeView[] {
  const parsed = rows.map(rowOf);
  const dupes = duplicatePaidIds(parsed);
  const url = appUrl();
  // Soporte nunca gestiona (y además no llega: no tiene billing.*). Anular/reenviar = cobrar ese turno (C-TP9).
  return parsed.map((r) =>
    chargeViewOf(r, {
      appUrl: url,
      canManage: !actor.support && canCollectCopago(caps, actor.practitionerId, r.practitionerId),
      siblingPaid: dupes.has(r.id),
    })
  );
}

export async function getBookingOnlineCharges(raw: { bookingId: string }): Promise<ActionResult<OnlineChargeView[]>> {
  const actor = await getActor();
  const parsed = BookingInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: BOOKING_NOT_FOUND };
  const { bookingId } = parsed.data;
  const tenantId = actor.tenantId;
  const caps = await capabilitiesForActor(actor);
  if (!scopeOf(caps, actor)) return { ok: false, error: NO_ACCESS };

  const res = await runWithRls(tenantId, async (tx: DbClient) => {
    const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { practitionerId: true } });
    if (!booking) return { ok: false as const, error: BOOKING_NOT_FOUND };
    if (!canCollectCopago(caps, actor.practitionerId, booking.practitionerId)) return { ok: false as const, error: NO_ACCESS };
    const rows = await tx.onlineCharge.findMany({
      where: { tenantId, bookingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: CHARGE_SELECT,
      // Un turno junta a lo sumo un cobro del turnero y unos pocos links (uno vivo a la vez): el techo es defensivo.
      take: 50,
    });
    return { ok: true as const, rows };
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: viewsOf(res.rows, caps, actor) };
}

export async function listPatientOnlineCharges(raw: { patientId: string }): Promise<ActionResult<OnlineChargeView[]>> {
  const actor = await getActor();
  const parsed = PatientInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: PATIENT_NOT_FOUND };
  const { patientId } = parsed.data;
  const tenantId = actor.tenantId;
  const caps = await capabilitiesForActor(actor);
  const scope = scopeOf(caps, actor);
  if (!scope) return { ok: false, error: NO_ACCESS };

  const res = await runWithRls(tenantId, async (tx: DbClient) => {
    // Archivado incluido: sus cobros siguen siendo plata del consultorio (Facturación los muestra igual).
    const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true } });
    if (!patient) return { ok: false as const, error: PATIENT_NOT_FOUND };
    const rows = await tx.onlineCharge.findMany({
      where: { tenantId, patientId, ...(scope.all ? {} : { practitionerId: scope.practitionerId }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: CHARGE_SELECT,
      take: 200,
    });
    return { ok: true as const, rows };
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, data: viewsOf(res.rows, caps, actor) };
}

type SummaryRow = { paidCents: number; liveCount: number; liveCents: number };

export async function listOnlineCharges(raw: {
  origin?: "TURNERO" | "LINK";
  status?: string;
  period?: string;
  practitionerId?: string;
  cursor?: string;
}): Promise<ActionResult<ListOnlineChargesResult>> {
  const actor = await getActor();
  const parsed = ListInput.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: BAD_FILTER };
  const f = parsed.data;
  const cursor = f.cursor ? decodeChargesCursor(f.cursor) : null;
  if (f.cursor && !cursor) return { ok: false, error: BAD_FILTER };
  const tenantId = actor.tenantId;
  const caps = await capabilitiesForActor(actor);
  const scope = scopeOf(caps, actor);
  if (!scope) return { ok: false, error: NO_ACCESS };
  // `collectOwn` con el filtro de OTRO profesional: no se le muestra nada ajeno (y no se le dice si existe).
  if (!scope.all && f.practitionerId && f.practitionerId !== scope.practitionerId) {
    return { ok: true, data: { rows: [], nextCursor: null, summary: { paidCents: 0, liveCount: 0, liveCents: 0 } } };
  }
  const practitionerId = scope.all ? (f.practitionerId ?? null) : scope.practitionerId;
  const range = f.period && isChargePeriod(f.period) ? chargePeriodRange(f.period, new Date()) : null;

  // Base del filtro SIN estado: el resumen (cobrado / por cobrar) es del período, profesional y origen elegidos, no
  // del estado (filtrar «Vencidos» no puede dejar el «Cobrado» en $ 0).
  const base: Prisma.OnlineChargeWhereInput = {
    tenantId,
    ...(f.origin ? { origin: f.origin } : {}),
    ...(practitionerId ? { practitionerId } : {}),
    ...(range ? { createdAt: { gte: range.from, ...(range.to ? { lt: range.to } : {}) } } : {}),
  };
  const statusWhere: Prisma.OnlineChargeWhereInput =
    f.status === "live" ? { status: { in: ["ACTIVE", "AUTHORIZED"] } } : f.status ? { status: f.status } : {};
  const cursorWhere: Prisma.OnlineChargeWhereInput = cursor
    ? { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }
    : {};

  const { rows, summary } = await runWithRls(tenantId, async (tx: DbClient) => {
    const rows = await tx.onlineCharge.findMany({
      where: { AND: [base, statusWhere, cursorWhere] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: CHARGE_SELECT,
      take: ONLINE_CHARGES_PAGE_SIZE + 1,
    });
    // Una sola sentencia para los tres números (FILTER), con los mismos filtros que la página salvo estado y cursor.
    // `createdAt` es TIMESTAMP sin zona guardado en UTC: el parámetro va como timestamptz → UTC (molde de
    // lib/dashboard.ts), así el borde del mes AR no depende de la TimeZone de la sesión.
    const from = range?.from ?? null;
    const to = range?.to ?? null;
    const [s] = await tx.$queryRaw<SummaryRow[]>`
      SELECT
        COALESCE(SUM(c."amountCents") FILTER (WHERE c."status" = 'PAID'), 0)::int AS "paidCents",
        COUNT(*) FILTER (WHERE c."status" IN ('ACTIVE', 'AUTHORIZED'))::int AS "liveCount",
        COALESCE(SUM(c."amountCents") FILTER (WHERE c."status" IN ('ACTIVE', 'AUTHORIZED')), 0)::int AS "liveCents"
      FROM "OnlineCharge" c
      WHERE c."tenantId" = ${tenantId}
        AND (${f.origin ?? null}::text IS NULL OR c."origin"::text = ${f.origin ?? null}::text)
        AND (${practitionerId}::text IS NULL OR c."practitionerId" = ${practitionerId}::text)
        AND (${from}::timestamptz IS NULL OR c."createdAt" >= (${from}::timestamptz AT TIME ZONE 'UTC'))
        AND (${to}::timestamptz IS NULL OR c."createdAt" < (${to}::timestamptz AT TIME ZONE 'UTC'))`;
    return { rows, summary: s ?? { paidCents: 0, liveCount: 0, liveCents: 0 } };
  });

  const more = rows.length > ONLINE_CHARGES_PAGE_SIZE;
  const page = more ? rows.slice(0, ONLINE_CHARGES_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return {
    ok: true,
    data: {
      rows: viewsOf(page, caps, actor),
      nextCursor: more && last ? encodeChargesCursor(last) : null,
      summary: { paidCents: summary.paidCents, liveCount: summary.liveCount, liveCents: summary.liveCents },
    },
  };
}
