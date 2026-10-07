/**
 * Server-side aggregations for the Dashboard KPIs and side cards.
 * All numbers are computed in Postgres / Prisma and scoped to the
 * active tenant.
 */
"use server";

import { unstable_cache } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { visibilityForActor, bulkPatientAccess } from "@/lib/visibility";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import { planSessionOrdinals } from "@/lib/plan-display";
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
  /**
   * A2b-S-vis: `access` por fila. Las filas "basic" (paciente ni asignado
   * ni compartido) llegan SIN diagnóstico ni progreso del plan (`cond: ""`,
   * 0/0) y sin id del próximo turno: el QuickMenu es de solo lectura.
   *
   * S14: "full" acá exige además `clinical.read` (`planTitleFor`): la
   * condición y el título del plan son clínicos. La Secretaria (nivel `admin`
   * de PD-13) recibe la fila "basic". `cond` vacío ("") = el "nulo" de §10
   * S14: se mantiene `string` para no cambiar el contrato de la UI.
   * `sessionsDone`/`sessionsTotal` = ordinal de la sesión cerrada entre las
   * vivas / sesiones vivas (M13, mismo número que el chip `Kine · 3/10`), no
   * `Session.index` / `totalSessions`.
   */
  recent: {
    id: string;
    name: string;
    cond: string;
    sessionsDone: number;
    sessionsTotal: number;
    nextBookingId: string | null;
    nextBookingAt: Date | null;
    /** Optimistic lock del próximo turno (`expectedUpdatedAt` de setBookingStatus). */
    nextBookingUpdatedAt: Date | null;
    access: "full" | "basic";
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
  "greetingName" | "pinnedKpis" | "reminderDismissed" | "reminderKey" | "recent" | "next"
> & {
  // Filas crudas: el enmascarado por acceso se aplica FUERA del cache, por
  // request. Si se hiciera adentro, un share revocado seguiría mostrando el
  // diagnóstico hasta que venza el TTL, y la clave de cache tendría que
  // incluir los shares del actor.
  recent: (Omit<DashboardData["recent"][number], "access">)[];
  next: (DashboardData["next"][number] & { patientId: string | null; serviceName: string })[];
};

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
    dayKey: string, // ISO yyyy-mm-dd, anchors the date ranges
    // S14 (enmienda EV0): sin el módulo `planes` (consultorio General) no se
    // consulta TreatmentProgram ni Session y esos KPIs valen 0. Va como
    // argumento porque adentro del cache no hay actor.
    withPlans: boolean
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
    const none = <T,>(v: T) => Promise.resolve(v);
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
      // Each query is wrapped in its own runWithRls so they still run in
      // parallel (one short tenant-scoped transaction / connection each) —
      // preserving today's Promise.all fan-out instead of serialising on a
      // single interactive transaction.
      runWithRls(tenantId, (tx) => tx.booking.count({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: today, lt: tomorrow },
          status: { not: "CANCELLED" },
        },
      })),
      runWithRls(tenantId, (tx) => tx.booking.findMany({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: weekStart, lt: nextWeekStart },
        },
        select: { scheduledFor: true, status: true },
      })),
      // "Activo" = ACTIVE **y** no archivado (`liveProgramWhere`, §2.4).
      withPlans
        ? runWithRls(tenantId, (tx) => tx.patient.count({
            where: {
              tenantId,
              ...patientWhere,
              programs: { some: { status: "ACTIVE", ...liveProgramWhere } },
            },
          }))
        : none(0),
      withPlans
        ? runWithRls(tenantId, (tx) => tx.treatmentProgram.count({
            where: {
              tenantId,
              status: "ACTIVE",
              ...liveProgramWhere,
              ...(seesAll ? {} : { patient: patientWhere }),
            },
          }))
        : none(0),
      withPlans
        ? runWithRls(tenantId, (tx) => tx.treatmentProgram.count({
            where: {
              tenantId,
              status: "ACTIVE",
              ...liveProgramWhere,
              sessions: { some: { ...liveSessionWhere, completedAt: { not: null } } },
              ...(seesAll ? {} : { patient: patientWhere }),
            },
          }))
        : none(0),
      runWithRls(tenantId, (tx) => tx.patient.count({
        where: {
          tenantId,
          ...patientWhere,
          createdAt: { gte: monthStart },
        },
      })),
      // Sesión viva de un plan vivo: una archivada (o de un plan archivado)
      // no es "reciente" ni tiene ordinal (M13).
      withPlans
        ? runWithRls(tenantId, (tx) => tx.session.findMany({
        where: {
          ...liveSessionWhere,
          program: { tenantId, ...liveProgramWhere },
          completedAt: { not: null },
        },
        orderBy: { completedAt: "desc" },
        take: 4,
        include: {
          program: {
            include: {
              // Para el ordinal (M13) y el total de vivas, como el chip de la agenda.
              sessions: {
                where: liveSessionWhere,
                select: { id: true, index: true, scheduledFor: true, archivedAt: true },
              },
              patient: {
                include: {
                  bookings: {
                    where: {
                      scheduledFor: { gte: now },
                      status: { notIn: ["CANCELLED", "COMPLETED"] },
                    },
                    orderBy: { scheduledFor: "asc" },
                    take: 1,
                    select: { id: true, scheduledFor: true, updatedAt: true },
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
      }))
        : none([]),
      runWithRls(tenantId, (tx) => tx.booking.findMany({
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
      })),
      runWithRls(tenantId, (tx) => tx.payment.aggregate({
        where: {
          booking: { tenantId },
          status: "PAID",
          createdAt: { gte: monthStart },
        },
        _sum: { amountCents: true },
      })),
      runWithRls(tenantId, (tx) => tx.payment.aggregate({
        where: {
          booking: { tenantId },
          status: "PAID",
          createdAt: { gte: prevMonthStart, lt: monthStart },
        },
        _sum: { amountCents: true },
      })),
      runWithRls(tenantId, (tx) => tx.payment.aggregate({
        where: {
          booking: { tenantId, patient: { coverages: { some: {} } } },
          status: "PAID",
          createdAt: { gte: monthStart },
        },
        _sum: { amountCents: true },
      })),
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
        // [P2-S14] antes: `s.index` / `totalSessions`, que con sesiones
        // archivadas (index fijo) no coincidía con el chip de la agenda.
        sessionsDone: planSessionOrdinals(s.program.sessions).get(s.id) ?? 0,
        sessionsTotal: s.program.sessions.length,
        nextBookingId: s.program.patient.bookings[0]?.id ?? null,
        nextBookingAt: s.program.patient.bookings[0]?.scheduledFor ?? null,
        nextBookingUpdatedAt: s.program.patient.bookings[0]?.updatedAt ?? null,
      })),
      next: nextAppts.map((b) => ({
        id: b.id,
        patientId: b.patientId,
        serviceName: b.service.name,
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
  // Anidado en el `taggedFetcher` de abajo: cuando el de afuera se recalcula,
  // Next corre este callback con `fetchCache: "force-no-store"` y este cache se
  // saltea (next 14.2 `unstable-cache.js`), así que el tag de afuera manda.
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
  const withPlans = modulesFor(actor.entitlements).has("planes");

  // Per-tenant cache via dynamically tagged wrapper. The static
  // `_loadDashboardCounts` provides the underlying compute; this thin
  // wrapper attaches the tenant-scoped tag so `revalidateTag` from a
  // mutation only nukes one tenant's slot, not all.
  //
  // S14 (enmienda EV0): la clave explícita NO lleva los módulos. Un cambio de
  // vertical/plan lo escribe `applyTenantEntitlementsInTx` y su caller revalida
  // `tenantEntitlementTags(tenantId)`, que incluye `tags.dashboard(tenantId)`
  // (el tag de este cache): el slot viejo muere con el cambio y no se sirve
  // un dashboard de General con planes (o al revés) durante el TTL. Ojo: el
  // `withPlans` igual termina en la clave efectiva porque `unstable_cache`
  // serializa los argumentos (`${keyParts}-${JSON.stringify(args)}`); no es
  // la barrera, es un efecto del runtime. La barrera es el tag.
  const taggedFetcher = unstable_cache(
    (tenantId: string, s: "all" | string, k: string, plans: boolean) =>
      _loadDashboardCounts(tenantId, s, k, plans),
    ["dashboard:counts", actor.tenantId, scope, dayKey],
    { tags: [tags.dashboard(actor.tenantId)], revalidate: ttl.micro }
  );

  const [counts, caps] = await Promise.all([
    taggedFetcher(actor.tenantId, scope, dayKey, withPlans),
    getMembershipRole(actor).then(capabilitiesFor),
  ]);

  // A2b-S-vis: "recientes" sale de las sesiones de TODO el tenant y
  // "próximos" puede incluir pacientes asignados a otro profesional. Se
  // resuelve el acceso por fila (una sola query) y las básicas pierden el
  // diagnóstico/plan, la OS y el copago — igual que en el directorio.
  const patientIds = Array.from(
    new Set([
      ...counts.recent.map((r) => r.id),
      ...counts.next.map((n) => n.patientId).filter((id): id is string => !!id),
    ])
  );
  const accessMap = await bulkPatientAccess(actor, patientIds);
  const isFull = (id: string) => accessMap.get(id) === "full";
  // S14: la condición/título del plan es clínica → misma regla que
  // `planTitleFor` (full **y** `clinical.read`). Hoy full ⇒ clinical.read
  // (PD-13), pero si un rol nuevo rompiera esa implicación, la fila igual
  // sale sin dato clínico.
  const seesClinical = (id: string) => caps.has("clinical.read") && isFull(id);
  // `unstable_cache` serializa a JSON: en un hit las fechas vuelven como
  // string. Se rehidratan acá para que el cliente reciba `Date` de verdad.
  const toDate = (d: Date | string | null) => (d ? new Date(d) : null);

  // Per-user bits computed outside the cache — preferences / reminder
  // dismissal differ per practitioner and would explode cache cardinality.
  const reminderKey = `near-discharge:${isoWeekKey(now)}`;
  const [reminderDismissed, prefs] = await Promise.all([
    isReminderDismissed(reminderKey),
    getUserPreferences(),
  ]);

  return {
    ...counts,
    recent: counts.recent.map((r) =>
      seesClinical(r.id)
        ? {
            ...r,
            nextBookingAt: toDate(r.nextBookingAt),
            nextBookingUpdatedAt: toDate(r.nextBookingUpdatedAt),
            access: "full" as const,
          }
        : {
            id: r.id,
            name: r.name,
            cond: "",
            sessionsDone: 0,
            sessionsTotal: 0,
            nextBookingId: null,
            nextBookingAt: toDate(r.nextBookingAt),
            nextBookingUpdatedAt: null,
            access: "basic" as const,
          }
    ),
    // Guest (sin paciente) = operable; con paciente básico → solo servicio.
    next: counts.next.map(({ patientId, serviceName, ...n }) =>
      !patientId || isFull(patientId) ? n : { ...n, tag: serviceName }
    ),
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
  // S14 (enmienda EV0, revisión): sin el módulo `sesiones` (consultorio
  // General) el gráfico devuelve 0 SIN consultar. Se arman los mismos
  // buckets (mismas etiquetas) con `rows = []` para que la UI no cambie de
  // forma; `load` es el único lugar que toca la base.
  const withSessions = modulesFor(actor.entitlements).has("sesiones");
  const load = (start: Date, end: Date) =>
    withSessions
      ? runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
          where: { tenantId: actor.tenantId, scheduledFor: { gte: start, lt: end } },
          select: { scheduledFor: true, status: true },
        }))
      : Promise.resolve([] as { scheduledFor: Date; status: string }[]);

  const DAY_MS = 86_400_000;
  const nowKey = toARDateKey(now); // "YYYY-MM-DD" in AR

  if (range === "week") {
    const weekStart = startOfWeek(now); // AR Monday midnight
    const end = new Date(weekStart.getTime() + 7 * DAY_MS);
    const rows = await load(weekStart, end);
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
    const rows = await load(start, end);
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
    const rows = await load(start, end);
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
      const rows = await runWithRls(tenantId, (tx) => tx.booking.findMany({
        where: {
          tenantId,
          scheduledFor: { gte: start, lt: end },
          status: { notIn: ["CANCELLED"] },
        },
        select: { scheduledFor: true },
      }));
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
