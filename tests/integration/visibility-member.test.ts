/**
 * PL-1b (H-PL1, C-PL5) — la visibilidad del paciente se resuelve por MIEMBRO, no por rol.
 *
 * Decisión 8 de Martin (15-oct, PL-D4): el Titular o el Administrador/a que NO atiende (`Membership.clinical =
 * false`) no ve HC: ve como la Secretaria (nivel `admin`, PD-13; Ley 26.529). Antes de PL-1b `patientAccessFor`
 * devolvía `full` a todo OWNER/ADMIN por el rol, antes de mirar si atiende, y `bulkPatientAccess` /
 * `visibilityForActor` le daban `seesAll`: la HC completa de todo el consultorio a alguien que no es profesional.
 *
 * Símbolo real (`patientAccessFor`, `bulkPatientAccess`, `visibilityForActor`, `hcAccessError`,
 * `capabilitiesForActor`) contra la DB; solo se mockea la sesión de Supabase (`asUser`). Controles: el Titular y el
 * Admin que SÍ atienden siguen en `full` (el falso verde sería «todo devuelve admin»).
 *
 * El Titular no clínico conserva acá su fila de `Practitioner` (la factory la crea): el caso más peligroso, porque
 * los pacientes de la factory nacen asignados a ese profesional y la asignación tampoco puede abrirle la HC.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { patientAccessFor, bulkPatientAccess, visibilityForActor } from "@/lib/visibility";
import { hcAccessError } from "@/lib/patient-access-internal";
import { capabilitiesForActor } from "@/lib/authz";
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

describe.skipIf(!RUN)("PL-1b · visibilidad por miembro (H-PL1)", () => {
  let db: PrismaClient;
  /** Titular NO clínico, con «Consultorio común» (el atajo que antes abría todo). */
  let S: EphemeralTenant;
  /** Titular NO clínico, sin «Consultorio común». */
  let N: EphemeralTenant;
  /** Control: Titular clínico (default de la base). */
  let C: EphemeralTenant;
  let adminNoClinical: { userId: string; practitionerId: string };
  let adminClinical: { userId: string; practitionerId: string };
  const pats: Record<"S" | "N" | "C", string[]> = { S: [], N: [], C: [] };

  async function setClinical(tenantId: string, userId: string, clinical: boolean) {
    await db.membership.update({ where: { userId_tenantId: { userId, tenantId } }, data: { clinical } });
  }

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db, { sharedPatientView: true });
    N = await createEphemeralTenant(db);
    C = await createEphemeralTenant(db);
    await setClinical(S.tenantId, S.userId, false);
    await setClinical(N.tenantId, N.userId, false);
    adminNoClinical = await addPractitioner(db, N, "ADMIN");
    await setClinical(N.tenantId, adminNoClinical.userId, false);
    // Desde PL-1 la factory crea al ADMIN con «Configuración» (como el backfill de M8): acá se prueba uno sin ella.
    await db.membership.update({
      where: { userId_tenantId: { userId: adminNoClinical.userId, tenantId: N.tenantId } },
      data: { grantSettings: false },
    });
    adminClinical = await addPractitioner(db, C, "ADMIN");
    for (const [k, T] of [["S", S], ["N", N], ["C", C]] as const) {
      const kine = await addPractitioner(db, T, "PRACTITIONER");
      // Uno asignado al Titular (default de la factory), uno a otro kine, uno sin asignar.
      pats[k] = [
        await addPatient(db, T, { notes: "Nota clínica privada" }),
        await addPatient(db, T, { assignedPractitionerId: kine.practitionerId }),
        await addPatient(db, T, { assignedPractitionerId: null }),
      ];
    }
  });

  afterAll(async () => {
    await S?.cleanup();
    await N?.cleanup();
    await C?.cleanup();
    await db?.$disconnect();
  });

  it("[PL-1b] un Titular no clínico ve la HC → admin (con y sin «Consultorio común»)", async () => {
    for (const k of ["S", "N"] as const) {
      const T = k === "S" ? S : N;
      asUser(T.userId);
      const actor = await getActor();
      for (const id of pats[k]) expect(await patientAccessFor(actor, id)).toBe("admin");
      const bulk = await bulkPatientAccess(actor, pats[k]);
      expect(pats[k].map((id) => bulk.get(id))).toEqual(["admin", "admin", "admin"]);
      const vis = await visibilityForActor(actor);
      expect(vis.seesAll).toBe(false);
      expect(vis.adminView).toBe(true);
      for (const id of pats[k]) {
        const err = await runWithRls(actor.tenantId, (tx) => hcAccessError(actor, id, tx));
        expect(err).toBe("No tenés acceso completo a este paciente.");
      }
    }
  });

  it("Administrador/a no clínico → admin, sin clinical.read ni tenant.admin propio (ADMIN sin grantSettings)", async () => {
    asUser(adminNoClinical.userId);
    const actor = await getActor();
    for (const id of pats.N) expect(await patientAccessFor(actor, id)).toBe("admin");
    const bulk = await bulkPatientAccess(actor, pats.N);
    expect(pats.N.map((id) => bulk.get(id))).toEqual(["admin", "admin", "admin"]);
    expect((await visibilityForActor(actor)).adminView).toBe(true);
    const caps = await capabilitiesForActor(actor);
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("plans.manage")).toBe(false);
    expect(caps.has("tenant.admin")).toBe(false);
    expect(caps.has("account.billing")).toBe(false);
  });

  it("capacidades del Titular no clínico: account.* y Configuración sí, clínico no", async () => {
    asUser(N.userId);
    const caps = await capabilitiesForActor(await getActor());
    expect(caps.has("account.owner")).toBe(true);
    expect(caps.has("account.billing")).toBe(true);
    expect(caps.has("tenant.admin")).toBe(true);
    expect(caps.has("agenda.operateAll")).toBe(true);
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("plans.manage")).toBe(false);
  });

  it("controles: el Titular clínico sigue en full; un Administrador/a legado con clinical = true ya no (PL-Z M1)", async () => {
    asUser(C.userId);
    const owner = await getActor();
    for (const id of pats.C) expect(await patientAccessFor(owner, id)).toBe("full");
    const ov = await visibilityForActor(owner);
    expect(ov.seesAll).toBe(true);
    expect(ov.adminView).toBe(false);
    expect((await capabilitiesForActor(owner)).has("clinical.read")).toBe(true);

    // PL-Z M1: el Administrador/a nunca atiende (§20.17), aunque la fila diga `clinical = true` (M8b las normaliza
    // antes del deploy): ve como la Secretaria.
    asUser(adminClinical.userId);
    const admin = await getActor();
    const bulk = await bulkPatientAccess(admin, pats.C);
    expect(pats.C.map((id) => bulk.get(id))).toEqual(["admin", "admin", "admin"]);
    expect((await capabilitiesForActor(admin)).has("clinical.read")).toBe(false);
  });
});
