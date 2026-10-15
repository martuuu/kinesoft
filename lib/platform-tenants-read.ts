import "server-only";
/**
 * Lecturas de /plataforma consultorios (EV0 · EV-P1, plan §15.4). Las llaman los
 * server components de EV-P3; no son server actions (no hay "use server": no
 * tienen por qué ser invocables desde el browser con un POST).
 *
 * Seguridad:
 *  - Todo va por `prismaService` (canal service, BYPASSRLS): el resumen y la
 *    lista cruzan TODOS los tenants, cosa que el rol app no puede hacer. Por eso
 *    la única barrera es `requirePlatformAdmin("platform.read")` (BO2-D; antes
 *    `requireSuperAdmin()`), y la llama CADA export (aunque el
 *    layout de /plataforma ya lo haga: el layout es UX, y un export nuevo que se
 *    olvide del guard filtraría todos los consultorios). grep 2 de §15.9 lo
 *    verifica.
 *  - CONTRATO PHI: el superadmin no es equipo clínico de nadie. Sobre modelos con
 *    PHI (Patient, Booking, Session, EvaScore, TreatmentProgram, ClinicalCase,
 *    PatientFile…) solo `count` / `_count`; nunca `findMany`/`findFirst` ni un
 *    `select`/`include` que traiga filas. Los DTOs (`-types.ts`) son el allowlist
 *    de lo que sale, fijado por el test de integración. grep 3 de §15.9.
 *  - AuditEvent sí se lee con `findMany`, pero solo `platform.*` (los escribe
 *    `auditPlatformInTx`, payload de enums/booleanos/fechas) y del payload se
 *    toman solo `changed/before/after` con valores primitivos.
 */
import { Prisma, type SaasPlan, type TenantStatus } from "@prisma/client";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { toARDateKey } from "@/lib/datetime-ar";
import { trialDaysLeft } from "@/components/plataforma/tenants/labels";
import { tenantAccessEnforcement } from "@/lib/env";
import { escapeLike } from "@/lib/email-match";
import { displayUserName } from "@/lib/display-name";
import { effectiveMode, tenantAccessFor } from "@/lib/tenant-access";
import { modulesFor, TENANT_MODULES } from "@/lib/tenant-modules";
import { PLAN_DEFAULTS, SAAS_PLANS, effectiveLimits } from "@/lib/saas-plans-logic";
import type { PlanLimits } from "@/lib/saas-plans-types";
import {
  PlatformTenantId,
  PlatformTenantListQuery,
  TENANT_STATUS_VALUES,
  parseStatusReason,
  trialEndsOnToDate,
  type PlatformTenantListQueryInput,
} from "@/lib/platform-tenants-schemas";
import {
  PLATFORM_ACTIVITY_PAGE_SIZE,
  PLATFORM_OVERVIEW_LIST_LIMIT,
  PLATFORM_RECENT_EVENTS,
  PLATFORM_TENANTS_PAGE_SIZE,
  PLATFORM_TRIAL_WARNING_DAYS,
  type PlatformActivityPage,
  type PlatformAuditChange,
  type PlatformAuditEventRow,
  type PlatformOverview,
  type PlatformTenantDetail,
  type PlatformTenantPage,
  type PlatformTenantRow,
} from "@/lib/platform-tenants-types";

const DAY_MS = 86_400_000;

/** Clave "YYYY-MM-DD" + n días de calendario (UTC solo como aritmética de fechas, no como reloj). */
function addDaysToKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Select común de la fila de lista. Los `_count` filtrados son COUNT(*) en SQL:
 * no traen filas de pacientes (contrato PHI).
 */
const rowSelect = {
  id: true,
  name: true,
  slug: true,
  vertical: true,
  saasPlan: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  publicBookingEnabled: true,
  onboardingCompletedAt: true,
  createdAt: true,
  // BO2-D: estado, motivo y las 4 columnas del acceso (`TENANT_ACCESS_SELECT`, C-BO1). PL-1d: los cupos a medida
  // por tipo reemplazan a `seatLimitOverride` (que queda en la base y ya no se lee acá).
  status: true,
  statusReason: true,
  statusChangedAt: true,
  maxUsersOverride: true,
  maxProfessionalsOverride: true,
  maxStaffOverride: true,
  subscriptionStatusChangedAt: true,
  slugAliases: { select: { slug: true }, orderBy: [{ createdAt: "desc" }, { slug: "asc" }] },
  memberships: {
    where: { role: "OWNER" },
    select: { user: { select: { email: true, fullName: true } } },
    orderBy: { invitedAt: "asc" },
  },
  _count: {
    select: {
      patients: { where: { archivedAt: null } },
      memberships: { where: { acceptedAt: { not: null } } },
    },
  },
} satisfies Prisma.TenantSelect;

type RowSource = Prisma.TenantGetPayload<{ select: typeof rowSelect }>;

/** Tenants (de `ids`) que son el home de algún superadmin: tienen una membresía de un `isPlatformAdmin`. */
async function platformHomeIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prismaService.membership.findMany({
    where: { tenantId: { in: ids }, user: { isPlatformAdmin: true } },
    select: { tenantId: true },
  });
  return new Set(rows.map((r) => r.tenantId));
}

/**
 * PL-1d: límites de cada plan desde `SaasPlanConfig` (GLOBAL_READONLY, 4 filas). Una fila que falte (base sin M8
 * completa, test que la borró) cae a `PLAN_DEFAULTS`, los mismos valores que siembra la migración: la lista de
 * Plataforma nunca se rompe por el catálogo.
 */
async function planLimitsByPlan(): Promise<Record<SaasPlan, PlanLimits>> {
  const rows = await prismaService.saasPlanConfig.findMany({
    select: { plan: true, maxUsers: true, maxProfessionals: true, maxStaff: true },
  });
  const out = Object.fromEntries(SAAS_PLANS.map((p) => [p, PLAN_DEFAULTS[p].limits])) as Record<SaasPlan, PlanLimits>;
  for (const r of rows) out[r.plan] = { maxUsers: r.maxUsers, maxProfessionals: r.maxProfessionals, maxStaff: r.maxStaff };
  return out;
}

function toRow(
  t: RowSource,
  homes: Set<string>,
  now: Date,
  limitsByPlan: Record<SaasPlan, PlanLimits>
): PlatformTenantRow {
  const access = tenantAccessFor(t, now);
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    vertical: t.vertical,
    saasPlan: t.saasPlan,
    subscriptionStatus: t.subscriptionStatus,
    trialEndsOn: t.trialEndsAt ? toARDateKey(t.trialEndsAt) : null,
    publicBookingEnabled: t.publicBookingEnabled,
    onboardingCompleted: t.onboardingCompletedAt !== null,
    ownerEmails: t.memberships.map((m) => m.user.email),
    // VX0-b (decisión 19): el titular se nombra por su nombre; el email va aparte, rotulado como «Email».
    ownerNames: t.memberships.map((m) => displayUserName(m.user.fullName)),
    patientCount: t._count.patients,
    memberCount: t._count.memberships,
    createdAt: t.createdAt.toISOString(),
    isPlatformHome: homes.has(t.id),
    status: t.status,
    statusReason: parseStatusReason(t.statusReason),
    statusChangedAt: t.statusChangedAt ? t.statusChangedAt.toISOString() : null,
    maxUsersOverride: t.maxUsersOverride,
    maxProfessionalsOverride: t.maxProfessionalsOverride,
    maxStaffOverride: t.maxStaffOverride,
    limits: effectiveLimits(limitsByPlan[t.saasPlan], t),
    access,
    effectiveAccessMode: effectiveMode(access.mode, tenantAccessEnforcement()),
    slugAliases: t.slugAliases.map((a) => a.slug),
  };
}

/** Resumen de /plataforma: consultorios por tipo × plan (SaaS, `saasPlan`), trials por vencer, altas sin terminar, turneros prendidos. */
export async function getPlatformOverview(): Promise<PlatformOverview> {
  await requirePlatformAdmin("platform.read");

  const now = new Date();
  const todayKey = toARDateKey(now);
  // "Vence en ≤ 14 días" en días de calendario AR: hasta el fin del día AR de
  // hoy + 14 (mismo instante que guarda el Drawer para ese día). Sin cota
  // inferior: un trial vencido que sigue TRIALING es justo lo que hay que mirar.
  const horizon = trialEndsOnToDate(addDaysToKey(todayKey, PLATFORM_TRIAL_WARNING_DAYS));
  const trialWhere: Prisma.TenantWhereInput = {
    subscriptionStatus: "TRIALING",
    trialEndsAt: { not: null, lte: horizon },
  };

  const [groups, statusGroups, trialsRaw, trialsCount, pendingRaw, pendingCount, bookingOn] = await Promise.all([
    prismaService.tenant.groupBy({
      by: ["vertical", "saasPlan"],
      _count: { _all: true },
      orderBy: [{ vertical: "asc" }, { saasPlan: "asc" }],
    }),
    // BO3-B: activos / suspendidos / de baja. Solo COUNT por estado (sin filas).
    prismaService.tenant.groupBy({ by: ["status"], _count: { _all: true }, orderBy: { status: "asc" } }),
    prismaService.tenant.findMany({
      where: trialWhere,
      select: { id: true, name: true, slug: true, vertical: true, saasPlan: true, trialEndsAt: true },
      orderBy: { trialEndsAt: "asc" },
      take: PLATFORM_OVERVIEW_LIST_LIMIT,
    }),
    prismaService.tenant.count({ where: trialWhere }),
    prismaService.tenant.findMany({
      where: { onboardingCompletedAt: null },
      select: { id: true, name: true, slug: true, vertical: true, saasPlan: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: PLATFORM_OVERVIEW_LIST_LIMIT,
    }),
    prismaService.tenant.count({ where: { onboardingCompletedAt: null } }),
    prismaService.tenant.count({ where: { publicBookingEnabled: true } }),
  ]);

  const trials = trialsRaw.map((t) => {
    // `trialEndsAt` no es null: lo garantiza el where.
    const trialEndsOn = toARDateKey(t.trialEndsAt!);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      vertical: t.vertical,
      saasPlan: t.saasPlan,
      trialEndsOn,
      // BO-Z B5: misma cuenta que `tenantAccessFor` y la banda del consultorio (hoy cuenta; el último día es 1).
      daysLeft: trialDaysLeft(t.trialEndsAt!, now),
    };
  });

  const byVerticalPlan = groups.map((g) => ({ vertical: g.vertical, saasPlan: g.saasPlan, count: g._count._all }));
  const byStatus = Object.fromEntries(TENANT_STATUS_VALUES.map((st) => [st, 0])) as Record<TenantStatus, number>;
  for (const g of statusGroups) byStatus[g.status] = g._count._all;
  return {
    totalTenants: byVerticalPlan.reduce((acc, g) => acc + g.count, 0),
    byStatus,
    byVerticalPlan,
    trialsEndingSoon: trials,
    trialsEndingSoonCount: trialsCount,
    onboardingPending: pendingRaw.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      vertical: t.vertical,
      saasPlan: t.saasPlan,
      createdAt: t.createdAt.toISOString(),
    })),
    onboardingPendingCount: pendingCount,
    publicBookingEnabledCount: bookingOn,
  };
}

/** Lista paginada (50) de consultorios con filtros por nombre/slug, tipo, plan y estado. */
export async function listPlatformTenants(raw: PlatformTenantListQueryInput = {}): Promise<PlatformTenantPage> {
  await requirePlatformAdmin("platform.read");
  // Vienen de searchParams editables a mano: un filtro inválido (`?plan=GOLD`)
  // cae a la lista sin filtros en vez de tirar un 500.
  const parsedQuery = PlatformTenantListQuery.safeParse(raw);
  const query = parsedQuery.success ? parsedQuery.data : PlatformTenantListQuery.parse({});

  // EV1-D: Prisma NO escapa `%`/`_` en `contains`/`equals` con `mode: "insensitive"` (va como ILIKE '%<texto>%'; medido contra el Docker en EV1-D: buscar «%» traía todas las filas).
  const qLike = query.q ? escapeLike(query.q) : "";
  const where: Prisma.TenantWhereInput = {
    ...(query.q
      ? {
          OR: [
            { name: { contains: qLike, mode: "insensitive" } },
            { slug: { contains: qLike, mode: "insensitive" } },
            // BO2-D: buscar por un slug viejo (alguien llega con el link que circuló antes del cambio).
            { slugAliases: { some: { slug: { contains: qLike, mode: "insensitive" } } } },
          ],
        }
      : {}),
    ...(query.vertical ? { vertical: query.vertical } : {}),
    ...(query.plan ? { saasPlan: query.plan } : {}),
    ...(query.status ? { subscriptionStatus: query.status } : {}),
    ...(query.tenantStatus ? { status: query.tenantStatus } : {}),
  };

  const [total, tenants, limitsByPlan] = await Promise.all([
    prismaService.tenant.count({ where }),
    prismaService.tenant.findMany({
      where,
      select: rowSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * PLATFORM_TENANTS_PAGE_SIZE,
      take: PLATFORM_TENANTS_PAGE_SIZE,
    }),
    planLimitsByPlan(),
  ]);
  const homes = await platformHomeIds(tenants.map((t) => t.id));
  const now = new Date();
  return {
    rows: tenants.map((t) => toRow(t, homes, now, limitsByPlan)),
    total,
    page: query.page,
    pageSize: PLATFORM_TENANTS_PAGE_SIZE,
  };
}

/** Solo valores primitivos (lo que escribe `applyTenantEntitlementsInTx`); cualquier otra cosa se descarta. */
function primitive(v: unknown): string | boolean | number | null | undefined {
  // BO1-B: `seatLimitOverride` es numérico; sin esto el cambio se veía como null en «Actividad».
  if (v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number") return v;
  return undefined;
}

function changesOf(payload: Prisma.JsonValue | null): PlatformAuditChange[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  const changed = Array.isArray(p.changed) ? p.changed.filter((k): k is string => typeof k === "string") : [];
  const before = p.before && typeof p.before === "object" ? (p.before as Record<string, unknown>) : {};
  const after = p.after && typeof p.after === "object" ? (p.after as Record<string, unknown>) : {};
  return changed.map((key) => ({
    key,
    before: primitive(before[key]) ?? null,
    after: primitive(after[key]) ?? null,
  }));
}

type EventSource = { id: string; action: string; createdAt: Date; actorId: string | null; payload: Prisma.JsonValue };

/** Nombres de las claves de primer nivel del payload; nunca los valores (pueden ser texto libre). */
function payloadKeysOf(payload: Prisma.JsonValue | null): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).sort();
}

/**
 * Filas de eventos `platform.*` → DTO. El email del actor se busca en `UserProfile` (staff, no PHI); del payload
 * solo salen `changed/before/after` primitivos (`changesOf`) y los nombres de las claves (`payloadKeysOf`).
 */
async function toEventRows(events: EventSource[]): Promise<PlatformActivityPage["events"]> {
  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await prismaService.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(actors.map((a) => [a.id, a.email]));
  return events.map((e) => ({
    id: e.id,
    action: e.action,
    createdAt: e.createdAt.toISOString(),
    actorEmail: e.actorId ? (emailById.get(e.actorId) ?? null) : null,
    changes: changesOf(e.payload),
    payloadKeys: payloadKeysOf(e.payload),
  }));
}

/** Detalle de un consultorio para /plataforma. null = no existe. */
export async function getPlatformTenantDetail(rawId: string): Promise<PlatformTenantDetail | null> {
  await requirePlatformAdmin("platform.read");
  const parsed = PlatformTenantId.safeParse(rawId);
  if (!parsed.success) return null;
  const tenantId = parsed.data;

  const t = await prismaService.tenant.findUnique({
    where: { id: tenantId },
    select: {
      ...rowSelect,
      legalName: true,
      taxId: true,
      phone: true,
      whatsapp: true,
      publicEmail: true,
      sharedPatientView: true,
      updatedAt: true,
      _count: {
        select: {
          ...rowSelect._count.select,
          practitioners: true,
          services: true,
          locations: true,
          bookings: true,
        },
      },
    },
  });
  if (!t) return null;

  const now = new Date();
  const [homes, pendingInvitations, bookingsLast30Days, bookingsUpcoming, lastActivity, events, limitsByPlan] = await Promise.all([
    platformHomeIds([t.id]),
    prismaService.invitation.count({ where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
    // Booking tiene PHI: solo count (contrato PHI).
    prismaService.booking.count({
      where: { tenantId, scheduledFor: { gte: new Date(now.getTime() - 30 * DAY_MS), lt: now } },
    }),
    prismaService.booking.count({ where: { tenantId, scheduledFor: { gte: now } } }),
    prismaService.auditEvent.aggregate({ where: { tenantId }, _max: { createdAt: true } }),
    prismaService.auditEvent.findMany({
      where: { tenantId, action: { startsWith: "platform." } },
      select: { id: true, action: true, createdAt: true, actorId: true, payload: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PLATFORM_RECENT_EVENTS,
    }),
    planLimitsByPlan(),
  ]);

  const recentPlatformEvents: PlatformAuditEventRow[] = (await toEventRows(events)).map(
    ({ payloadKeys: _keys, ...e }) => e
  );

  // C-PL1: `TenantEntitlements.plan` es el plan SaaS.
  const modules = modulesFor({ vertical: t.vertical, plan: t.saasPlan, publicBookingEnabled: t.publicBookingEnabled });
  return {
    ...toRow(t, homes, now, limitsByPlan),
    legalName: t.legalName,
    taxId: t.taxId,
    phone: t.phone,
    whatsapp: t.whatsapp,
    publicEmail: t.publicEmail,
    sharedPatientView: t.sharedPatientView,
    modules: TENANT_MODULES.filter((m) => modules.has(m)),
    counts: {
      members: t._count.memberships,
      pendingInvitations,
      practitioners: t._count.practitioners,
      patients: t._count.patients,
      services: t._count.services,
      locations: t._count.locations,
      bookingsTotal: t._count.bookings,
      bookingsLast30Days,
      bookingsUpcoming,
    },
    lastActivityAt: lastActivity._max.createdAt ? lastActivity._max.createdAt.toISOString() : null,
    recentPlatformEvents,
    publicBookingPath: `/c/${t.slug}/booking`,
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Cursor de «Actividad»: el id de un AuditEvent (cuid/uuid). Se valida antes de tocar la base. */
const ActivityCursor = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

/**
 * BO3-B · pestaña «Actividad» del detalle: eventos `platform.*` del consultorio, del más nuevo al más viejo, de a
 * `PLATFORM_ACTIVITY_PAGE_SIZE`, con cursor (keyset sobre `createdAt desc, id desc`).
 *
 * Mismo contrato PHI que el detalle: solo `AuditEvent` con `action` que empieza con `platform.` y del consultorio
 * pedido (el `where` va siempre, también con cursor: un cursor de otro consultorio solo corre la posición, no trae
 * sus filas). null = el consultorio no existe o el id está mal formado; un cursor inválido arranca de cero.
 */
export async function getPlatformTenantActivity(
  rawTenantId: string,
  rawCursor?: string | null
): Promise<PlatformActivityPage | null> {
  await requirePlatformAdmin("platform.read");
  const parsed = PlatformTenantId.safeParse(rawTenantId);
  if (!parsed.success) return null;
  const tenantId = parsed.data;
  const exists = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!exists) return null;

  const cur = rawCursor ? ActivityCursor.safeParse(rawCursor) : null;
  const cursor = cur?.success ? cur.data : null;

  const where = { tenantId, action: { startsWith: "platform." } } satisfies Prisma.AuditEventWhereInput;
  // Un cursor que no es de este consultorio (o no existe) se ignora: Prisma con un cursor ajeno ordenaría desde
  // la posición de esa fila, que no tiene sentido para el superadmin.
  const anchor = cursor
    ? await prismaService.auditEvent.findFirst({ where: { ...where, id: cursor }, select: { id: true } })
    : null;

  const rows = await prismaService.auditEvent.findMany({
    where,
    select: { id: true, action: true, createdAt: true, actorId: true, payload: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}),
    take: PLATFORM_ACTIVITY_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, PLATFORM_ACTIVITY_PAGE_SIZE);
  return {
    events: await toEventRows(page),
    nextCursor: rows.length > PLATFORM_ACTIVITY_PAGE_SIZE ? page[page.length - 1].id : null,
  };
}
