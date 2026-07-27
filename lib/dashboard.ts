/**
 * Server-side aggregations for the Dashboard KPIs and side cards.
 * All numbers are computed in Postgres / Prisma and scoped to the
 * active tenant.
 */
"use server";

import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { visibilityForActor } from "@/lib/visibility";
import { isReminderDismissed } from "@/lib/notifications";
import { getUserPreferences } from "@/lib/preferences";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { tags, ttl } from "@/lib/cache-tags";
import { toARDateKey, toARDow, localToARIso } from "@/lib/datetime-ar";
import type { KpiKey } from "@/lib/preferences-constants";

function startOfDay(d: Date) {
  // AR midnight of the AR day containing `d`, anchored to the business tz
  // so ranges don't drift on a UTC host.
  return new Date(localToARIso(`${toARDateKey(d)}T00:00:00`));
}

function startOfWeek(d: Date) {
  // Monday as week start (Argentina convention). AR has no DST, so stepping
  // back whole days in ms keeps us on AR midnight.
  const x = startOfDay(d);
  const day = (toARDow(x) + 6) % 7; // 0 = Monday
  return new Date(x.getTime() - day * 86_400_000);
}

export type DashboardData = {
  greetingName: string;
  todayCount: number;
  weeklyBars: { d: string; c: number; a: number }[];
  pinned: {
    activePatients: number;
    weekSessions: number;
    activePrograms: number;
    adherencePct: number;
    newPatientsMonth: number;
    nearingDischarge: number;
  };
  pinnedKpis: KpiKey[];
  recent: {
    id: string;
    name: string;
    cond: string;
    sessionsDone: number;
    sessionsTotal: number;
    nextBookingId: string | null;
    nextBookingAt: Date | null;
  }[];
  next: {
    id: string;
    time: string;
    name: string;
    tag: string;
  }[];
  monthRevenueCents: number;
  revenuePrevMonthCents: number;
  privateShare: number;
  insurerShare: number;
  reminderDismissed: boolean;
  reminderKey: string;
};

/**
 * Cacheable inner shape — everything that derives purely from tenantId,
 * visibility scope and date markers. Excludes per-user bits
 * (`greetingName`, `pinnedKpis`, `reminderDismissed`, `reminderKey`)
 * which the outer wrapper layers on top.
 */
type DashboardCounts = Omit<
  DashboardData,
  "greetingName" | "pinnedKpis" | "reminderDismissed" | "reminderKey"
>;

/**
 * Heavy DB work — wrapped in `unstable_cache` so repeated dashboard hits
 * within `ttl.micro` (60s) re-use the result. Cache key includes
 * `tenantId + scope + dayKey`; the scope token captures whether the
 * actor is OWNER/ADMIN (`all`), in shared mode (`shared`), or scoped to
 * a single practitioner (the practitionerId). Two practitioners with
 * identical scope on the same tenant share the cache entry.
 *
 * Cannot read cookies/headers/getActor inside — all inputs are
 * primitives so the wrapper can serialise them into the cache key.
 */
const _loadDashboardCounts = unstable_cache(
  async (
    tenantId: string,
    scope: "all" | string, // "all" or a practitionerId
    dayKey: string // ISO yyyy-mm-dd, anchors the date ranges
  ): Promise<DashboardCounts> => {
    // `dayKey` is the AR "YYYY-MM-DD"; anchor every period boundary to the
    // AR wall-clock so ranges don't drift into the prev/next day on a UTC
    // host. AR has no DST, so day math via fixed 24h steps is exact.
    const DAY_MS = 86_400_000;
    const today = new Date(localToARIso(`${dayKey}T00:00:00`));
    const tomorrow = new Date(today.getTime() + DAY_MS);
    // Mid-day AR anchor for "upcoming" lower bounds (stable within the day).
    const now = new Date(localToARIso(`${dayKey}T12:00:00`));
    const mondayOffset = (toARDow(today) + 6) % 7; // 0 = Monday
    const weekStart = new Date(today.getTime() - mondayOffset * DAY_MS);
    const nextWeekStart = new Date(weekStart.getTime() + 7 * DAY_MS);
    const ym = dayKey.slice(0, 7); // "YYYY-MM" in AR
    const [yNum, mNum] = ym.split("-").map(Number);
    const monthStart = new Date(localToARIso(`${ym}-01T00:00:00`));
    const prevYm =
      mNum === 1 ? `${yNum - 1}-12` : `${yNum}-${String(mNum - 1).padStart(2, "0")}`;
    const prevMonthStart = new Date(localToARIso(`${prevYm}-01T00:00:00`));

    const seesAll = scope === "all";
    const bookingWhere = seesAll ? {} : { practitionerId: scope };
    const patientWhere = seesAll
      ? {}
      : { OR: [{ assignedPractitionerId: scope }, { assignedPractitionerId: null }] };

    const [
      todayCount,
      weekBookings,
      activePatients,
      activePrograms,
      nearingDischarge,
      newPatientsMonth,
      recentSessions,
      nextAppts,
      monthPayments,
      prevMonthPayments,
      insurerPayments,
    ] = await Promise.all([
      prisma.booking.count({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: today, lt: tomorrow },
          status: { not: "CANCELLED" },
        },
      }),
      prisma.booking.findMany({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: weekStart, lt: nextWeekStart },
        },
        select: { scheduledFor: true, status: true },
      }),
      prisma.patient.count({
        where: {
          tenantId,
          ...patientWhere,
          programs: { some: { status: "ACTIVE" } },
        },
      }),
      prisma.treatmentProgram.count({
        where: {
          tenantId,
          status: "ACTIVE",
          ...(seesAll ? {} : { patient: patientWhere }),
        },
      }),
      prisma.treatmentProgram.count({
        where: {
          tenantId,
          status: "ACTIVE",
          sessions: { some: { completedAt: { not: null } } },
          ...(seesAll ? {} : { patient: patientWhere }),
        },
      }),
      prisma.patient.count({
        where: {
          tenantId,
          ...patientWhere,
          createdAt: { gte: monthStart },
        },
      }),
      prisma.session.findMany({
        where: {
          program: { tenantId },
          completedAt: { not: null },
        },
        orderBy: { completedAt: "desc" },
        take: 4,
        include: {
          program: {
            include: {
              patient: {
                include: {
                  bookings: {
                    where: {
                      scheduledFor: { gte: now },
                      status: { notIn: ["CANCELLED", "COMPLETED"] },
                    },
                    orderBy: { scheduledFor: "asc" },
                    take: 1,
                    select: { id: true, scheduledFor: true },
                  },
                },
              },
              case: {
                include: {
                  diagnoses: {
                    include: { condition: true },
                    take: 1,
                    orderBy: { rank: "asc" },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.booking.findMany({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: now },
          status: { notIn: ["CANCELLED", "COMPLETED"] },
        },
        orderBy: { scheduledFor: "asc" },
        take: 3,
        include: {
          patient: { include: { coverages: { include: { insurerRef: true }, orderBy: { id: "desc" }, take: 1 } } },
          service: true,
        },
      }),
      prisma.payment.aggregate({
        where: {
          booking: { tenantId },
          status: "PAID",
          createdAt: { gte: monthStart },
        },
        _sum: { amountCents: true },
      }),
      prisma.payment.aggregate({
        where: {
          booking: { tenantId },
          status: "PAID",
          createdAt: { gte: prevMonthStart, lt: monthStart },
        },
        _sum: { amountCents: true },
      }),
      prisma.payment.aggregate({
        where: {
          booking: { tenantId, patient: { coverages: { some: {} } } },
          status: "PAID",
          createdAt: { gte: monthStart },
        },
        _sum: { amountCents: true },
      }),
    ]);

    const bars = ["L", "M", "M", "J", "V", "S", "D"].map((d, i) => {
      const dayStart = new Date(weekStart.getTime() + i * DAY_MS);
      const dayEnd = new Date(dayStart.getTime() + DAY_MS);
      let c = 0;
      let a = 0;
      for (const b of weekBookings) {
        if (b.scheduledFor >= dayStart && b.scheduledFor < dayEnd) {
          if (b.status === "COMPLETED" || b.status === "CONFIRMED") c++;
          else if (b.status === "NO_SHOW" || b.status === "CANCELLED") a++;
        }
      }
      return { d, c, a };
    });

    const weekSessions = bars.reduce((s, b) => s + b.c, 0);
    const totalSlots = weekSessions + bars.reduce((s, b) => s + b.a, 0);
    const adherencePct = totalSlots ? Math.round((weekSessions / totalSlots) * 100) : 100;

    const monthCents = monthPayments._sum.amountCents ?? 0;
    const prevCents = prevMonthPayments._sum.amountCents ?? 0;
    const insurerCents = insurerPayments._sum.amountCents ?? 0;
    const privateShare = monthCents
      ? Math.round(((monthCents - insurerCents) / monthCents) * 100)
      : 0;
    const insurerShare = monthCents
      ? Math.round((insurerCents / monthCents) * 100)
      : 0;

    const particularCopago = await getParticularCopagoCents(tenantId);

    return {
      todayCount,
      weeklyBars: bars,
      pinned: {
        activePatients,
        weekSessions,
        activePrograms,
        adherencePct,
        newPatientsMonth,
        nearingDischarge,
      },
      recent: recentSessions.map((s) => ({
        id: s.program.patient.id,
        name: `${s.program.patient.firstName} ${s.program.patient.lastName}`,
        cond: s.program.case?.diagnoses[0]?.condition?.name ?? s.program.title,
        sessionsDone: s.index,
        sessionsTotal: s.program.totalSessions,
        nextBookingId: s.program.patient.bookings[0]?.id ?? null,
        nextBookingAt: s.program.patient.bookings[0]?.scheduledFor ?? null,
      })),
      next: nextAppts.map((b) => ({
        id: b.id,
        time: b.scheduledFor.toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        }),
        name: b.patient
          ? `${b.patient.firstName} ${b.patient.lastName}`
          : b.guestName ?? "Sin asignar",
        // "Servicio - ObraSocial - $Copago" — same billing line as the
        // agenda. Particular (no coverage/guest) uses the service price.
        tag: (() => {
          const coverage = b.patient?.coverages[0];
          const insurer = coverage?.insurerRef;
          // Only the real insurer name surfaces — particular/uninsured
          // turnos drop the segment (never print the word "Particular").
          const os = insurer?.name ?? coverage?.insurer ?? "";
          const obraSocial = os.toLowerCase() === "particular" ? "" : os;
          const copagoCents = resolveBookingCopagoCents({
            bookingOverride: b.copagoCents,
            coverageOverride: coverage?.copagoCents ?? null,
            hasCoverage: !!coverage,
            insurerCopago: insurer ? insurer.copagoCents : null,
            particularCopago,
            servicePriceCents: b.service.priceCents,
          });
          const copago = (copagoCents / 100).toLocaleString("es-AR", {
            style: "currency",
            currency: "ARS",
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          });
          return [b.service.name, obraSocial, copago].filter(Boolean).join(" - ");
        })(),
      })),
      monthRevenueCents: monthCents,
      revenuePrevMonthCents: prevCents,
      privateShare,
      insurerShare,
    };
  },
  ["dashboard:counts"],
  // Tags are static here; the per-tenant invalidation is achieved by the
  // dashboard mutations (createBooking, etc.) calling
  // `revalidateTag(tags.dashboard(tenantId))`. The wrapper itself is keyed
  // by tenantId in `keyParts` so different tenants get separate slots.
  { revalidate: ttl.micro }
);

/** ISO-week token; rolls over Monday at 00:00 — matches the dismissal key. */
function isoWeekKey(d: Date): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + 3 - ((x.getDay() + 6) % 7));
  const week1 = new Date(x.getFullYear(), 0, 4);
  return (
    x.getFullYear() +
    "-W" +
    String(
      1 +
        Math.round(
          ((x.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
        )
    ).padStart(2, "0")
  );
}

export async function getDashboardData(): Promise<DashboardData> {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const now = new Date();
  const dayKey = toARDateKey(now);
  const scope: "all" | string = v.seesAll ? "all" : actor.practitionerId;

  // Per-tenant cache via dynamically tagged wrapper. The static
  // `_loadDashboardCounts` provides the underlying compute; this thin
  // wrapper attaches the tenant-scoped tag so `revalidateTag` from a
  // mutation only nukes one tenant's slot, not all.
  const taggedFetcher = unstable_cache(
    (tenantId: string, s: "all" | string, k: string) =>
      _loadDashboardCounts(tenantId, s, k),
    ["dashboard:counts", actor.tenantId, scope, dayKey],
    { tags: [tags.dashboard(actor.tenantId)], revalidate: ttl.micro }
  );

  const counts = await taggedFetcher(actor.tenantId, scope, dayKey);

  // Per-user bits computed outside the cache — preferences / reminder
  // dismissal differ per practitioner and would explode cache cardinality.
  const reminderKey = `near-discharge:${isoWeekKey(now)}`;
  const [reminderDismissed, prefs] = await Promise.all([
    isReminderDismissed(reminderKey),
    getUserPreferences(),
  ]);

  return {
    ...counts,
    greetingName: actor.practitionerName.split(" ")[0],
    pinnedKpis: prefs.pinnedKpis,
    reminderDismissed,
    reminderKey,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Sessions chart — refetchable from the client via range toggle
// ──────────────────────────────────────────────────────────────────────

export type ChartRange = "week" | "month" | "3m";

export type ChartBar = { label: string; done: number; missed: number };

export async function getSessionsChart(range: ChartRange): Promise<ChartBar[]> {
  const actor = await getActor();
  const now = new Date();

  const DAY_MS = 86_400_000;
  const nowKey = toARDateKey(now); // "YYYY-MM-DD" in AR

  if (range === "week") {
    const weekStart = startOfWeek(now); // AR Monday midnight
    const end = new Date(weekStart.getTime() + 7 * DAY_MS);
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: weekStart, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    const labels = ["L", "M", "M", "J", "V", "S", "D"];
    return labels.map((label, i) => {
      const ds = new Date(weekStart.getTime() + i * DAY_MS);
      const de = new Date(ds.getTime() + DAY_MS);
      return countBookings(rows, ds, de, label);
    });
  }

  if (range === "month") {
    const ym = nowKey.slice(0, 7); // "YYYY-MM" in AR
    const [my, mm] = ym.split("-").map(Number);
    const start = new Date(localToARIso(`${ym}-01T00:00:00`));
    const nextYm = mm === 12 ? `${my + 1}-01` : `${my}-${String(mm + 1).padStart(2, "0")}`;
    const end = new Date(localToARIso(`${nextYm}-01T00:00:00`));
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: start, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    // Bucket by ISO-week within the month.
    const buckets: ChartBar[] = [];
    let cur = new Date(start);
    let w = 1;
    while (cur < end) {
      const next = new Date(cur.getTime() + 7 * DAY_MS);
      buckets.push(countBookings(rows, cur, next < end ? next : end, `S${w}`));
      cur = next;
      w++;
    }
    return buckets;
  }

  // 3m: bucket by AR calendar month for the last 3 months.
  const [cy, cm] = nowKey.slice(0, 7).split("-").map(Number); // cm is 1-based
  const buckets: ChartBar[] = [];
  for (let i = 2; i >= 0; i--) {
    // Absolute 0-based month index, normalised across year boundaries.
    const abs = cy * 12 + (cm - 1) - i;
    const sy = Math.floor(abs / 12);
    const sm = abs % 12; // 0-based month
    const startYm = `${sy}-${String(sm + 1).padStart(2, "0")}`;
    const start = new Date(localToARIso(`${startYm}-01T00:00:00`));
    const nextYm = sm === 11 ? `${sy + 1}-01` : `${sy}-${String(sm + 2).padStart(2, "0")}`;
    const end = new Date(localToARIso(`${nextYm}-01T00:00:00`));
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: start, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    buckets.push(
      countBookings(
        rows,
        start,
        end,
        start.toLocaleDateString("es-AR", {
          month: "short",
          timeZone: "America/Argentina/Buenos_Aires",
        })
      )
    );
  }
  return buckets;
}

function countBookings(
  rows: { scheduledFor: Date; status: string }[],
  start: Date,
  end: Date,
  label: string
): ChartBar {
  let done = 0;
  let missed = 0;
  for (const r of rows) {
    if (r.scheduledFor < start || r.scheduledFor >= end) continue;
    if (r.status === "COMPLETED" || r.status === "CONFIRMED") done++;
    else if (r.status === "NO_SHOW" || r.status === "CANCELLED") missed++;
  }
  return { label, done, missed };
}

// ──────────────────────────────────────────────────────────────────────
// MiniCalendar nav — booking days for a given month
// ──────────────────────────────────────────────────────────────────────

export async function getMonthBookingDays(
  year: number,
  monthIndex0: number
): Promise<number[]> {
  const actor = await getActor();
  const fetcher = unstable_cache(
    async (tenantId: string, y: number, m: number): Promise<number[]> => {
      // Anchor the month window to AR midnight so bookings in the AR
      // 21:00–24:00 edge of the first/last day aren't pulled from the
      // wrong calendar month (UTC host is +3h ahead of AR).
      const mm = String(m + 1).padStart(2, "0");
      const start = new Date(localToARIso(`${y}-${mm}-01T00:00:00`));
      const nextY = m === 11 ? y + 1 : y;
      const nextMM = String(m === 11 ? 1 : m + 2).padStart(2, "0");
      const end = new Date(localToARIso(`${nextY}-${nextMM}-01T00:00:00`));
      const rows = await prisma.booking.findMany({
        where: {
          tenantId,
          scheduledFor: { gte: start, lt: end },
          status: { notIn: ["CANCELLED"] },
        },
        select: { scheduledFor: true },
      });
      const days = new Set<number>();
      // Derive the day-of-month in AR, not the host tz.
      for (const r of rows) days.add(Number(toARDateKey(r.scheduledFor).slice(8, 10)));
      return Array.from(days).sort((a, b) => a - b);
    },
    ["booking-days", actor.tenantId, String(year), String(monthIndex0)],
    { tags: [tags.bookingDays(actor.tenantId)], revalidate: ttl.micro }
  );
  return fetcher(actor.tenantId, year, monthIndex0);
}
