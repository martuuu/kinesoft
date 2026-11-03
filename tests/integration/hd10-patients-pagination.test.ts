/**
 * HD-10 / HD-14 (PV §27) · `/pacientes` paginado (`?page=`, 50 por página) y edad / «última visita» en hora AR.
 *
 * Contrato (brief PV, HD-10): dos fases en UNA `runWithRls` — una consulta liviana sobre TODOS los matches, el acceso
 * en lote, el predicado de visibilidad, el orden (con las claves de «Próximo turno» / «Última visita» agregadas para
 * el tenant, sin N+1), `totals` sobre las filas visibles, el recorte y la hidratación de ≤ 50 ids. `page` se recorta a
 * `[1, pageCount]`. El export de pacientes sigue trayendo TODO (no pagina).
 *
 * Símbolo real (`listPatients`, `exportPatientsCsv`) contra el Docker; solo se mockea la sesión (y el reloj en los
 * casos de 23:30 AR, que corren con TZ=UTC como en Vercel).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listPatients } from "@/lib/patients";
import { exportPatientsCsv } from "@/lib/patients-export-internal";
import { getActor } from "@/lib/session";
import { PATIENTS_PAGE_SIZE, type PatientRow, type PatientsPage } from "@/lib/patients-types";
import {
  ownerClient,
  createEphemeralTenant,
  addInsurer,
  addPatient,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const N = 120;
const HOUR = 3_600_000;

/** Las filas de una respuesta (la página de HD-10; acepta el array de antes: así los casos de TZ fallaban por la fecha y no por la forma). */
const rowsOf = (r: PatientsPage | PatientRow[]): PatientRow[] => (Array.isArray(r) ? r : r.rows);
const ar = (local: string) => new Date(`${local}-03:00`);

describe.skipIf(!RUN)("HD-10 · /pacientes paginado", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let T2: EphemeralTenant;
  let sfx: string;
  /** `byIndex[i]` = id del paciente i (1..N); el apellido lleva el índice con ceros → orden alfabético = orden de i. */
  const byIndex: string[] = [];
  let osA: string;
  let condSlug: string;
  let sec: { userId: string };
  let otherKine: { userId: string };
  let ageA: string;
  let ageB: string;
  let lateVisit: string;

  const idx = (id: string) => byIndex.indexOf(id);
  const allPages = async (opts: Parameters<typeof listPatients>[0]) => {
    const first = (await listPatients({ ...opts, page: 1 })) as PatientsPage;
    const out = [...first.rows];
    for (let p = 2; p <= first.pageCount; p++) out.push(...((await listPatients({ ...opts, page: p })) as PatientsPage).rows);
    return { first, rows: out };
  };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    T2 = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    sfx = uniqueSuffix();

    await db.patient.createMany({
      data: Array.from({ length: N }, (_, k) => {
        const i = k + 1;
        return {
          tenantId: K.tenantId,
          firstName: "Hd",
          lastName: `Hd10 ${sfx} ${String(i).padStart(3, "0")}`,
          documentId: `HD10-${sfx}-${i}`,
          assignedPractitionerId: K.practitionerId,
        };
      }),
    });
    const created = await db.patient.findMany({
      where: { tenantId: K.tenantId },
      orderBy: { lastName: "asc" },
      select: { id: true },
    });
    expect(created).toHaveLength(N);
    byIndex.push("", ...created.map((p) => p.id));

    // «Próximo turno»: i % 3 === 0 tiene un turno futuro; cuanto más grande i, más temprano. i = 1 tiene uno
    // CANCELADO más temprano que todos (no cuenta).
    const base = new Date(Math.ceil((Date.now() + 2 * 24 * HOUR) / HOUR) * HOUR);
    const bookings = [];
    for (let i = 3; i <= N; i += 3) {
      bookings.push({
        tenantId: K.tenantId,
        patientId: byIndex[i],
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: new Date(base.getTime() + (N - i + 1) * HOUR),
        durationMin: 45,
        status: "CONFIRMED" as const,
        idempotencyKey: randomUUID(),
      });
    }
    bookings.push({
      tenantId: K.tenantId,
      patientId: byIndex[1],
      practitionerId: K.practitionerId,
      serviceId: K.serviceId,
      scheduledFor: base,
      durationMin: 45,
      status: "CANCELLED" as const,
      idempotencyKey: randomUUID(),
    });
    await db.booking.createMany({ data: bookings });

    // Planes: i % 4 === 1 tiene un plan ACTIVE con una sesión realizada; i = 2 uno COMPLETED. CF2 (D-CF2-15): la
    // «Última visita» ya no sale de las sesiones sino de los turnos (abajo); los planes quedan para el filtro clínico,
    // el diagnóstico y el export.
    const past = new Date(Math.floor((Date.now() - 24 * HOUR) / HOUR) * HOUR);
    const planned: { i: number; status: "ACTIVE" | "COMPLETED" }[] = [];
    for (let i = 1; i <= N; i += 4) planned.push({ i, status: "ACTIVE" });
    planned.push({ i: 2, status: "COMPLETED" });
    condSlug = `hd10-${sfx}`;
    const cond = await db.condition.create({ data: { slug: condSlug, name: `Cond HD10`, tenantId: K.tenantId } });
    const kase = await db.clinicalCase.create({
      data: { tenantId: K.tenantId, authorId: K.practitionerId, selectedZones: [], refinements: {}, patientId: byIndex[1] },
    });
    await db.diagnosis.create({ data: { caseId: kase.id, conditionId: cond.id, matchScore: 0.9, rank: 1 } });
    for (const { i, status } of planned) {
      const prog = await db.treatmentProgram.create({
        data: {
          tenantId: K.tenantId,
          patientId: byIndex[i],
          caseId: i === 1 ? kase.id : undefined,
          title: `Plan ${i}`,
          startDate: new Date("2026-01-05T12:00:00Z"),
          status,
        },
      });
      await db.session.createMany({
        data: [
          {
            programId: prog.id,
            practitionerId: K.practitionerId,
            index: 1,
            scheduledFor: new Date(past.getTime() - i * HOUR),
            completedAt: new Date(past.getTime() - i * HOUR),
          },
          { programId: prog.id, practitionerId: K.practitionerId, index: 2, scheduledFor: new Date(past.getTime() + 30 * 24 * HOUR) },
        ],
      });
    }

    // «Última visita» (CF2 D-CF2-15, todos los verticales): i % 4 === 1 tiene un turno PASADO CONFIRMED (nadie marcó
    // «Atendido»); cuanto más chico i, más reciente. i = 2 tiene un ausente más reciente que todos (no cuenta).
    const visits = [];
    for (let i = 1; i <= N; i += 4) {
      visits.push({
        tenantId: K.tenantId,
        patientId: byIndex[i],
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: new Date(past.getTime() - i * HOUR),
        durationMin: 45,
        status: "CONFIRMED" as const,
        idempotencyKey: randomUUID(),
      });
    }
    visits.push({
      tenantId: K.tenantId,
      patientId: byIndex[2],
      practitionerId: K.practitionerId,
      serviceId: K.serviceId,
      scheduledFor: new Date(past.getTime() + HOUR / 2),
      durationMin: 45,
      status: "NO_SHOW" as const,
      idempotencyKey: randomUUID(),
    });
    await db.booking.createMany({ data: visits });

    // `?os=`: los pares tienen OS A vigente; i % 10 === 1 tuvo OS A y hoy tiene OS B (el pre-filtro SQL los trae,
    // la cobertura vigente los saca). Ids explícitos: la vigente es la de id mayor (`orderBy id desc`).
    osA = await addInsurer(db, K, { name: `OS A ${sfx}` });
    const osB = await addInsurer(db, K, { name: `OS B ${sfx}` });
    const covs = [];
    for (let i = 1; i <= N; i++) {
      if (i % 2 === 0) covs.push({ id: `hd10-${sfx}-1-${i}`, patientId: byIndex[i], insurer: "OS A", insurerId: osA });
      if (i % 10 === 1) {
        covs.push({ id: `hd10-${sfx}-0-${i}`, patientId: byIndex[i], insurer: "OS A", insurerId: osA });
        covs.push({ id: `hd10-${sfx}-1-${i}`, patientId: byIndex[i], insurer: "OS B", insurerId: osB });
      }
    }
    await db.coverage.createMany({ data: covs });

    sec = await addStaff(db, K, "ASSISTANT");
    otherKine = await addPractitioner(db, K);

    // Tenant aparte para los bordes de 23:30 AR (no ensucian los 120).
    ageA = await addPatient(db, T2, { lastName: `Edad A ${sfx}` });
    ageB = await addPatient(db, T2, { lastName: `Edad B ${sfx}` });
    await db.patient.update({ where: { id: ageA }, data: { dateOfBirth: new Date("2000-10-28T00:00:00Z") } });
    await db.patient.update({ where: { id: ageB }, data: { dateOfBirth: new Date("2000-10-27T00:00:00Z") } });
    lateVisit = await addPatient(db, T2, { lastName: `Visita ${sfx}` });
    await db.booking.create({
      data: {
        tenantId: T2.tenantId,
        patientId: lateVisit,
        practitionerId: T2.practitionerId,
        serviceId: T2.serviceId,
        scheduledFor: ar("2026-03-10T22:30:00"),
        durationMin: 45,
        status: "COMPLETED",
        idempotencyKey: randomUUID(),
      },
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await K?.cleanup();
    await T2?.cleanup();
    await db?.$disconnect();
  });

  it("[HD-10] 120 pacientes: páginas de 50/50/20 sin duplicados ni huecos, en el orden de apellido", async () => {
    asUser(K.userId);
    const p1 = (await listPatients({ page: 1 })) as PatientsPage;
    const p2 = (await listPatients({ page: 2 })) as PatientsPage;
    const p3 = (await listPatients({ page: 3 })) as PatientsPage;
    expect(PATIENTS_PAGE_SIZE).toBe(50);
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([50, 50, 20]);
    expect(p1).toMatchObject({ total: N, page: 1, pageCount: 3 });
    expect(p3).toMatchObject({ total: N, page: 3, pageCount: 3 });
    const got = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(got).size).toBe(N);
    expect(got).toEqual(byIndex.slice(1));
    // `totals` sobre TODAS las visibles (no la página). CF2 (decisión 3): sin «con/sin plan».
    expect(p2.totals).toEqual({ all: N });
    // La página hidrata cobertura, próximo turno y última visita; el plan ya no (CF2: solo el export).
    const r1 = p1.rows.find((r) => r.id === byIndex[1])!;
    expect(r1.access).toBe("full");
    expect(r1.activePlans).toEqual([]);
    expect(r1.activeProgramTitle).toBeNull();
    expect(r1.obraSocial).toBe(`OS B ${sfx}`);
    expect(r1.lastVisit).not.toBeNull();
    expect(p1.rows.find((r) => r.id === byIndex[3])!.upcomingAt).not.toBeNull();
  });

  it("[HD-10] `page` fuera de rango se recorta a [1, pageCount]", async () => {
    asUser(K.userId);
    const hi = (await listPatients({ page: 99 })) as PatientsPage;
    expect(hi).toMatchObject({ page: 3, pageCount: 3, total: N });
    expect(hi.rows).toHaveLength(20);
    for (const raw of [0, -4, Number.NaN]) {
      const lo = (await listPatients({ page: raw })) as PatientsPage;
      expect(lo).toMatchObject({ page: 1, pageCount: 3 });
      expect(lo.rows[0].id).toBe(byIndex[1]);
    }
    // Sin resultados: una sola página vacía.
    const none = (await listPatients({ q: `no-existe-${sfx}`, page: 4 })) as PatientsPage;
    expect(none).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1, totals: { all: 0 } });
  });

  it("[HD-10] «Próximo turno»: las páginas concatenadas = el orden completo (null al final, estable)", async () => {
    asUser(K.userId);
    const { first, rows } = await allPages({ sort: "upcoming.asc" });
    expect(first.total).toBe(N);
    const withNext: string[] = [];
    for (let i = N; i >= 3; i--) if (i % 3 === 0) withNext.push(byIndex[i]);
    const rest = byIndex.slice(1).filter((id) => !withNext.includes(id));
    expect(rows.map((r) => r.id)).toEqual([...withNext, ...rest]);
    // El turno CANCELADO de i = 1 no cuenta.
    expect(rows.find((r) => r.id === byIndex[1])!.upcomingAt).toBeNull();
  });

  it("[HD-10] «Última visita» (Kine, CF2 D-CF2-15): las páginas concatenadas = el orden completo, sin ausentes", async () => {
    asUser(K.userId);
    const { rows } = await allPages({ sort: "lastVisit.desc" });
    const withLast: string[] = [];
    for (let i = 1; i <= N; i += 4) withLast.push(byIndex[i]);
    const rest = byIndex.slice(1).filter((id) => !withLast.includes(id));
    expect(rows.map((r) => r.id)).toEqual([...withLast, ...rest]);
    // i = 2: solo un ausente (y un plan COMPLETED con una sesión realizada) → sin última visita.
    expect(rows.find((r) => r.id === byIndex[2])!.lastVisit).toBeNull();
  });

  it("[HD-10] Secretaría (ASSISTANT): proyección `admin` en todas las páginas y `filter=active` vacío", async () => {
    asUser(sec.userId);
    const { first, rows } = await allPages({});
    expect(first).toMatchObject({ total: N, pageCount: 3 });
    expect(rows).toHaveLength(N);
    for (const r of rows) {
      expect(r.access).toBe("admin");
      expect(r.activePlans).toEqual([]);
      expect(r.notes).toBeNull();
      // CF2 (D-CF2-15): la última visita sale de la agenda, no de la HC: la Secretaria la ve.
      expect(r.lastVisit === null).toBe(idx(r.id) % 4 !== 1);
    }
    expect(rows.find((r) => r.id === byIndex[4])!.obraSocial).toBe(`OS A ${sfx}`);
    expect(rows.find((r) => r.id === byIndex[3])!.upcomingAt).not.toBeNull();
    // Sin HC: los filtros clínicos no le devuelven filas ni conteo (era un oráculo, P0.Z H-b1).
    for (const f of [{ filter: "active" as const }, { filter: "no-program" as const }, { diagnosisSlug: condSlug }]) {
      const r = (await listPatients(f)) as PatientsPage;
      expect(r).toMatchObject({ rows: [], total: 0, pageCount: 1 });
      expect(r.totals.all).toBe(0);
    }
    // CF2 (D-CF2-15): «Última visita» ordena igual que para el titular (mismo criterio para todos los roles).
    const lv = await allPages({ sort: "lastVisit.desc" });
    const withLast: string[] = [];
    for (let i = 1; i <= N; i += 4) withLast.push(byIndex[i]);
    expect(lv.rows.map((r) => r.id)).toEqual([...withLast, ...byIndex.slice(1).filter((id) => !withLast.includes(id))]);
  });

  it("[HD-10] kine en básico + diagnosisSlug: sin filas básicas ni conteo", async () => {
    asUser(otherKine.userId);
    const dx = (await listPatients({ diagnosisSlug: condSlug })) as PatientsPage;
    expect(dx).toMatchObject({ rows: [], total: 0, pageCount: 1 });
    expect(dx.totals).toEqual({ all: 0 });
    const all = (await listPatients({})) as PatientsPage;
    expect(all.total).toBe(N);
    expect(all.totals).toEqual({ all: N });
    expect(all.rows.every((r) => r.access === "basic" && r.obraSocial === null && r.lastVisit === null)).toBe(true);
    // Control: el kine a cargo (titular) sí filtra por diagnóstico.
    asUser(K.userId);
    const own = (await listPatients({ diagnosisSlug: condSlug })) as PatientsPage;
    expect(own.rows.map((r) => r.id)).toEqual([byIndex[1]]);
    expect(own.total).toBe(1);
  });

  it("[HD-10] `?os=` por cobertura VIGENTE entre páginas", async () => {
    asUser(K.userId);
    const { first, rows } = await allPages({ insurerKey: osA });
    const evens = byIndex.filter((_, i) => i > 0 && i % 2 === 0);
    expect(first).toMatchObject({ total: evens.length, pageCount: 2 });
    expect(first.rows).toHaveLength(50);
    expect(rows.map((r) => r.id)).toEqual(evens);
    expect(rows.some((r) => idx(r.id) % 10 === 1)).toBe(false);
  });

  it("[HD-10] el export sigue trayendo los 120 (no pagina)", async () => {
    asUser(K.userId);
    const csv = await exportPatientsCsv(await getActor(), {});
    const lines = csv.trim().split("\n").slice(1);
    expect(lines).toHaveLength(N);
    for (const id of byIndex.slice(1)) expect(csv).toContain(id);
    // CF2: el plan salió de la página pero el export lo sigue hidratando (`mode: "all"`).
    expect(lines.find((l) => l.includes(byIndex[1]))).toContain("Plan 1");
  });

  it("[HD-14] edad a las 23:30 AR con el host en UTC: quien cumple mañana todavía no tiene la edad nueva", async () => {
    asUser(T2.userId);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(ar("2026-10-27T23:30:00"));
      // A nació el 28-oct-2000: el 27 a la noche AR tiene 25; B (27-oct-2000) cumplió 26 hoy.
      expect(rowsOf(await listPatients({ ageMin: 26, ageMax: 26 })).map((r) => r.id)).toEqual([ageB]);
      expect(rowsOf(await listPatients({ ageMin: 25, ageMax: 25 })).map((r) => r.id)).toEqual([ageA]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("[HD-14] «última visita» por día AR: un turno de las 22:30 AR entra en su día y no en el siguiente", async () => {
    asUser(T2.userId);
    const same = rowsOf(await listPatients({ lastVisitFrom: "2026-03-10", lastVisitTo: "2026-03-10" }));
    expect(same.map((r) => r.id)).toEqual([lateVisit]);
    expect(rowsOf(await listPatients({ lastVisitFrom: "2026-03-11" }))).toEqual([]);
  });
});
