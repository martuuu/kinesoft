/**
 * Server-side aggregations for the Dashboard KPIs and side cards.
 * All numbers are computed in Postgres / Prisma and scoped to the
 * active tenant.
 */
"use server";

import { mpConnectMode } from "@/lib/env";
import { greetingFirstName } from "@/lib/display-name";
import { unstable_cache } from "next/cache";
import { runWithRls, type DbClient } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { getMemberAccess, memberCapabilitiesForActor } from "@/lib/authz";
import { isClinicalMember } from "@/lib/roles";
import { isOversightMember } from "@/lib/roles-core";
import { modulesFor } from "@/lib/tenant-modules";
import { visibilityForActor, bulkPatientAccess } from "@/lib/visibility";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import { planSessionOrdinals } from "@/lib/plan-display";
import { getUserPreferences } from "@/lib/preferences";
import {
  getParticularCopagoCents,
  loadPractitionerPricesInTx,
  practitionerPriceKey,
  resolveBookingCopagoCents,
} from "@/lib/billing-internal";
import { tags, ttl } from "@/lib/cache-tags";
import { toARDateKey, toARDow, localToARIso, arIsoWeekKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import type { KpiKey, Preferences } from "@/lib/preferences-constants";
import { RevenueRangeSchema } from "@/lib/preferences-schemas";
import {
  revenuePeriod,
  revenueScopeFor,
  revenueScopeKey,
  summarizeRevenue,
  type RevenueAmounts,
  type RevenueRange,
  type RevenueScope,
  type RevenueScopeKind,
  type RevenueSummary,
} from "@/lib/dashboard-revenue";
import type { ActionResult } from "@/lib/validation";
import type { Prisma } from "@prisma/client";
import { dayWindow } from "@/lib/availability/day";
import { cajaScopeFor, cashTodayFrom } from "@/lib/caja-logic";
import { collectedGroupsInTx } from "@/lib/caja-internal";
import type { CashTodayRow, CashTodaySummary, CollectedGroup } from "@/lib/caja-types";

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

/** A quién destina un profesional lo de hoy («destina $X a …» de la tarjeta). Sin OS (D-CF2-16). */
export type CashTodayGiven = { practitionerId: string; practitionerName: string; cents: number };
export type DashboardCashTodayRow = CashTodayRow & { givenTo: CashTodayGiven[] };
/** `CashTodaySummary` + el destinatario de lo que destina cada fila (asignable a `CashTodaySummary`). */
export type DashboardCashToday = Omit<CashTodaySummary, "rows"> & { rows: DashboardCashTodayRow[] };

export type DashboardData = {
  greetingName: string;
  /**
   * PL-Z (FX4): el switch «Aparece en el turnero online» del propio profesional va en el menú de perfil (el
   * Profesional no tiene Configuración). `null` = el actor no tiene ficha de profesional (Secretaria, Admin que no
   * atiende). Se lee FUERA del `unstable_cache` de los counts: es por usuario y cambia con su propio toggle.
   */
  ownPublicBooking: { practitionerId: string; enabled: boolean; myMp?: boolean } | null;
  todayCount: number;
  weeklyBars: { d: string; c: number; a: number }[];
  pinned: {
    activePatients: number;
    weekSessions: number;
    activePrograms: number;
    /** [PF2-a] `null` sin turnos con resultado en la semana (realizados + ausentes = 0): no hay adherencia. */
    adherencePct: number | null;
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
  /**
   * S14r: ingresos del MES AR (KPI `monthRevenue`) = MP + copagos cobrados a
   * mano, con la obra social aparte (`lib/dashboard-revenue.ts`). Antes:
   * `monthRevenueCents`/`revenuePrevMonthCents`/`privateShare`/`insurerShare`,
   * que solo sumaban los `Payment` de MP.
   *
   * SR-D5I: acotado por `revenueScope`. `null` = el rol no ve ingresos
   * (Secretaria): la UI no renderiza ni la KPI ni el widget.
   */
  monthRevenue: RevenueSummary | null;
  /** S14r: el widget en el período que eligió el usuario (`dashboardPrefs.revenueRange`). `null` como `monthRevenue`. */
  revenue: RevenueSummary | null;
  /**
   * SR-D5I: de quién son los ingresos de arriba (`revenueScopeFor`): `tenant`
   * (todo el consultorio), `own` (los turnos del profesional: la UI titula
   * "Tus ingresos…") o `none`. Solo el tipo: el id del profesional no viaja.
   */
  revenueScope: RevenueScopeKind;
  /**
   * CF2 (D-CF2-16/17, sesión P-D): tarjeta «Cobrado hoy» de la Secretaria = scope `desk` de la caja (`cajaScopeFor`:
   * `billing.collect` sin `billing.manage`): copagos + online de HOY por profesional con lo que destina/recibe, sin OS.
   * `null` para cualquier otro rol (Titular/Admin/Facturación tienen `/caja` y el widget de Ingresos; el profesional,
   * sus ingresos). Es la única enmienda a SR-D5I: `revenue`/`monthRevenue` siguen `null` para la Secretaria.
   *
   * Opcional en el TIPO solo para no tocar los fixtures de render de otras sesiones (`dashboard-modules`, `mb1d`,
   * `pf1-dashboard`, `revenue-card`): `loadDashboard` SIEMPRE lo setea (objeto o `null`).
   *
   * Cache: NO va en `dashboard:counts`. Esa clave es por tenant + token de visibilidad, y la Secretaria comparte el
   * token `no-practitioner` con Facturación: cacheada ahí, Facturación heredaría la tarjeta, y un cobro (que no
   * siempre revalida el tag `dashboard`: el webhook de MP no lo hace) quedaría viejo hasta el TTL. Se calcula en la
   * tx de la página, por request, como los ingresos: nunca más vieja que la carga.
   */
  cashToday?: DashboardCashToday | null;
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
  | "greetingName"
  | "pinnedKpis"
  | "reminderDismissed"
  | "reminderKey"
  | "recent"
  | "next"
  | "revenue"
  | "monthRevenue"
  | "revenueScope"
  | "ownPublicBooking"
  | "cashToday"
> & {
  // Filas crudas: el enmascarado por acceso se aplica FUERA del cache, por
  // request. Si se hiciera adentro, un share revocado seguiría mostrando el
  // diagnóstico hasta que venza el TTL, y la clave de cache tendría que
  // incluir los shares del actor.
  recent: (Omit<DashboardData["recent"][number], "access">)[];
  next: (DashboardData["next"][number] & { patientId: string | null; serviceName: string })[];
};

/**
 * IAM-4a: token de scope de un actor SIN profesional (Secretaria, Facturación) que tampoco «ve todo». No choca con
 * un id real (los ids son cuid) ni con `"all"`. Va en la clave del cache como cualquier scope.
 */
const NO_PRACTITIONER_SCOPE = "no-practitioner";

/**
 * PF2-a: prefijo del token de un profesional clínico que no es Titular. Si ve todo depende de
 * `Tenant.sharedPatientView`, que no viene en el Actor: se lee ADENTRO de la tx de los counts (solo en un miss).
 * Antes el scope salía de `visibilityForActor` en una tx propia previa a los counts, y con el acceso por fila
 * (A2b) DESPUÉS de los counts eran 3 tx en serie como mínimo (C-PF8: ≤ 2 en frío). Este token tampoco choca con
 * un id ni con `"all"`. Un profesional de un consultorio con vista compartida tiene así su propia entrada (mismos
 * números que la de `"all"`): más cardinalidad, ninguna mezcla. Cambiar `sharedPatientView` revalida
 * `/dashboard` (`setSharedPatientView`), y eso vence estas entradas (tag implícito de la ruta en `unstable_cache`).
 */
const SHARED_VIEW_PENDING = "pending-shared:";

/** Filas de «Pacientes recientes» y cuántas sesiones cerradas se miran para juntar esos pacientes distintos. */
const RECENT_ROWS = 4;
const RECENT_SCAN = 40;

/** Scope de visibilidad del actor como token primitivo (va en las claves de cache). */
function dashboardScopeFor(actor: { practitionerId: string | null }, seesAll: boolean): "all" | string {
  return seesAll ? "all" : actor.practitionerId ?? NO_PRACTITIONER_SCOPE;
}

/**
 * PF2-a: el token de scope de los counts SIN query. Espeja `memberTier` + `visibilityForActor`
 * (lib/visibility.ts): soporte o miembro no clínico (PD-13) → nunca «ve todo»; Titular clínico (oversight) →
 * `"all"`; el resto (profesional) → `"all"` solo con `sharedPatientView`, que se resuelve adentro
 * (`SHARED_VIEW_PENDING`). La membresía sale del Actor (`getMemberAccess`, misma fila de la foto: cero queries);
 * sin fila, el mismo default que `memberTier` (PRACTITIONER clínico).
 */
async function countsScopeTokenFor(actor: Actor): Promise<string> {
  const own = actor.practitionerId ?? NO_PRACTITIONER_SCOPE;
  if (actor.support) return own;
  const m = (await getMemberAccess(actor)) ?? { role: "PRACTITIONER" as const, clinical: true };
  if (!isClinicalMember(m)) return own;
  // El mismo predicado que `memberTier` (lib/visibility.ts), co-titular incluido (CT-INT, H2): si no coincidieran, los
  // counts del dashboard no serían lo que `visibilityForActor` le abre. CF3 ZF4a: antes era una copia de OVERSIGHT_ROLES.
  if (isOversightMember(m)) return "all";
  return `${SHARED_VIEW_PENDING}${own}`;
}

/**
 * Turnos que cuenta el dashboard para un scope: todos, los del profesional o
 * ninguno (condición imposible, nunca `practitionerId: null`). Lo comparten la
 * carga inicial y `getSessionsChart` (EV1-A) para que el gráfico no cambie de
 * universo al tocar el rango.
 */
function bookingScopeWhere(scope: "all" | string): Prisma.BookingWhereInput {
  if (scope === "all") return {};
  if (scope === NO_PRACTITIONER_SCOPE) return { id: { in: [] } };
  return { practitionerId: scope };
}

/**
 * Heavy DB work — wrapped in `unstable_cache` so repeated dashboard hits
 * within `ttl.micro` (60s) re-use the result. Cache key includes
 * `tenantId + scope + dayKey`; the scope token (`countsScopeTokenFor`) is
 * `all`, a practitionerId, `no-practitioner` or `pending-shared:<pid>`.
 *
 * Cannot read cookies/headers/getActor inside — all inputs are
 * primitives so the wrapper can serialise them into the cache key.
 *
 * PF2-a (C-PF8): UNA transacción propia con las lecturas en serie (antes 8 `runWithRls` en paralelo + 1 del copago
 * particular = 9 tx por miss, y con el pool chico, P2028 en la presión de pool). Es propia y no la de la página a
 * propósito: en un miss VENCIDO Next devuelve lo viejo y recalcula en segundo plano, después de la respuesta, cuando
 * la tx de la página ya cerró. Y la página no la anida: los counts se resuelven ANTES de abrir la suya (con
 * `connection_limit=1` una tx esperando otra conexión adentro de otra tx es un deadlock hasta el `maxWait`).
 */
const _loadDashboardCounts = unstable_cache(
  async (
    tenantId: string,
    scopeToken: string, // "all", a practitionerId, NO_PRACTITIONER_SCOPE or SHARED_VIEW_PENDING + id
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
    const monthStart = new Date(localToARIso(`${ym}-01T00:00:00`));

    return runWithRls(tenantId, async (tx) => {
      // PF2-a: el profesional ve todo solo con la vista compartida del consultorio (`visibilityForActor`).
      let scope: "all" | string = scopeToken;
      if (scopeToken.startsWith(SHARED_VIEW_PENDING)) {
        const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { sharedPatientView: true } });
        scope = t?.sharedPatientView ? "all" : scopeToken.slice(SHARED_VIEW_PENDING.length);
      }
      const seesAll = scope === "all";
      // IAM-4a: sin profesional, condiciones imposibles (no `IS NULL`): los KPIs «propios» valen 0.
      const noPractitioner = scope === NO_PRACTITIONER_SCOPE;
      const bookingWhere = bookingScopeWhere(scope);
      // El `assignedPractitionerId: null` de acá es a propósito (pacientes «del consultorio» que todo profesional
      // cuenta), y solo con un profesional real: nunca como sustituto de un actor sin profesional.
      const patientWhere: Prisma.PatientWhereInput = seesAll
        ? {}
        : noPractitioner
          ? { id: { in: [] } }
          : { OR: [{ assignedPractitionerId: scope }, { assignedPractitionerId: null }] };

      // En una tx interactiva las sentencias van en serie por la misma conexión: el `Promise.all` de antes no
      // ganaba nada salvo conexiones (mismo razonamiento que `revenueAmountsInTx`). Mismas sentencias.
      const todayCount = await tx.booking.count({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: today, lt: tomorrow },
          status: { not: "CANCELLED" },
        },
      });
      const weekBookings = await tx.booking.findMany({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: weekStart, lt: nextWeekStart },
        },
        select: { scheduledFor: true, status: true },
      });
      // "Activo" = ACTIVE **y** no archivado (`liveProgramWhere`, §2.4).
      const activePatients = withPlans
        ? await tx.patient.count({
            where: {
              tenantId,
              ...patientWhere,
              programs: { some: { status: "ACTIVE", ...liveProgramWhere } },
            },
          })
        // EV1-A: sin planes "Pacientes activos" valía 0 siempre. En General la
        // misma KPI es "Pacientes atendidos" (`GENERAL_KPI_COPY`): pacientes
        // distintos con un turno COMPLETED en los últimos 30 días, con el mismo
        // scope de turnos que `todayCount` (sin profesional → 0). Una sola query
        // acotada por fecha; no se agrega para Kine.
        : (
            await tx.booking.findMany({
              where: {
                tenantId,
                ...bookingWhere,
                status: "COMPLETED",
                patientId: { not: null },
                scheduledFor: { gte: new Date(tomorrow.getTime() - 30 * DAY_MS), lt: tomorrow },
              },
              distinct: ["patientId"],
              select: { patientId: true },
            })
          ).length;
      const activePrograms = withPlans
        ? await tx.treatmentProgram.count({
            where: {
              tenantId,
              status: "ACTIVE",
              ...liveProgramWhere,
              ...(seesAll ? {} : { patient: patientWhere }),
            },
          })
        : 0;
      const nearingDischarge = withPlans
        ? await tx.treatmentProgram.count({
            where: {
              tenantId,
              status: "ACTIVE",
              ...liveProgramWhere,
              sessions: { some: { ...liveSessionWhere, completedAt: { not: null } } },
              ...(seesAll ? {} : { patient: patientWhere }),
            },
          })
        : 0;
      const newPatientsMonth = await tx.patient.count({
        where: {
          tenantId,
          ...patientWhere,
          createdAt: { gte: monthStart },
        },
      });
      // Sesión viva de un plan vivo: una archivada (o de un plan archivado)
      // no es "reciente" ni tiene ordinal (M13).
      //
      // [PF2-a] Uno por PACIENTE (la sesión cerrada más reciente de cada uno). Antes `take: 4` sobre sesiones: un
      // paciente con 3 sesiones cerradas seguidas ocupaba 3 de las 4 filas (lo vio el revisor visual de PF2).
      // Prisma no tiene `distinct` por un campo de la relación (`program.patientId`), así que va en dos pasos:
      // ids livianos de las últimas sesiones → las 4 primeras de pacientes distintos → la carga completa de esas.
      const recentIds: string[] = [];
      if (withPlans) {
        const latest = await tx.session.findMany({
          where: {
            ...liveSessionWhere,
            program: { tenantId, ...liveProgramWhere },
            completedAt: { not: null },
          },
          orderBy: [{ completedAt: "desc" }, { id: "asc" }],
          take: RECENT_SCAN,
          select: { id: true, program: { select: { patientId: true } } },
        });
        const seen = new Set<string>();
        for (const r of latest) {
          if (seen.has(r.program.patientId)) continue;
          seen.add(r.program.patientId);
          recentIds.push(r.id);
          if (recentIds.length === RECENT_ROWS) break;
        }
      }
      const recentSessions = recentIds.length
        ? await tx.session.findMany({
            where: { id: { in: recentIds }, program: { tenantId } },
            orderBy: [{ completedAt: "desc" }, { id: "asc" }],
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
          })
        : [];
      const nextAppts = await tx.booking.findMany({
        where: {
          tenantId,
          ...bookingWhere,
          scheduledFor: { gte: now },
          status: { notIn: ["CANCELLED", "COMPLETED"] },
        },
        orderBy: { scheduledFor: "asc" },
        take: 3,
        // CF3 ZF1 (B5): solo lo que arma la línea (nombre, servicio, escalera del copago). Antes `include` traía la fila
        // entera del paciente (DNI, teléfono, notas…) y del servicio a un snapshot cacheado. Misma sentencia.
        select: {
          id: true,
          patientId: true,
          practitionerId: true,
          serviceId: true,
          scheduledFor: true,
          guestName: true,
          copagoCents: true,
          patient: {
            select: {
              firstName: true,
              lastName: true,
              coverages: {
                select: { insurer: true, copagoCents: true, insurerRef: { select: { name: true, copagoCents: true, isParticular: true } } },
                orderBy: { id: "desc" },
                take: 1,
              },
            },
          },
          service: { select: { name: true, priceCents: true } },
        },
      });
      // SR-D5I: los ingresos del mes (S14r) ya NO van acá. Este cache se
      // comparte por `scope` de VISIBILIDAD de pacientes ("all" para OWNER/
      // ADMIN y para cualquier rol con `sharedPatientView`), que no es el
      // scope de la plata: un PRACTITIONER con `sharedPatientView` caía en la
      // entrada "all" del OWNER. Salen de la tx de la página (`revenueSummaryInTx`).
      const particularCopago = await getParticularCopagoCents(tenantId, tx);
      // CF3 PR-C2 (D-CF3-1): precio del profesional de los ≤ 3 próximos turnos, en una sentencia y solo si hay turnos
      // (el presupuesto del dashboard es de transacciones, pf2-dashboard-budget: esta va en la misma tx). CF3 ZF1 (M1):
      // también los invitados, que se cobran con la escalera del particular (= lo que congela `toggleBilling`).
      // Este snapshot cachea con TTL `micro` y el tag del dashboard: un precio nuevo se ve al vencer, como el resto.
      const practitionerPrices = await loadPractitionerPricesInTx(
        tx,
        tenantId,
        nextAppts.map((b) => ({ practitionerId: b.practitionerId, serviceId: b.serviceId }))
      );

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
      // [PF2-a] D4 de VX0-b: sin turnos con resultado no hay adherencia que mostrar. Antes valía 100 y un
      // consultorio nuevo veía «100 % de adherencia» sin un solo turno; la UI lo tapaba recalculando el
      // denominador con `weeklyBars` (components/dashboard/kpi-view.ts).
      const adherencePct = totalSlots ? Math.round((weekSessions / totalSlots) * 100) : null;

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
          // [PF2-a] D6 de VX0-b: el diagnóstico (condición de rango 1 del caso) o vacío, que la UI muestra como
          // «Sin diagnóstico cargado». Antes caía al título del plan, que no es un diagnóstico.
          cond: s.program.case?.diagnoses[0]?.condition?.name ?? "",
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
            hourCycle: "h23",
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
            // CF3 ZF1 (B5): la fila «Particular» del catálogo se reconoce por `isParticular`, no por el nombre (un
            // consultorio que la renombra la veía impresa). El nombre solo queda para la cobertura de texto libre
            // sin fila (legado), que no tiene el flag.
            const os = insurer ? (insurer.isParticular ? "" : insurer.name) : coverage?.insurer ?? "";
            const obraSocial = !insurer && os.toLowerCase() === "particular" ? "" : os;
            const copagoCents = resolveBookingCopagoCents({
              bookingOverride: b.copagoCents,
              coverageOverride: coverage?.copagoCents ?? null,
              hasCoverage: !!coverage,
              insurerCopago: insurer ? insurer.copagoCents : null,
              particularCopago,
              servicePriceCents: b.service.priceCents,
              practitionerPriceCents: practitionerPrices.get(practitionerPriceKey(b.practitionerId, b.serviceId)) ?? null,
              insurerIsParticular: insurer?.isParticular === true,
            });
            // HD-14: el formatter compartido (como la agenda), no un `toLocaleString` propio: con centavos muestra
            // «$ 1.500,50» y no el redondeo a pesos (HD-15).
            const copago = formatARS(copagoCents);
            return [b.service.name, obraSocial, copago].filter(Boolean).join(" - ");
          })(),
        })),
      };
    });
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

/** Lo que recibe `DashboardScreen`: los datos, las preferencias y los días con turnos del mes AR en curso. */
export type DashboardPageData = {
  data: DashboardData;
  preferences: Preferences;
  bookingDays: number[];
};

/**
 * PF2-a (C-PF8): la carga de `/dashboard` entera, con el presupuesto de ≤ 2 tx en frío y ≤ 1 en caliente
 * (`tests/integration/pf2-dashboard-budget.test.ts`). Antes la página hacía `Promise.all` de `getDashboardData`,
 * `getUserPreferences` y `getMonthBookingDays`: 15-16 tx en frío y 4 en caliente.
 */
export async function getDashboardPageData(): Promise<DashboardPageData> {
  const actor = await getActor();
  return loadDashboard(actor, { withBookingDays: true });
}

export async function getDashboardData(): Promise<DashboardData> {
  const actor = await getActor();
  return (await loadDashboard(actor, { withBookingDays: false })).data;
}

/**
 * Orden (C-PF8):
 *   1. preferencias (sin tx: `UserPreferences` no tiene RLS) y counts del cache (en un miss, su tx propia) en
 *      paralelo. Ninguno tiene una tx abierta mientras espera al otro.
 *   2. UNA tx de la página, abierta recién con los counts en la mano: acceso por fila (A2b, fuera del cache: un
 *      share revocado se ve en la próxima carga), recordatorio, turnero propio, ingresos y días del calendario.
 * Los ingresos de la carga ya no pasan por `cachedRevenue` (su clave con el scope queda igual para `getRevenue`):
 * cacheados eran 1-2 tx más en cada miss, y adentro de esta tx son sentencias de una tx que ya está abierta.
 * Los días del calendario, igual (`getMonthBookingDays` sigue cacheado para la navegación del mini-calendario).
 */
async function loadDashboard(
  actor: Actor,
  opts: { withBookingDays: boolean }
): Promise<{ data: DashboardData; preferences: Preferences; bookingDays: number[] }> {
  const now = new Date();
  const dayKey = toARDateKey(now);
  const withPlans = modulesFor(actor.entitlements).has("planes");
  const scopeToken = await countsScopeTokenFor(actor);

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
    (tenantId: string, s: string, k: string, plans: boolean) => _loadDashboardCounts(tenantId, s, k, plans),
    ["dashboard:counts", actor.tenantId, scopeToken, dayKey],
    { tags: [tags.dashboard(actor.tenantId)], revalidate: ttl.micro }
  );

  // SR-D5I: el scope de los ingresos sale de las capabilities del miembro (no de la visibilidad, ver
  // `revenueScopeFor`; PL-1: por miembro, H-PL1). Sale del Actor (`Actor.membership`) sin query extra.
  const [counts, prefs, caps] = await Promise.all([
    taggedFetcher(actor.tenantId, scopeToken, dayKey, withPlans),
    getUserPreferences(),
    memberCapabilitiesForActor(actor),
  ]);
  const revenueScope = revenueScopeFor(caps, actor.practitionerId);
  const revenuePid = revenueScope.kind === "own" ? revenueScope.practitionerId : null;
  // CF2 (D-CF2-16): «Cobrado hoy» solo para el scope `desk` de la caja. El soporte nunca (como `loadCajaPage`; además
  // `memberCapabilitiesForActor` ya le saca `billing.*`).
  const withCashToday = !actor.support && cajaScopeFor(caps, actor.practitionerId).kind === "desk";

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
  // Per-user bits computed outside the cache — preferences / reminder
  // dismissal differ per practitioner and would explode cache cardinality.
  // HD-14: semana ISO del día AR (lunes 00:00 AR), no la del host: en Vercel (UTC) el domingo 21:00 AR ya era lunes.
  const reminderKey = `near-discharge:${arIsoWeekKey(now)}`;
  const practitionerId = actor.practitionerId;
  const [arYear, arMonth] = dayKey.split("-").map(Number);
  const tenantId = actor.tenantId;

  const page = await runWithRls(tenantId, async (tx) => {
    const accessMap = await bulkPatientAccess(actor, patientIds, tx);
    // Recordatorio pospuesto: fila de DismissedReminder con dismissedUntil > ahora (lo escribe dismissReminder de
    // lib/notifications.ts), con la tx de la página.
    const dismissed = await tx.dismissedReminder.findUnique({
      where: { tenantId_userId_reminderKey: { tenantId, userId: actor.userId, reminderKey } },
      select: { dismissedUntil: true },
    });
    const own = practitionerId
      ? await tx.practitioner.findFirst({
          where: { id: practitionerId, tenantId },
          select: { id: true, publicBookingEnabled: true },
        })
      : null;
    // S14r: el widget arranca en el período que el usuario dejó elegido. El mes va siempre (KPI); la semana se
    // pide solo si hace falta, con el mismo scope. Con scope `none` no se consulta nada (ni `Payment`).
    const monthRevenue =
      revenueScope.kind === "none" ? null : await revenueSummaryInTx(tx, tenantId, revenuePid, "month", dayKey);
    const revenue =
      revenueScope.kind === "none"
        ? null
        : prefs.dashboard.revenueRange === "month"
          ? monthRevenue
          : await revenueSummaryInTx(tx, tenantId, revenuePid, prefs.dashboard.revenueRange, dayKey);
    const bookingDays = opts.withBookingDays ? await bookingDaysInTx(tx, tenantId, arYear, arMonth - 1) : [];
    // CF2 (P-D): +1 sentencia en esta tx, 0 tx (C-PF8). Hoy AR (`dayWindow`, nunca el día del host), sin OS: la rama
    // de la obra social ni se evalúa con `includeInsurer: false`. `now` = la hora que muestra «Actualizado a las …».
    const cashToday = withCashToday
      ? cashTodayForDesk(await collectedGroupsInTx(tx, tenantId, dayWindow(dayKey), { includeInsurer: false }), now)
      : null;
    return {
      accessMap,
      reminderDismissed: !!dismissed && dismissed.dismissedUntil > new Date(),
      // TP-3z: `myMp` = existe «Mi Mercado Pago» (cobros online prendidos): el menú de perfil ofrece el ítem solo así.
      ownPublicBooking: own
        ? { practitionerId: own.id, enabled: own.publicBookingEnabled, myMp: mpConnectMode() !== "off" }
        : null,
      monthRevenue,
      revenue,
      bookingDays,
      cashToday,
    };
  });

  const isFull = (id: string) => page.accessMap.get(id) === "full";
  // S14: la condición/título del plan es clínica → misma regla que
  // `planTitleFor` (full **y** `clinical.read`). Hoy full ⇒ clinical.read
  // (PD-13), pero si un rol nuevo rompiera esa implicación, la fila igual
  // sale sin dato clínico.
  const seesClinical = (id: string) => caps.has("clinical.read") && isFull(id);
  // `unstable_cache` serializa a JSON: en un hit las fechas vuelven como
  // string. Se rehidratan acá para que el cliente reciba `Date` de verdad.
  const toDate = (d: Date | string | null) => (d ? new Date(d) : null);

  const data: DashboardData = {
    ...counts,
    monthRevenue: page.monthRevenue,
    revenue: page.revenue,
    revenueScope: revenueScope.kind,
    cashToday: page.cashToday,
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
    // DIR-0: sin nombre real el saludo va sin nombre («Hola 👋»), no «Hola, Usuario».
    greetingName: greetingFirstName(actor.practitionerName),
    pinnedKpis: prefs.pinnedKpis,
    reminderDismissed: page.reminderDismissed,
    reminderKey,
    ownPublicBooking: page.ownPublicBooking,
  };
  return { data, preferences: prefs, bookingDays: page.bookingDays };
}

/**
 * CF2 (P-D → INT-P): la tarjeta «Cobrado hoy» es `cashTodayFrom` tal cual (`lib/caja-logic.ts`): desde INT-P la fila
 * ya trae a QUIÉN destina (`CashTodayRow.givenTo`, de la misma liquidación `desk`, sin OS ni ceros), así que no se
 * liquida dos veces. Puro, sobre los grupos ya leídos: 0 sentencias.
 */
function cashTodayForDesk(groups: readonly CollectedGroup[], now: Date): DashboardCashToday {
  return cashTodayFrom(groups, now);
}

// ──────────────────────────────────────────────────────────────────────
// S14r · Ingresos del período (Mes/Semana) — ver `lib/dashboard-revenue.ts`
// ──────────────────────────────────────────────────────────────────────

/**
 * Montos crudos de `[start, end)` para el tenant, o solo los turnos de
 * `practitionerId` (SR-D5I, scope `own`; `null` = todo el consultorio). El
 * legado, el manual y la OS filtran por el `Booking.practitionerId` ACTUAL del
 * turno: si un turno cobrado se reasigna, su plata se muda con él (decisión
 * documentada en `revenueScopeFor`). El cobro online filtra por su profesional
 * IMPUTADO (`OnlineCharge.practitionerId`, inmutable): un link sin turno no
 * tiene otro, y la plata entró a la cuenta de MP de ese profesional. Todo en la
 * tx del caller y con `tenantId` a mano en el WHERE: en prod la conexión tiene
 * BYPASSRLS y es la única barrera.
 *
 *   - MP legado: `Payment` PAID por `createdAt` (mismo criterio de fecha que
 *     tenía el widget; el webhook no emite el tag `dashboard`, entra por TTL).
 *   - MP online (T5, C-TP11): `OnlineCharge` PAID por `approvedAt` (la fecha
 *     en que MP aprobó, no la de alta del link: un link de octubre pagado en
 *     noviembre es plata de noviembre). Incluye las señas y los links SIN
 *     turno. Scope por el profesional IMPUTADO del cobro (`practitionerId` de
 *     la fila), que para un cobro con turno es el del turno al cobrar. REFUNDED
 *     no suma (la plata volvió).
 *   - Copagos a mano: `paymentStatus PAID` con `copagoPaidAt` en el período,
 *     NETOS de las señas que la recepción vio al cobrar (`settledAt <=
 *     copagoPaidAt`): con seña + resto en efectivo, «Pagado» cobró solo el
 *     resto (C-TP10) y la seña ya sumó en MP. Antes sumaba el copago entero
 *     (doble conteo) y con el filtro viejo de `Payment` el resto se perdía
 *     (hallazgo 4 de §25.2). Una seña acreditada DESPUÉS del cobro a mano no se
 *     resta: la recepción cobró el copago entero y esa seña es un reintegro
 *     pendiente en MP. Se excluyen el turno con `Payment` legado PAID (ya contó
 *     arriba) y el pagado TOTAL online (medio MERCADO_PAGO sin quién cobró: lo
 *     escribe el webhook, ya contó como online); con `COALESCE` porque un cobro
 *     de antes de M12 tiene el medio NULL y es manual. Los cobros marcados
 *     antes de M3a tienen `copagoPaidAt` NULL y no se cuentan: no hay una fecha
 *     de cobro confiable que inventarles (cabecera de la migración). El monto
 *     es `copagoCents`: al marcar cobrado, `setBookingCopagoPaid` congela el
 *     copago resuelto (Q8), así que en una fila con fecha nunca es null.
 *
 *   Las tres van en UNA sentencia (C-TP11; antes dos `aggregate`): sumar la
 *   fuente online no podía costar una sentencia más (`pf2-dashboard-budget`).
 *   - Obra social (aparte): turnos con `insurerPaidAt` en el período × el
 *     arancel (`Insurer.fixedFeeCents`) de la cobertura vigente del paciente
 *     (la última por id, como `resolvePatientBilling` y la tab Facturación).
 *     El arancel se resuelve al leer (no es una columna del turno: P11, arancel
 *     retroactivo, sigue abierto). Se agrupa por paciente para no traer un
 *     turno por fila: 2 consultas acotadas por pacientes distintos.
 */
// Gate de SR (SRZ): antes cada período abría 3 `runWithRls` en paralelo y
// `loadRevenue` pedía 2 períodos = 6 transacciones interactivas por llamada.
// Desde SR-D5I el mes corre EN PARALELO con los counts del dashboard (que ya
// abren las suyas), y con el pool chico la integración completa daba "Unable to
// start a transaction in the given time" (maxWait 2 s): el mismo riesgo en prod
// con varios usuarios a la vez. Ahora es UNA transacción por resumen, con las
// lecturas en serie adentro (en una tx interactiva comparten la conexión: el
// `Promise.all` no ganaba nada salvo conexiones). Mismas sentencias, 1 BEGIN.
async function revenueAmountsInTx(
  tx: DbClient,
  tenantId: string,
  start: Date,
  end: Date,
  withInsurer: boolean,
  practitionerId: string | null
): Promise<RevenueAmounts> {
  // `tenantId` a mano SIEMPRE; el profesional se suma encima, nunca lo reemplaza.
  const own = practitionerId ? { practitionerId } : {};
  // C-TP11 literal (enmienda TP-ZF1 M1: una seña reintegrada DESPUÉS del cobro a mano se sigue restando del manual —
  // la recepción cobró solo el resto y la seña ya salió de MP al reintegrarse; antes el manual volvía al copago entero y
  // Ingresos contaba de más). Los bordes viajan como ISO y se convierten a la hora de pared UTC de las columnas `timestamp(3)`
  // (mismo molde que `lib/booking-rooms-internal.ts`): un `Date` crudo dependería del TimeZone de la sesión.
  const $t = tenantId;
  const $prof = practitionerId;
  const $start = start.toISOString();
  const $end = end.toISOString();
  const [money] = await tx.$queryRaw<{ legacyMp: number; onlineMp: number; manualNet: number }[]>`
    SELECT
      COALESCE((SELECT sum(p."amountCents") FROM "Payment" p JOIN "Booking" b ON b."id" = p."bookingId"
         WHERE b."tenantId" = ${$t} AND (${$prof}::text IS NULL OR b."practitionerId" = ${$prof}) AND p."status" = 'PAID'
           AND p."createdAt" >= (${$start}::timestamptz AT TIME ZONE 'UTC') AND p."createdAt" < (${$end}::timestamptz AT TIME ZONE 'UTC')), 0)::int AS "legacyMp",
      COALESCE((SELECT sum(c."amountCents") FROM "OnlineCharge" c
         WHERE c."tenantId" = ${$t} AND (${$prof}::text IS NULL OR c."practitionerId" = ${$prof}) AND c."status" = 'PAID'
           AND c."approvedAt" >= (${$start}::timestamptz AT TIME ZONE 'UTC') AND c."approvedAt" < (${$end}::timestamptz AT TIME ZONE 'UTC')), 0)::int AS "onlineMp",
      COALESCE((SELECT sum(GREATEST(0, COALESCE(b."copagoCents", 0) - COALESCE(d."cents", 0))) FROM "Booking" b
         LEFT JOIN LATERAL (SELECT sum(c."amountCents") AS "cents" FROM "OnlineCharge" c
            WHERE c."tenantId" = b."tenantId" AND c."bookingId" = b."id" AND c."kind" = 'DEPOSIT'
              AND (c."status" = 'PAID' OR (c."status" = 'REFUNDED' AND c."refundedAt" > b."copagoPaidAt"))
              AND c."settledAt" <= b."copagoPaidAt") d ON true
         WHERE b."tenantId" = ${$t} AND (${$prof}::text IS NULL OR b."practitionerId" = ${$prof}) AND b."paymentStatus" = 'PAID'
           AND b."copagoPaidAt" >= (${$start}::timestamptz AT TIME ZONE 'UTC') AND b."copagoPaidAt" < (${$end}::timestamptz AT TIME ZONE 'UTC')
           AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."bookingId" = b."id" AND p."status" = 'PAID')
           AND NOT COALESCE(b."copagoPaymentMethod" = 'MERCADO_PAGO' AND b."copagoCollectedById" IS NULL, false)), 0)::int AS "manualNet"`;
  let insurerCents = 0;
  if (withInsurer) {
    const perPatient = await tx.booking.groupBy({
      by: ["patientId"],
      where: { tenantId, ...own, patientId: { not: null }, insurerPaidAt: { gte: start, lt: end } },
      _count: { _all: true },
    });
    if (perPatient.length > 0) {
      const coverages = await tx.coverage.findMany({
        where: {
          patientId: { in: perPatient.map((r) => r.patientId!) },
          patient: { tenantId },
        },
        orderBy: { id: "desc" },
        select: { patientId: true, insurerRef: { select: { fixedFeeCents: true, isParticular: true } } },
      });
      const fee = new Map<string, number>();
      for (const c of coverages) {
        if (fee.has(c.patientId)) continue; // la primera = la de id mayor = la vigente
        // Particular / texto libre: ninguna OS paga (cuenta como privado).
        fee.set(c.patientId, c.insurerRef && !c.insurerRef.isParticular ? c.insurerRef.fixedFeeCents : 0);
      }
      insurerCents = perPatient.reduce((acc, r) => acc + r._count._all * (fee.get(r.patientId!) ?? 0), 0);
    }
  }
  return {
    mpCents: (money?.legacyMp ?? 0) + (money?.onlineMp ?? 0),
    manualCents: money?.manualNet ?? 0,
    insurerCents,
  };
}

/**
 * Resumen del período AR del día `dayKey`, con el anterior para el "vs", en la tx que se le pase. PF2-a: lo usan
 * `loadRevenue` (el miss de `cachedRevenue`, con su propia tx) y la tx única de la carga de `/dashboard`.
 */
async function revenueSummaryInTx(
  tx: DbClient,
  tenantId: string,
  practitionerId: string | null,
  range: RevenueRange,
  dayKey: string
): Promise<RevenueSummary> {
  const p = revenuePeriod(range, new Date(localToARIso(`${dayKey}T00:00:00`)));
  const current = await revenueAmountsInTx(tx, tenantId, p.start, p.end, true, practitionerId);
  // Del anterior solo se compara el total (MP + copagos): la OS no entra en el "vs".
  const previous = await revenueAmountsInTx(tx, tenantId, p.prevStart, p.prevEnd, false, practitionerId);
  return summarizeRevenue(range, current, previous);
}

/** Resumen del período AR del día `dayKey` en su propia tx (miss de `cachedRevenue`). */
function loadRevenue(
  tenantId: string,
  practitionerId: string | null,
  range: RevenueRange,
  dayKey: string
): Promise<RevenueSummary> {
  return runWithRls(tenantId, (tx) => revenueSummaryInTx(tx, tenantId, practitionerId, range, dayKey));
}

/**
 * Cache por tenant + SCOPE + período + día AR, bajo el tag `dashboard` (lo
 * invalidan las mutaciones de turnos y cobros; el tag es por tenant y alcanza
 * a todos los scopes).
 *
 * SR-D5I: el scope va EXPLÍCITO en los `keyParts` (`revenueScopeKey`). Antes
 * la clave era `[tenantId, range, dayKey]`: con ingresos por profesional, A y
 * B compartirían la entrada y el segundo vería la plata del primero hasta el
 * TTL. Que Next también serialice los argumentos es un efecto del runtime, no
 * la barrera. Lo prueba `tests/integration/dashboard-revenue-scope.test.ts`
 * con un Map real (A → B → OWNER → A). El caller nunca pasa `none`.
 */
function cachedRevenue(
  tenantId: string,
  scope: Exclude<RevenueScope, { kind: "none" }>,
  range: RevenueRange,
  dayKey: string
): Promise<RevenueSummary> {
  const practitionerId = scope.kind === "own" ? scope.practitionerId : null;
  return unstable_cache(
    (t: string, pid: string | null, r: RevenueRange, k: string) => loadRevenue(t, pid, r, k),
    ["dashboard:revenue", tenantId, revenueScopeKey(scope), range, dayKey],
    { tags: [tags.dashboard(tenantId)], revalidate: ttl.micro }
  )(tenantId, practitionerId, range, dayKey);
}

/**
 * S14r: el widget de ingresos al cambiar Mes/Semana (mismo patrón que
 * `getSessionsChart`). Gate = el del resto del dashboard (`getActor`, tenant
 * del Actor y `where: { tenantId }` a mano adentro). No persiste la elección:
 * eso es `updateDashboardPrefs` (`lib/preferences.ts`), que la UI llama junto.
 *
 * SR-D5I: el scope sale del ACTOR (rol → capabilities), nunca de un parámetro
 * del cliente. Sin acceso (Secretaria) devuelve error sin consultar nada.
 */
export async function getRevenue(range: RevenueRange): Promise<ActionResult<RevenueSummary>> {
  const actor = await getActor();
  const parsed = RevenueRangeSchema.safeParse(range);
  if (!parsed.success) return { ok: false, error: "Período inválido." };
  const scope = revenueScopeFor(await memberCapabilitiesForActor(actor), actor.practitionerId);
  if (scope.kind === "none") return { ok: false, error: "No tenés acceso a los ingresos del consultorio." };
  return { ok: true, data: await cachedRevenue(actor.tenantId, scope, parsed.data, toARDateKey(new Date())) };
}

// ──────────────────────────────────────────────────────────────────────
// Sessions chart — refetchable from the client via range toggle
// ──────────────────────────────────────────────────────────────────────

export type ChartRange = "week" | "month" | "3m";

export type ChartBar = { label: string; done: number; missed: number };

export async function getSessionsChart(range: ChartRange): Promise<ChartBar[]> {
  const actor = await getActor();
  const now = new Date();
  // EV1-A: el gráfico cuenta TURNOS (Booking), no `Session`, en los dos
  // verticales. La enmienda EV0 lo apagaba sin el módulo `sesiones` y en
  // General la carga inicial (`weeklyBars`, también de turnos) mostraba datos
  // que se vaciaban al tocar "Semana/Mes/3 meses". Ahora General lo ve como
  // "Turnos" (rótulo en `SessionsChart`) con los mismos números que la carga
  // inicial; Kine no cambia.
  //
  // Mismo scope que `weeklyBars` (`_loadDashboardCounts`): antes esta action
  // contaba TODO el consultorio y un profesional sin «ver todo» veía sus turnos
  // en la carga inicial y los de todos al tocar "Semana". Sin profesional (y
  // sin ver todo) no hay turnos propios: barras en 0.
  const own = bookingScopeWhere(dashboardScopeFor(actor, (await visibilityForActor(actor)).seesAll));
  const load = (start: Date, end: Date) =>
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: { tenantId: actor.tenantId, ...own, scheduledFor: { gte: start, lt: end } },
      select: { scheduledFor: true, status: true },
    }));

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

/**
 * Días (del mes AR) con algún turno no cancelado, en la tx que se le pase. PF2-a: lo usan el miss de
 * `getMonthBookingDays` (navegación del mini-calendario, cacheada) y la tx única de la carga de `/dashboard`.
 */
async function bookingDaysInTx(tx: DbClient, tenantId: string, y: number, m: number): Promise<number[]> {
  // Anchor the month window to AR midnight so bookings in the AR
  // 21:00–24:00 edge of the first/last day aren't pulled from the
  // wrong calendar month (UTC host is +3h ahead of AR).
  const mm = String(m + 1).padStart(2, "0");
  const start = new Date(localToARIso(`${y}-${mm}-01T00:00:00`));
  const nextY = m === 11 ? y + 1 : y;
  const nextMM = String(m === 11 ? 1 : m + 2).padStart(2, "0");
  const end = new Date(localToARIso(`${nextY}-${nextMM}-01T00:00:00`));
  const rows = await tx.booking.findMany({
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
}

function isValidMonth(year: unknown, monthIndex0: unknown): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(monthIndex0) &&
    (year as number) >= 2000 &&
    (year as number) <= 2100 &&
    (monthIndex0 as number) >= 0 &&
    (monthIndex0 as number) <= 11
  );
}

export async function getMonthBookingDays(
  year: number,
  monthIndex0: number
): Promise<number[]> {
  const actor = await getActor();
  // HD-3: es una action (llamable con cualquier valor por RPC) y la clave de cache lleva `String(year)` /
  // `String(monthIndex0)`: sin validar, cada valor basura abría un slot nuevo por tenant y un mes fuera de rango
  // llegaba a Prisma como `Invalid Date`. Se valida ANTES de armar `unstable_cache`: entrada inválida → `[]` sin clave.
  if (!isValidMonth(year, monthIndex0)) return [];
  const fetcher = unstable_cache(
    async (tenantId: string, y: number, m: number): Promise<number[]> =>
      runWithRls(tenantId, (tx) => bookingDaysInTx(tx, tenantId, y, m)),
    ["booking-days", actor.tenantId, String(year), String(monthIndex0)],
    { tags: [tags.bookingDays(actor.tenantId)], revalidate: ttl.micro }
  );
  return fetcher(actor.tenantId, year, monthIndex0);
}
