/**
 * CF2 P-S1 (§29, D-CF2-14, D-CF2-15, decisiones 2 y 3 de Martin) · el directorio de pacientes sale de los turnos.
 *
 * Contrato (brief CF2 P.1, literal):
 *  - «Última visita» = el último turno PASADO que no fue cancelado ni ausente (`lastSeenAt`; no exige «Atendido»: muchos
 *    consultorios no lo marcan). Mismo criterio en la columna, el filtro «Última visita desde/hasta» y el orden, para
 *    TODOS los roles y verticales: la Secretaria (fila `admin`) la ve; con acceso básico, «Última visita» y «Estado»
 *    ocultos («Kinesiólogo» visible).
 *  - Estado (D-CF2-14): Activo = turno próximo o una visita en los últimos 90 días; Inactivo = ninguna; Archivado = la
 *    vista de archivados. Sale de los turnos, no de la HC.
 *  - Profesionales de la fila (decisión 2): el a cargo + los que tienen turnos con el paciente (próximos o del último
 *    mes), en todas las filas (también basic).
 *  - El plan sale de Pacientes (decisión 3): la página no hidrata planes; solo el export CSV (`mode: "all"`).
 *  - `bookingFactsByPatient`: 1 `$queryRaw` agrupado con `tenantId` a mano (en prod la conexión es BYPASSRLS y las FK
 *    saltean RLS: un turno de OTRO consultorio que apunte a un paciente de este no puede colarse).
 *  - Presupuesto: ≤ 9 sentencias en los 3 órdenes y para la Secretaria (antes 10).
 *  - `listPractitionerNames()`: todos los profesionales del consultorio con estado (activo / suspendido / quitado),
 *    cacheado con `["practitioners:names", tenantId]` y el tag `practitioners`.
 *
 * Símbolo real (`listPatients`, `exportPatientsCsv`, `listPractitionerNames`) contra el Docker; solo se mockea la sesión
 * y se instrumentan los clientes Prisma. Corre con `kinesoft_app` y con el owner.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import { listPatients } from "@/lib/patients";
import { exportPatientsCsv } from "@/lib/patients-export-internal";
import { listPractitionerNames } from "@/lib/practitioner-names-internal";
import { getActor } from "@/lib/session";
import { toARDateKey } from "@/lib/datetime-ar";
import { revalidateTag } from "next/cache";
import { tags } from "@/lib/cache-tags";
import type { PatientRow, PatientSort } from "@/lib/patients-types";
import { measure } from "@/tests/helpers/query-counter";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!RUN)("CF2 P-S1 · directorio de pacientes desde los turnos", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let T2: EphemeralTenant;
  let sfx: string;
  let kineB: { userId: string; practitionerId: string };
  let kineC: { userId: string; practitionerId: string };
  let kineGone: { userId: string; practitionerId: string };
  let sec: { userId: string };
  /** A cargo P0; turno pasado CONFIRMED (nunca «Atendido») hace 5 días con P0, próximo con B; cancelado y ausente con C. */
  let pA: string;
  /** A cargo P0; COMPLETED hace 100 días con B; plan ACTIVE (solo lo ve el CSV). */
  let pB: string;
  /**
   * Sin a cargo («Consultorio común»); CONFIRMED pasado hace 10 días con B y una reserva online impaga (PENDING) pasada
   * hace ~1 día con P0: la reserva no es visita ni hace reciente a P0 (INT-P, D-CF2-15).
   */
  let pC: string;
  /** A cargo P0; solo un turno cancelado (el mismo día que la visita de pA). */
  let pD: string;
  /** A cargo B; CONFIRMED hace 3 días con B. */
  let pE: string;
  let visitA: Date;
  let nextA: Date;
  let visitB: Date;
  let visitC: Date;
  let visitE: Date;
  let pendingC: Date;
  let planBTitle: string;

  const base = Math.floor(Date.now() / HOUR) * HOUR;
  const booking = (
    t: EphemeralTenant,
    patientId: string,
    practitionerId: string,
    scheduledFor: Date,
    status: BookingStatus,
  ) => ({
    tenantId: t.tenantId,
    patientId,
    practitionerId,
    serviceId: t.serviceId,
    scheduledFor,
    durationMin: 45,
    status,
    idempotencyKey: randomUUID(),
  });
  const rowOf = (rows: PatientRow[], id: string) => {
    const r = rows.find((x) => x.id === id);
    expect(r, `fila ${id}`).toBeDefined();
    return r!;
  };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO", sharedPatientView: false });
    T2 = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    sfx = uniqueSuffix();
    kineB = await addPractitioner(db, K, "PRACTITIONER");
    kineC = await addPractitioner(db, K, "PRACTITIONER");
    kineGone = await addPractitioner(db, K, "PRACTITIONER");
    sec = await addStaff(db, K, "ASSISTANT");

    pA = await addPatient(db, K, { lastName: `Cf2ps1 ${sfx} A` });
    pB = await addPatient(db, K, { lastName: `Cf2ps1 ${sfx} B` });
    pC = await addPatient(db, K, { lastName: `Cf2ps1 ${sfx} C`, assignedPractitionerId: null });
    pD = await addPatient(db, K, { lastName: `Cf2ps1 ${sfx} D` });
    pE = await addPatient(db, K, { lastName: `Cf2ps1 ${sfx} E`, assignedPractitionerId: kineB.practitionerId });

    visitA = new Date(base - 5 * DAY - 2 * HOUR);
    nextA = new Date(base + 3 * DAY + 2 * HOUR);
    visitB = new Date(base - 100 * DAY);
    visitC = new Date(base - 10 * DAY);
    visitE = new Date(base - 3 * DAY);
    pendingC = new Date(base - 1 * DAY - 3 * HOUR);
    await db.booking.createMany({
      data: [
        booking(K, pA, K.practitionerId, visitA, "CONFIRMED"),
        booking(K, pA, kineB.practitionerId, nextA, "CONFIRMED"),
        // Cancelado y ausente MÁS recientes que la visita: no son «última visita» ni hacen reciente a C.
        booking(K, pA, kineC.practitionerId, new Date(base - 1 * DAY), "CANCELLED"),
        booking(K, pA, kineC.practitionerId, new Date(base - 2 * DAY), "NO_SHOW"),
        // Cancelado a futuro: no es «próximo turno».
        booking(K, pA, kineC.practitionerId, new Date(base + 1 * DAY), "CANCELLED"),
        booking(K, pB, kineB.practitionerId, visitB, "COMPLETED"),
        booking(K, pC, kineB.practitionerId, visitC, "CONFIRMED"),
        // Reserva del turnero con seña obligatoria que nunca se pagó (`pub:`): queda PENDING en el pasado.
        { ...booking(K, pC, K.practitionerId, pendingC, "PENDING"), idempotencyKey: `pub:${randomUUID()}` },
        booking(K, pD, K.practitionerId, new Date(visitA.getTime() + HOUR), "CANCELLED"),
        booking(K, pE, kineB.practitionerId, visitE, "CONFIRMED"),
      ],
    });
    // Drift a propósito: un turno de OTRO consultorio que apunta a pA (las FK saltean RLS). Más cercano que el
    // próximo real y con otro profesional: si el agregado no filtra `tenantId`, pA lo mostraría.
    await db.booking.create({ data: booking(T2, pA, T2.practitionerId, new Date(base + 1 * DAY + HOUR), "CONFIRMED") });
    await db.booking.create({ data: booking(T2, pA, T2.practitionerId, new Date(base - 1 * DAY + HOUR), "COMPLETED") });

    planBTitle = `Plan cf2 ${sfx}`;
    await db.treatmentProgram.create({
      data: {
        tenantId: K.tenantId,
        patientId: pB,
        title: planBTitle,
        totalSessions: 4,
        discipline: "KINESIOLOGY",
        startDate: new Date(base - 20 * DAY),
        status: "ACTIVE",
      },
    });

    // Suspendido (membership.disabledAt) y quitado (sin membership, la fila Practitioner queda).
    await db.membership.update({
      where: { userId_tenantId: { userId: kineC.userId, tenantId: K.tenantId } },
      data: { disabledAt: new Date() },
    });
    await db.membership.delete({ where: { userId_tenantId: { userId: kineGone.userId, tenantId: K.tenantId } } });
  });

  afterEach(() => usePassthroughUnstableCache());

  afterAll(async () => {
    await K?.cleanup();
    await T2?.cleanup();
    await db?.$disconnect();
  });

  it("[CF2-PS1-1] Secretaria: última visita, estado y profesionales; sin notas ni planes", async () => {
    asUser(sec.userId);
    const rows = (await listPatients({ q: sfx })).rows;
    const a = rowOf(rows, pA);
    expect(a).toMatchObject({ access: "admin", notes: null, activePlans: [], activeProgramTitle: null, sessionsTotal: 0 });
    // CONFIRMED pasado (nadie marcó «Atendido») = última visita; el cancelado y el ausente más nuevos no.
    expect(a.lastVisit?.toISOString()).toBe(visitA.toISOString());
    expect(a.upcomingAt?.toISOString()).toBe(nextA.toISOString());
    expect(a.activity).toBe("active");
    expect(a.assignedPractitionerId).toBe(K.practitionerId);
    // A cargo primero, después el del próximo turno; C (solo cancelado/ausente) no.
    expect(a.practitionerIds).toEqual([K.practitionerId, kineB.practitionerId]);
    const b = rowOf(rows, pB);
    expect(b.lastVisit?.toISOString()).toBe(visitB.toISOString());
    expect(b.activity).toBe("inactive");
    expect(b.activePlans).toEqual([]);
    // B lo vio hace 100 días: fuera del último mes.
    expect(b.practitionerIds).toEqual([K.practitionerId]);
    const c = rowOf(rows, pC);
    expect(c).toMatchObject({ assignedPractitionerId: null, activity: "active", practitionerIds: [kineB.practitionerId] });
    expect(c.lastVisit?.toISOString()).toBe(visitC.toISOString());
    const d = rowOf(rows, pD);
    expect(d).toMatchObject({ lastVisit: null, upcomingAt: null, activity: "inactive", practitionerIds: [K.practitionerId] });
  });

  it("[CF2-PS1-2] Kine sin plan activo igual tiene última visita y estado (full)", async () => {
    // Titular (full sobre todo): pA no tiene plan; antes la «última visita» Kine salía de sesiones de planes.
    asUser(K.userId);
    const rows = (await listPatients({ q: sfx })).rows;
    const a = rowOf(rows, pA);
    expect(a.access).toBe("full");
    expect(a.lastVisit?.toISOString()).toBe(visitA.toISOString());
    expect(a.activity).toBe("active");
    // El plan salió de la página (decisión 3): pB tiene uno ACTIVE y la fila no lo hidrata.
    const b = rowOf(rows, pB);
    expect(b).toMatchObject({ access: "full", activePlans: [], activeProgramTitle: null, activity: "inactive" });
    expect(b.lastVisit?.toISOString()).toBe(visitB.toISOString());
    // Profesional (kineB): su paciente es full con la visita de hace 3 días.
    asUser(kineB.userId);
    const e = rowOf((await listPatients({ q: sfx })).rows, pE);
    expect(e).toMatchObject({ access: "full", activity: "active", practitionerIds: [kineB.practitionerId] });
    expect(e.lastVisit?.toISOString()).toBe(visitE.toISOString());
  });

  it("[CF2-PS1-3] fila basic: profesionales visibles, última visita y estado ocultos", async () => {
    asUser(kineB.userId);
    const a = rowOf((await listPatients({ q: sfx })).rows, pA);
    expect(a).toMatchObject({
      access: "basic",
      lastVisit: null,
      activity: null,
      assignedPractitionerId: K.practitionerId,
      practitionerIds: [K.practitionerId, kineB.practitionerId],
    });
    expect(a.upcomingAt?.toISOString()).toBe(nextA.toISOString());
  });

  it("[CF2-PS1-4] orden y filtro de «Última visita» con el mismo criterio, también para la Secretaria", async () => {
    const expected = [pE, pA, pC, pB, pD];
    for (const user of [sec.userId, K.userId]) {
      asUser(user);
      const rows = (await listPatients({ q: sfx, sort: "lastVisit.desc" })).rows;
      expect(rows.map((r) => r.id)).toEqual(expected);
      // Filtro por el día AR de la visita de pA: el CONFIRMED entra, el cancelado de pD (mismo día) no.
      const day = toARDateKey(visitA);
      const f = (await listPatients({ q: sfx, lastVisitFrom: day, lastVisitTo: day })).rows;
      expect(f.map((r) => r.id)).toEqual([pA]);
    }
    // Kine con filas basic: ordenar por un dato que no ve no las delata (van al final, en orden SQL).
    asUser(kineB.userId);
    const lv = (await listPatients({ q: sfx, sort: "lastVisit.desc" })).rows.map((r) => r.id);
    expect(lv).toEqual([pE, pA, pB, pC, pD]);
  });

  it("[CF2-INTP-4] un PENDING pasado (reserva online impaga) no es visita: columna, reciente, orden y filtro", async () => {
    for (const user of [sec.userId, K.userId]) {
      asUser(user);
      const c = rowOf((await listPatients({ q: sfx })).rows, pC);
      // Columna (`lastSeenAt` de `bookingFactsByPatient`): la visita CONFIRMED, no la reserva más nueva.
      expect(c.lastVisit?.toISOString()).toBe(visitC.toISOString());
      // «Reciente» (mismo `lastSeenAt`): P0 solo tiene la reserva impaga con pC, así que no aparece.
      expect(c.practitionerIds).toEqual([kineB.practitionerId]);
      // Orden (`lastSeenByPatient`): si la reserva contara, pC (≈1 día) iría antes que pE (3 días).
      const order = (await listPatients({ q: sfx, sort: "lastVisit.desc" })).rows.map((r) => r.id);
      expect(order.indexOf(pC)).toBeGreaterThan(order.indexOf(pE));
      // Filtro por el día AR de la reserva (`lastVisitBookingWhere`): pC no entra.
      const day = toARDateKey(pendingC);
      expect((await listPatients({ q: sfx, lastVisitFrom: day, lastVisitTo: day })).rows.map((r) => r.id)).not.toContain(pC);
    }
  });

  it("[CF2-INTP-5] filtro «Última visita»: el turno cruzado de otro consultorio no hace entrar al paciente", async () => {
    // El COMPLETED de T2 que apunta a pA (FK cruzada): ese día K solo tiene el cancelado de pA y la reserva de pC.
    const day = toARDateKey(new Date(base - 1 * DAY + HOUR));
    for (const user of [sec.userId, K.userId]) {
      asUser(user);
      expect((await listPatients({ q: sfx, lastVisitFrom: day, lastVisitTo: day })).rows.map((r) => r.id)).toEqual([]);
    }
  });

  it("[CF2-PS1-5] ningún id de otro consultorio (turno con FK cruzada incluido)", async () => {
    for (const user of [sec.userId, K.userId, kineB.userId]) {
      asUser(user);
      for (const sort of ["lastName.asc", "upcoming.asc", "lastVisit.desc"] as PatientSort[]) {
        const rows = (await listPatients({ q: sfx, sort })).rows;
        const a = rowOf(rows, pA);
        expect(a.upcomingAt?.toISOString()).toBe(nextA.toISOString());
        if (a.access !== "basic") expect(a.lastVisit?.toISOString()).toBe(visitA.toISOString());
        for (const r of rows) expect(r.practitionerIds ?? []).not.toContain(T2.practitionerId);
        expect(rows.map((r) => r.id).sort()).toEqual([pA, pB, pC, pD, pE].sort());
      }
    }
  });

  it("[CF2-PS1-6] ≤ 9 sentencias en los 3 órdenes y para la Secretaria; la página no lee planes", async () => {
    // El techo literal (≤ 9) es el de `tests/perf/plans.perf.test.ts` (1.000 pacientes, donde el getActor del fixture
    // suma una sentencia más que acá). Acá además se fija la FORMA: la página no toca TreatmentProgram ni Session
    // (el plan salió, decisión 3) y los turnos son 1 agregado (+1 clave tenant-wide si el orden la pide).
    const events = () =>
      (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;
    const touches = (table: string) => events().filter((e) => e.query.includes(`"${table}"`)).length;
    for (const user of [K.userId, sec.userId]) {
      for (const sort of ["lastName.asc", "upcoming.asc", "lastVisit.desc"] as PatientSort[]) {
        asUser(user);
        await listPatients({ sort });
        const { m } = await measure(() => listPatients({ sort }));
        const who = `${user === sec.userId ? "Secretaria" : "titular"} · ${sort}`;
        expect(m.statements, who).toBeLessThanOrEqual(9);
        expect(touches("TreatmentProgram"), who).toBe(0);
        expect(touches("Session"), who).toBe(0);
        expect(touches("Booking"), who).toBe(sort === "lastName.asc" ? 1 : 2);
      }
    }
  });

  it("[CF2-PS1-7] el export (mode all) sigue trayendo el plan activo", async () => {
    asUser(K.userId);
    const csv = await exportPatientsCsv(await getActor(), { ids: [pB] });
    const line = csv.split("\n").find((l) => l.includes(pB))!;
    expect(line).toContain(planBTitle);
  });

  it("[CF2-PS1-8] listPractitionerNames: todos con estado, solo del consultorio, cacheado por tenant", async () => {
    const cache = useRealUnstableCache();
    asUser(sec.userId);
    const names = await listPractitionerNames();
    const byId = new Map(names.map((n) => [n.id, n]));
    expect(byId.get(K.practitionerId)?.status).toBe("active");
    expect(byId.get(kineB.practitionerId)).toMatchObject({ status: "active", name: expect.stringMatching(/^Kine /) });
    expect(byId.get(kineC.practitionerId)?.status).toBe("suspended");
    expect(byId.get(kineGone.practitionerId)?.status).toBe("removed");
    expect(byId.has(T2.practitionerId)).toBe(false);
    for (const n of names) expect(n.name).not.toContain("@");
    expect(cache.keyParts).toContainEqual(["practitioners:names", K.tenantId]);
    // Cacheado: un cambio de nombre no se ve hasta que se revalida el tag `practitioners` (lo hacen las mutaciones de
    // equipo y de perfil que ya lo usan para `listPractitioners`).
    await db.userProfile.update({ where: { id: kineB.userId }, data: { fullName: `Renombrado ${sfx}` } });
    expect(await listPractitionerNames()).toEqual(names);
    revalidateTag(tags.practitioners(K.tenantId));
    const fresh = await listPractitionerNames();
    expect(fresh.find((n) => n.id === kineB.practitionerId)?.name).toBe(`Renombrado ${sfx}`);
  });

  it("[CF2-ZF3-6] fila basic: el a cargo + quienes tienen turno próximo; el que lo VIO hace poco no (no se infiere la visita)", async () => {
    const z = uniqueSuffix();
    const kineD = await addPractitioner(db, K, "PRACTITIONER");
    const kineE = await addPractitioner(db, K, "PRACTITIONER");
    const pF = await addPatient(db, K, { lastName: `Zf3six ${z}` });
    await db.booking.createMany({
      data: [
        booking(K, pF, kineD.practitionerId, new Date(base - 4 * DAY), "CONFIRMED"),
        booking(K, pF, kineE.practitionerId, new Date(base + 2 * DAY), "CONFIRMED"),
        booking(K, pF, K.practitionerId, new Date(base + 6 * DAY), "CONFIRMED"),
      ],
    });
    // kineB no atiende a pF (a cargo P0, sin turnos con B, sin vista compartida): fila basic.
    asUser(kineB.userId);
    const basic = rowOf((await listPatients({ q: `Zf3six ${z}` })).rows, pF);
    expect(basic).toMatchObject({ access: "basic", lastVisit: null, activity: null });
    expect(basic.practitionerIds).toEqual([K.practitionerId, kineE.practitionerId]);
    // La Secretaria (admin) y el Titular (full) siguen viendo al que lo vio hace 4 días (decisión 2).
    for (const user of [sec.userId, K.userId]) {
      asUser(user);
      const r = rowOf((await listPatients({ q: `Zf3six ${z}` })).rows, pF);
      expect(r.practitionerIds, user).toEqual([K.practitionerId, kineE.practitionerId, kineD.practitionerId]);
    }
  });
});
