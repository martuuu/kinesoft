/**
 * B3.3 AV-actions — server actions de disponibilidad contra la DB real (rol
 * app con RLS en `test:integration`, owner BYPASSRLS = prod en `:owner`).
 * Corre en TZ=UTC: es lo que destapa un día/hora calculado con el reloj del
 * host en vez del AR.
 *
 * Lo que se protege:
 *   - authz: `agenda.viewAll` (BILLING ve; sin membresía no hay actor);
 *   - IDOR: profesional / servicio / sede / paciente / cobertura de otro
 *     tenant → error explícito (las FK y el loader filtran en silencio);
 *   - día bloqueado: candado, sin slots, clase "bloqueado" con el motivo;
 *   - "cualquier profesional": elegibilidad por PractitionerService y
 *     PractitionerPayer + hueco más temprano;
 *   - recurrencia mensual (fin de mes) y semanal en varias ventanas de carga;
 *   - sin PHI: ni nombre, ni notas, ni id del paciente en ninguna respuesta.
 *
 * Fixtures con el owner client (el código bajo test no siembra). Días fijos
 * en 2027, lejos de "hoy", para que nada dependa del reloj.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  classifyBookingInstant,
  getAgendaAvailability,
  listAvailableSlots,
  previewRecurrence,
} from "@/lib/availability-actions";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const TUE = "2027-03-09"; // martes: A.practitioner atiende 9-13
const LOCKED_TUE = "2027-03-16"; // martes con bloqueo de día completo
const at = (hhmm: string, day = TUE) => `${day}T${hhmm}:00-03:00`;

describe.skipIf(!RUN)("availability actions (B3.3)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string }; // sin franjas → horario del tenant lun-sáb
  let billing: { userId: string; practitionerId: string };
  let locPrimary: string;
  let locOfB: string;
  let osteo: string; // de A.practitioner, cupo 1, 60'
  let shared: string; // del consultorio (practitionerId null), 30', ilimitado
  let osNoA: string; // obra social que A.practitioner NO acepta
  let patient: string;
  let patientOfB: string;
  const PHI_NAME = `Zoraida${uniqueSuffix()}`;
  const PHI_NOTE = `nota-clinica-${uniqueSuffix()}`;

  async function booking(
    data: { practitionerId?: string; serviceId?: string; patientId?: string; when: string; durationMin?: number }
  ) {
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId: data.patientId ?? patient,
        practitionerId: data.practitionerId ?? A.practitionerId,
        serviceId: data.serviceId ?? A.serviceId,
        scheduledFor: new Date(data.when),
        durationMin: data.durationMin ?? 45,
        status: "CONFIRMED",
        idempotencyKey: `av-${uniqueSuffix()}`,
        notes: PHI_NOTE,
        title: `Sesión de ${PHI_NAME}`,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
    billing = await addPractitioner(db, A, "BILLING");
    locPrimary = (await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    locOfB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Principal", isPrimary: true } })).id;
    // A.practitioner: solo martes 9-13 en la principal.
    await db.practitionerSchedule.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, locationId: locPrimary, dow: 2, startMin: 540, endMin: 780 },
    });
    osteo = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: A.practitionerId, name: "Osteo", durationMin: 60, priceCents: 1000, maxConcurrent: 1 },
      })
    ).id;
    shared = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Gimnasio", durationMin: 30, priceCents: 1000 },
      })
    ).id;
    osNoA = await addInsurer(db, A, { name: `OS ${uniqueSuffix()}` });
    await db.practitionerPayer.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, insurerId: osNoA, active: false },
    });
    patient = await addPatient(db, A, { firstName: PHI_NAME, lastName: "Quintanilla", notes: PHI_NOTE });
    patientOfB = await addPatient(db, B);
    // Bloqueo de día completo (todos los profesionales) con motivo.
    await db.timeBlock.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: null,
        startsAt: new Date(at("00:00", LOCKED_TUE)),
        endsAt: new Date(at("23:59", LOCKED_TUE)),
        allDay: true,
        reason: "Feriado",
        createdById: A.userId,
      },
    });
    // Osteo 10:00-11:00 (cupo 1 → lleno) del paciente con PHI.
    await booking({ serviceId: osteo, when: at("10:00"), durationMin: 60 });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  describe("authz", () => {
    it("BILLING (agenda.viewAll sin clinical.read) ve la disponibilidad y los slots", async () => {
      asUser(billing.userId);
      const av = await getAgendaAvailability({ from: TUE, to: TUE });
      expect(av.ok).toBe(true);
      const slots = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: TUE });
      expect(slots.ok).toBe(true);
    });

    it("sin membresía en el tenant: nunca ve la agenda de ese tenant", async () => {
      // Sin membresía aceptada `buildActor` no arma actor (UnauthenticatedError).
      // En dev/test `KINESOFT_ALLOW_DEMO_ACTOR=1` cae al tenant demo, así que el
      // invariante que se afirma es el de seguridad: rechaza o responde con
      // OTRO tenant, jamás con los profesionales de A. (Con rol pero sin
      // `agenda.viewAll` hoy no existe: todos los roles la tienen; la matriz
      // está en tests/unit/capabilities.test.ts.)
      const ghost = await addPractitioner(db, A, "ASSISTANT");
      await db.membership.delete({ where: { userId_tenantId: { userId: ghost.userId, tenantId: A.tenantId } } });
      asUser(ghost.userId);
      const leak = (v: unknown) =>
        [A.practitionerId, prac2.practitionerId, ghost.practitionerId, locPrimary].some((id) => JSON.stringify(v).includes(id));
      const outcome = await getAgendaAvailability({ from: TUE, to: TUE }).then(
        (v) => ({ rejected: false, v }),
        () => ({ rejected: true, v: null })
      );
      expect(outcome.rejected || !leak(outcome.v)).toBe(true);
      // Con un id de A: si hay actor (demo), es de otro tenant → "Profesional inválido".
      const direct = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: TUE }).then(
        (v) => v,
        () => null
      );
      if (direct) expect(direct.ok).toBe(false);
    });
  });

  describe("límites de entrada", () => {
    it("getAgendaAvailability: más de 14 días o rango invertido → error de validación", async () => {
      asUser(A.userId);
      const tooLong = await getAgendaAvailability({ from: "2027-03-01", to: "2027-03-15" });
      expect(tooLong.ok).toBe(false);
      const ok14 = await getAgendaAvailability({ from: "2027-03-01", to: "2027-03-14" });
      expect(ok14.ok).toBe(true);
      const inverted = await getAgendaAvailability({ from: "2027-03-10", to: "2027-03-09" });
      expect(inverted.ok).toBe(false);
      const badDay = await getAgendaAvailability({ from: "2027-02-30", to: "2027-03-01" });
      expect(badDay.ok).toBe(false);
    });

    it("classify sin zona horaria en el instante → rechazo (no se adivina la TZ del host)", async () => {
      asUser(A.userId);
      const r = await classifyBookingInstant({
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        scheduledFor: `${TUE}T10:00:00`,
      });
      expect(r.ok).toBe(false);
    });
  });

  describe("IDOR (ids de otro tenant)", () => {
    it("profesional, sede, servicio, paciente y cobertura ajenos → error explícito", async () => {
      asUser(A.userId);
      expect(await getAgendaAvailability({ from: TUE, to: TUE, practitionerIds: [B.practitionerId] })).toEqual({
        ok: false,
        error: "Profesional inválido.",
      });
      expect(await getAgendaAvailability({ from: TUE, to: TUE, locationId: locOfB })).toEqual({
        ok: false,
        error: "Sede inválida.",
      });
      expect(
        await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: B.serviceId, dayKey: TUE })
      ).toEqual({ ok: false, error: "Servicio inválido." });
      expect(
        await listAvailableSlots({ practitionerId: "any", serviceId: A.serviceId, dayKey: TUE, patientId: patientOfB })
      ).toEqual({ ok: false, error: "Paciente inválido." });
      expect(
        await listAvailableSlots({ practitionerId: "any", serviceId: A.serviceId, dayKey: TUE, insurerId: B.particularInsurerId })
      ).toEqual({ ok: false, error: "Obra social inválida." });
      expect(
        await classifyBookingInstant({ practitionerId: B.practitionerId, serviceId: A.serviceId, scheduledFor: at("10:00") })
      ).toEqual({ ok: false, error: "Profesional inválido." });
      expect(
        await previewRecurrence({
          anchor: at("10:00"),
          count: 2,
          frequency: "weekly",
          practitionerId: A.practitionerId,
          serviceId: B.serviceId,
        })
      ).toEqual({ ok: false, error: "Servicio inválido." });
    });
  });

  describe("agenda y slots de un día abierto", () => {
    it("getAgendaAvailability: franjas por profesional, fallback, cupo efectivo", async () => {
      asUser(A.userId);
      const r = await getAgendaAvailability({ from: TUE, to: TUE });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const av = r.data;
      expect(av.primaryLocationId).toBe(locPrimary);
      const ids = av.practitioners.map((p) => p.practitionerId);
      expect(ids).toEqual(expect.arrayContaining([A.practitionerId, prac2.practitionerId]));
      expect(av.practitioners.find((p) => p.practitionerId === prac2.practitionerId)?.isFallback).toBe(true);
      const day = av.days[0];
      expect(day.dayKey).toBe(TUE);
      expect(day.byPractitioner[A.practitionerId].scheduledRanges).toEqual([
        { startMin: 540, endMin: 780, locationId: locPrimary },
      ]);
      expect(day.byPractitioner[A.practitionerId].dayLockState.status).toBe("open");
      // prac2 sin franjas: horario del tenant (8-19) en la principal.
      expect(day.byPractitioner[prac2.practitionerId].workingRanges).toEqual([
        { startMin: 480, endMin: 1140, locationId: locPrimary },
      ]);
      expect(av.capOf[A.practitionerId][osteo]).toBe(1);
      expect(av.capOf[A.practitionerId][shared]).toBeNull();
      // osteo es de A.practitioner: prac2 sin fila PS no la tiene habilitada.
      expect(av.enabledServiceIds[A.practitionerId]).toEqual(expect.arrayContaining([osteo, shared]));
      expect(av.enabledServiceIds[prac2.practitionerId]).not.toContain(osteo);
      expect(av.enabledServiceIds[prac2.practitionerId]).toContain(shared);
    });

    it("listAvailableSlots (profesional): paso 15 en la franja, cupo lleno, conflicto del paciente", async () => {
      asUser(A.userId);
      const r = await listAvailableSlots({
        practitionerId: A.practitionerId,
        serviceId: osteo,
        dayKey: TUE,
        patientId: patient,
      });
      expect(r.ok).toBe(true);
      if (!r.ok || r.data.mode !== "practitioner") throw new Error("modo inesperado");
      const d = r.data;
      expect(d).toMatchObject({ durationMin: 60, cap: 1, stepMin: 15, serviceEnabled: true, acceptsInsurer: true });
      // 9:00 … 12:00 (60' tienen que entrar antes de las 13:00).
      expect(d.slots.map((s) => s.time)).toEqual([
        "09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00", "11:15", "11:30", "11:45", "12:00",
      ]);
      const s10 = d.slots.find((s) => s.time === "10:00")!;
      expect(s10).toMatchObject({ available: false, reason: "cupo-completo", used: 1, cap: 1, patientConflict: "duplicado" });
      expect(d.slots.find((s) => s.time === "09:30")!.patientConflict).toBe("paciente-superpuesto");
      expect(d.slots.find((s) => s.time === "11:00")).toMatchObject({ available: true, patientConflict: null });
      expect(d.slots.find((s) => s.time === "09:00")!.iso).toBe(new Date(at("09:00")).toISOString());
    });

    it("classifyBookingInstant: libre / sobreturno / fuera de horario", async () => {
      asUser(A.userId);
      const base = { practitionerId: A.practitionerId, serviceId: osteo };
      const free = await classifyBookingInstant({ ...base, scheduledFor: at("11:00") });
      expect(free).toMatchObject({ ok: true, data: { class: "libre", outOfHours: false, blocked: false } });
      const full = await classifyBookingInstant({ ...base, scheduledFor: at("10:30") });
      expect(full).toMatchObject({ ok: true, data: { class: "sobreturno", used: 1, cap: 1 } });
      const late = await classifyBookingInstant({ ...base, scheduledFor: at("12:30") });
      expect(late).toMatchObject({ ok: true, data: { class: "fuera-de-horario", outOfHours: true } });
      // Editar el mismo turno: no cuenta contra sí mismo.
      const own = await db.booking.findFirstOrThrow({ where: { tenantId: A.tenantId, serviceId: osteo } });
      const moved = await classifyBookingInstant({ ...base, scheduledFor: at("10:30"), excludeBookingId: own.id });
      expect(moved).toMatchObject({ ok: true, data: { class: "libre" } });
    });
  });

  describe("día bloqueado", () => {
    it("candado del día, sin slots y clase 'bloqueado' con el motivo", async () => {
      asUser(A.userId);
      const r = await getAgendaAvailability({ from: LOCKED_TUE, to: LOCKED_TUE });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const day = r.data.days[0];
      expect(day.clinic).toMatchObject({ status: "locked", reason: "bloqueo", detail: "Feriado" });
      const a = day.byPractitioner[A.practitionerId];
      expect(a.scheduledRanges).toHaveLength(1); // el horario existe…
      expect(a.workingRanges).toEqual([]); // …pero no queda nada reservable
      expect(a.dayLockState).toMatchObject({ status: "locked", reason: "bloqueo", detail: "Feriado" });
      expect(r.data.blocks).toEqual([
        expect.objectContaining({ practitionerId: null, allDay: true, reason: "Feriado" }),
      ]);

      const slots = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: LOCKED_TUE });
      expect(slots.ok && slots.data.mode === "practitioner" && slots.data.slots).toEqual([]);

      const any = await listAvailableSlots({ practitionerId: "any", serviceId: shared, dayKey: LOCKED_TUE });
      expect(any.ok).toBe(true);
      if (!any.ok || any.data.mode !== "any") return;
      expect(any.data.practitioners.every((p) => p.firstSlot === null && p.availableCount === 0)).toBe(true);
      // El hueco más temprano cae DESPUÉS del día bloqueado.
      expect(any.data.firstFree).not.toBeNull();
      expect(Date.parse(any.data.firstFree!.iso)).toBeGreaterThanOrEqual(Date.parse(at("00:00", "2027-03-17")));

      const c = await classifyBookingInstant({
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        scheduledFor: at("10:00", LOCKED_TUE),
      });
      expect(c).toMatchObject({ ok: true, data: { class: "bloqueado", blocked: true, outOfHours: false, blockReasons: ["Feriado"] } });
    });
  });

  describe("cualquier profesional", () => {
    it("elegibles por servicio y cobertura; primer hueco por profesional y el más temprano", async () => {
      asUser(A.userId);
      const r = await listAvailableSlots({ practitionerId: "any", serviceId: shared, dayKey: TUE });
      expect(r.ok).toBe(true);
      if (!r.ok || r.data.mode !== "any") throw new Error("modo inesperado");
      const byId = Object.fromEntries(r.data.practitioners.map((p) => [p.practitionerId, p]));
      expect(byId[A.practitionerId].firstSlot?.time).toBe("09:00");
      expect(byId[prac2.practitionerId].firstSlot?.time).toBe("08:00");
      expect(r.data.firstFree).toMatchObject({ practitionerId: prac2.practitionerId, iso: new Date(at("08:00")).toISOString(), durationMin: 30 });

      // Osteo es de A.practitioner: prac2 no es elegible (sin fila PS).
      const os = await listAvailableSlots({ practitionerId: "any", serviceId: osteo, dayKey: TUE });
      expect(os.ok && os.data.mode === "any" && os.data.practitioners.map((p) => p.practitionerId)).toEqual([A.practitionerId]);

      // Cobertura que A.practitioner no acepta → solo prac2 (sin fila PP = acepta).
      const ins = await listAvailableSlots({ practitionerId: "any", serviceId: shared, dayKey: TUE, insurerId: osNoA });
      expect(ins.ok && ins.data.mode === "any" && ins.data.practitioners.map((p) => p.practitionerId)).not.toContain(
        A.practitionerId
      );
      expect(ins.ok && ins.data.mode === "any" && ins.data.practitioners.map((p) => p.practitionerId)).toContain(
        prac2.practitionerId
      );

      // Profesional puntual con la cobertura que no acepta: slots igual, con aviso.
      const one = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: shared, dayKey: TUE, insurerId: osNoA });
      expect(one).toMatchObject({ ok: true, data: { mode: "practitioner", acceptsInsurer: false } });

      // PractitionerService deshabilitado para prac2 → sale de "any".
      await db.practitionerService.create({
        data: { tenantId: A.tenantId, practitionerId: prac2.practitionerId, serviceId: shared, enabled: false },
      });
      const off = await listAvailableSlots({ practitionerId: "any", serviceId: shared, dayKey: TUE });
      expect(off.ok && off.data.mode === "any" && off.data.practitioners.map((p) => p.practitionerId)).not.toContain(
        prac2.practitionerId
      );
      // IAM-2e: Facturación tiene fila Practitioner y membresía aceptada (sin
      // franjas → horario del tenant 8-19) y antes ganaba a las 8:00 como si
      // atendiera. Ya no es elegible (no es rol clínico): queda A a las 9:00.
      expect(off.ok && off.data.mode === "any" && off.data.practitioners.map((p) => p.practitionerId)).not.toContain(
        billing.practitionerId
      );
      expect(off.ok && off.data.mode === "any" && off.data.firstFree).toMatchObject({
        practitionerId: A.practitionerId,
        iso: new Date(at("09:00")).toISOString(),
      });
      await db.practitionerService.deleteMany({ where: { practitionerId: prac2.practitionerId, serviceId: shared } });
    });
  });

  describe("previewRecurrence", () => {
    it("mensual a fin de mes: 31/01 → 28/02 → 31/03, resumen y flags por fecha", async () => {
      asUser(A.userId);
      // Un bloqueo el 31/03 para prac2 y un turno del paciente el 28/02 a la misma hora.
      await db.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: prac2.practitionerId,
          startsAt: new Date(at("09:00", "2027-03-31")),
          endsAt: new Date(at("12:00", "2027-03-31")),
          reason: "Congreso",
          createdById: A.userId,
        },
      });
      await booking({ practitionerId: A.practitionerId, serviceId: A.serviceId, when: at("10:00", "2027-02-28") });

      const r = await previewRecurrence({
        anchor: at("10:00", "2027-01-31"),
        count: 3,
        frequency: "monthly",
        practitionerId: prac2.practitionerId,
        serviceId: shared,
        patientId: patient,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const p = r.data;
      expect(p.summary).toBe("3 sesiones · Mensual 31/01 → 31/03");
      expect(p.items.map((i) => i.dayKey)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
      expect(p.items.every((i) => i.time === "10:00")).toBe(true);
      // 31/01 y 28/02 son domingo: fuera del horario lun-sáb (solo aviso, status libre/dup).
      expect(p.items[0]).toMatchObject({ status: "libre", class: "fuera-de-horario", outOfHours: true });
      expect(p.items[1]).toMatchObject({ status: "duplicado", class: "duplicado", outOfHours: true });
      expect(p.items[2]).toMatchObject({
        status: "sobreturno",
        class: "bloqueado",
        blocked: true,
        outOfHours: false,
        blockReasons: ["Congreso"],
      });
      expect(p.counts).toEqual({ libre: 1, sobreturno: 1, duplicado: 1, outOfHours: 2, blocked: 1 });
    });

    it("semanal larga (varias ventanas de carga): detecta el turno del paciente en la última", async () => {
      asUser(A.userId);
      // 12 martes desde el 06/04 → hasta el 22/06 (77 días: 2 ventanas de carga).
      await booking({ practitionerId: A.practitionerId, serviceId: A.serviceId, when: at("11:00", "2027-06-22") });
      const r = await previewRecurrence({
        anchor: at("11:00", "2027-04-06"),
        count: 12,
        daysOfWeek: [1], // 0=Lun → 1=Mar
        frequency: "weekly",
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: patient,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.items).toHaveLength(12);
      expect(r.data.items[11]).toMatchObject({ dayKey: "2027-06-22", status: "duplicado" });
      expect(r.data.items.slice(0, 11).every((i) => i.status === "libre" && !i.outOfHours)).toBe(true);
      expect(r.data.summary).toBe("12 sesiones · Semanal 06/04 → 22/06");
    });

    it("[VX3-f] Clínica general: el resumen cuenta «turnos» (unidad de los módulos del actor, no del cliente)", async () => {
      const G = await createEphemeralTenant(db, { vertical: "GENERAL" });
      try {
        asUser(G.userId);
        const r = await previewRecurrence({
          anchor: at("10:00", "2027-04-06"),
          count: 3,
          frequency: "weekly",
          practitionerId: G.practitionerId,
          serviceId: G.serviceId,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.data.summary).toBe("3 turnos · Semanal 06/04 → 20/04");
        expect(r.data.summary).not.toMatch(/sesi/i);
      } finally {
        await G.cleanup();
      }
    });
  });

  describe("sin PHI", () => {
    it("ninguna respuesta lleva nombre, notas ni id del paciente", async () => {
      asUser(billing.userId);
      const responses = await Promise.all([
        getAgendaAvailability({ from: TUE, to: TUE }),
        listAvailableSlots({ practitionerId: A.practitionerId, serviceId: osteo, dayKey: TUE, patientId: patient }),
        listAvailableSlots({ practitionerId: "any", serviceId: osteo, dayKey: TUE, patientId: patient }),
        classifyBookingInstant({ practitionerId: A.practitionerId, serviceId: osteo, scheduledFor: at("10:00"), patientId: patient }),
        previewRecurrence({
          anchor: at("10:00"),
          count: 2,
          frequency: "weekly",
          practitionerId: A.practitionerId,
          serviceId: osteo,
          patientId: patient,
        }),
      ]);
      for (const res of responses) {
        expect(res.ok).toBe(true);
        const json = JSON.stringify(res);
        expect(json).not.toContain(PHI_NAME);
        expect(json).not.toContain("Quintanilla");
        expect(json).not.toContain(PHI_NOTE);
        expect(json).not.toContain(patient);
        expect(json).not.toMatch(/"patientId"|"title"|"notes"/);
      }
    });
  });
});
