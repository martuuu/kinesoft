/**
 * P2-FX1 — buscador de pacientes de la agenda.
 *
 * Bug: el `PatientPicker` del modal y del drawer de turnos buscaba con
 * `searchPatientsForAssignment` (Plan Builder: solo `full` + módulo
 * `diagnostico`). La Secretaria no encontraba a nadie al dar un turno
 * (rompía PD-09), un kine en básico tampoco y en un consultorio GENERAL el
 * buscador quedaba vacío.
 *
 * Se testea el despacho real del picker (`searchForPicker`) y la action
 * nueva (`searchPatientsForBooking`) contra la DB; solo se mockea la sesión
 * (integration-setup). Corre con los dos roles: `kinesoft_app` (RLS) y owner
 * BYPASSRLS (`test:integration:owner`, reproduce prod): el aislamiento entre
 * consultorios tiene que salir del `where: { tenantId }` a mano.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { searchPatientsForBooking } from "@/lib/patient-search";
import { searchForPicker } from "@/components/patients/patient-picker-search";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Staff = { userId: string; practitionerId: string };
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe.skipIf(!RUN)("P2-FX1 · búsqueda de pacientes de la agenda", () => {
  let db: PrismaClient;
  /** Consultorio de kinesiología, sin "Consultorio común" (acceso por asignación). */
  let T: EphemeralTenant;
  /** Consultorio GENERAL (sin módulo `diagnostico`). */
  let G: EphemeralTenant;
  /** Otro consultorio con pacientes que matchean el mismo término. */
  let X: EphemeralTenant;
  let assistant: Staff;
  /** Kine sin asignación ni share sobre los pacientes de T (los ve en básico). */
  let other: Staff;
  /** Token único compartido por los apellidos de los 3 consultorios. */
  let tok: string;
  let dni: string;
  let pT: string;
  let pT2: string;
  let pArchived: string;
  let pG: string;
  let pX: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    X = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, T, "ASSISTANT");
    other = await addPractitioner(db, T, "PRACTITIONER");

    const s = uniqueSuffix();
    tok = `Fxone${s.replace(/[^a-z0-9]/gi, "")}`;
    // DNI numérico único (el de la factory es "DNI-<s>"): 8 dígitos.
    dni = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    pT = await addPatient(db, T, { firstName: "Juana", lastName: `${tok} Uno`, documentId: dni });
    pT2 = await addPatient(db, T, { firstName: "Pedro", lastName: `${tok} Dos` });
    pArchived = await addPatient(db, T, { firstName: "Archi", lastName: `${tok} Archivado` });
    await db.patient.update({ where: { id: pArchived }, data: { archivedAt: new Date() } });
    pG = await addPatient(db, G, { firstName: "Gral", lastName: `${tok} General` });
    // Mismo DNI que pT en otro consultorio (el único es por tenant).
    pX = await addPatient(db, X, { firstName: "Juana", lastName: `${tok} Ajena`, documentId: dni });
  });

  afterAll(async () => {
    await T?.cleanup();
    await G?.cleanup();
    await X?.cleanup();
  });

  // Bug real: el despacho del picker de la agenda. Antes del fix
  // `searchForPicker` no existía y el picker llamaba siempre a
  // `searchPatientsForAssignment` → [] para la Secretaria.
  it("[P2-FX1] la Secretaria encuentra pacientes desde el picker de la agenda", async () => {
    asUser(assistant.userId);
    expect(ids(await searchForPicker("booking", tok))).toEqual(expect.arrayContaining([pT, pT2]));
  });

  it("la Secretaria (ASSISTANT) encuentra por nombre, por apellido y por DNI", async () => {
    asUser(assistant.userId);
    expect(ids(await searchPatientsForBooking("juana"))).toContain(pT);
    expect(ids(await searchPatientsForBooking(tok.toUpperCase()))).toEqual(expect.arrayContaining([pT, pT2]));
    expect(ids(await searchPatientsForBooking(dni))).toEqual([pT]);
    // DNI tipeado con puntos ("30.123.456").
    const dotted = `${dni.slice(0, 2)}.${dni.slice(2, 5)}.${dni.slice(5)}`;
    expect(ids(await searchPatientsForBooking(dotted))).toEqual([pT]);
    // Nombre + apellido en el mismo término.
    expect(ids(await searchPatientsForBooking(`Juana ${tok}`))).toEqual([pT]);
  });

  it("un PRACTITIONER encuentra a un paciente que ve en básico", async () => {
    asUser(other.userId);
    expect(ids(await searchForPicker("booking", "Pedro " + tok))).toEqual([pT2]);
  });

  it("en un consultorio GENERAL el buscador encuentra pacientes", async () => {
    asUser(G.userId);
    expect(ids(await searchForPicker("booking", tok))).toEqual([pG]);
  });

  it("otro consultorio nunca aparece (ni por nombre ni por DNI repetido)", async () => {
    for (const u of [T.userId, assistant.userId, other.userId]) {
      asUser(u);
      const byName = ids(await searchPatientsForBooking(tok));
      expect(byName).not.toContain(pX);
      expect(byName).not.toContain(pG);
      expect(ids(await searchPatientsForBooking(dni))).toEqual([pT]);
    }
    // Control positivo: el de X sí aparece para X.
    asUser(X.userId);
    expect(ids(await searchPatientsForBooking(dni))).toEqual([pX]);
  });

  it("los archivados no aparecen", async () => {
    asUser(T.userId);
    const r = ids(await searchPatientsForBooking(tok));
    expect(r).toEqual(expect.arrayContaining([pT, pT2]));
    expect(r).not.toContain(pArchived);
  });

  it("el DTO tiene exactamente id, firstName, lastName y documentId", async () => {
    asUser(assistant.userId);
    const r = await searchPatientsForBooking(dni);
    expect(r).toHaveLength(1);
    expect(Object.keys(r[0]).sort()).toEqual(["documentId", "firstName", "id", "lastName"]);
    expect(r[0]).toEqual({ id: pT, firstName: "Juana", lastName: `${tok} Uno`, documentId: dni });
  });

  it("término vacío o de más de 80 caracteres → [] sin error; orden determinístico", async () => {
    asUser(T.userId);
    expect(await searchPatientsForBooking("")).toEqual([]);
    expect(await searchPatientsForBooking("   ")).toEqual([]);
    expect(await searchPatientsForBooking("x".repeat(81))).toEqual([]);
    expect(await searchForPicker("booking", "")).toEqual([]);
    // lastName asc: "<tok> Dos" < "<tok> Uno".
    expect(ids(await searchPatientsForBooking(tok))).toEqual([pT2, pT]);
  });

  it("source=assignment conserva la regla del Plan Builder (solo full + diagnostico)", async () => {
    asUser(assistant.userId);
    expect(await searchForPicker("assignment", tok)).toEqual([]);
    asUser(other.userId);
    expect(await searchForPicker("assignment", tok)).toEqual([]);
    asUser(G.userId);
    expect(await searchForPicker("assignment", tok)).toEqual([]);
    // Control positivo: el dueño (asignado) sí los ve con HC.
    asUser(T.userId);
    expect(ids(await searchForPicker("assignment", tok))).toEqual(expect.arrayContaining([pT, pT2]));
  });
});
