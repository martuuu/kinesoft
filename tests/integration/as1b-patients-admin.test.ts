/**
 * T3c-1b (plan §23.5, C-AS1 `patients.editAdmin`) — la Secretaria y el Admin operan la ficha administrativa.
 *
 * Contrato:
 *  - `updatePatient`: rama `full` como antes; rama `admin` + `patients.editAdmin` (OWNER, ADMIN, ASSISTANT) con lista
 *    cerrada (nombre, apellido, email, teléfono, DNI, nacimiento; `PatientAdminUpdate.strict()`). Cualquier clave
 *    clínica (`notes`, `diagnosisTitle`, `diagnosisNote`) → rechazo SIN escribir «Las notas y el diagnóstico los edita
 *    el profesional a cargo.». BILLING (admin sin `editAdmin`) no edita.
 *  - `setPatientCoverage` / `setPatientDefaultCopago`: `full` o `admin` + `editAdmin`. `getPatientBillingPreview`:
 *    `full` o `admin` (BILLING incluido).
 *  - `listPatients`: proyección `admin` con contacto, nacimiento, DNI, obra social y próximo turno; sin notas, planes
 *    ni última visita.
 *  - `createPatient` / `assignPatientToPractitioner`: el profesional elegido tiene que ser reservable y no estar
 *    deshabilitado (`bookablePractitionerWhere(..., { includeDisabledFilter: true })`).
 *  - Pedidos del portal: deciden `full` o `admin` + `editAdmin` (Facturación afuera).
 *  - `proposePayerPlan`: `patients.editAdmin` o `clinical.read`.
 *
 * Símbolos reales contra la DB; solo se mockea la sesión de Supabase (integration-setup). Corre con los dos roles
 * (`kinesoft_app` con RLS y owner BYPASSRLS). Los controles positivos (Secretaria/Admin que SÍ pueden) evitan el falso
 * verde de «todo se rechaza».
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  assignPatientToPractitioner,
  createPatient,
  getPatientBillingPreview,
  listPatients,
  setPatientCoverage,
  setPatientDefaultCopago,
  updatePatient,
} from "@/lib/patients";
import { exportPatientsCsv } from "@/lib/patients-export-internal";
import { getActor } from "@/lib/session";
import { decidePatientPortalRequest, listPatientPortalRequests } from "@/lib/patient-portal-requests";
import { proposePayerPlan } from "@/lib/catalog";
import { matchKey } from "@/lib/catalog/normalize";
import {
  ownerClient,
  createEphemeralTenant,
  addInsurer,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanBooking, createPlan } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const CLINICAL_COPY = "Las notas y el diagnóstico los edita el profesional a cargo.";

// `Patient.phone` es único por consultorio: cada teléfono del test es distinto.
let phoneSeq = Math.floor(Math.random() * 1_000_000);
const ph = () => `11${String(++phoneSeq).padStart(8, "0")}`;

type Staff = { userId: string; practitionerId: string };

describe.skipIf(!RUN)("[AS-1b] pacientes editados por Secretaria/Admin, portal y catálogo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let sec: Staff;
  let billing: Staff;
  let admin: Staff;
  let kine: Staff;
  let disabledKine: Staff;
  const payerIds: string[] = [];
  const portalUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    sec = await addPractitioner(db, A, "ASSISTANT");
    billing = await addPractitioner(db, A, "BILLING");
    admin = await addPractitioner(db, A, "ADMIN");
    // ADMIN de hoy (§20.17): no atiende. La factory lo crea con la forma vieja (`clinical` default); se normaliza.
    await db.membership.update({
      where: { userId_tenantId: { userId: admin.userId, tenantId: A.tenantId } },
      data: { clinical: false },
    });
    kine = await addPractitioner(db, A, "PRACTITIONER");
    disabledKine = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: disabledKine.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    if (db) {
      if (portalUsers.length) await db.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
      await db.payerPlan.deleteMany({ where: { payerId: { in: payerIds } } });
      await db.payer.deleteMany({ where: { id: { in: payerIds } } });
      await db.$disconnect();
    }
  });

  const clinicalPatient = () =>
    addPatient(db, A, { phone: ph(), email: `p-${uniqueSuffix()}@test.local`, notes: "Lumbalgia crónica" });

  /** Ficha con cuenta del portal vinculada (`Patient.userId`): el email ya no decide el vínculo. */
  const linkedPatient = async () => {
    const id = await clinicalPatient();
    const userId = `test-user-t3zs1-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local` } });
    portalUsers.push(userId);
    await db.patient.update({ where: { id }, data: { userId } });
    return id;
  };

  const snapshot = (id: string) =>
    db.patient.findUniqueOrThrow({
      where: { id },
      select: {
        firstName: true,
        phone: true,
        email: true,
        documentId: true,
        notes: true,
        diagnosisTitle: true,
        diagnosisNote: true,
        updatedAt: true,
        assignedPractitionerId: true,
      },
    });

  // ── updatePatient ──────────────────────────────────────────────────────

  it("[AS-1b] la Secretaria edita teléfono, email, DNI y nacimiento con lock optimista; las notas quedan", async () => {
    const id = await clinicalPatient();
    const before = await snapshot(id);
    asUser(sec.userId);
    const dni = `S1B-${uniqueSuffix()}`;
    const newPhone = ph();
    const r = await updatePatient({
      id,
      phone: newPhone,
      documentId: dni,
      dateOfBirth: "1990-04-02",
      expectedUpdatedAt: before.updatedAt.toISOString(),
    });
    if (!r.ok) throw new Error(r.error);
    const after = await db.patient.findUniqueOrThrow({ where: { id } });
    expect(after.phone).toBe(newPhone);
    expect(after.documentId).toBe(dni);
    expect(after.dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-04-02");
    expect(after.notes).toBe("Lumbalgia crónica");
    expect(r.data.updatedAt).toBe(after.updatedAt.toISOString());

    // Lock optimista: el `updatedAt` viejo ya no vale.
    const stale = await updatePatient({ id, phone: ph(), expectedUpdatedAt: before.updatedAt.toISOString() });
    expect(stale.ok).toBe(false);
    expect((await db.patient.findUniqueOrThrow({ where: { id } })).phone).toBe(newPhone);
  });

  it("[AS-1b] la Secretaria NO edita notas ni diagnóstico: rechazo sin escribir (tampoco el teléfono que venía junto)", async () => {
    const id = await clinicalPatient();
    const before = await snapshot(id);
    asUser(sec.userId);
    for (const clinical of [
      { notes: "Pisada" },
      { diagnosisTitle: "Otro" },
      { diagnosisNote: "" }, // vaciar también es escribir
    ]) {
      const r = await updatePatient({ id, phone: ph(), ...clinical });
      expect(r).toEqual({ ok: false, error: CLINICAL_COPY });
    }
    expect(await snapshot(id)).toEqual(before);
  });

  it("[AS-1b] la rama admin es lista cerrada: una clave fuera de la lista → rechazo sin escribir", async () => {
    const id = await clinicalPatient();
    const before = await snapshot(id);
    asUser(sec.userId);
    const r = await updatePatient({ id, phone: ph(), assignedPractitionerId: sec.practitionerId } as never);
    expect(r.ok).toBe(false);
    expect(await snapshot(id)).toEqual(before);
  });

  it("[AS-1b] BILLING no edita la ficha (ni contacto)", async () => {
    const id = await clinicalPatient();
    const before = await snapshot(id);
    asUser(billing.userId);
    const r = await updatePatient({ id, phone: ph() });
    expect(r.ok).toBe(false);
    expect(await snapshot(id)).toEqual(before);
  });

  it("[AS-1b] el Admin no clínico edita contacto y tampoco toca notas", async () => {
    const id = await clinicalPatient();
    asUser(admin.userId);
    const email = `nuevo-${uniqueSuffix()}@test.local`;
    const phone = ph();
    const r = await updatePatient({ id, email: email.toUpperCase(), phone, firstName: "Ana" });
    if (!r.ok) throw new Error(r.error);
    const after = await snapshot(id);
    expect(after).toMatchObject({ email, phone, firstName: "Ana", notes: "Lumbalgia crónica" });
    expect(await updatePatient({ id, notes: "x" })).toEqual({ ok: false, error: CLINICAL_COPY });
  });

  // T3-Y (decisión de Martin 19-oct, «Justamente es labor de la secretaria poder cargar y modificar emails»): se
  // revierte el bloqueo de T3-Z A1. La red contra el auto-vínculo equivocado del portal es PD-15 (email verificado y
  // exactamente una ficha), no la edición de la ficha.
  it("[T3-Y] la Secretaria cambia el email de una ficha sin portal → ok y queda normalizado", async () => {
    const id = await clinicalPatient();
    asUser(sec.userId);
    const email = `nuevo-${uniqueSuffix()}@test.local`;
    const phone = ph();
    const r = await updatePatient({ id, email: `  ${email.toUpperCase()} `, phone });
    if (!r.ok) throw new Error(r.error);
    expect(await snapshot(id)).toMatchObject({ email, phone, notes: "Lumbalgia crónica" });
    // Vaciarlo también vale (lista cerrada `PatientAdminUpdate`: `""` = borrar).
    const cleared = await updatePatient({ id, email: "" });
    if (!cleared.ok) throw new Error(cleared.error);
    expect((await snapshot(id)).email).toBeNull();
  });

  it("[T3Z-s1] la Secretaria cambia el email de una ficha vinculada al portal", async () => {
    const id = await linkedPatient();
    asUser(sec.userId);
    const email = `vinc-${uniqueSuffix()}@test.local`;
    const r = await updatePatient({ id, email });
    if (!r.ok) throw new Error(r.error);
    expect((await snapshot(id)).email).toBe(email);
  });

  it("[T3Z-s1] control: la rama full (titular) cambia el email de una ficha sin vincular", async () => {
    const id = await clinicalPatient();
    asUser(A.userId);
    const email = `full-${uniqueSuffix()}@test.local`;
    const r = await updatePatient({ id, email });
    if (!r.ok) throw new Error(r.error);
    expect((await snapshot(id)).email).toBe(email);
  });

  it("[AS-1b] control: el titular (full) sigue editando notas", async () => {
    const id = await clinicalPatient();
    asUser(A.userId);
    const r = await updatePatient({ id, notes: "Mejoró" });
    if (!r.ok) throw new Error(r.error);
    expect((await snapshot(id)).notes).toBe("Mejoró");
  });

  // ── export CSV ─────────────────────────────────────────────────────────

  // T3-Z M1: el CSV salía con email y teléfono para todo `admin`; Facturación (sin `patients.editAdmin`) no ve los
  // contactos en la ficha, así que tampoco los baja en masa. Secretaria y Admin (editAdmin) sí.
  it("[T3Z-s1] exportPatientsCsv: Facturación sin email ni teléfono; la Secretaria con contactos; audit con adminCount", async () => {
    const tag = uniqueSuffix();
    const phone = ph();
    const email = `csv-${tag}@test.local`;
    const id = await addPatient(db, A, { lastName: `Csv ${tag}`, phone, email });

    asUser(billing.userId);
    const csvBilling = await exportPatientsCsv(await getActor(), { ids: [id] });
    const lineBilling = csvBilling.split("\n").find((l) => l.includes(id))!;
    expect(lineBilling).toContain(`Csv ${tag}`);
    expect(lineBilling).not.toContain(email);
    expect(lineBilling).not.toContain(phone);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, actorId: billing.userId, action: "patient.export" },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    expect(audit.payload).toMatchObject({ count: 1, adminCount: 1 });

    asUser(sec.userId);
    const lineSec = (await exportPatientsCsv(await getActor(), { ids: [id] })).split("\n").find((l) => l.includes(id))!;
    expect(lineSec).toContain(email);
    expect(lineSec).toContain(phone);
  });

  // ── cobertura, copago propio y preview ─────────────────────────────────

  it("[AS-1b] la Secretaria carga cobertura y copago propio; BILLING no", async () => {
    const osde = await addInsurer(db, A, { name: `OSDE ${uniqueSuffix()}`, copagoCents: 300_000 });
    const id = await clinicalPatient();

    asUser(billing.userId);
    expect((await setPatientCoverage({ patientId: id, insurerId: osde, memberId: "77" })).ok).toBe(false);
    expect((await setPatientDefaultCopago({ patientId: id, copagoCents: 120_000 })).ok).toBe(false);
    expect(await db.coverage.count({ where: { patientId: id } })).toBe(0);

    asUser(sec.userId);
    const cov = await setPatientCoverage({ patientId: id, insurerId: osde, memberId: "77" });
    if (!cov.ok) throw new Error(cov.error);
    const cop = await setPatientDefaultCopago({ patientId: id, copagoCents: 120_000 });
    if (!cop.ok) throw new Error(cop.error);
    expect(await db.coverage.findFirstOrThrow({ where: { patientId: id } })).toMatchObject({
      insurerId: osde,
      memberId: "77",
      copagoCents: 120_000,
    });
    const audits = await db.auditEvent.findMany({
      where: { tenantId: A.tenantId, entityId: id, action: { in: ["patient.coverage.update", "patient.copago.update"] } },
      select: { action: true, actorId: true },
    });
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorId === sec.userId)).toBe(true);
  });

  it("[AS-1b] preview de copago: Secretaria y BILLING lo ven (admin), un kine en básico no", async () => {
    const osde = await addInsurer(db, A, { name: `OS ${uniqueSuffix()}`, copagoCents: 250_000 });
    const id = await clinicalPatient();
    await db.coverage.create({ data: { patientId: id, insurer: "OS", insurerId: osde } });

    asUser(sec.userId);
    expect(await getPatientBillingPreview(id)).toMatchObject({ copagoCents: 250_000, source: "OS" });
    asUser(billing.userId);
    expect(await getPatientBillingPreview(id)).toMatchObject({ copagoCents: 250_000, source: "OS" });
    asUser(kine.userId); // paciente del titular, sin share ni consultorio común → básico
    expect(await getPatientBillingPreview(id)).toBeNull();
  });

  // ── listPatients ───────────────────────────────────────────────────────

  it("[AS-1b] listPatients proyección admin: contacto, DNI, nacimiento, OS y próximo turno; sin notas, planes ni última visita", async () => {
    const tag = uniqueSuffix();
    const osde = await addInsurer(db, A, { name: `OSDE-${tag}` });
    const listPhone = ph();
    const id = await addPatient(db, A, {
      lastName: `Lista ${tag}`,
      phone: listPhone,
      email: `l-${tag}@test.local`,
      notes: "Nota clínica",
    });
    await db.patient.update({ where: { id }, data: { dateOfBirth: new Date("1985-01-20") } });
    await db.coverage.create({ data: { patientId: id, insurer: `OSDE-${tag}`, insurerId: osde } });
    await createPlan(db, A, { patientId: id, sessions: 2 });
    const upcoming = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    await addPlanBooking(db, A, { patientId: id, scheduledFor: upcoming });

    asUser(sec.userId);
    const row = (await listPatients({ q: tag })).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      access: "admin",
      email: `l-${tag}@test.local`,
      phone: listPhone,
      obraSocial: `OSDE-${tag}`,
      notes: null,
      activePlans: [],
      activeProgramTitle: null,
      sessionsTotal: 0,
      sessionsDone: 0,
      lastVisit: null,
    });
    expect(row!.documentId).toBeTruthy();
    expect(row!.dateOfBirth?.toISOString().slice(0, 10)).toBe("1985-01-20");
    expect(+row!.upcomingAt!).toBe(+upcoming);

    // Control: el titular (full) ve las notas y el plan.
    asUser(A.userId);
    const full = (await listPatients({ q: tag })).find((r) => r.id === id);
    expect(full).toMatchObject({ access: "full", notes: "Nota clínica" });
    expect(full!.activePlans).toHaveLength(1);
  });

  // ── pedidos del portal ─────────────────────────────────────────────────

  it("[AS-1b] pedido del portal: BILLING no lo decide (sin escribir); la Secretaria sí", async () => {
    const oldPhone = ph();
    const newPhone = ph();
    const id = await addPatient(db, A, { phone: oldPhone });
    const req = await db.patientChangeRequest.create({
      data: { tenantId: A.tenantId, patientId: id, changes: { phone: newPhone }, requestedByUserId: null },
    });

    asUser(billing.userId);
    const denied = await decidePatientPortalRequest({
      id: req.id,
      expectedUpdatedAt: req.updatedAt.toISOString(),
      decision: "APPROVE",
    });
    expect(denied.ok).toBe(false);
    expect(await db.patientChangeRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({
      status: "PENDING",
      decidedById: null,
    });
    expect((await db.patient.findUniqueOrThrow({ where: { id } })).phone).toBe(oldPhone);
    // Ver el pedido sigue abierto a todo `admin` (lectura, como el perfil): lo que se cierra es decidir.
    const listed = await listPatientPortalRequests({ patientId: id });
    expect(listed.ok && listed.data.map((x) => x.id)).toEqual([req.id]);

    asUser(sec.userId);
    const ok = await decidePatientPortalRequest({
      id: req.id,
      expectedUpdatedAt: req.updatedAt.toISOString(),
      decision: "APPROVE",
    });
    if (!ok.ok) throw new Error(ok.error);
    expect((await db.patient.findUniqueOrThrow({ where: { id } })).phone).toBe(newPhone);
    expect((await db.patientChangeRequest.findUniqueOrThrow({ where: { id: req.id } })).decidedById).toBe(sec.userId);
  });

  // ── profesional deshabilitado ──────────────────────────────────────────

  it("[AS-1b] createPatient con assignTo a un profesional deshabilitado → rechazo, no se crea nada; reservable → ok", async () => {
    asUser(sec.userId);
    const dni = `S1B-D-${uniqueSuffix()}`;
    const r = await createPatient({ firstName: "Dis", lastName: "Abled", documentId: dni }, { assignTo: disabledKine.practitionerId });
    expect(r.ok).toBe(false);
    expect(await db.patient.count({ where: { tenantId: A.tenantId, documentId: dni } })).toBe(0);

    const ok = await createPatient({ firstName: "En", lastName: "Abled", documentId: dni }, { assignTo: kine.practitionerId });
    if (!ok.ok) throw new Error(ok.error);
    expect((await db.patient.findUniqueOrThrow({ where: { id: ok.data.id } })).assignedPractitionerId).toBe(kine.practitionerId);
  });

  it("[AS-1b] reasignar a un profesional deshabilitado → rechazo sin escribir", async () => {
    const id = await addPatient(db, A);
    asUser(A.userId);
    const r = await assignPatientToPractitioner({ patientId: id, practitionerId: disabledKine.practitionerId });
    expect(r.ok).toBe(false);
    expect((await snapshot(id)).assignedPractitionerId).toBe(A.practitionerId);
    // Control: a un profesional reservable sí.
    const ok = await assignPatientToPractitioner({ patientId: id, practitionerId: kine.practitionerId });
    expect(ok.ok).toBe(true);
    expect((await snapshot(id)).assignedPractitionerId).toBe(kine.practitionerId);
  });

  // ── proposePayerPlan ───────────────────────────────────────────────────

  it("[AS-1b] proposePayerPlan: BILLING → rechazo sin escribir; Secretaria (editAdmin) y kine (clinical.read) sí", async () => {
    const name = `Prestadora ${uniqueSuffix()}`;
    const payer = await db.payer.create({
      data: {
        slug: `test-payer-${uniqueSuffix()}`,
        name,
        kind: "OBRA_SOCIAL",
        matchKey: matchKey(name),
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
      select: { id: true },
    });
    payerIds.push(payer.id);

    asUser(billing.userId);
    expect((await proposePayerPlan(payer.id, "Plan Facturación")).ok).toBe(false);
    expect(await db.payerPlan.count({ where: { payerId: payer.id } })).toBe(0);

    asUser(sec.userId);
    const bySec = await proposePayerPlan(payer.id, "Plan Secretaria");
    if (!bySec.ok) throw new Error(bySec.error);
    asUser(kine.userId);
    const byKine = await proposePayerPlan(payer.id, "Plan Kine");
    if (!byKine.ok) throw new Error(byKine.error);
    expect(await db.payerPlan.count({ where: { payerId: payer.id, tenantId: A.tenantId } })).toBe(2);
  });
});
