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
import { tags, ttl } from "@/lib/cache-tags";
import type { KpiKey } from "@/lib/preferences-constants";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d: Date) {
  // Monday as week start (Argentina convention).
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
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

export async function getDashboardData(): Promise<DashboardData> {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const weekStart = startOfWeek(now);
  const nextWeekStart = new Date(weekStart);
  nextWeekStart.setDate(nextWeekStart.getDate() + 7);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

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
        tenantId: actor.tenantId,
        ...v.bookingWhere,
        scheduledFor: { gte: today, lt: tomorrow },
        status: { not: "CANCELLED" },
      },
    }),
    prisma.booking.findMany({
      where: {
        tenantId: actor.tenantId,
        ...v.bookingWhere,
        scheduledFor: { gte: weekStart, lt: nextWeekStart },
      },
      select: { scheduledFor: true, status: true },
    }),
    prisma.patient.count({
      where: {
        tenantId: actor.tenantId,
        ...v.patientWhere,
        programs: { some: { status: "ACTIVE" } },
      },
    }),
    prisma.treatmentProgram.count({
      where: {
        tenantId: actor.tenantId,
        status: "ACTIVE",
        ...(v.seesAll ? {} : { patient: v.patientWhere }),
      },
    }),
    prisma.treatmentProgram.count({
      where: {
        tenantId: actor.tenantId,
        status: "ACTIVE",
        sessions: { some: { completedAt: { not: null } } },
        ...(v.seesAll ? {} : { patient: v.patientWhere }),
      },
    }),
    prisma.patient.count({
      where: {
        tenantId: actor.tenantId,
        ...v.patientWhere,
        createdAt: { gte: monthStart },
      },
    }),
    prisma.session.findMany({
      where: {
        program: { tenantId: actor.tenantId },
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
            case: { include: { diagnoses: { include: { condition: true }, take: 1, orderBy: { rank: "asc" } } } },
          },
        },
      },
    }),
    prisma.booking.findMany({
      where: {
        tenantId: actor.tenantId,
        ...v.bookingWhere,
        scheduledFor: { gte: now },
        status: { notIn: ["CANCELLED", "COMPLETED"] },
      },
      orderBy: { scheduledFor: "asc" },
      take: 3,
      include: { patient: true, service: true },
    }),
    prisma.payment.aggregate({
      where: {
        booking: { tenantId: actor.tenantId },
        status: "PAID",
        createdAt: { gte: monthStart },
      },
      _sum: { amountCents: true },
    }),
    prisma.payment.aggregate({
      where: {
        booking: { tenantId: actor.tenantId },
        status: "PAID",
        createdAt: { gte: prevMonthStart, lt: monthStart },
      },
      _sum: { amountCents: true },
    }),
    prisma.payment.aggregate({
      where: {
        booking: { tenantId: actor.tenantId, patient: { coverages: { some: {} } } },
        status: "PAID",
        createdAt: { gte: monthStart },
      },
      _sum: { amountCents: true },
    }),
  ]);

  // Weekly bars (7 days, Mon..Sun): realised vs absent (NO_SHOW + CANCELLED).
  const bars = ["L", "M", "M", "J", "V", "S", "D"].map((d, i) => {
    const dayStart = new Date(weekStart);
    dayStart.setDate(dayStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
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

  // ISO-week dismissal key (so the "Más tarde" clears on Monday).
  const isoWeek = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    return (
      d.getFullYear() +
      "-W" +
      String(
        1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
      ).padStart(2, "0")
    );
  })();
  const reminderKey = `near-discharge:${isoWeek}`;
  const [reminderDismissed, prefs] = await Promise.all([
    isReminderDismissed(reminderKey),
    getUserPreferences(),
  ]);

  return {
    greetingName: actor.practitionerName.split(" ")[0],
    pinnedKpis: prefs.pinnedKpis,
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
      cond:
        s.program.case?.diagnoses[0]?.condition?.name ??
        s.program.title,
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
        timeZone: "America/Argentina/Buenos_Aires",
      }),
      name: b.patient
        ? `${b.patient.firstName} ${b.patient.lastName}`
        : b.guestName ?? "Sin asignar",
      tag: b.service.name,
    })),
    monthRevenueCents: monthCents,
    revenuePrevMonthCents: prevCents,
    privateShare,
    insurerShare,
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

  if (range === "week") {
    const weekStart = startOfWeek(now);
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 7);
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: weekStart, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    const labels = ["L", "M", "M", "J", "V", "S", "D"];
    return labels.map((label, i) => {
      const ds = new Date(weekStart);
      ds.setDate(ds.getDate() + i);
      const de = new Date(ds);
      de.setDate(de.getDate() + 1);
      return countBookings(rows, ds, de, label);
    });
  }

  if (range === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: start, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    // Bucket by ISO-week within the month.
    const buckets: ChartBar[] = [];
    let cur = new Date(start);
    let w = 1;
    while (cur < end) {
      const next = new Date(cur);
      next.setDate(next.getDate() + 7);
      buckets.push(countBookings(rows, cur, next < end ? next : end, `S${w}`));
      cur = next;
      w++;
    }
    return buckets;
  }

  // 3m: bucket by calendar month for the last 3 months.
  const buckets: ChartBar[] = [];
  for (let i = 2; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const rows = await prisma.booking.findMany({
      where: { tenantId: actor.tenantId, scheduledFor: { gte: start, lt: end } },
      select: { scheduledFor: true, status: true },
    });
    buckets.push(
      countBookings(
        rows,
        start,
        end,
        start.toLocaleDateString("es-AR", { month: "short" })
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
      const start = new Date(y, m, 1);
      const end = new Date(y, m + 1, 1);
      const rows = await prisma.booking.findMany({
        where: {
          tenantId,
          scheduledFor: { gte: start, lt: end },
          status: { notIn: ["CANCELLED"] },
        },
        select: { scheduledFor: true },
      });
      const days = new Set<number>();
      for (const r of rows) days.add(r.scheduledFor.getDate());
      return Array.from(days).sort((a, b) => a - b);
    },
    ["booking-days", actor.tenantId, String(year), String(monthIndex0)],
    { tags: [tags.bookingDays(actor.tenantId)], revalidate: ttl.micro }
  );
  return fetcher(actor.tenantId, year, monthIndex0);
}
