/**
 * P0-S02p (Planes E1, PD-13) — nivel de acceso "administrativo".
 *
 * Decisión de Martin (PD-13): un rol SIN `clinical.read` (ASSISTANT =
 * Secretaria, BILLING = Facturación) tiene SIEMPRE exactamente `admin` sobre
 * todos los pacientes del tenant:
 *  - nunca `full`, aunque el tenant tenga `sharedPatientView`, haya un
 *    `PatientShare` a su nombre o el paciente esté asignado a su practitioner;
 *  - nunca menos que `admin`: no depende de "Consultorio común".
 *
 * Antes de S02p la Secretaria con `sharedPatientView` caía en el corto
 * circuito "everyone sees everything" y recibía `full` → HC completa por
 * cualquier superficie que gatea con `=== "full"`.
 *
 * Se prueba el símbolo real (`patientAccessFor`, `bulkPatientAccess`,
 * `visibilityForActor`, `hcAccessError`) contra la DB; solo se mockea la
 * sesión de Supabase. Los controles (OWNER full, PRACTITIONER básico/full,
 * tenant ajeno none) evitan el falso verde de "todo devuelve admin".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { patientAccessFor, bulkPatientAccess, visibilityForActor } from "@/lib/visibility";
import { hcAccessError } from "@/lib/patient-access-internal";
import { getPatientCore } from "@/lib/patients";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Staff = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("P0-S02p · nivel admin (PD-13)", () => {
  let db: PrismaClient;
  /** Tenant con "Consultorio común" (sharedPatientView = true). */
  let S: EphemeralTenant;
  /** Tenant sin "Consultorio común". */
  let N: EphemeralTenant;
  /** Tenant ajeno: sus pacientes son `none` para todos los de S/N. */
  let X: EphemeralTenant;

  const staff: Record<"S" | "N", { assistant: Staff; billing: Staff; kine: Staff }> = {} as never;
  const pats: Record<"S" | "N", { ofOwner: string; ofAssistant: string; sharedToAssistant: string }> = {} as never;
  let foreignPatient: string;

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db, { sharedPatientView: true });
    N = await createEphemeralTenant(db);
    X = await createEphemeralTenant(db);
    for (const [key, T] of [["S", S], ["N", N]] as const) {
      const assistant = await addPractitioner(db, T, "ASSISTANT");
      const billing = await addPractitioner(db, T, "BILLING");
      const kine = await addPractitioner(db, T, "PRACTITIONER");
      staff[key] = { assistant, billing, kine };
      const ofOwner = await addPatient(db, T, { notes: "Nota clínica privada" });
      // Precheck 15 de Martin: hay prod con pacientes asignados a la
      // Secretaria. La asignación NO le da full (PD-13).
      const ofAssistant = await addPatient(db, T, { assignedPractitionerId: assistant.practitionerId });
      const sharedToAssistant = await addPatient(db, T);
      await db.patientShare.create({
        data: { tenantId: T.tenantId, patientId: sharedToAssistant, practitionerId: assistant.practitionerId },
      });
      pats[key] = { ofOwner, ofAssistant, sharedToAssistant };
    }
    foreignPatient = await addPatient(db, X);
  });

  afterAll(async () => {
    await S?.cleanup();
    await N?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  const all = (k: "S" | "N") => [pats[k].ofOwner, pats[k].ofAssistant, pats[k].sharedToAssistant];

  it("[P0-S02p] ASSISTANT con sharedPatientView → admin, sin HC", async () => {
    asUser(staff.S.assistant.userId);
    const actor = await getActor();

    for (const id of all("S")) expect(await patientAccessFor(actor, id)).toBe("admin");

    const bulk = await bulkPatientAccess(actor, all("S"));
    expect([...bulk.values()]).toEqual(["admin", "admin", "admin"]);

    // `seesAll` = "acceso full a todo el tenant": la Secretaria ya no lo tiene.
    const vis = await visibilityForActor(actor);
    expect(vis.seesAll).toBe(false);
    expect(vis.adminView).toBe(true);

    // Sin HC: el gate de las mutaciones clínicas la rechaza aunque el
    // paciente esté asignado a ella o compartido con ella.
    for (const id of all("S")) {
      const err = await runWithRls(actor.tenantId, (tx) => hcAccessError(actor, id, tx));
      expect(err).toBe("No tenés acceso completo a este paciente.");
    }
  });

  it("ASSISTANT sin sharedPatientView → admin (no basic) sobre todos, y nunca full por asignación o share", async () => {
    asUser(staff.N.assistant.userId);
    const actor = await getActor();
    for (const id of all("N")) expect(await patientAccessFor(actor, id)).toBe("admin");
    const bulk = await bulkPatientAccess(actor, all("N"));
    expect(all("N").map((id) => bulk.get(id))).toEqual(["admin", "admin", "admin"]);
    const vis = await visibilityForActor(actor);
    expect(vis.seesAll).toBe(false);
    expect(vis.adminView).toBe(true);
  });

  it("BILLING → admin en los dos tenants", async () => {
    for (const k of ["S", "N"] as const) {
      asUser(staff[k].billing.userId);
      const actor = await getActor();
      for (const id of all(k)) expect(await patientAccessFor(actor, id)).toBe("admin");
      const bulk = await bulkPatientAccess(actor, all(k));
      expect(all(k).map((id) => bulk.get(id))).toEqual(["admin", "admin", "admin"]);
      expect((await visibilityForActor(actor)).seesAll).toBe(false);
    }
  });

  it("paciente de otro tenant → none para la Secretaria (no admin)", async () => {
    asUser(staff.S.assistant.userId);
    const actor = await getActor();
    expect(await patientAccessFor(actor, foreignPatient)).toBe("none");
    const bulk = await bulkPatientAccess(actor, [foreignPatient, pats.S.ofOwner]);
    expect(bulk.has(foreignPatient)).toBe(false);
    expect(bulk.get(pats.S.ofOwner)).toBe("admin");
  });

  it("controles: OWNER full; PRACTITIONER básico sin share y full con sharedPatientView", async () => {
    asUser(N.userId);
    const owner = await getActor();
    for (const id of all("N")) expect(await patientAccessFor(owner, id)).toBe("full");
    const ownerVis = await visibilityForActor(owner);
    expect(ownerVis.seesAll).toBe(true);
    expect(ownerVis.adminView).toBe(false);

    asUser(staff.N.kine.userId);
    const kineN = await getActor();
    for (const id of all("N")) expect(await patientAccessFor(kineN, id)).toBe("basic");
    const bulkN = await bulkPatientAccess(kineN, all("N"));
    expect(all("N").map((id) => bulkN.get(id))).toEqual(["basic", "basic", "basic"]);
    expect((await visibilityForActor(kineN)).adminView).toBe(false);

    asUser(staff.S.kine.userId);
    const kineS = await getActor();
    for (const id of all("S")) expect(await patientAccessFor(kineS, id)).toBe("full");
    expect((await visibilityForActor(kineS)).seesAll).toBe(true);
  });

  // Post-integración (handoff H1 a lib/patients.ts): hoy `getPatientCore`
  // solo recorta con `access === "basic"`, así que `admin` cae en la rama de
  // HC completa (y antes de S02p la Secretaria con sharedPatientView ya
  // recibía `full`). Cuando el integrador aplique H1 (y S07sp la proyección
  // admin), este test pasa y hay que darlo vuelta a `it`.
  it("[P0-S02p] getPatientCore de ASSISTANT con sharedPatientView no trae notas ni diagnóstico", async () => {
    asUser(staff.S.assistant.userId);
    const core = await getPatientCore(pats.S.ofOwner);
    expect(core).not.toBeNull();
    expect(core).not.toHaveProperty("notes");
    expect(core).not.toHaveProperty("diagnosisTitle");
    expect(core).not.toHaveProperty("diagnosisNote");
    expect(core?.access).not.toBe("full");
  });
});
