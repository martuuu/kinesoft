/**
 * PF2-b (C-PF8) · `/pacientes/[id]`: presupuesto de transacciones y visibilidad idéntica.
 *
 * Contrato (brief PF §2.4, literal): «la página resuelve el actor antes y hace `runWithRls(tenantId, tx =>
 * loadX(actor, tx))`»; `/pacientes/[id]` hoy 12 → presupuesto **≤ 3**. Medido acá antes de PF2-b, con el fixture de
 * este archivo (full + deep link + evoluciones + nombre del metadata): 16 tx · 63 sentencias → 3 tx · 42. Afuera de
 * la tx única: evoluciones (1 tx propia, `lib/clinical-notes*.ts` no admite `tx` sin tocar §5.51-55) y
 * `listInsurers` en frío (PF2-d, con `unstable_cache`).
 *
 * FC-2b (§24.2 hallazgo 3): la tx 3 pasa a ser la «clinical home» de la HC (`getPatientClinicalHome`: resumen +
 * primera página + compositor + deep link). El perfil `full` queda en EXACTAMENTE 3 tx (no «≤»: una 4ª sería la
 * timeline pedida aparte, que es lo que se sacó) y la tx 3 tiene su techo de sentencias (`HOME_TX_STATEMENTS`).
 *
 * Se mide el loader REAL con los mismos argumentos que la página (`loadPatientProfilePage(actor, id, noteBookingId)`),
 * con `installQueryCounter` (solo un listener en los clientes de `@/lib/db`) y `unstable_cache` en pass-through (=
 * siempre en frío: el peor caso). La visibilidad se compara contra los lectores públicos de siempre
 * (`getPatientCore`, `getPatientBookingsAll`, `getPatientPlans`…) con la Secretaria, un PRACTITIONER básico, uno con
 * el paciente a cargo y el Titular: tiene que dar EXACTAMENTE lo mismo.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan } from "@/tests/helpers/plan-factory";
import { getActor } from "@/lib/session";
import { patientAccessFor } from "@/lib/visibility";
import {
  getPatientCore,
  getPatientBookingsAll,
  getPatientBookingsSummary,
  getPatientBillableCount,
  getPatientEvaScores,
} from "@/lib/patients";
import { getPatientPlans, getPatientPlanBalances } from "@/lib/plans-read";
import { getPatientClinicalHome, getPatientClinicalSummary, getPatientTimeline } from "@/lib/clinical-notes-read";
import { listInsurers } from "@/lib/insurers";
import { loadPatientProfilePage, profileNoteBookingId } from "@/lib/patient-profile-loader";

const RUN = process.env.INTEGRATION === "1";
const BUDGET = 3;
/**
 * Techo de sentencias de la tx 3 (FC-2b), peor caso: deep link + módulo `sesiones` + escritura (compositor). Medido el
 * 19-oct: 11 = actor 1 (`getActor`, fuera de la tx) + gate 3 (paciente, ajustes, membresía) + resumen 1 (último +
 * contador en una) + timeline 3 (raíces con el LATERAL del documento, enmiendas, sesiones) + compositor 1 + deep link 2
 * (turno, notas). Antes de FC-2b la timeline iba en una 4ª tx pedida por el cliente al montar. Si sube, es un N+1 o una
 * lectura nueva: se discute, no se corre el número.
 */
const HOME_TX_STATEMENTS = 11;

/** Claves exactas de `PatientAdminCore` (congelado) y de la proyección básica. */
const ADMIN_CORE_KEYS = [
  "access", "assignedPractitionerName", "coverage", "dateOfBirth", "documentId", "email", "emergency", "firstName",
  "id", "lastName", "nextBookingAt", "phone", "updatedAt",
].sort();
const BASIC_CORE_KEYS = ["access", "documentId", "firstName", "id", "lastName", "nextBookingAt"].sort();

type Staff = { userId: string; practitionerId: string };

/** Sentencias de la última `measure` (el recorder de tests/helpers/query-counter.ts es global). */
const recorded = () =>
  (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;

describe.skipIf(!RUN)("PF2-b · perfil del paciente en ≤ 3 tx, misma visibilidad", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let G: EphemeralTenant;
  let X: EphemeralTenant;
  let secretaria: Staff;
  let kineBasico: Staff;
  let kineACargo: Staff;
  let patientId: string;
  let bookingId: string;
  let foreignBookingId: string;
  let gPatient: string;
  let xPatient: string;

  beforeAll(async () => {
    db = ownerClient();
    // Sin «Consultorio común»: el PRACTITIONER que no lo tiene a cargo queda en `basic`.
    A = await createEphemeralTenant(db, { sharedPatientView: false, vertical: "KINESIOLOGY" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    X = await createEphemeralTenant(db);
    secretaria = await addPractitioner(db, A, "ASSISTANT");
    kineBasico = await addPractitioner(db, A, "PRACTITIONER");
    kineACargo = await addPractitioner(db, A, "PRACTITIONER");

    patientId = await addPatient(db, A, {
      assignedPractitionerId: kineACargo.practitionerId,
      notes: "Nota clínica privada",
      email: `pf2b-${randomUUID().slice(0, 8)}@test.local`,
    });
    await db.coverage.create({ data: { patientId, insurer: "OSDE", planName: "310", memberId: "99", copagoCents: 1234 } });
    await db.emergencyContact.create({ data: { patientId, name: "Mamá", relation: "Madre", phone: "1155555555" } });
    // Un plan con 3 sesiones y 2 turnos vinculados (planes + saldos con datos de verdad).
    await createPlan(db, A, { patientId, sessions: 3, bookings: 2 });
    // Uno archivado: sale en los saldos (puede seguir debiendo) y NO en la lista (`liveProgramWhere`). Fija que el
    // loader, que lee los planes UNA vez y filtra en memoria, da lo mismo que los dos lectores de lib/plans-read.ts.
    await createPlan(db, A, { patientId, sessions: 2, bookings: 1, data: { archivedAt: new Date() } });
    // Turnos sueltos: uno futuro (próximo turno), uno cobrado (cuenta en Facturación), con texto clínico a redactar.
    const mk = async (pid: string, at: Date, paymentStatus: "PAID" | "UNPAID") =>
      (
        await db.booking.create({
          data: {
            tenantId: A.tenantId,
            patientId: pid,
            practitionerId: A.practitionerId,
            serviceId: A.serviceId,
            scheduledFor: at,
            durationMin: 45,
            status: "CONFIRMED",
            paymentStatus,
            idempotencyKey: randomUUID(),
            title: "Lumbalgia",
            description: "Irradiada",
            notes: "Refiere dolor 8/10",
          },
        })
      ).id;
    bookingId = await mk(patientId, new Date(Date.now() + 3 * 86_400_000), "UNPAID");
    await mk(patientId, new Date(Date.now() - 3 * 86_400_000), "PAID");
    foreignBookingId = await mk(await addPatient(db, A), new Date(Date.now() + 86_400_000), "UNPAID");
    await db.evaScore.create({ data: { patientId, value: 6 } });
    await db.clinicalNote.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        body: "Evolución de prueba",
        occurredAt: new Date(),
        authorUserId: kineACargo.userId,
        authorPractitionerId: kineACargo.practitionerId,
        authorName: "Kine a cargo",
        idempotencyKey: randomUUID(),
      },
    });

    gPatient = await addPatient(db, G);
    await db.evaScore.create({ data: { patientId: gPatient, value: 3 } });
    xPatient = await addPatient(db, X);
  });

  afterAll(async () => {
    await A?.cleanup();
    await G?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  /** Lo que hace la página: actor resuelto antes, deep link parseado igual, misma carga. */
  async function pageLoad(id: string, searchParams: Record<string, string> = {}) {
    const actor = await getActor();
    return loadPatientProfilePage(actor, id, profileNoteBookingId(actor, searchParams));
  }

  // ── Presupuesto ────────────────────────────────────────────────────────

  it(`[PF2-b] full con deep link (peor caso, cache en frío): ≤ ${BUDGET} tx`, async () => {
    for (const who of [A.userId, kineACargo.userId]) {
      asUser(who);
      const { result, m } = await measure(() => pageLoad(patientId, { tab: "evoluciones", turno: bookingId }));
      console.log(`[PF2-b] perfil full (${who === A.userId ? "Titular" : "a cargo"}): ${m.transactions} tx · ${m.statements} sentencias`);
      expect(result.access).toBe("full");
      expect(m.transactions).toBe(BUDGET);
      // La tx 3 es la «clinical home» completa: la página no tiene que pedir nada más al montar.
      if (result.access !== "full") return;
      expect(result.clinicalHome?.firstPage?.items.length).toBeGreaterThan(0);
      expect(result.clinicalHome?.composer).not.toBeNull();
    }
  });

  it(`[FC-2b] tx 3 (clinical home, peor caso con deep link): 1 tx · ≤ ${HOME_TX_STATEMENTS} sentencias`, async () => {
    asUser(kineACargo.userId);
    // Calentamiento: el primer `getActor` del archivo resuelve la sesión en frío (no es de la tx).
    await getPatientClinicalHome(patientId, { noteBookingId: bookingId, timeline: true });
    const { result, m } = await measure(() =>
      getPatientClinicalHome(patientId, { noteBookingId: bookingId, timeline: true })
    );
    const sql = recorded().map((e) => e.query.replace(/\s+/g, " ").slice(0, 120));
    console.log(`[FC-2b] clinical home: ${m.transactions} tx · ${m.statements} sentencias\n  ${sql.join("\n  ")}`);
    expect(result?.deepLink).not.toBeNull();
    // El turno del deep link es a 3 días: fuera de la ventana del chip (12 h, EV2-D12); el de hace 3 días sí entra.
    expect(result?.composer?.candidates.length).toBeGreaterThan(0);
    expect(result?.composer?.candidates.map((c) => c.id)).not.toContain(bookingId);
    expect(m.transactions).toBe(1);
    expect(m.statements).toBeLessThanOrEqual(HOME_TX_STATEMENTS);
    // Anti-false-green: el techo se mide con todo prendido (timeline de verdad y sesiones del plan del fixture).
    expect(recorded().filter((e) => /FROM "Session" s/.test(e.query))).toHaveLength(1);
    expect(recorded().filter((e) => /LEFT JOIN LATERAL/.test(e.query) && /"PatientDocument"/.test(e.query)).length).toBeGreaterThan(0);
  });

  it(`[PF2-b] admin (Secretaria), básico y ajeno: 1 tx`, async () => {
    for (const [who, id, access] of [
      [secretaria.userId, patientId, "admin"],
      [kineBasico.userId, patientId, "basic"],
      [A.userId, xPatient, "none"],
    ] as const) {
      asUser(who);
      const { result, m } = await measure(() => pageLoad(id));
      console.log(`[PF2-b] perfil ${access}: ${m.transactions} tx · ${m.statements} sentencias`);
      expect(result.access).toBe(access);
      expect(m.transactions).toBe(1);
      // Ningún slice clínico para estos niveles: ni evoluciones ni EVA se leen (no solo se ocultan).
      expect(recorded().filter((e) => /"(ClinicalNote|EvaScore)"/.test(e.query))).toEqual([]);
    }
  });

  // ── Visibilidad: exactamente lo mismo que los lectores públicos ────────

  it("[PF2-b] Secretaria: proyección admin idéntica (core, turnos redactados, planes admin, saldos) y nada clínico", async () => {
    asUser(secretaria.userId);
    const actor = await getActor();
    expect(await patientAccessFor(actor, patientId)).toBe("admin");
    const r = await pageLoad(patientId, { tab: "evoluciones", turno: bookingId });
    if (r.access !== "admin") throw new Error(`esperaba admin, vino ${r.access}`);
    expect(Object.keys(r).sort()).toEqual(["access", "balances", "bookingsPage", "core", "plans"]);
    expect(Object.keys(r.core).sort()).toEqual(ADMIN_CORE_KEYS);
    expect(r.core).not.toHaveProperty("notes");
    expect(r.core).toEqual(await getPatientCore(patientId));
    expect(r.bookingsPage).toEqual(await getPatientBookingsAll(patientId, 100));
    expect(r.bookingsPage.rows.length).toBe(5); // 2 + 1 de los planes, 2 sueltos
    for (const b of r.bookingsPage.rows) expect(b).toMatchObject({ title: null, description: null, notes: null });
    expect(r.plans).toEqual(await getPatientPlans({ patientId }));
    expect(r.balances).toEqual(await getPatientPlanBalances({ patientId }));
    expect(r.plans?.ok && r.plans.data.length).toBe(1);
    expect(r.balances?.ok && r.balances.data.plans.length).toBe(2);
  });

  it("[PF2-b] PRACTITIONER básico: proyección basic idéntica y ningún slice", async () => {
    asUser(kineBasico.userId);
    const actor = await getActor();
    expect(await patientAccessFor(actor, patientId)).toBe("basic");
    const r = await pageLoad(patientId, { tab: "evoluciones", turno: bookingId });
    if (r.access !== "basic") throw new Error(`esperaba basic, vino ${r.access}`);
    expect(Object.keys(r).sort()).toEqual(["access", "core"]);
    expect(Object.keys(r.core).sort()).toEqual(BASIC_CORE_KEYS);
    expect(r.core).toEqual(await getPatientCore(patientId));
    expect(r.core.nextBookingAt).not.toBeNull();
  });

  it("[PF2-b] full (a cargo y Titular): cada slice igual al lector público", async () => {
    for (const who of [kineACargo.userId, A.userId]) {
      asUser(who);
      const actor = await getActor();
      expect(await patientAccessFor(actor, patientId)).toBe("full");
      const r = await pageLoad(patientId, { tab: "evoluciones", turno: bookingId });
      if (r.access !== "full") throw new Error(`esperaba full, vino ${r.access}`);
      expect(r.core).toEqual(await getPatientCore(patientId));
      expect(r.core).toHaveProperty("notes", "Nota clínica privada");
      expect(r.recentBookings).toEqual(await getPatientBookingsSummary(patientId, 5));
      expect(r.recentBookings[0]).toMatchObject({ title: "Lumbalgia", notes: "Refiere dolor 8/10" });
      expect(r.billableCount).toBe(await getPatientBillableCount(patientId));
      expect(r.billableCount).toBe(1);
      expect(r.evaScores).toEqual(await getPatientEvaScores(patientId));
      expect(r.evaScores).toHaveLength(1);
      expect(r.plans).toEqual(await getPatientPlans({ patientId }));
      expect(r.balances).toEqual(await getPatientPlanBalances({ patientId }));
      // FC-3d: `clinicalSummary` suelto se borró del loader (nadie lo consumía): el resumen es `clinicalHome.summary`.
      expect(r).not.toHaveProperty("clinicalSummary");
      expect(r.clinicalHome?.summary).toEqual(await getPatientClinicalSummary(patientId));
      expect(r.clinicalHome?.summary.liveCount).toBe(1);
      // FC-2b: la tx 3 da lo mismo que los lectores sueltos (resumen, «Cargar más» desde cero, drawer del turno).
      expect(r.clinicalHome).toEqual(await getPatientClinicalHome(patientId, { noteBookingId: bookingId, timeline: true }));
      const page = await getPatientTimeline({ patientId, limit: 10 });
      expect(r.clinicalHome?.firstPage).toEqual(page);
      expect(r.insurers).toEqual(await listInsurers({ onlyActive: true }));
      // Profesionales del selector: solo clínicos con membresía aceptada (la Secretaria no atiende).
      const ids = r.practitioners.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([A.practitionerId, kineBasico.practitionerId, kineACargo.practitionerId]));
      expect(ids).not.toContain(secretaria.practitionerId);
      // Deep link: el turno de ESTE paciente sí.
      expect(r.noteBookingRow?.id).toBe(bookingId);
    }
  });

  it("[PF2-b] deep link: un turno de otro paciente no se proyecta; con otra pestaña no se mira; sin pestaña sí (FC: HC inicial)", async () => {
    asUser(A.userId);
    const other = await pageLoad(patientId, { tab: "evoluciones", turno: foreignBookingId });
    expect(other.access === "full" && other.noteBookingRow).toBeNull();
    expect(other.access === "full" && other.clinicalHome?.deepLink).toBeNull();
    // `?tab=planes&nuevo=1&turno=` es «crear plan desde el turno»: no abre la ficha.
    const planes = await pageLoad(patientId, { tab: "planes", turno: bookingId });
    expect(planes.access === "full" && planes.noteBookingRow).toBeNull();
    // §24.7 (FC-3d): la HC es la pestaña inicial, así que `?turno=` vale sin `tab` y con el alias `hc`.
    for (const sp of [{ turno: bookingId }, { tab: "hc", turno: bookingId }] as Record<string, string>[]) {
      const r = await pageLoad(patientId, sp);
      expect(r.access === "full" && r.noteBookingRow?.id).toBe(bookingId);
    }
    const garbage = await pageLoad(patientId, { tab: "evoluciones", turno: "x'; drop" });
    expect(garbage.access === "full" && garbage.noteBookingRow).toBeNull();
  });

  it("[PF2-b] consultorio General: sin planes, saldos ni EVA (ni se leen)", async () => {
    asUser(G.userId);
    const { result: r, m } = await measure(() => pageLoad(gPatient));
    if (r.access !== "full") throw new Error(`esperaba full, vino ${r.access}`);
    expect(recorded().filter((e) => /"(TreatmentProgram|EvaScore)"/.test(e.query))).toEqual([]);
    expect(r.plans).toBeNull();
    expect(r.balances).toBeNull();
    expect(r.evaScores).toEqual([]);
    expect(m.transactions).toBeLessThanOrEqual(BUDGET);
  });

  it("[PF2-b] paciente de otro consultorio: none (la página da 404)", async () => {
    asUser(A.userId);
    expect((await pageLoad(xPatient)).access).toBe("none");
    expect(await getPatientCore(xPatient)).toBeNull();
  });
});
