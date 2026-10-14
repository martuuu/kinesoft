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
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { toARDateKey } from "@/lib/datetime-ar";
import { tenantAccessEnforcement } from "@/lib/env";
import { effectiveMode, tenantAccessFor } from "@/lib/tenant-access";
import { modulesFor, TENANT_MODULES } from "@/lib/tenant-modules";
import {
  PlatformTenantId,
  PlatformTenantListQuery,
  parseStatusReason,
  trialEndsOnToDate,
  type PlatformTenantListQueryInput,
} from "@/lib/platform-tenants-schemas";
import {
  PLATFORM_OVERVIEW_LIST_LIMIT,
  PLATFORM_RECENT_EVENTS,
  PLATFORM_TENANTS_PAGE_SIZE,
  PLATFORM_TRIAL_WARNING_DAYS,
  type PlatformAuditChange,
  type PlatformAuditEventRow,
  type PlatformOverview,
  type PlatformTenantDetail,
  type PlatformTenantPage,
  type PlatformTenantRow,
} from "@/lib/platform-tenants-types";

const DAY_MS = 86_400_000;

/** Días entre dos claves "YYYY-MM-DD" (aritmética de calendario, sin reloj del host). */
function daysBetweenKeys(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

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
  plan: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  publicBookingEnabled: true,
  onboardingCompletedAt: true,
  createdAt: true,
  // BO2-D: estado, motivo, cupo y las 4 columnas del acceso (`TENANT_ACCESS_SELECT`, C-BO1).
  status: true,
  statusReason: true,
  statusChangedAt: true,
  seatLimitOverride: true,
  subscriptionStatusChangedAt: true,
  slugAliases: { select: { slug: true }, orderBy: [{ createdAt: "desc" }, { slug: "asc" }] },
  memberships: {
    where: { role: "OWNER" },
    select: { user: { select: { email: true } } },
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

function toRow(t: RowSource, homes: Set<string>, now: Date): PlatformTenantRow {
  const access = tenantAccessFor(t, now);
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    vertical: t.vertical,
    plan: t.plan,
    subscriptionStatus: t.subscriptionStatus,
    trialEndsOn: t.trialEndsAt ? toARDateKey(t.trialEndsAt) : null,
    publicBookingEnabled: t.publicBookingEnabled,
    onboardingCompleted: t.onboardingCompletedAt !== null,
    ownerEmails: t.memberships.map((m) => m.user.email),
    patientCount: t._count.patients,
    memberCount: t._count.memberships,
    createdAt: t.createdAt.toISOString(),
    isPlatformHome: homes.has(t.id),
    status: t.status,
    statusReason: parseStatusReason(t.statusReason),
    statusChangedAt: t.statusChangedAt ? t.statusChangedAt.toISOString() : null,
    seatLimitOverride: t.seatLimitOverride,
    access,
    effectiveAccessMode: effectiveMode(access.mode, tenantAccessEnforcement()),
    slugAliases: t.slugAliases.map((a) => a.slug),
  };
}

/** Resumen de /plataforma: consultorios por tipo × plan, trials por vencer, altas sin terminar, turneros prendidos. */
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

  const [groups, trialsRaw, trialsCount, pendingRaw, pendingCount, bookingOn] = await Promise.all([
    prismaService.tenant.groupBy({
      by: ["vertical", "plan"],
      _count: { _all: true },
      orderBy: [{ vertical: "asc" }, { plan: "asc" }],
    }),
    prismaService.tenant.findMany({
      where: trialWhere,
      select: { id: true, name: true, slug: true, vertical: true, plan: true, trialEndsAt: true },
      orderBy: { trialEndsAt: "asc" },
      take: PLATFORM_OVERVIEW_LIST_LIMIT,
    }),
    prismaService.tenant.count({ where: trialWhere }),
    prismaService.tenant.findMany({
      where: { onboardingCompletedAt: null },
      select: { id: true, name: true, slug: true, vertical: true, plan: true, createdAt: true },
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
      plan: t.plan,
      trialEndsOn,
      daysLeft: daysBetweenKeys(todayKey, trialEndsOn),
    };
  });

  const byVerticalPlan = groups.map((g) => ({ vertical: g.vertical, plan: g.plan, count: g._count._all }));
  return {
    totalTenants: byVerticalPlan.reduce((acc, g) => acc + g.count, 0),
    byVerticalPlan,
    trialsEndingSoon: trials,
    trialsEndingSoonCount: trialsCount,
    onboardingPending: pendingRaw.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      vertical: t.vertical,
      plan: t.plan,
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

  const where: Prisma.TenantWhereInput = {
    ...(query.q
      ? {
          OR: [
            { name: { contains: query.q, mode: "insensitive" } },
            { slug: { contains: query.q, mode: "insensitive" } },
            // BO2-D: buscar por un slug viejo (alguien llega con el link que circuló antes del cambio).
            { slugAliases: { some: { slug: { contains: query.q, mode: "insensitive" } } } },
          ],
        }
      : {}),
    ...(query.vertical ? { vertical: query.vertical } : {}),
    ...(query.plan ? { plan: query.plan } : {}),
    ...(query.status ? { subscriptionStatus: query.status } : {}),
    ...(query.tenantStatus ? { status: query.tenantStatus } : {}),
  };

  const [total, tenants] = await Promise.all([
    prismaService.tenant.count({ where }),
    prismaService.tenant.findMany({
      where,
      select: rowSelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * PLATFORM_TENANTS_PAGE_SIZE,
      take: PLATFORM_TENANTS_PAGE_SIZE,
    }),
  ]);
  const homes = await platformHomeIds(tenants.map((t) => t.id));
  const now = new Date();
  return {
    rows: tenants.map((t) => toRow(t, homes, now)),
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
  const [homes, pendingInvitations, bookingsLast30Days, bookingsUpcoming, lastActivity, events] = await Promise.all([
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
  ]);

  const actorIds = [...new Set(events.map((e) => e.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await prismaService.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(actors.map((a) => [a.id, a.email]));

  const recentPlatformEvents: PlatformAuditEventRow[] = events.map((e) => ({
    id: e.id,
    action: e.action,
    createdAt: e.createdAt.toISOString(),
    actorEmail: e.actorId ? (emailById.get(e.actorId) ?? null) : null,
    changes: changesOf(e.payload),
  }));

  const modules = modulesFor(t);
  return {
    ...toRow(t, homes, now),
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
