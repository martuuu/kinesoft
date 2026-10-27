/**
 * HD-10 (PV §27) · el directorio de pacientes (`/pacientes`) paginado, y la vía SIN paginar del export.
 *
 * Por qué existe: `listPatients` traía e hidrataba el directorio entero en cada request (con 1.000 pacientes, 1.000
 * filas con cobertura, próximo turno y planes) para mostrar todo en una sola página. Ahora va en dos fases dentro de
 * UNA `runWithRls`:
 *   1. consulta liviana sobre TODOS los matches del `where` (los escalares de la proyección, el conteo de planes
 *      activos con `planes` y la cobertura vigente solo con `?os=`), ordenada como antes + `id`;
 *   2. acceso en lote (`bulkPatientAccess` con el mismo `tx`);
 *   3. visibilidad (`isDirectoryVisible`, movido tal cual a `lib/patients-list-logic.ts`);
 *   4. las claves de orden que dependen de filas relacionadas, SOLO si el orden las pide, agregadas para todo el
 *      tenant con un `groupBy` (sin N+1 ni un IN de todos los ids): «Próximo turno» = `MIN(scheduledFor)` de turnos
 *      futuros no cancelados; «Última visita» = `MAX(completedAt)` de sesiones vivas de planes activos (Kine) o
 *      `MAX(scheduledFor)` de turnos COMPLETED (General). La clave de «Última visita» solo vale en filas `full`;
 *   5. `totals` sobre las filas visibles; 6. recorte; 7. hidratación de ≤ 50 ids (próximo turno, cobertura vigente,
 *      planes y sesiones), reusando lo que el orden ya agregó para el tenant.
 * Presupuesto (`tests/perf/plans.perf.test.ts`, `BUDGET.listPatients = 10`): con la hidratación literal del brief
 * (`patient.findMany` + `baseInclude` + `programsInclude` sobre la página) eran 11 sentencias; los escalares van en la
 * fase 1 y la hidratación lee directo de Booking/Coverage/TreatmentProgram (sin releer Patient) → 10.
 *
 * `server-only` y no en `lib/patients.ts` ("use server"): una export de ahí es un endpoint RPC, y la vía sin paginar
 * (`all`) no tiene que poder pedirla un cliente. El actor se resuelve ACÁ con `getActor()` (como siempre hizo
 * `listPatients`), así el export (`lib/patients-export-internal.ts`) aplica el mismo tenant y la misma visibilidad que
 * la página.
 */
import "server-only";
import { Prisma } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";
import { bulkPatientAccess } from "@/lib/visibility";
import { escapeLike } from "@/lib/email-match";
import { PARTICULAR_INSURER_KEY } from "@/lib/patients-os-filter";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  clampPatientsPage,
  directoryTotals,
  dobBoundsForAge,
  isDirectoryVisible,
  normalizeAgeBound,
  normalizeDirectoryQuery,
  parseLastVisitBound,
  sortByDateKey,
  type DirectoryRowAccess,
} from "@/lib/patients-list-logic";
import {
  PATIENTS_PAGE_SIZE,
  type ListPatientsOptions,
  type PatientListPlanChip,
  type PatientRow,
  type PatientsPage,
} from "@/lib/patients-types";

type SessionAgg = { totalLive: number; done: number; lastDoneAt: Date | null };
type ProgramChip = { id: string; title: string; discipline: PatientListPlanChip["discipline"]; patientId: string };
type CoverageLite = {
  patientId: string;
  insurer: string;
  insurerId: string | null;
  insurerRef: { name: string; isParticular: boolean } | null;
};

/**
 * El directorio para el actor de la sesión. `mode: "page"` (la página, `listPatients`) recorta a
 * `PATIENTS_PAGE_SIZE`; `mode: "all"` (solo el export CSV) devuelve todas las filas visibles en una sola "página".
 */
export async function listPatientsDirectory(
  opts: ListPatientsOptions = {},
  mode: "page" | "all" = "page",
): Promise<PatientsPage> {
  const actor = await getActor();
  const q = normalizeDirectoryQuery(opts.q);
  const sort = opts.sort ?? "lastName.asc";
  // EV1-B: el directorio se arma por módulos. Sin `planes` (consultorio
  // General) no hay plan que mostrar ni por el cual filtrar: "con plan / sin
  // plan" se ignora (cae a "todos") y no se consultan planes ni sesiones.
  // Sin `diagnostico`, `diagnosisSlug` se ignora igual. Se ignoran en vez de
  // tirar porque llegan por URL (un link viejo o compartido desde un Kine no
  // tiene que romper la página). Kine: sin cambios.
  const modules = modulesFor(actor.entitlements);
  const plansOn = modules.has("planes");
  const filter =
    !plansOn && (opts.filter === "active" || opts.filter === "no-program") ? "all" : opts.filter;
  const diagnosisSlug = modules.has("diagnostico") ? opts.diagnosisSlug : undefined;
  // Sprint 16: directory shows EVERY patient of the tenant; per-row
  // access (full vs basic) is resolved below via `bulkPatientAccess`
  // and PHI fields are masked accordingly for basic rows.

  // HD-14: la edad se cuenta sobre el día AR (`toARDateKey`), en UTC puro: antes `now.getFullYear()/getDate()` del
  // host (UTC en Vercel) adelantaba el cumpleaños desde las 21:00 AR. Edad acotada a 0..130 (llega por URL).
  const now = new Date();
  const ageMin = normalizeAgeBound(opts.ageMin);
  const ageMax = normalizeAgeBound(opts.ageMax);
  const dob = dobBoundsForAge(toARDateKey(now), ageMin, ageMax);
  const dobWhere: Prisma.PatientWhereInput = dob ? { dateOfBirth: dob } : {};

  // Last-visit range — patients with at least one COMPLETED booking
  // whose scheduledFor falls in the window. HD-14: las puntas son 00:00 y
  // 23:59:59.999 AR (antes `new Date("…T00:00:00")` en el TZ del host).
  const lvFrom = parseLastVisitBound(opts.lastVisitFrom, "from");
  const lvTo = parseLastVisitBound(opts.lastVisitTo, "to");
  const lastVisitWhere: Prisma.PatientWhereInput =
    lvFrom || lvTo
      ? {
          bookings: {
            some: {
              status: "COMPLETED",
              scheduledFor: {
                ...(lvFrom ? { gte: lvFrom } : {}),
                ...(lvTo ? { lte: lvTo } : {}),
              },
            },
          },
        }
      : {};

  // Diagnosis filter — patient has a clinical case whose top-rank
  // diagnosis matches the given condition slug. We use `some` on the
  // chain so the SQL stays one tractable subquery.
  const diagnosisWhere: Prisma.PatientWhereInput = diagnosisSlug
    ? {
        programs: {
          some: {
            case: {
              diagnoses: {
                some: { condition: { slug: diagnosisSlug } },
              },
            },
          },
        },
      }
    : {};

  // EV1-B: Prisma 5 NO escapa `contains`: arma `ILIKE '%' || $1 || '%'` con el
  // valor crudo (medido contra el Docker: `contains: "%"` → param `"%%%"`), así
  // que buscar «%» traía todo el directorio y «_» matcheaba cualquier carácter.
  // Se escapa con `escapeLike` (backslash es el escape default de ILIKE en PG).
  // El post-filtro de filas basic (`isDirectoryVisible`) usa `includes` sobre
  // `q` crudo: ahí no hay comodines. HD-10: `q` ≤ 100 caracteres.
  const qLike = q ? escapeLike(q) : undefined;
  const insurerKey = opts.insurerKey?.trim() || undefined;
  // T3e-2p: en SQL, un pre-filtro amplio sobre CUALQUIER cobertura (Prisma no expresa "la más reciente" en un
  // `where`); el exacto sobre la vigente va en JS (`isDirectoryVisible` → `matchesInsurerKey`). «Particular» = sin
  // cobertura, texto libre (`insurerId` null: el turno cobra como particular, `resolveBookingCopagoCents`) o la fila
  // `isParticular`. El id no se valida contra el catálogo: `where.tenantId` ya acota los pacientes y un id ajeno no
  // matchea a nadie.
  const insurerWhere: Prisma.PatientWhereInput = !insurerKey
    ? {}
    : insurerKey === PARTICULAR_INSURER_KEY
      ? {
          OR: [
            { coverages: { none: {} } },
            { coverages: { some: { insurerId: null } } },
            { coverages: { some: { insurerRef: { isParticular: true } } } },
          ],
        }
      : { coverages: { some: { insurerId: insurerKey } } };

  const activeLiveProgramWhere = { ...liveProgramWhere, status: "ACTIVE" } satisfies Prisma.TreatmentProgramWhereInput;

  const where: Prisma.PatientWhereInput = {
    tenantId: actor.tenantId,
    ...(filter === "archived" ? { archivedAt: { not: null } } : { archivedAt: null }),
    ...(qLike
      ? {
          OR: [
            { firstName: { contains: qLike, mode: "insensitive" } },
            { lastName: { contains: qLike, mode: "insensitive" } },
            { email: { contains: qLike, mode: "insensitive" } },
            { documentId: { contains: qLike, mode: "insensitive" } },
          ],
        }
      : {}),
    // S32: «Con plan» / «Sin plan» con el MISMO predicado que la columna y el
    // contador del pill (plan ACTIVE y vivo, `liveProgramWhere`).
    ...(filter === "active"
      ? { programs: { some: activeLiveProgramWhere } }
      : filter === "no-program"
        ? { programs: { none: activeLiveProgramWhere } }
        : {}),
    // `AND` y no spread: `insurerWhere` de «Particular» es un `OR` y pisaría el de `q`.
    AND: [insurerWhere],
    ...dobWhere,
    ...lastVisitWhere,
    ...diagnosisWhere,
  };

  // Orden SQL de siempre + `id` (HD-10: con páginas, dos filas con el mismo apellido y nombre no pueden cambiar de
  // lugar entre requests y aparecer en dos páginas o en ninguna). «Próximo turno» / «Última visita» se ordenan en
  // memoria sobre este orden (sort estable).
  const orderBy: Prisma.PatientOrderByWithRelationInput[] = [
    ...(sort === "lastName.asc"
      ? [{ lastName: "asc" as const }, { firstName: "asc" as const }]
      : sort === "lastName.desc"
        ? [{ lastName: "desc" as const }, { firstName: "desc" as const }]
        : sort === "createdAt.desc"
          ? [{ createdAt: "desc" as const }]
          : sort === "createdAt.asc"
            ? [{ createdAt: "asc" as const }]
            : [{ lastName: "asc" as const }]),
    { id: "asc" },
  ];

  // Cobertura vigente = la de id mayor (mismo orden que la columna «Obra social» y que `?os=`).
  const coverageSelect = {
    orderBy: { id: "desc" },
    take: 1,
    select: { patientId: true, insurer: true, insurerId: true, insurerRef: { select: { name: true, isParticular: true } } },
  } satisfies Prisma.Patient$coveragesArgs;
  const programOrder: Prisma.TreatmentProgramOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  const programChipSelect = { id: true, title: true, discipline: true, patientId: true } as const;

  return runWithRls(actor.tenantId, async (tx) => {
    // ── 1. Fase liviana sobre TODOS los matches ───────────────────────────────
    // Los escalares de la proyección vienen acá (no se relee Patient para la página: era la sentencia 11). El conteo
    // de planes activos y vivos es un subselect de la misma sentencia; la cobertura vigente solo con `?os=` (la
    // visibilidad la necesita para todas las filas; sin `?os=` se lee solo para la página).
    const light = await tx.patient.findMany({
      where,
      orderBy,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        documentId: true,
        createdAt: true,
        email: true,
        phone: true,
        dateOfBirth: true,
        notes: true,
        _count: plansOn ? { select: { programs: { where: activeLiveProgramWhere } } } : undefined,
        coverages: insurerKey ? coverageSelect : undefined,
      },
    });

    // ── 2. Acceso en lote, con el mismo tx ────────────────────────────────────
    const accessMap = await bulkPatientAccess(actor, light.map((r) => r.id), tx);
    const accessOf = (id: string): DirectoryRowAccess => accessMap.get(id) ?? "basic";

    // ── 3. Visibilidad (P0.Z H-b1 + T3e-2p; ver `isDirectoryVisible`) ─────────
    const clinicalFilter = Boolean(diagnosisSlug) || filter === "active" || filter === "no-program";
    const maskedFilter = Boolean(insurerKey) || ageMin != null || ageMax != null || Boolean(lvFrom || lvTo);
    const qLower = q?.toLowerCase();
    const visible = light.filter((p) =>
      isDirectoryVisible(
        {
          firstName: p.firstName,
          lastName: p.lastName,
          documentId: p.documentId,
          currentCoverage: currentCoverageOf(p),
        },
        accessMap.get(p.id),
        { insurerKey, clinicalFilter, maskedFilter, qLower },
      ),
    );

    // ── 4. Claves de orden agregadas para el tenant (solo si el orden las pide) ─
    let upcomingAll: Map<string, Date> | null = null;
    let lastCompletedAll: Map<string, Date> | null = null;
    let programsAll: ProgramChip[] | null = null;
    let sessionAggAll: Map<string, SessionAgg> | null = null;
    if (visible.length > 0 && sort === "upcoming.asc") {
      upcomingAll = await upcomingByPatient(tx, actor.tenantId, now);
    }
    // «Última visita» solo ordena filas `full`: sin ninguna visible (Secretaría, kine en básico) no se agrega nada y
    // queda el orden SQL.
    if (sort === "lastVisit.desc" && visible.some((p) => accessOf(p.id) === "full")) {
      if (plansOn) {
        // Kine: última sesión viva realizada de CUALQUIER plan activo y vivo. Los planes activos del tenant (para el
        // mapa programa → paciente) y el agregado de sesiones por plan: con esto la página no vuelve a consultar ni
        // planes ni sesiones. `_max(completedAt)` ignora NULL: es la última realizada.
        const [programs, agg] = await Promise.all([
          tx.treatmentProgram.findMany({
            where: { tenantId: actor.tenantId, ...activeLiveProgramWhere },
            orderBy: programOrder,
            select: programChipSelect,
          }),
          sessionAggByProgram(tx, { tenantId: actor.tenantId, ...activeLiveProgramWhere }),
        ]);
        programsAll = programs;
        sessionAggAll = agg;
      } else {
        lastCompletedAll = await lastCompletedByPatient(tx, actor.tenantId);
      }
    }
    const lastVisitOfPatient = (id: string, programs: ProgramChip[], agg: Map<string, SessionAgg>, lastCompleted: Map<string, Date>) => {
      if (!plansOn) return lastCompleted.get(id) ?? null;
      let lastDone: Date | null = null;
      for (const pr of programs) {
        const at = agg.get(pr.id)?.lastDoneAt ?? null;
        if (at && (!lastDone || at > lastDone)) lastDone = at;
      }
      return lastDone;
    };
    const programsByPatientAll = programsAll ? groupPrograms(programsAll) : null;

    let ordered = visible;
    if (upcomingAll) {
      const m = upcomingAll;
      ordered = sortByDateKey(visible, (p) => m.get(p.id), "asc");
    } else if (sort === "lastVisit.desc" && (programsByPatientAll || lastCompletedAll)) {
      const progs = programsByPatientAll ?? new Map<string, ProgramChip[]>();
      const agg = sessionAggAll ?? new Map<string, SessionAgg>();
      const last = lastCompletedAll ?? new Map<string, Date>();
      // Solo filas `full`: una basic/admin no muestra la última visita, y ordenar por ella la delataba.
      ordered = sortByDateKey(
        visible,
        (p) => (accessOf(p.id) === "full" ? lastVisitOfPatient(p.id, progs.get(p.id) ?? [], agg, last) : null),
        "desc",
      );
    }

    // ── 5. Totales sobre las visibles · 6. recorte ────────────────────────────
    const totals = directoryTotals(
      visible.map((p) => ({ access: accessOf(p.id), activePlanCount: p._count?.programs ?? 0 })),
      plansOn,
    );
    const total = visible.length;
    const { page, pageCount, start } =
      mode === "all"
        ? { page: 1, pageCount: 1, start: 0 }
        : clampPatientsPage(total, opts.page, PATIENTS_PAGE_SIZE);
    const slice = mode === "all" ? ordered : ordered.slice(start, start + PATIENTS_PAGE_SIZE);
    if (slice.length === 0) return { rows: [], total, totals, page, pageCount };

    // ── 7. Hidratación de la página ───────────────────────────────────────────
    // Solo lo que la proyección de cada fila muestra: cobertura para full/admin (basic sale con `obraSocial: null`),
    // planes, sesiones y última visita para full. Lo que el orden ya agregó para el tenant se reusa.
    const pageIds = slice.map((p) => p.id);
    const fullIds = pageIds.filter((id) => accessOf(id) === "full");
    const coverageIds = insurerKey ? [] : pageIds.filter((id) => accessOf(id) !== "basic");
    const [upcoming, coverages, programs, sessionAgg, lastCompleted] = await Promise.all([
      upcomingAll ?? upcomingByPatient(tx, actor.tenantId, now, pageIds),
      coverageIds.length > 0
        ? tx.coverage.findMany({
            // Coverage no tiene `tenantId`: `patientId` sale de la fase 1 (ya acotada al tenant) y además se exige por
            // la relación (en prod la conexión es BYPASSRLS).
            where: { patientId: { in: coverageIds }, patient: { tenantId: actor.tenantId } },
            orderBy: { id: "desc" },
            select: coverageSelect.select,
          })
        : Promise.resolve([] as CoverageLite[]),
      !plansOn || fullIds.length === 0
        ? Promise.resolve([] as ProgramChip[])
        : programsAll
          ? Promise.resolve(programsAll)
          : tx.treatmentProgram.findMany({
              where: { tenantId: actor.tenantId, patientId: { in: fullIds }, ...activeLiveProgramWhere },
              orderBy: programOrder,
              select: programChipSelect,
            }),
      // S32: sesiones por plan activo de la página, en una sola consulta agregada (sin N+1).
      !plansOn || fullIds.length === 0
        ? Promise.resolve(new Map<string, SessionAgg>())
        : sessionAggAll
          ? Promise.resolve(sessionAggAll)
          : sessionAggByProgram(tx, { tenantId: actor.tenantId, patientId: { in: fullIds }, ...activeLiveProgramWhere }),
      // EV1-B: sin `planes`, «última visita» = último turno COMPLETED (la misma definición que el filtro).
      plansOn || fullIds.length === 0
        ? Promise.resolve(new Map<string, Date>())
        : lastCompletedAll
          ? Promise.resolve(lastCompletedAll)
          : lastCompletedByPatient(tx, actor.tenantId, fullIds),
    ]);

    const coverageOf = new Map<string, CoverageLite>();
    if (insurerKey) {
      for (const p of slice) {
        const c = currentCoverageOf(p);
        if (c) coverageOf.set(p.id, c);
      }
    } else {
      for (const c of coverages) if (!coverageOf.has(c.patientId)) coverageOf.set(c.patientId, c);
    }
    const programsByPatient = programsByPatientAll ?? groupPrograms(programs);

    const rows = slice.map((p): PatientRow => {
      const access = accessOf(p.id);
      const upcomingAt = upcoming.get(p.id) ?? null;
      // PD-13: `admin` (rol sin clinical.read) no ve HC. T3c-1b (§23.5): lo que
      // la recepción necesita para llamar y cobrar (contacto, nacimiento, DNI,
      // obra social, próximo turno, lo mismo que `PatientAdminCore` en el
      // perfil) y NADA clínico: notas, planes y última visita quedan vacíos. La
      // UI decide HC con `=== "full"`.
      if (access === "admin") {
        const coverage = coverageOf.get(p.id);
        return {
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          phone: p.phone,
          documentId: p.documentId,
          dateOfBirth: p.dateOfBirth,
          notes: null,
          createdAt: p.createdAt,
          activeProgramTitle: null,
          sessionsTotal: 0,
          sessionsDone: 0,
          activePlans: [],
          lastVisit: null,
          upcomingAt,
          obraSocial: coverage?.insurerRef?.name ?? coverage?.insurer ?? "Particular",
          access: "admin",
        };
      }
      // Basic rows expose ONLY name + DNI + next booking. Every other
      // field is nulled out so a basic-access kine can't even infer
      // medical history by glancing at the directory.
      if (access !== "full") {
        return {
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: null,
          phone: null,
          documentId: p.documentId,
          dateOfBirth: null,
          notes: null,
          createdAt: p.createdAt,
          activeProgramTitle: null,
          sessionsTotal: 0,
          sessionsDone: 0,
          activePlans: [],
          lastVisit: null,
          upcomingAt,
          obraSocial: null,
          access: "basic",
        };
      }
      // S32: un chip por plan activo y vivo (más reciente primero; P0-S02a: `id` desempata). Un plan sin sesiones
      // vivas no tiene fila en el `groupBy` → 0/0.
      const NO_SESSIONS: SessionAgg = { totalLive: 0, done: 0, lastDoneAt: null };
      const progs = plansOn ? (programsByPatient.get(p.id) ?? []) : [];
      const activePlans: PatientListPlanChip[] = progs.map((pr) => {
        const a = sessionAgg.get(pr.id) ?? NO_SESSIONS;
        return { discipline: pr.discipline, done: a.done, totalLive: a.totalLive };
      });
      const prog = progs[0];
      const progAgg = prog ? (sessionAgg.get(prog.id) ?? NO_SESSIONS) : NO_SESSIONS;
      const coverage = coverageOf.get(p.id);
      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        documentId: p.documentId,
        dateOfBirth: p.dateOfBirth,
        notes: p.notes,
        createdAt: p.createdAt,
        activeProgramTitle: prog?.title ?? null,
        sessionsTotal: progAgg.totalLive,
        sessionsDone: progAgg.done,
        activePlans,
        // «Última visita» (Kine) = la última sesión viva realizada de CUALQUIER plan activo.
        lastVisit: lastVisitOfPatient(p.id, progs, sessionAgg, lastCompleted),
        upcomingAt,
        obraSocial: coverage?.insurerRef?.name ?? coverage?.insurer ?? "Particular",
        access: "full",
      };
    });
    return { rows, total, totals, page, pageCount };
  });
}

/**
 * Próximo turno (no cancelado, desde `now`) por paciente. Sin `patientIds`: todo el tenant (clave de orden); con
 * `patientIds`: solo la página.
 */
async function upcomingByPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
  patientIds?: string[],
): Promise<Map<string, Date>> {
  const agg = await tx.booking.groupBy({
    by: ["patientId"],
    where: {
      tenantId,
      ...(patientIds ? { patientId: { in: patientIds } } : {}),
      scheduledFor: { gte: now },
      status: { not: "CANCELLED" },
    },
    _min: { scheduledFor: true },
  });
  const out = new Map<string, Date>();
  for (const a of agg) if (a.patientId && a._min.scheduledFor) out.set(a.patientId, a._min.scheduledFor);
  return out;
}

/** Último turno COMPLETED por paciente (General). Sin `patientIds`: todo el tenant. */
async function lastCompletedByPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  patientIds?: string[],
): Promise<Map<string, Date>> {
  const agg = await tx.booking.groupBy({
    by: ["patientId"],
    where: { tenantId, ...(patientIds ? { patientId: { in: patientIds } } : {}), status: "COMPLETED" },
    _max: { scheduledFor: true },
  });
  const out = new Map<string, Date>();
  for (const a of agg) if (a.patientId && a._max.scheduledFor) out.set(a.patientId, a._max.scheduledFor);
  return out;
}

/**
 * S32: sesiones vivas / realizadas / última realizada por plan, en UNA consulta agregada (`GROUP BY programId`): sin
 * N+1 y sin traer filas de Session. `_count.completedAt` = COUNT(columna), que no cuenta NULL → realizadas;
 * `_max(completedAt)` ignora NULL → la última realizada. El tenant va por `program` (Session no tiene `tenantId`; en
 * prod la conexión es BYPASSRLS).
 */
async function sessionAggByProgram(
  tx: Prisma.TransactionClient,
  program: Prisma.TreatmentProgramWhereInput,
): Promise<Map<string, SessionAgg>> {
  const agg = await tx.session.groupBy({
    by: ["programId"],
    where: { ...liveSessionWhere, program },
    _count: { _all: true, completedAt: true },
    _max: { completedAt: true },
  });
  const out = new Map<string, SessionAgg>();
  for (const a of agg) {
    out.set(a.programId, { totalLive: a._count._all, done: a._count.completedAt, lastDoneAt: a._max.completedAt });
  }
  return out;
}

/**
 * La cobertura vigente que trajo la fase 1. Solo viene con `?os=`: el select es condicional y el tipo de Prisma no
 * sigue un `select` que depende de un valor en runtime (sin `?os=` el campo no está y esto da `undefined`).
 */
function currentCoverageOf(p: { coverages?: unknown }): CoverageLite | undefined {
  return (p.coverages as CoverageLite[] | undefined)?.[0];
}

/** Planes por paciente, conservando el orden de la consulta (más reciente primero). */
function groupPrograms(programs: ProgramChip[]): Map<string, ProgramChip[]> {
  const out = new Map<string, ProgramChip[]>();
  for (const pr of programs) {
    const list = out.get(pr.patientId);
    if (list) list.push(pr);
    else out.set(pr.patientId, [pr]);
  }
  return out;
}
