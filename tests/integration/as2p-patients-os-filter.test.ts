/**
 * [AS-2p] T3e-2p (plan §23.9) · /pacientes filtra por la obra social VIGENTE (`?os=`) y la proyección admin del perfil
 * trae lo que «Editar datos» necesita para no adivinar.
 *
 * Contrato:
 *  - `listPatients({ insurerKey })` reemplaza el ILIKE por nombre: `insurerKey` = id del catálogo del tenant o
 *    `"particular"`. Matchea solo la cobertura vigente (la más reciente, `id desc`, la misma que muestra la columna):
 *    una cobertura vieja de OSDE no hace aparecer a quien hoy es de Swiss.
 *  - «Particular» = sin cobertura, cobertura sin `insurerId` (texto libre: el turno cobra como particular) o
 *    cobertura que apunta a la fila `isParticular` del catálogo.
 *  - Filas `basic` se descartan con el filtro (la obra social es PHI recortada para ellas: H-b1); `admin` y `full`
 *    se conservan.
 *  - `getPatientCore` rama admin: `coverage` con `insurerId`, `payerPlanId`, `copagoCents` y `updatedAt` del paciente;
 *    sigue sin notas ni diagnóstico.
 *
 * Símbolo real contra la DB; solo se mockea la sesión. Corre con los dos roles (kinesoft_app y owner BYPASSRLS).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPatientCore, listPatients } from "@/lib/patients";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe.skipIf(!RUN)("[AS-2p] /pacientes por obra social + proyección admin para «Editar datos»", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let other: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let stranger: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let osde: string;
  let swiss: string;
  let foreignOs: string;
  let sfx: string;
  // Pacientes (todos a cargo de `kine`).
  let pOsde: string; // vigente OSDE
  let pNowSwiss: string; // OSDE vieja, Swiss vigente
  let pNowOsde: string; // texto libre viejo, OSDE vigente
  let pNone: string; // sin cobertura
  let pFree: string; // texto libre (sin insurerId)
  let pPartRow: string; // fila Particular del catálogo

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    other = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    stranger = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    sfx = uniqueSuffix();
    osde = await addInsurer(db, T, { name: `OSDE ${sfx}` });
    swiss = await addInsurer(db, T, { name: `Swiss ${sfx}` });
    foreignOs = await addInsurer(db, other, { name: `OSDE ${sfx}` });

    const mk = (tag: string) => addPatient(db, T, { assignedPractitionerId: kine.practitionerId, lastName: `${tag} ${sfx}` });
    pOsde = await mk("Osde");
    pNowSwiss = await mk("NowSwiss");
    pNowOsde = await mk("NowOsde");
    pNone = await mk("None");
    pFree = await mk("Free");
    pPartRow = await mk("PartRow");

    // El orden de creación es el de vigencia (cuid ordenable por tiempo, como en el resto de los tests de cobertura).
    await db.coverage.create({ data: { patientId: pOsde, insurer: `OSDE ${sfx}`, insurerId: osde } });
    await db.coverage.create({ data: { patientId: pNowSwiss, insurer: `OSDE ${sfx}`, insurerId: osde } });
    await db.coverage.create({ data: { patientId: pNowSwiss, insurer: `Swiss ${sfx}`, insurerId: swiss } });
    await db.coverage.create({ data: { patientId: pNowOsde, insurer: "PAMI texto" } });
    await db.coverage.create({ data: { patientId: pNowOsde, insurer: `OSDE ${sfx}`, insurerId: osde } });
    await db.coverage.create({ data: { patientId: pFree, insurer: "IOSFA texto libre" } });
    await db.coverage.create({ data: { patientId: pPartRow, insurer: "Particular", insurerId: T.particularInsurerId } });
  });

  afterAll(async () => {
    await T?.cleanup();
    await other?.cleanup();
    await db?.$disconnect();
  });

  const mine = async (insurerKey: string) =>
    ids(await listPatients({ q: sfx, insurerKey })).sort();

  it("[AS-2p] por id del catálogo: solo la cobertura vigente matchea (una vieja no)", async () => {
    asUser(kine.userId);
    expect(await mine(osde)).toEqual([pOsde, pNowOsde].sort());
    expect(await mine(swiss)).toEqual([pNowSwiss]);
  });

  it("[AS-2p] «Particular»: sin cobertura, texto libre o la fila Particular; no quien hoy tiene OS", async () => {
    asUser(kine.userId);
    expect(await mine("particular")).toEqual([pNone, pFree, pPartRow].sort());
  });

  it("[AS-2p] id de otro tenant o inexistente: nada", async () => {
    asUser(kine.userId);
    expect(await mine(foreignOs)).toEqual([]);
    expect(await mine("no-existe")).toEqual([]);
  });

  it("[AS-2p] filas basic se descartan con el filtro; admin (Secretaria) se conservan", async () => {
    asUser(stranger.userId);
    // Sin filtro el kine sin acceso ve las filas (proyección básica)…
    expect(ids(await listPatients({ q: sfx }))).toEqual(expect.arrayContaining([pOsde, pNone]));
    // …pero la obra social no es un oráculo.
    expect(await mine(osde)).toEqual([]);
    expect(await mine("particular")).toEqual([]);
    asUser(assistant.userId);
    expect(await mine(osde)).toEqual([pOsde, pNowOsde].sort());
    expect(await mine("particular")).toEqual([pNone, pFree, pPartRow].sort());
  });

  it("[AS-2p] proyección admin: cobertura con insurerId/payerPlanId/copagoCents y updatedAt; sin notas", async () => {
    const p = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId, notes: "Nota clínica 2p" });
    await db.coverage.create({ data: { patientId: p, insurer: "Vieja", copagoCents: 1 } });
    await db.coverage.create({
      data: { patientId: p, insurer: "nombre cacheado", insurerId: osde, planName: "310", memberId: "99", copagoCents: 600000 },
    });
    const row = await db.patient.findUniqueOrThrow({ where: { id: p }, select: { updatedAt: true } });
    asUser(assistant.userId);
    const core = await getPatientCore(p);
    if (core?.access !== "admin") throw new Error(`esperaba admin, vino ${core?.access}`);
    expect(core.coverage).toEqual({
      insurer: `OSDE ${sfx}`,
      insurerId: osde,
      planName: "310",
      payerPlanId: null,
      memberId: "99",
      copagoCents: 600000,
    });
    expect(new Date(core.updatedAt).getTime()).toBe(row.updatedAt.getTime());
    for (const k of ["notes", "diagnosisTitle", "diagnosisNote", "userId"]) expect(core).not.toHaveProperty(k);
  });
});
