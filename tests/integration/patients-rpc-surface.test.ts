/**
 * Superficie RPC de `lib/patients.ts` (PLANES.md §8, P0.1 · S02a; enmienda E0).
 *
 * `lib/patients.ts` es `"use server"`: TODA export es un endpoint POST que
 * cualquier miembro del tenant puede invocar con el action-id del chunk
 * público, tenga o no un caller en la UI. `getPatient` (wrapper pre-Sprint-16,
 * 0 callers) no tenía gate de acceso: con `visibilityForActor` → `patientWhere
 * = {}` devolvía la HC completa (planes, sesiones, ejercicios, diagnósticos,
 * EVA, turnos) a un profesional básico o a la Secretaria. Se borra; este test
 * evita que vuelva y fija que los lectores de HC que quedan cierran a `[]`
 * para básico y ASSISTANT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as patientsModule from "@/lib/patients";
import { getPatientEvaScores } from "@/lib/patients";
import { getPatientProgramsFull, getPatientProgramsLite } from "@/lib/programs";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("patients · superficie RPC (P0-S02a, E0)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let basicKine: { userId: string };
  let assistant: { userId: string };
  let patientId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    basicKine = await addPractitioner(db, A, "PRACTITIONER");
    assistant = await addPractitioner(db, A, "ASSISTANT");
    // Paciente asignado al OWNER, sin shares ni "Consultorio común": el otro
    // profesional y la Secretaria quedan en acceso básico.
    patientId = await addPatient(db, A);
    const prog = await db.treatmentProgram.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        title: "Plan con HC",
        totalSessions: 1,
        frequency: 1,
        startDate: new Date("2030-01-07T03:00:00.000Z"),
        sessions: {
          create: [{ index: 1, practitionerId: A.practitionerId, scheduledFor: new Date("2030-01-07T13:00:00Z"), notes: "Dolor lumbar" }],
        },
      },
    });
    expect(prog.id).toBeTruthy();
    await db.evaScore.create({ data: { patientId, value: 7 } });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[P0-S02a] getPatient: básico/ASSISTANT no leen HC por RPC", () => {
    // La export ya no existe: no hay action-id que invocar.
    expect("getPatient" in patientsModule).toBe(false);
    expect((patientsModule as Record<string, unknown>).getPatient).toBeUndefined();
  });

  it.each([
    ["profesional básico", () => basicKine.userId],
    ["ASSISTANT sin Consultorio común", () => assistant.userId],
  ])("los lectores de HC que quedan devuelven [] para %s", async (_label, who) => {
    asUser(who());
    expect(await getPatientProgramsLite(patientId)).toEqual([]);
    expect(await getPatientProgramsFull(patientId)).toEqual([]);
    expect(await getPatientEvaScores(patientId)).toEqual([]);
  });

  it("control: el OWNER (full) sí lee la HC por los mismos lectores", async () => {
    asUser(A.userId);
    const full = await getPatientProgramsFull(patientId);
    expect(full).toHaveLength(1);
    expect(full[0].sessions[0].notes).toBe("Dolor lumbar");
    expect(await getPatientEvaScores(patientId)).toHaveLength(1);
  });
});
