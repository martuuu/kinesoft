/**
 * [CF-A1..5] CF (§28, M20) — lecturas del staff y setters de las reglas de agenda, contra Postgres en los dos roles
 * (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Contrato (brief CF A.7 + CF-D3/D6/D11):
 *   - `listAvailableSlots`: paso = `q.stepMin` ?? el del profesional ?? el del consultorio ?? 15, POR profesional
 *     (en "any" cada `AnyPractitionerSlot` trae su `stepMin`). Con la regla de servicio exclusivo (el default,
 *     `allowParallelServices = false`) el slot que pisa OTRO servicio de OTRO paciente sale `available: false` con
 *     razón `otro-servicio` (el staff lo puede forzar como sobreturno); el mismo paciente no cuenta (CF-D3).
 *   - `classifyBookingInstant` informa `otherServiceBusy` / `otherServiceId`; `previewRecurrence`, `otherServiceBusy`
 *     por fecha. Sin la regla (toggle encendido) no aparecen las claves nuevas.
 *   - `setTenantAgendaRules` (`tenant.admin` + soporte) y `setPractitionerAgendaRules` (`schedule.configure` +
 *     profesional reservable): FOR UPDATE, no-op sin audit si el valor no cambia, audit en la misma tx, error legible
 *     con el copy de `AGENDA_RULES_COPY` (no un 500 del CHECK de M20).
 *
 * Símbolos reales; se mockea solo la cookie (`asUser`). `withSupportWritable` tira con un nombre fuera de
 * `SUPPORT_WRITABLE_ACTIONS` (lib/support-writable.ts, de otra sesión): hasta que el integrador sume los dos nombres
 * (handoff de CF-A) el mock deja pasar SOLO esos dos y para todo lo demás llama al real (precedente: as2c).
 * Fechas de nov 2027 (mar = 2027-11-02), sin franjas: fallback del consultorio 08-19 lun-sáb.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("@/lib/support-writable", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/support-writable")>();
  const PENDING = new Set([
    "lib/tenant-settings.ts#setTenantAgendaRules",
    "lib/practitioner-schedule.ts#setPractitionerAgendaRules",
  ]);
  return {
    ...real,
    withSupportWritable: <T,>(name: string, fn: () => Promise<T>) =>
      PENDING.has(name) && !real.SUPPORT_WRITABLE_ACTIONS.has(name) ? fn() : real.withSupportWritable(name, fn),
  };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { classifyBookingInstant, listAvailableSlots, previewRecurrence } from "@/lib/availability-actions";
import { setTenantAgendaRules } from "@/lib/tenant-settings";
import { setPractitionerAgendaRules } from "@/lib/practitioner-schedule";
import { AGENDA_RULES_COPY } from "@/lib/agenda-rules-config";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ar = (local: string) => new Date(`${local}:00-03:00`);
const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });

describe.skipIf(!RUN)("[CF-A] reglas de agenda: lecturas del staff y setters", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let svcA: string; // 30'
  let svcB: string; // 30'
  let P30: { userId: string; practitionerId: string }; // paso propio 30
  let PInh: { userId: string; practitionerId: string }; // hereda el del consultorio (45)
  let PEx: { userId: string; practitionerId: string }; // servicio exclusivo (default)
  let PPar: { userId: string; practitionerId: string }; // atiende servicios distintos a la vez
  let suspended: { userId: string; practitionerId: string };
  let secWith: string;
  let secWithout: string;

  const audits = (action: string, entityId: string) =>
    db.auditEvent.findMany({ where: { tenantId: A.tenantId, action, entityId }, orderBy: { createdAt: "asc" } });
  const tenantRules = () =>
    db.tenant.findUniqueOrThrow({
      where: { id: A.tenantId },
      select: { agendaSlotStepMin: true, publicSlotStepMin: true, publicMinLeadMinutes: true },
    });
  const pracRules = (id: string) =>
    db.practitioner.findUniqueOrThrow({
      where: { id },
      select: { allowParallelServices: true, agendaSlotStepMin: true, publicSlotStepMin: true },
    });

  async function mk(o: { prac: string; when: Date; svc: string; patientId?: string; dur?: number }) {
    const patientId = o.patientId ?? (await addPatient(db, A));
    await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: o.prac,
        serviceId: o.svc,
        patientId,
        scheduledFor: o.when,
        durationMin: o.dur ?? 30,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    return patientId;
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    svcA = (
      await db.service.create({ data: { tenantId: A.tenantId, practitionerId: null, name: "Kine", durationMin: 30, priceCents: 0 } })
    ).id;
    svcB = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Evaluación", durationMin: 30, priceCents: 0 },
      })
    ).id;
    P30 = await addPractitioner(db, A);
    PInh = await addPractitioner(db, A);
    PEx = await addPractitioner(db, A);
    PPar = await addPractitioner(db, A, "PRACTITIONER", { allowParallelServices: true });
    suspended = await addPractitioner(db, A);
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
    secWith = (await addStaff(db, A, "ASSISTANT", { grantSettings: true })).userId;
    secWithout = (await addStaff(db, A, "ASSISTANT")).userId;
    await db.tenant.update({ where: { id: A.tenantId }, data: { agendaSlotStepMin: 45 } });
    await db.practitioner.update({ where: { id: P30.practitionerId }, data: { agendaSlotStepMin: 30 } });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => asUser(A.userId));

  // ── [CF-A1] paso de la grilla ──────────────────────────────────────────────

  it("[CF-A1] profesional con paso 30: horarios cada 30; el que no tiene paso hereda el 45 del consultorio", async () => {
    const r30 = await listAvailableSlots({ practitionerId: P30.practitionerId, serviceId: svcA, dayKey: "2027-11-02" });
    if (!r30.ok || r30.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    expect(r30.data.stepMin).toBe(30);
    expect(r30.data.slots.slice(0, 4).map((s) => hhmm(s.iso))).toEqual(["08:00", "08:30", "09:00", "09:30"]);

    const r45 = await listAvailableSlots({ practitionerId: PInh.practitionerId, serviceId: svcA, dayKey: "2027-11-02" });
    if (!r45.ok || r45.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    expect(r45.data.stepMin).toBe(45);
    expect(r45.data.slots.slice(0, 3).map((s) => hhmm(s.iso))).toEqual(["08:00", "08:45", "09:30"]);

    // El pedido explícito (`stepMin`) gana sobre la regla.
    const r15 = await listAvailableSlots({ practitionerId: P30.practitionerId, serviceId: svcA, dayKey: "2027-11-02", stepMin: 15 });
    if (!r15.ok || r15.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    expect(r15.data.stepMin).toBe(15);
    expect(hhmm(r15.data.slots[1].iso)).toBe("08:15");
  });

  it("[CF-A1] «cualquiera»: cada profesional trae su paso", async () => {
    const r = await listAvailableSlots({ practitionerId: "any", serviceId: svcA, dayKey: "2027-11-02" });
    if (!r.ok || r.data.mode !== "any") throw new Error("esperaba modo any");
    const by = Object.fromEntries(r.data.practitioners.map((p) => [p.practitionerId, p]));
    expect(by[P30.practitionerId]?.stepMin).toBe(30);
    expect(by[PInh.practitionerId]?.stepMin).toBe(45);
  });

  // ── [CF-A2] otro servicio en la grilla y en el aviso ───────────────────────

  // Paso 15 explícito: estos profesionales heredan el 45 del consultorio (08:00, 08:45, 09:30, 10:15…) y no habría
  // un slot a las 10:00.
  it("[CF-A2] con otro servicio pisado: slot `otro-servicio` y `otherServiceBusy`; el mismo paciente no cuenta", async () => {
    const owner = await mk({ prac: PEx.practitionerId, when: ar("2027-11-03T10:00"), svc: svcB });
    const other = await addPatient(db, A);

    const r = await listAvailableSlots({ practitionerId: PEx.practitionerId, serviceId: svcA, dayKey: "2027-11-03", stepMin: 15, patientId: other });
    if (!r.ok || r.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    const at10 = r.data.slots.find((s) => s.iso === ar("2027-11-03T10:00").toISOString());
    expect(at10).toMatchObject({ available: false, reason: "otro-servicio" });

    // CF-D3: el paciente del turno de otro servicio no choca consigo mismo por servicio (sí por paciente).
    const same = await listAvailableSlots({ practitionerId: PEx.practitionerId, serviceId: svcA, dayKey: "2027-11-03", stepMin: 15, patientId: owner });
    if (!same.ok || same.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    const s10 = same.data.slots.find((s) => s.iso === ar("2027-11-03T10:00").toISOString());
    expect(s10?.reason).not.toBe("otro-servicio");

    const c = await classifyBookingInstant({
      practitionerId: PEx.practitionerId,
      serviceId: svcA,
      scheduledFor: ar("2027-11-03T10:00").toISOString(),
      patientId: other,
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.data).toMatchObject({ class: "otro-servicio", otherServiceBusy: true, otherServiceId: svcB });

    const free = await classifyBookingInstant({
      practitionerId: PEx.practitionerId,
      serviceId: svcA,
      scheduledFor: ar("2027-11-03T11:00").toISOString(),
      patientId: other,
    });
    if (!free.ok) throw new Error(free.error);
    expect(free.data).toMatchObject({ class: "libre", otherServiceBusy: false, otherServiceId: null });
  });

  it("[CF-A2] con el toggle encendido no hay chip ni claves nuevas (conducta de antes)", async () => {
    await mk({ prac: PPar.practitionerId, when: ar("2027-11-03T10:00"), svc: svcB });
    const other = await addPatient(db, A);
    const r = await listAvailableSlots({ practitionerId: PPar.practitionerId, serviceId: svcA, dayKey: "2027-11-03", stepMin: 15, patientId: other });
    if (!r.ok || r.data.mode !== "practitioner") throw new Error("esperaba slots del profesional");
    const at10 = r.data.slots.find((s) => s.iso === ar("2027-11-03T10:00").toISOString());
    expect(at10).toMatchObject({ available: true });
    const c = await classifyBookingInstant({
      practitionerId: PPar.practitionerId,
      serviceId: svcA,
      scheduledFor: ar("2027-11-03T10:00").toISOString(),
      patientId: other,
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.data.class).toBe("libre");
    expect("otherServiceBusy" in c.data).toBe(false);
    expect("otherServiceId" in c.data).toBe(false);
  });

  // ── [CF-A3] serie ──────────────────────────────────────────────────────────

  it("[CF-A3] previewRecurrence marca `otherServiceBusy` por fecha (y la sube a sobreturno, CF-D4)", async () => {
    await mk({ prac: PEx.practitionerId, when: ar("2027-11-11T10:00"), svc: svcB });
    const patientId = await addPatient(db, A);
    const r = await previewRecurrence({
      practitionerId: PEx.practitionerId,
      serviceId: svcA,
      anchor: ar("2027-11-04T10:00").toISOString(),
      count: 2,
      frequency: "weekly",
      patientId,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.items.map((i) => [i.dayKey, i.otherServiceBusy, i.status])).toEqual([
      ["2027-11-04", undefined, "libre"],
      ["2027-11-11", true, "sobreturno"],
    ]);
  });

  // ── [CF-A4] setters ────────────────────────────────────────────────────────

  it("[CF-A4] consultorio: guarda y audita con el antes y el después; el mismo valor no audita", async () => {
    await db.tenant.update({ where: { id: A.tenantId }, data: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null } });
    const r = await setTenantAgendaRules({ agendaSlotStepMin: 30, publicSlotStepMin: null, publicMinLeadMinutes: 1440 });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await tenantRules()).toEqual({ agendaSlotStepMin: 30, publicSlotStepMin: null, publicMinLeadMinutes: 1440 });
    const ev = await audits("tenant.agenda_rules", A.tenantId);
    expect(ev.at(-1)?.payload).toEqual({
      from: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null },
      to: { agendaSlotStepMin: 30, publicSlotStepMin: null, publicMinLeadMinutes: 1440 },
    });
    expect(ev.at(-1)?.actorId).toBe(A.userId);

    const n = ev.length;
    expect(await setTenantAgendaRules({ agendaSlotStepMin: 30, publicSlotStepMin: null, publicMinLeadMinutes: 1440 })).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await audits("tenant.agenda_rules", A.tenantId)).toHaveLength(n);
    // Restaura el 45 del consultorio para los tests de la grilla si corren después.
    await db.tenant.update({ where: { id: A.tenantId }, data: { agendaSlotStepMin: 45, publicMinLeadMinutes: null } });
  });

  it("[CF-A4] consultorio: valor inválido → error legible con el campo, y la fila no cambia", async () => {
    const before = await tenantRules();
    expect(await setTenantAgendaRules({ agendaSlotStepMin: 20, publicSlotStepMin: null, publicMinLeadMinutes: null })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.agendaStep,
      fieldErrors: { agendaSlotStepMin: [AGENDA_RULES_COPY.agendaStep] },
    });
    expect(await setTenantAgendaRules({ agendaSlotStepMin: null, publicSlotStepMin: 7, publicMinLeadMinutes: null })).toMatchObject({
      ok: false,
      error: AGENDA_RULES_COPY.publicStep,
    });
    expect(await setTenantAgendaRules({ agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: 80_641 })).toMatchObject({
      ok: false,
      error: AGENDA_RULES_COPY.minLead,
    });
    expect(await tenantRules()).toEqual(before);
  });

  it("[CF-A4] profesional: guarda y audita; no-op sin audit; inválido legible", async () => {
    const id = PInh.practitionerId;
    const r = await setPractitionerAgendaRules(id, { allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 30 });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await pracRules(id)).toEqual({ allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 30 });
    const ev = await audits("practitioner.agenda_rules", id);
    expect(ev.at(-1)?.payload).toEqual({
      from: { allowParallelServices: false, agendaSlotStepMin: null, publicSlotStepMin: null },
      to: { allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 30 },
    });
    const n = ev.length;
    expect((await setPractitionerAgendaRules(id, { allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 30 })).ok).toBe(true);
    expect(await audits("practitioner.agenda_rules", id)).toHaveLength(n);

    expect(
      await setPractitionerAgendaRules(id, { allowParallelServices: "true" as unknown as boolean, agendaSlotStepMin: null, publicSlotStepMin: null })
    ).toMatchObject({ ok: false, error: AGENDA_RULES_COPY.allowParallel });
    expect(await setPractitionerAgendaRules(id, { allowParallelServices: false, agendaSlotStepMin: 10, publicSlotStepMin: null })).toMatchObject({
      ok: false,
      error: AGENDA_RULES_COPY.agendaStep,
    });
    expect(await pracRules(id)).toEqual({ allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 30 });

    // Vuelve a heredar (para el resto del archivo).
    expect((await setPractitionerAgendaRules(id, { allowParallelServices: false, agendaSlotStepMin: null, publicSlotStepMin: null })).ok).toBe(true);
    expect(await pracRules(id)).toEqual({ allowParallelServices: false, agendaSlotStepMin: null, publicSlotStepMin: null });
  });

  it("[CF-A4] profesional sin «Configuración» no cambia la regla de otro (ni la suya); cruce de tenant y suspendido = no encontrado", async () => {
    asUser(P30.userId);
    await expect(
      setPractitionerAgendaRules(PEx.practitionerId, { allowParallelServices: true, agendaSlotStepMin: null, publicSlotStepMin: null })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      setPractitionerAgendaRules(P30.practitionerId, { allowParallelServices: true, agendaSlotStepMin: 30, publicSlotStepMin: null })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setTenantAgendaRules({ agendaSlotStepMin: 60, publicSlotStepMin: null, publicMinLeadMinutes: null })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect((await pracRules(PEx.practitionerId)).allowParallelServices).toBe(false);

    asUser(A.userId);
    expect(
      await setPractitionerAgendaRules(B.practitionerId, { allowParallelServices: true, agendaSlotStepMin: null, publicSlotStepMin: null })
    ).toEqual({ ok: false, error: "Profesional no encontrado." });
    expect((await db.practitioner.findUniqueOrThrow({ where: { id: B.practitionerId } })).allowParallelServices).toBe(false);
    expect(
      await setPractitionerAgendaRules(suspended.practitionerId, { allowParallelServices: true, agendaSlotStepMin: null, publicSlotStepMin: null })
    ).toEqual({ ok: false, error: "Profesional no encontrado." });
    expect((await pracRules(suspended.practitionerId)).allowParallelServices).toBe(false);
  });

  // ── [CF-A5] Secretaría ─────────────────────────────────────────────────────

  it("[CF-A5] Secretaría con «Configuración» (`tenant.admin` / `schedule.configure`) puede; sin ella, no", async () => {
    asUser(secWith);
    expect((await setTenantAgendaRules({ agendaSlotStepMin: 45, publicSlotStepMin: 60, publicMinLeadMinutes: 120 })).ok).toBe(true);
    expect(await tenantRules()).toEqual({ agendaSlotStepMin: 45, publicSlotStepMin: 60, publicMinLeadMinutes: 120 });
    expect((await audits("tenant.agenda_rules", A.tenantId)).at(-1)?.actorId).toBe(secWith);
    expect((await setPractitionerAgendaRules(PInh.practitionerId, { allowParallelServices: false, agendaSlotStepMin: 30, publicSlotStepMin: null })).ok).toBe(true);
    expect((await pracRules(PInh.practitionerId)).agendaSlotStepMin).toBe(30);

    asUser(secWithout);
    await expect(setTenantAgendaRules({ agendaSlotStepMin: 15, publicSlotStepMin: null, publicMinLeadMinutes: null })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(
      setPractitionerAgendaRules(PInh.practitionerId, { allowParallelServices: true, agendaSlotStepMin: null, publicSlotStepMin: null })
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Deja todo como lo esperan los tests de la grilla.
    await db.tenant.update({ where: { id: A.tenantId }, data: { agendaSlotStepMin: 45, publicSlotStepMin: null, publicMinLeadMinutes: null } });
    await db.practitioner.update({ where: { id: PInh.practitionerId }, data: { agendaSlotStepMin: null } });
  });
});
