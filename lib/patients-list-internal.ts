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
 *      futuros no cancelados; «Última visita» = `MAX(scheduledFor)` de turnos pasados no cancelados, ausentes ni PENDING
 *      (CF2 D-CF2-15, todos los verticales). La clave de «Última visita» vale en filas `full` y `admin` (las basic no
 *      la muestran);
 *   5. `totals` sobre las filas visibles; 6. recorte; 7. hidratación de ≤ 50 ids: los hechos de turnos por paciente ×
 *      profesional (`bookingFactsByPatient`, 1 `$queryRaw`: próximo turno, última visita, profesionales recientes) y la
 *      cobertura vigente. Los planes y sesiones SOLO en `mode: "all"` (el CSV usa «Plan activo»): CF2 decisión 3, el
 *      plan salió de la página.
 * Presupuesto (`tests/perf/plans.perf.test.ts`, `BUDGET.listPatients = 9`): HD-10 dejó 10 (fase 1 + acceso + próximo
 * turno + cobertura + planes + sesiones); CF2 cambia próximo turno por los hechos agregados y saca planes y sesiones de
 * la página → 8 en el orden por apellido y 9 con «Próximo turno» / «Última visita» (la clave tenant-wide).
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
  PATIENT_LAST_VISIT_EXCLUDED_STATUSES,
  clampPatientsPage,
  directoryTotalsAll,
  dobBoundsForAge,
  foldPatientBookingFacts,
  isDirectoryVisible,
  lastVisitBookingWhere,
  normalizeAgeBound,
  normalizeDirectoryQuery,
  parseLastVisitBound,
  patientActivity,
  patientPractitionerIds,
  sortByDateKey,
  type DirectoryRowAccess,
  type PatientBookingFactRow,
  type PatientBookingFacts,
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

  // «Última visita desde/hasta»: pacientes con al menos un turno PASADO no cancelado, ausente ni PENDING en la ventana (CF2
  // D-CF2-15: el mismo criterio que la columna y el orden; antes exigía COMPLETED y un consultorio que nunca marca
  // «Atendido» no encontraba a nadie). HD-14: las puntas son 00:00 y 23:59:59.999 AR (antes `new Date("…T00:00:00")`
  // en el TZ del host). `bookings` es la relación del paciente, ya acotado por `where.tenantId`; el turno también lleva
  // su `tenantId` (INT-P): la FK `Booking.patientId` no mira el tenant y en prod (BYPASSRLS) un turno de otro
  // consultorio que apunte al paciente lo haría entrar, igual que el agregado de la columna (`[CF2-PS1-5]`).
  const lvFrom = parseLastVisitBound(opts.lastVisitFrom, "from");
  const lvTo = parseLastVisitBound(opts.lastVisitTo, "to");
  const lastVisitWhere: Prisma.PatientWhereInput =
    lvFrom || lvTo ? { bookings: { some: { tenantId: actor.tenantId, ...lastVisitBookingWhere(now, lvFrom, lvTo) } } } : {};

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
    // S32: «Con plan» / «Sin plan» (plan ACTIVE y vivo, `liveProgramWhere`). CF2 (decisión 3): las pastillas salieron
    // y `/pacientes` normaliza `?filter=` a `all | archived`; queda acá por compatibilidad con un llamador RPC viejo
    // (sigue siendo filtro clínico: solo filas `full`).
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
    // Los escalares de la proyección vienen acá (no se relee Patient para la página: era la sentencia 11). La cobertura
    // vigente solo con `?os=` (la visibilidad la necesita para todas las filas; sin `?os=` se lee solo para la página).
    // CF2: sale el conteo de planes activos (`_count.programs`, era para los pills «Con/Sin plan») y entra el a cargo.
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
        assignedPractitionerId: true,
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
    let lastSeenAll: Map<string, Date> | null = null;
    if (visible.length > 0 && sort === "upcoming.asc") {
      upcomingAll = await upcomingByPatient(tx, actor.tenantId, now);
    }
    // «Última visita» ordena filas `full` y `admin` (las dos la ven, D-CF2-15): sin ninguna (kine con todo en básico)
    // no se agrega nada y queda el orden SQL.
    if (sort === "lastVisit.desc" && visible.some((p) => accessOf(p.id) !== "basic")) {
      lastSeenAll = await lastSeenByPatient(tx, actor.tenantId, now);
    }

    let ordered = visible;
    if (upcomingAll) {
      const m = upcomingAll;
      ordered = sortByDateKey(visible, (p) => m.get(p.id), "asc");
    } else if (lastSeenAll) {
      const m = lastSeenAll;
      // Una fila basic no muestra la última visita: ordenar por ella la delataba (va al final, en el orden SQL).
      ordered = sortByDateKey(visible, (p) => (accessOf(p.id) === "basic" ? null : m.get(p.id)), "desc");
    }

    // ── 5. Totales sobre las visibles · 6. recorte ────────────────────────────
    const totals = directoryTotalsAll(visible);
    const total = visible.length;
    const { page, pageCount, start } =
      mode === "all"
        ? { page: 1, pageCount: 1, start: 0 }
        : clampPatientsPage(total, opts.page, PATIENTS_PAGE_SIZE);
    const slice = mode === "all" ? ordered : ordered.slice(start, start + PATIENTS_PAGE_SIZE);
    if (slice.length === 0) return { rows: [], total, totals, page, pageCount };

    // ── 7. Hidratación de la página ───────────────────────────────────────────
    // Lo que la proyección de cada fila muestra: los hechos de turnos (todas las filas: el próximo turno y los
    // profesionales se ven también en basic), la cobertura para full/admin (basic sale con `obraSocial: null`) y,
    // solo en el export (`mode: "all"`), planes y sesiones de las filas full.
    const pageIds = slice.map((p) => p.id);
    const fullIds = pageIds.filter((id) => accessOf(id) === "full");
    const coverageIds = insurerKey ? [] : pageIds.filter((id) => accessOf(id) !== "basic");
    const withPlans = mode === "all" && plansOn && fullIds.length > 0;
    const [factRows, coverages, programs, sessionAgg] = await Promise.all([
      bookingFactsByPatient(tx, actor.tenantId, now, pageIds),
      coverageIds.length > 0
        ? tx.coverage.findMany({
            // Coverage no tiene `tenantId`: `patientId` sale de la fase 1 (ya acotada al tenant) y además se exige por
            // la relación (en prod la conexión es BYPASSRLS).
            where: { patientId: { in: coverageIds }, patient: { tenantId: actor.tenantId } },
            orderBy: { id: "desc" },
            select: coverageSelect.select,
          })
        : Promise.resolve([] as CoverageLite[]),
      withPlans
        ? tx.treatmentProgram.findMany({
            where: { tenantId: actor.tenantId, patientId: { in: fullIds }, ...activeLiveProgramWhere },
            orderBy: programOrder,
            select: programChipSelect,
          })
        : Promise.resolve([] as ProgramChip[]),
      // S32: sesiones por plan activo, en una sola consulta agregada (sin N+1).
      withPlans
        ? sessionAggByProgram(tx, { tenantId: actor.tenantId, patientId: { in: fullIds }, ...activeLiveProgramWhere })
        : Promise.resolve(new Map<string, SessionAgg>()),
    ]);
    const facts = foldPatientBookingFacts(factRows, now);
    const NO_FACTS: PatientBookingFacts = { nextAt: null, lastVisitAt: null, recentPractitionerIds: [], upcomingPractitionerIds: [] };
    const archivedView = filter === "archived";

    const coverageOf = new Map<string, CoverageLite>();
    if (insurerKey) {
      for (const p of slice) {
        const c = currentCoverageOf(p);
        if (c) coverageOf.set(p.id, c);
      }
    } else {
      for (const c of coverages) if (!coverageOf.has(c.patientId)) coverageOf.set(c.patientId, c);
    }
    const programsByPatient = groupPrograms(programs);

    const rows = slice.map((p): PatientRow => {
      const access = accessOf(p.id);
      const f = facts.get(p.id) ?? NO_FACTS;
      const upcomingAt = f.nextAt;
      // CF2 (decisión 2): el a cargo + los profesionales con turno próximo o del último mes. En las filas full/admin;
      // la basic lleva solo el a cargo + los del próximo turno (ZA-6, abajo): el kine en básico lo necesita para derivar,
      // pero «del último mes» era la última visita que esa fila oculta.
      const practitionerIds = patientPractitionerIds(p.assignedPractitionerId, f.recentPractitionerIds);
      // D-CF2-14/15: última visita y estado salen de los turnos (no de la HC), así que `full` y `admin` los ven.
      const lastVisit = f.lastVisitAt;
      const activity = patientActivity({ archivedView, nextAt: f.nextAt, lastVisitAt: f.lastVisitAt }, now);
      // PD-13: `admin` (rol sin clinical.read) no ve HC. T3c-1b (§23.5): lo que
      // la recepción necesita para llamar y cobrar (contacto, nacimiento, DNI,
      // obra social, próximo turno, lo mismo que `PatientAdminCore` en el
      // perfil) y NADA clínico: notas y planes quedan vacíos. CF2 (D-CF2-15):
      // la última visita y el estado sí (salen de la agenda, que la recepción
      // ya ve). La UI decide HC con `=== "full"`.
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
          lastVisit,
          upcomingAt,
          obraSocial: coverage?.insurerRef?.name ?? coverage?.insurer ?? "Particular",
          access: "admin",
          assignedPractitionerId: p.assignedPractitionerId,
          practitionerIds,
          activity,
        };
      }
      // Basic rows expose ONLY name + DNI + next booking (+ CF2: a cargo y los del próximo turno). Every other
      // field is nulled out so a basic-access kine can't even infer
      // medical history by glancing at the directory. D-CF2-15: sin última visita ni estado.
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
          assignedPractitionerId: p.assignedPractitionerId,
          // CF2-ZF3 (ZA-6): el a cargo + quienes tienen turno próximo; sin «visto en el último mes» (delataba la visita).
          practitionerIds: patientPractitionerIds(p.assignedPractitionerId, f.upcomingPractitionerIds),
          activity: null,
        };
      }
      // S32: un chip por plan activo y vivo (más reciente primero; P0-S02a: `id` desempata). Un plan sin sesiones
      // vivas no tiene fila en el `groupBy` → 0/0. CF2: solo en el export (`mode: "all"`); en la página quedan vacíos.
      const NO_SESSIONS: SessionAgg = { totalLive: 0, done: 0, lastDoneAt: null };
      const progs = programsByPatient.get(p.id) ?? [];
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
        // CF2 D-CF2-15: «Última visita» = último turno pasado no cancelado, ausente ni PENDING, también en Kine (antes era la
        // última sesión realizada de un plan activo: un paciente sin plan quedaba sin visita aunque viniera cada semana).
        lastVisit,
        upcomingAt,
        obraSocial: coverage?.insurerRef?.name ?? coverage?.insurer ?? "Particular",
        access: "full",
        assignedPractitionerId: p.assignedPractitionerId,
        practitionerIds,
        activity,
      };
    });
    return { rows, total, totals, page, pageCount };
  });
}

/**
 * Próximo turno (no cancelado, desde `now`) por paciente, para TODO el tenant: la clave del orden «Próximo turno». La
 * página lo lee de `bookingFactsByPatient` (mismo predicado que `nextAt`).
 */
async function upcomingByPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
): Promise<Map<string, Date>> {
  const agg = await tx.booking.groupBy({
    by: ["patientId"],
    where: {
      tenantId,
      patientId: { not: null },
      scheduledFor: { gte: now },
      status: { not: "CANCELLED" },
    },
    _min: { scheduledFor: true },
  });
  const out = new Map<string, Date>();
  for (const a of agg) if (a.patientId && a._min.scheduledFor) out.set(a.patientId, a._min.scheduledFor);
  return out;
}

/**
 * CF2 D-CF2-15: última visita (último turno pasado no cancelado, ausente ni PENDING) por paciente, para TODO el tenant: la clave
 * del orden «Última visita». Mismo predicado que el filtro (`lastVisitBookingWhere`) y que `lastSeenAt` de
 * `bookingFactsByPatient`.
 */
async function lastSeenByPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
): Promise<Map<string, Date>> {
  const agg = await tx.booking.groupBy({
    by: ["patientId"],
    where: { tenantId, patientId: { not: null }, ...lastVisitBookingWhere(now, undefined, undefined) },
    _max: { scheduledFor: true },
  });
  const out = new Map<string, Date>();
  for (const a of agg) if (a.patientId && a._max.scheduledFor) out.set(a.patientId, a._max.scheduledFor);
  return out;
}

/**
 * CF2 (P.1) · hechos de turnos por paciente × profesional en UN `$queryRaw` agrupado (el `groupBy` de Prisma no
 * expresa tres agregados con `FILTER` distintos en una sentencia: serían tres). Lo pliega `foldPatientBookingFacts`:
 *  - `nextAt` = MIN(scheduledFor) de turnos ≥ now no cancelados (el «Próximo turno» de siempre);
 *  - `lastCompletedAt` = MAX de COMPLETED (compatibilidad; ya no es la «última visita»);
 *  - `lastSeenAt` = MAX de turnos < now que no son CANCELLED, NO_SHOW ni PENDING (D-CF2-15; la lista sale de
 *    `PATIENT_LAST_VISIT_EXCLUDED_STATUSES`, la misma del filtro).
 * `tenantId` a mano: en prod la conexión es BYPASSRLS y la FK `Booking.patientId` no mira el tenant, así que un turno de
 * otro consultorio que apunte a un paciente de este no tiene que colarse (test `[CF2-PS1-5]`). `scheduledFor` es
 * `timestamp(3)` en UTC: el borde viaja como ISO y se lleva a la hora de pared UTC (molde de `lib/dashboard.ts`), sin
 * depender del TimeZone de la sesión. Sin `patientIds`: todo el tenant.
 */
export async function bookingFactsByPatient(
  tx: Prisma.TransactionClient,
  tenantId: string,
  now: Date,
  patientIds?: readonly string[],
): Promise<PatientBookingFactRow[]> {
  if (patientIds && patientIds.length === 0) return [];
  const $now = now.toISOString();
  const excluded = [...PATIENT_LAST_VISIT_EXCLUDED_STATUSES] as string[];
  const scope = patientIds
    ? Prisma.sql`AND b."patientId" = ANY(${[...patientIds]})`
    : Prisma.sql`AND b."patientId" IS NOT NULL`;
  return tx.$queryRaw<PatientBookingFactRow[]>`
    SELECT b."patientId", b."practitionerId",
      MIN(b."scheduledFor") FILTER (
        WHERE b."scheduledFor" >= (${$now}::timestamptz AT TIME ZONE 'UTC') AND b."status" <> 'CANCELLED'
      ) AS "nextAt",
      MAX(b."scheduledFor") FILTER (WHERE b."status" = 'COMPLETED') AS "lastCompletedAt",
      MAX(b."scheduledFor") FILTER (
        WHERE b."scheduledFor" < (${$now}::timestamptz AT TIME ZONE 'UTC')
          AND NOT (b."status"::text = ANY(${excluded}::text[]))
      ) AS "lastSeenAt"
    FROM "Booking" b
    WHERE b."tenantId" = ${tenantId} ${scope}
    GROUP BY b."patientId", b."practitionerId"`;
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
