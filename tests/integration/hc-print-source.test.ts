/**
 * [FC-2e] `loadHcPrintSourceInTx` contra la base real (C-FC4): completa la fuente imprimible con consultorio, sede,
 * paciente, honorífico y firma de cada autor. Corre con los dos roles (`kinesoft_app` con RLS y el owner BYPASSRLS =
 * prod): con BYPASSRLS lo ajeno tiene que seguir sin salir por el `tenantId` a mano.
 *
 * Las filas de las entradas las pasa el caller (el loader es neutral y no lee la tabla de notas): acá son sintéticas,
 * con autores reales del consultorio y uno de OTRO consultorio (no tiene que filtrar ni su honorífico ni su firma).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { loadHcPrintSourceInTx, type HcPrintEntryRow } from "@/lib/hc-print-internal";
import { runWithRls } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { addPatient, addPractitioner, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

function row(over: Partial<HcPrintEntryRow>): HcPrintEntryRow {
  return {
    id: "r1",
    parentId: null,
    revision: 1,
    label: "Ficha",
    title: "Control",
    occurredAt: new Date("2026-10-10T13:00:00Z"),
    createdAt: new Date("2026-10-10T14:00:00Z"),
    body: "Texto",
    bodyDoc: null,
    diagnoses: null,
    authorName: "Ana Pérez",
    authorPractitionerId: null,
    authorLicense: "MN 1234",
    importSource: null,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

describe.skipIf(!RUN)("[FC-2e] loadHcPrintSourceInTx", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let Other: EphemeralTenant;
  let patientId: string;
  let otherPatientId: string;
  let proA: string;
  let proB: string;
  let branchId: string;
  const actorOf = (t: EphemeralTenant) => ({ tenantId: t.tenantId, userId: t.userId }) as unknown as Actor;

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, {});
    Other = await createEphemeralTenant(db, {});
    proA = (await addPractitioner(db, K)).practitionerId;
    proB = (await addPractitioner(db, K)).practitionerId;
    await db.practitioner.update({ where: { id: proA }, data: { honorific: "LIC", signatureStorageKey: `${K.tenantId}/signature/${proA}/n.png`, signatureUpdatedAt: new Date() } });
    await db.practitioner.update({ where: { id: Other.practitionerId }, data: { honorific: "DRA", signatureStorageKey: "otro/firma.png", signatureUpdatedAt: new Date() } });
    await db.tenant.update({ where: { id: K.tenantId }, data: { name: "Consultorio Ñandú", phone: "11 4444-0000", logoStorageKey: `${K.tenantId}/logo/n.png`, logoUpdatedAt: new Date() } });
    await db.location.create({ data: { tenantId: K.tenantId, name: "Principal", address: "Av. Siempreviva 742", city: "Córdoba", phone: "351 555-0000", isPrimary: true } });
    branchId = (await db.location.create({ data: { tenantId: K.tenantId, name: "Sucursal", address: "Calle 2", city: "Rosario", isPrimary: false } })).id;
    patientId = await addPatient(db, K, { firstName: "Juan", lastName: "Gómez", documentId: `30${Date.now() % 1000000}` });
    await db.patient.update({ where: { id: patientId }, data: { dateOfBirth: new Date("1980-01-02T00:00:00Z") } });
    otherPatientId = await addPatient(db, Other, { firstName: "Ajeno", lastName: "Otro" });
  });

  afterAll(async () => {
    await K?.cleanup();
    await Other?.cleanup();
  });

  it("membrete con la sede principal, paciente, autores y claves de assets del tenant", async () => {
    const rows = [
      row({ id: "am", parentId: "r1", authorPractitionerId: proB, authorName: "Beto", occurredAt: new Date("2026-10-12T13:00:00Z") }),
      row({ id: "r2", occurredAt: new Date("2026-10-11T13:00:00Z"), authorPractitionerId: proB, createdAt: new Date("2026-10-13T14:00:00Z") }),
      row({ id: "r1", authorPractitionerId: proA, diagnoses: [{ v: 1, source: "icd11", refId: "x", code: "FA20.0", title: "Lumbalgia", uri: "u", release: "r" }, { bogus: true }] }),
      row({ id: "huérfana", parentId: "no-vino" }),
    ];
    const src = await runWithRls(K.tenantId, (tx) => loadHcPrintSourceInTx(tx, actorOf(K), { patientId, rows, truncated: true }));
    expect(src).not.toBeNull();
    expect(src!.tenant).toEqual({ name: "Consultorio Ñandú", addressLine: "Av. Siempreviva 742, Córdoba", phone: "351 555-0000", hasLogo: true });
    expect(src!.patient).toMatchObject({ firstName: "Juan", lastName: "Gómez", dateOfBirth: "1980-01-02" });
    expect(src!.truncated).toBe(true);
    // Raíces en orden cronológico, la enmienda bajo su raíz, la huérfana afuera.
    expect(src!.entries.map((e) => [e.root.id, e.amendments.map((a) => a.id)])).toEqual([["r1", ["am"]], ["r2", []]]);
    const r1 = src!.entries[0].root;
    expect(r1).toMatchObject({ authorHonorific: "LIC", authorHasSignature: true, authorPractitionerId: proA, lateEntry: false });
    expect(r1.diagnoses).toHaveLength(1);
    expect(src!.entries[1].root).toMatchObject({ authorHonorific: null, authorHasSignature: false, lateEntry: true });
    expect(src!.assetKeys).toEqual({ logoKey: `${K.tenantId}/logo/n.png`, signatureKeys: { [proA]: `${K.tenantId}/signature/${proA}/n.png` } });
  });

  it("con locationId usa la sede del turno (y su teléfono, o el del consultorio)", async () => {
    const src = await runWithRls(K.tenantId, (tx) => loadHcPrintSourceInTx(tx, actorOf(K), { patientId, rows: [], locationId: branchId }));
    expect(src!.tenant).toMatchObject({ addressLine: "Calle 2, Rosario", phone: "11 4444-0000" });
    expect(src!.entries).toEqual([]);
  });

  it("autor de otro consultorio en las filas: sin honorífico ni firma (no cruza tenants)", async () => {
    const rows = [row({ authorPractitionerId: Other.practitionerId })];
    const src = await runWithRls(K.tenantId, (tx) => loadHcPrintSourceInTx(tx, actorOf(K), { patientId, rows }));
    expect(src!.entries[0].root).toMatchObject({ authorHonorific: null, authorHasSignature: false, authorPractitionerId: null });
    expect(Object.values(src!.assetKeys!.signatureKeys)).not.toContain("otro/firma.png");
  });

  it("paciente de otro consultorio → null", async () => {
    const src = await runWithRls(K.tenantId, (tx) => loadHcPrintSourceInTx(tx, actorOf(K), { patientId: otherPatientId, rows: [] }));
    expect(src).toBeNull();
  });
});
