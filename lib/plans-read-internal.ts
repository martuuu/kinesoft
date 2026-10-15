import { displayMemberName } from "@/lib/display-name";
import "server-only";
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";
import { canSeePlanAuthorization, planTitleFor } from "@/lib/plan-authz-internal";
import { planBalance, type PlanPricing } from "@/lib/plan-pricing";
import { isLinkedProgram, planSessionOrdinals } from "@/lib/plan-display";
import { dbDateToDayKey } from "@/lib/availability/day";
import { toARDateKey } from "@/lib/datetime-ar";
import type { PlanScheduleV1 } from "@/lib/plans-types";
import type {
  PlanAuthorizationDTO,
  PlanBalanceDTO,
  PlanDetailDTO,
  PlanDTO,
  PlanHeaderDTO,
  PlanReadLevel,
  PlanSessionDTO,
  PlanSessionState,
  SchedulablePlanSession,
} from "@/lib/plans-read-types";

/**
 * Proyección de lecturas de Planes (S14, ES2b P2.0), server-only.
 *
 * Una sola query por lista de planes (`PLAN_READ_SELECT`) y la proyección en
 * memoria, en vez de una query por "sin turno", otra por ordinal y otra por
 * saldo: así la PlanCard, `/planes`, el saldo y el modal de agenda derivan
 * todo de las MISMAS filas y no pueden contradecirse (el "sin turno" de la
 * card y el del filtro de `/planes` son la misma función).
 *
 * Los gates de escritura viven en `lib/plan-authz-internal.ts` (P2-C1) y acá
 * solo se consumen (`planTitleFor`, `canSeePlanAuthorization`). El nivel de
 * LECTURA (`planReadLevel`) es la regla de §5 "Lecturas" y vive acá porque
 * P2-C1 no la publicó como función; está escrita con los mismos predicados
 * positivos (`=== 'full'`) para no abrirle nada al nivel `admin` de PD-13.
 */

// ─── Nivel de lectura (§5 "Lecturas") ────────────────────────────────────────

/**
 * - `full`: acceso full **y** `clinical.read` (= `planTitleFor` devuelve el
 *   título): DTO completo.
 * - `admin`: proyección administrativa (título null; sin notas, ejercicios,
 *   EVA ni cuotas por sesión) para
 *     · `plans.schedule` + (full o `agenda.operateAll`): la Secretaria agenda
 *       sesiones (misma regla que `assertPlanScheduleInTx`);
 *     · `billing.manage`: Facturación ve el saldo y la autorización (E2).
 * - `null`: nada. Un PRACTITIONER en acceso básico tiene `plans.schedule` pero
 *   ni full ni `operateAll`: no ve planes de pacientes ajenos (su acceso básico
 *   es solo el directorio). `none` = paciente de otro tenant o inexistente.
 */
export function planReadLevel(caps: ReadonlySet<Capability>, access: PatientAccessLevel): PlanReadLevel | null {
  if (access === "none") return null;
  if (access === "full" && caps.has("clinical.read")) return "full";
  if (caps.has("plans.schedule") && (access === "full" || caps.has("agenda.operateAll"))) return "admin";
  if (caps.has("billing.manage")) return "admin";
  return null;
}

/** ¿El rol puede leer planes de ALGÚN paciente? Corta antes de tocar la base. */
export function canReadAnyPlan(caps: ReadonlySet<Capability>): boolean {
  return caps.has("clinical.read") || caps.has("plans.schedule") || caps.has("billing.manage");
}

// ─── Query ───────────────────────────────────────────────────────────────────

/** Estados que liberan la sesión (I2, C4): todo lo demás la ocupa. */
const INACTIVE_FOR_SESSION = ["CANCELLED", "NO_SHOW"] as const;

/**
 * Lo que se lee de cada plan. Trae columnas clínicas (título, notas) porque
 * el nivel se decide por fila después; la proyección (abajo) es la que decide
 * qué sale. Nada de esto viaja al cliente sin pasar por `project*`.
 */
export const PLAN_READ_SELECT = {
  id: true,
  patientId: true,
  title: true,
  notes: true,
  status: true,
  discipline: true,
  practitionerId: true,
  serviceId: true,
  locationId: true,
  templateId: true,
  durationMin: true,
  schedule: true,
  pricingMode: true,
  pricePerSessionCents: true,
  totalPriceCents: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  patient: { select: { firstName: true, lastName: true } },
  practitioner: { select: { user: { select: { fullName: true, email: true } } } },
  service: { select: { name: true } },
  // Todos los turnos del plan, en cualquier estado: el saldo (P7) cuenta los
  // cancelados y ausentes cobrados, y R-LEGACY mira si hay alguno.
  bookings: { select: { status: true, paymentStatus: true, copagoCents: true, insurerPaidAt: true } },
  sessions: {
    orderBy: { index: "asc" },
    select: {
      id: true,
      index: true,
      practitionerId: true,
      scheduledFor: true,
      completedAt: true,
      archivedAt: true,
      title: true,
      notes: true,
      priceCents: true,
      _count: { select: { exercises: true } },
      // Solo el turno ACTIVO (I2: a lo sumo uno). Es el criterio de
      // `sessionWithoutActiveBookingWhere`; el test lo compara con el predicado.
      bookings: {
        where: { status: { notIn: [...INACTIVE_FOR_SESSION] } },
        select: { id: true, scheduledFor: true, status: true, updatedAt: true },
        orderBy: { scheduledFor: "asc" },
      },
    },
  },
  // La vigente (único parcial: a lo sumo una sin `supersededAt`).
  authorizations: {
    where: { supersededAt: null },
    select: { id: true, code: true, authorizedSessions: true, startsOn: true, expiresOn: true },
    take: 1,
  },
} satisfies Prisma.TreatmentProgramSelect;

export type RawPlan = Prisma.TreatmentProgramGetPayload<{ select: typeof PLAN_READ_SELECT }>;

/**
 * Lee planes del tenant. `where` es un fragmento SIN tenantId: el `tenantId`
 * va acá a mano, dentro de un `AND`, porque en prod la conexión tiene
 * BYPASSRLS y es la única barrera (y un spread del caller podría pisarlo).
 */
export function loadPlansInTx(
  tx: DbClient,
  tenantId: string,
  where: Prisma.TreatmentProgramWhereInput,
  opts: { take?: number } = {}
): Promise<RawPlan[]> {
  return tx.treatmentProgram.findMany({
    where: { AND: [{ tenantId }, where] },
    select: PLAN_READ_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    ...(opts.take ? { take: opts.take } : {}),
  });
}

// ─── Proyección ──────────────────────────────────────────────────────────────

export type ProjectCtx = {
  caps: ReadonlySet<Capability>;
  access: PatientAccessLevel;
  level: PlanReadLevel;
  now: Date;
};

type RawSession = RawPlan["sessions"][number];

/** R-LEGACY (§2.3): `schedule` no nulo o algún turno con `programId`. */
export function isRawPlanLinked(p: Pick<RawPlan, "schedule" | "bookings">): boolean {
  return isLinkedProgram({ hasSchedule: p.schedule != null, hasLinkedBooking: p.bookings.length > 0 });
}

function sessionState(s: RawSession, now: Date): PlanSessionState {
  if (s.archivedAt) return "archived";
  if (s.completedAt) return "done";
  const active = s.bookings[0];
  if (!active) return "unbooked";
  return active.scheduledFor.getTime() <= now.getTime() ? "overdue" : "booked";
}

/**
 * Día de una sesión para comparar con la autorización (dayKeys AR, §2.6).
 * Excepción legacy (§2.5): las sesiones del alta vieja quedaron a 00:00Z y
 * cuentan por su fecha UTC; con `toARDateKey` caerían el día anterior. Solo
 * en planes NO vinculados y solo a medianoche UTC exacta: un plan vinculado
 * nunca escribe a 00:00Z (sus sesiones son instantes reales del motor).
 */
export function sessionDayKey(scheduledFor: Date, linked: boolean): string {
  if (!linked && scheduledFor.getUTCHours() === 0 && scheduledFor.getUTCMinutes() === 0 && scheduledFor.getUTCSeconds() === 0) {
    return scheduledFor.toISOString().slice(0, 10);
  }
  return toARDateKey(scheduledFor);
}

function pricingOf(p: Pick<RawPlan, "pricingMode" | "pricePerSessionCents" | "totalPriceCents">): PlanPricing {
  if (p.pricingMode === "PER_SESSION" && p.pricePerSessionCents != null) {
    return { mode: "PER_SESSION", pricePerSessionCents: p.pricePerSessionCents };
  }
  if (p.pricingMode === "PACKAGE" && p.totalPriceCents != null) {
    return { mode: "PACKAGE", totalPriceCents: p.totalPriceCents };
  }
  return null;
}

/**
 * Saldo P7 con el `planBalance` puro (S16p, sin editarlo). `insurerPaidAt` NO
 * entra en "cobrado" (copago del paciente ≠ arancel de la OS: ver la decisión
 * en `PlanBalanceDTO`); se cuenta aparte.
 */
export function balanceOf(p: RawPlan): PlanBalanceDTO {
  const live = p.sessions.filter((s) => s.archivedAt == null);
  const b = planBalance({
    pricing: pricingOf(p),
    sessions: live.map((s) => ({ priceCents: s.priceCents, completed: s.completedAt != null })),
    bookings: p.bookings,
    // S14r (08-oct): en un plan CANCELLED el pactado = devengado (no cuenta las
    // sesiones canceladas que el paciente ya no va a hacer).
    programStatus: p.status,
  });
  return { ...b, insurerPaidBookings: p.bookings.filter((x) => x.insurerPaidAt != null).length };
}

/**
 * La vigente con usadas/agendadas (E2). Usadas = realizadas con fecha AR ≥
 * `startsOn`; agendadas = vivas sin cerrar con turno activo ≥ `startsOn`.
 * Fechas de la orden con `dbDateToDayKey` (slice UTC de un `@db.Date`).
 */
export function authorizationOf(p: RawPlan, linked: boolean): PlanAuthorizationDTO | null {
  const a = p.authorizations[0];
  if (!a) return null;
  const startsOn = dbDateToDayKey(a.startsOn);
  let used = 0;
  let scheduled = 0;
  for (const s of p.sessions) {
    if (s.archivedAt) continue;
    if (s.completedAt) {
      if (sessionDayKey(s.scheduledFor, linked) >= startsOn) used += 1;
    } else if (s.bookings[0] && toARDateKey(s.bookings[0].scheduledFor) >= startsOn) {
      scheduled += 1;
    }
  }
  return {
    id: a.id,
    code: a.code,
    authorizedSessions: a.authorizedSessions,
    startsOn,
    expiresOn: dbDateToDayKey(a.expiresOn),
    used,
    scheduled,
  };
}

function practitionerName(p: RawPlan): string | null {
  const u = p.practitioner?.user;
  return u ? displayMemberName(u.fullName) : null; // DIR-0: nunca el email
}

/**
 * Sesiones proyectadas + agregados. Ordinal M13 (`planSessionOrdinals`: por
 * fecha entre las vivas, empate por `index`); "sin turno" = `unbooked` en un
 * plan vinculado (R-LEGACY).
 */
function sessionsOf(p: RawPlan, ctx: ProjectCtx, linked: boolean) {
  const ordinals = planSessionOrdinals(p.sessions);
  const full = ctx.level === "full";
  const sessions: PlanSessionDTO[] = p.sessions.map((s) => {
    const state = sessionState(s, ctx.now);
    const b = s.bookings[0];
    return {
      id: s.id,
      index: s.index,
      ordinal: ordinals.get(s.id) ?? null,
      state,
      sinTurno: linked && state === "unbooked",
      scheduledFor: s.scheduledFor,
      completedAt: s.completedAt,
      archivedAt: s.archivedAt,
      booking: b ? { id: b.id, scheduledFor: b.scheduledFor, status: b.status, updatedAt: b.updatedAt } : null,
      // Título de la sesión: misma regla que el del plan (es clínico).
      title: planTitleFor(ctx.caps, ctx.access, s.title),
      notes: full ? s.notes : null,
      priceCents: full ? s.priceCents : null,
      exerciseCount: full ? s._count.exercises : null,
    };
  });
  return { sessions, ordinals };
}

export function projectHeader(p: RawPlan, ctx: ProjectCtx): PlanHeaderDTO & { _sessions: PlanSessionDTO[] } {
  const linked = isRawPlanLinked(p);
  const { sessions } = sessionsOf(p, ctx, linked);
  const live = sessions.filter((s) => s.archivedAt == null);
  const next = live
    .filter((s) => s.state === "booked" && s.booking)
    .sort((a, b) => a.booking!.scheduledFor.getTime() - b.booking!.scheduledFor.getTime())[0];
  return {
    id: p.id,
    patientId: p.patientId,
    level: ctx.level,
    discipline: p.discipline,
    status: p.status,
    archivedAt: p.archivedAt,
    linked,
    title: planTitleFor(ctx.caps, ctx.access, p.title),
    practitionerId: p.practitionerId,
    practitionerName: practitionerName(p),
    serviceId: p.serviceId,
    serviceName: p.service?.name ?? null,
    locationId: p.locationId,
    totalLive: live.length,
    done: live.filter((s) => s.state === "done").length,
    sinTurno: live.filter((s) => s.sinTurno).length,
    nextSession: next ? { sessionId: next.id, ordinal: next.ordinal!, at: next.booking!.scheduledFor } : null,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    _sessions: sessions,
  };
}

/**
 * DTO de la PlanCard. La autorización (E2) se agrega SOLO si el actor la
 * puede ver: si no, la clave no existe (no `undefined`, no `null`), así un
 * `JSON.stringify` o un spread en la UI no pueden filtrarla.
 */
export function projectPlan(p: RawPlan, ctx: ProjectCtx): PlanDTO {
  const { _sessions, ...header } = projectHeader(p, ctx);
  const dto: PlanDTO = {
    ...header,
    notes: ctx.level === "full" ? p.notes : null,
    pricingMode: p.pricingMode,
    balance: balanceOf(p),
    sessions: _sessions,
  };
  if (canSeePlanAuthorization(ctx.caps, ctx.access)) {
    dto.authorization = authorizationOf(p, header.linked);
  }
  return dto;
}

/** `getPlanDetail` (solo `full`). */
export function projectPlanDetail(p: RawPlan, ctx: ProjectCtx): PlanDetailDTO {
  if (ctx.level !== "full") throw new Error("projectPlanDetail: solo nivel full");
  return {
    ...projectPlan(p, ctx),
    // `schedule` lo escribe solo el motor (validado con PlanScheduleV1Schema).
    schedule: (p.schedule ?? null) as PlanScheduleV1 | null,
    durationMin: p.durationMin,
    templateId: p.templateId,
    pricePerSessionCents: p.pricePerSessionCents,
    totalPriceCents: p.totalPriceCents,
  };
}

/**
 * Allowlist de `listSchedulablePlanSessions` (E1): se arma campo por campo.
 * Solo planes ACTIVE, no archivados y vinculados (el caller filtra en la
 * query; acá se vuelve a mirar `linked` por si un caller futuro no lo hace).
 * Sesiones vivas sin cerrar, con o sin turno (con turno = reprogramar).
 * `practitionerId`: el responsable del plan (ADR-003: el plan referencia
 * `(practitionerId, serviceId) + locationId`); si es null (legacy sin
 * backfill), el de la sesión.
 */
export function schedulableSessionsOf(p: RawPlan): SchedulablePlanSession[] {
  if (p.status !== "ACTIVE" || p.archivedAt != null || !isRawPlanLinked(p)) return [];
  const ordinals = planSessionOrdinals(p.sessions);
  const totalLive = ordinals.size;
  const out: SchedulablePlanSession[] = [];
  for (const s of p.sessions) {
    const ordinal = ordinals.get(s.id);
    if (ordinal == null || s.completedAt != null) continue;
    out.push({
      sessionId: s.id,
      programId: p.id,
      ordinal,
      totalLive,
      discipline: p.discipline,
      serviceId: p.serviceId,
      practitionerId: p.practitionerId ?? s.practitionerId,
      locationId: p.locationId,
      sinTurno: s.bookings.length === 0,
    });
  }
  return out.sort((a, b) => a.ordinal - b.ordinal);
}

// ─── Historial ───────────────────────────────────────────────────────────────

/**
 * Claves del payload de audit que pueden salir en el historial. Los payloads
 * son libres (`program.delete` guarda el título, otros podrían guardar notas):
 * con una allowlist, un payload nuevo con PHI no sale hasta que alguien lo
 * agrega acá a propósito.
 */
const HISTORY_DETAIL_KEYS = ["from", "to", "auto", "index", "fields"] as const;

export function historyDetail(payload: Prisma.JsonValue | null): Record<string, string | number | boolean | string[] | null> {
  const out: Record<string, string | number | boolean | string[] | null> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  for (const k of HISTORY_DETAIL_KEYS) {
    const v = (payload as Record<string, Prisma.JsonValue>)[k];
    if (v === undefined) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}
