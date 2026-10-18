/**
 * WA-0 (§21.6) · `getPatientShareContact`: el celular del paciente para el `wa.me` del drawer, contra la DB real.
 *
 * Acceso = el del contacto en el perfil: `full` (dueño) y `admin` (Secretaria, PD-13) lo reciben; `basic` (kine sin
 * acceso al paciente) y un paciente de OTRO tenant → `hidden` (sin distinguir «no hay número» de «no lo ves»). Los
 * controles (dueño ok, kine hidden sobre el mismo paciente) evitan el falso verde de «todo devuelve ok/hidden».
 * Solo se mockea la sesión (tests/helpers/actor).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPatientShareContact } from "@/lib/booking-share-actions";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[WA-0] getPatientShareContact", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let X: EphemeralTenant;
  let assistant: { userId: string };
  let kine: { userId: string };
  let mobile: string;
  let landline: string;
  let noPhone: string;
  let foreign: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db); // sin «Consultorio común»: el kine queda en basic sobre los del dueño
    X = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, T, "ASSISTANT");
    kine = await addPractitioner(db, T, "PRACTITIONER");
    mobile = await addPatient(db, T, { phone: "0351 155 123456" });
    landline = await addPatient(db, T, { phone: "011 4321-5678" });
    noPhone = await addPatient(db, T);
    foreign = await addPatient(db, X, { phone: "11 2345 6789" });
  });

  afterAll(async () => {
    await T?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  it("dueño (full): celular normalizado; fijo y vacío → invalid con motivo", async () => {
    asUser(T.userId);
    expect(await getPatientShareContact(mobile)).toEqual({ status: "ok", e164: "+5493515123456" });
    expect(await getPatientShareContact(landline)).toEqual({ status: "invalid", reason: "landline" });
    expect(await getPatientShareContact(noPhone)).toEqual({ status: "invalid", reason: "empty" });
  });

  it("Secretaria (admin): ve el contacto, igual que en el perfil", async () => {
    asUser(assistant.userId);
    expect(await getPatientShareContact(mobile)).toEqual({ status: "ok", e164: "+5493515123456" });
    expect(await getPatientShareContact(landline)).toEqual({ status: "invalid", reason: "landline" });
  });

  it("kine sin acceso (basic): hidden, sin decir si hay número", async () => {
    asUser(kine.userId);
    expect(await getPatientShareContact(mobile)).toEqual({ status: "hidden" });
    expect(await getPatientShareContact(noPhone)).toEqual({ status: "hidden" });
  });

  it("paciente de otro tenant, id inexistente o basura → hidden", async () => {
    asUser(T.userId);
    expect(await getPatientShareContact(foreign)).toEqual({ status: "hidden" });
    expect(await getPatientShareContact("no-existe")).toEqual({ status: "hidden" });
    expect(await getPatientShareContact("")).toEqual({ status: "hidden" });
    expect(await getPatientShareContact("x".repeat(500))).toEqual({ status: "hidden" });
  });
});
