/**
 * `lib/reception-state.ts` (B3.6 AG-layout): estados operativos del modo
 * Recepción (decisión 3: timestamps `arrivedAt`/`attendingAt`, sin nuevos
 * BookingStatus), transiciones permitidas, orden de la lista y espera.
 * Corre en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import {
  LATE_AFTER_MIN,
  RECEPTION_ACTION_LABEL,
  allowedTransitions,
  applyReceptionAction,
  calledMinutes,
  lateMinutes,
  receptionState,
  sortForReception,
  undoStatus,
  undoTarget,
  waitingMinutes,
  type ReceptionBooking,
  type ReceptionState,
} from "@/lib/reception-state";

const DAY = "2026-10-05";
const ar = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-03:00`);

function b(hhmm: string, over: Partial<ReceptionBooking> = {}): ReceptionBooking {
  return { id: `b-${hhmm}`, scheduledFor: ar(hhmm), durationMin: 45, status: "CONFIRMED", ...over };
}

describe("receptionState", () => {
  const now = ar("10:00");
  it.each<[string, ReceptionBooking, ReceptionState]>([
    ["por llegar (futuro)", b("10:30"), "por-llegar"],
    ["por llegar dentro de la tolerancia (10 min justos)", b("09:50"), "por-llegar"],
    ["demorado (11 min sin llegada)", b("09:49"), "demorado"],
    ["en sala", b("09:30", { arrivedAt: ar("09:25") }), "en-sala"],
    ["en atención", b("09:30", { arrivedAt: ar("09:25"), attendingAt: ar("09:35") }), "en-atencion"],
    ["[SV03] llamado (calledAt gana a arrivedAt)", b("09:30", { arrivedAt: ar("09:25"), calledAt: ar("09:40") }), "llamado"],
    [
      "[SV03] en atención gana a calledAt",
      b("09:30", { arrivedAt: ar("09:25"), calledAt: ar("09:40"), attendingAt: ar("09:42") }),
      "en-atencion",
    ],
    ["[SV03] calledAt null = en sala", b("09:30", { arrivedAt: ar("09:25"), calledAt: null }), "en-sala"],
    ["[SV03] atendido gana a calledAt", b("09:00", { status: "COMPLETED", arrivedAt: ar("08:55"), calledAt: ar("09:00") }), "atendido"],
    ["[SV03] cancelado gana a calledAt", b("09:00", { status: "CANCELLED", arrivedAt: ar("08:55"), calledAt: ar("09:00") }), "cancelado"],
    [
      "[SV03] ISO strings con calledAt (DTO)",
      { ...b("09:00"), arrivedAt: ar("08:58").toISOString(), calledAt: ar("09:05").toISOString() },
      "llamado",
    ],
    ["atendido gana a los timestamps", b("09:00", { status: "COMPLETED", arrivedAt: ar("08:55") }), "atendido"],
    ["ausente", b("08:00", { status: "NO_SHOW" }), "ausente"],
    ["cancelado", b("08:00", { status: "CANCELLED", arrivedAt: ar("07:55") }), "cancelado"],
    ["PENDING se trata como activo", b("10:30", { status: "PENDING" }), "por-llegar"],
    ["ISO strings (DTO)", { ...b("09:00"), scheduledFor: ar("09:00").toISOString(), arrivedAt: ar("08:58").toISOString() }, "en-sala"],
  ])("%s", (_name, booking, expected) => {
    expect(receptionState(booking, now)).toBe(expected);
  });

  it(`N = ${LATE_AFTER_MIN} min documentado y configurable`, () => {
    expect(LATE_AFTER_MIN).toBe(10);
    expect(receptionState(b("09:55"), now, { lateAfterMin: 3 })).toBe("demorado");
  });
});

describe("allowedTransitions", () => {
  it("matriz completa", () => {
    expect(allowedTransitions("por-llegar")).toEqual(["llego", "ausente"]);
    expect(allowedTransitions("demorado")).toEqual(["llego", "ausente"]);
    expect(allowedTransitions("en-sala")).toEqual(["llamar", "en-atencion", "atendido", "deshacer"]);
    expect(allowedTransitions("llamado")).toEqual(["en-atencion", "atendido", "deshacer"]);
    expect(allowedTransitions("en-atencion")).toEqual(["atendido", "deshacer"]);
    expect(allowedTransitions("atendido")).toEqual(["deshacer"]);
    expect(allowedTransitions("ausente")).toEqual(["deshacer"]);
    expect(allowedTransitions("cancelado")).toEqual([]);
  });
  it("cada acción tiene rótulo en castellano", () => {
    expect(RECEPTION_ACTION_LABEL).toEqual({
      llego: "Llegó",
      llamar: "Llamar",
      "en-atencion": "En atención",
      atendido: "Atendido",
      ausente: "Ausente",
      deshacer: "Deshacer",
    });
  });
});

describe("applyReceptionAction", () => {
  const now = ar("10:00");

  it("Llegó: setea arrivedAt = now → en-sala", () => {
    const r = applyReceptionAction(b("10:00"), "llego", now);
    expect(r).toEqual({ ok: true, from: "por-llegar", to: "en-sala", patch: { arrivedAt: now } });
  });

  it("En atención: setea attendingAt", () => {
    const r = applyReceptionAction(b("09:30", { arrivedAt: ar("09:20") }), "en-atencion", now);
    expect(r).toEqual({ ok: true, from: "en-sala", to: "en-atencion", patch: { attendingAt: now } });
  });

  it("Atendido: status COMPLETED (conserva timestamps)", () => {
    const r = applyReceptionAction(b("09:30", { arrivedAt: ar("09:20"), attendingAt: ar("09:30") }), "atendido", now);
    expect(r).toEqual({ ok: true, from: "en-atencion", to: "atendido", patch: { status: "COMPLETED" } });
  });

  it("Ausente: status NO_SHOW", () => {
    expect(applyReceptionAction(b("09:00"), "ausente", now)).toEqual({
      ok: true,
      from: "demorado",
      to: "ausente",
      patch: { status: "NO_SHOW" },
    });
  });

  it("Deshacer vuelve un paso", () => {
    // Se deshace la llegada: vuelve a por-llegar (o demorado si ya pasó la tolerancia).
    expect(applyReceptionAction(b("09:30", { arrivedAt: ar("09:20") }), "deshacer", now)).toMatchObject({
      ok: true,
      to: "demorado",
      patch: { arrivedAt: null },
    });
    expect(applyReceptionAction(b("09:55", { arrivedAt: ar("09:50") }), "deshacer", now)).toMatchObject({
      ok: true,
      to: "por-llegar",
      patch: { arrivedAt: null },
    });
    expect(
      applyReceptionAction(b("09:30", { arrivedAt: ar("09:20"), attendingAt: ar("09:30") }), "deshacer", now)
    ).toMatchObject({ ok: true, to: "en-sala", patch: { attendingAt: null } });
    // Atendido con timestamps → vuelve a en-atención (el turno vuelve a CONFIRMED).
    expect(
      applyReceptionAction(
        b("09:00", { status: "COMPLETED", arrivedAt: ar("08:55"), attendingAt: ar("09:00") }),
        "deshacer",
        now
      )
    ).toMatchObject({ ok: true, to: "en-atencion", patch: { status: "CONFIRMED" } });
    // Ausente → por llegar / demorado según la hora.
    expect(applyReceptionAction(b("09:00", { status: "NO_SHOW" }), "deshacer", now)).toMatchObject({
      ok: true,
      to: "demorado",
      patch: { status: "CONFIRMED" },
    });
  });

  it("[revisión B-pre] deshacer atendido/ausente vuelve al status de ORIGEN (undoStatus)", () => {
    const PUB = "pub:tenant-1:3f1e6a2c-9b7d-4c1e-8a55-0d2b6c7e9f10";
    const undo = (over: Partial<ReceptionBooking>) =>
      applyReceptionAction(b("09:00", { status: "NO_SHOW", ...over }), "deshacer", now);
    // Guest (patientId null): nace PENDING → vuelve a PENDING.
    expect(undo({ patientId: null })).toMatchObject({ ok: true, patch: { status: "PENDING" } });
    // Reserva pública impaga (UNPAID / FAILED) → PENDING (sigue venciendo a los 30 min).
    for (const paymentStatus of ["UNPAID", "FAILED"]) {
      expect(undo({ patientId: "pat-1", idempotencyKey: PUB, paymentStatus })).toMatchObject({
        patch: { status: "PENDING" },
      });
      // Cliente: la key no viaja, manda el flag del DTO.
      expect(undo({ patientId: "pat-1", publicReservation: true, paymentStatus })).toMatchObject({
        patch: { status: "PENDING" },
      });
    }
    // Pública ya paga / turno de agenda con paciente / sin datos de cobro → CONFIRMED.
    expect(undo({ patientId: "pat-1", idempotencyKey: PUB, paymentStatus: "PAID" })).toMatchObject({
      patch: { status: "CONFIRMED" },
    });
    expect(
      undo({ patientId: "pat-1", idempotencyKey: "0b8c1a7e-1111-4222-8333-944455556666", paymentStatus: "UNPAID" })
    ).toMatchObject({ patch: { status: "CONFIRMED" } });
    expect(undo({ patientId: "pat-1", publicReservation: false, paymentStatus: "UNPAID" })).toMatchObject({
      patch: { status: "CONFIRMED" },
    });
    expect(undo({})).toMatchObject({ patch: { status: "CONFIRMED" } });
    // Atendido también.
    expect(
      applyReceptionAction(b("09:00", { status: "COMPLETED", patientId: null }), "deshacer", now)
    ).toMatchObject({ patch: { status: "PENDING" } });
    // undoStatus directo.
    expect(undoStatus({ ...b("09:00"), patientId: null })).toBe("PENDING");
  });

  it("transición inválida rechazada con mensaje", () => {
    const r = applyReceptionAction(b("10:30"), "atendido", now);
    expect(r).toEqual({ ok: false, from: "por-llegar", error: "No se puede marcar «Atendido» un turno por llegar." });
    expect(applyReceptionAction(b("10:30", { status: "CANCELLED" }), "llego", now)).toMatchObject({ ok: false });
    expect(applyReceptionAction(b("10:30"), "deshacer", now)).toMatchObject({ ok: false });
  });

  it("Llegó solo para turnos de hoy (AR)", () => {
    const tomorrow = b("09:00", { scheduledFor: ar("09:00", "2026-10-06") });
    expect(applyReceptionAction(tomorrow, "llego", now)).toEqual({
      ok: false,
      from: "por-llegar",
      error: "Solo se marca la llegada de turnos de hoy.",
    });
    // 22:30 AR del día del turno (01:30Z del día siguiente): sigue siendo hoy.
    expect(applyReceptionAction(b("21:00"), "llego", ar("22:30"))).toMatchObject({ ok: true, to: "en-sala" });
  });
});

describe("waitingMinutes / lateMinutes", () => {
  const now = ar("10:00");
  it("espera = minutos desde arrivedAt, solo en sala", () => {
    expect(waitingMinutes(b("09:30", { arrivedAt: ar("09:42") }), now)).toBe(18);
    expect(waitingMinutes(b("09:30"), now)).toBeNull();
    expect(waitingMinutes(b("09:30", { arrivedAt: ar("09:20"), attendingAt: ar("09:30") }), now)).toBeNull();
  });
  it("demora = minutos pasados de la hora, solo demorado", () => {
    expect(lateMinutes(b("09:35"), now)).toBe(25);
    expect(lateMinutes(b("09:55"), now)).toBeNull();
    expect(lateMinutes(b("09:35", { arrivedAt: ar("09:50") }), now)).toBeNull();
  });
});

describe("sortForReception", () => {
  it("en atención primero, después cronológico; cancelados al final; demorados destacados", () => {
    const now = ar("10:00");
    const rows = [
      b("11:00"),
      b("08:00", { status: "CANCELLED" }),
      b("09:00", { status: "COMPLETED" }),
      b("09:30", { arrivedAt: ar("09:20"), attendingAt: ar("09:40") }),
      b("09:15"), // demorado
      b("09:45", { arrivedAt: ar("09:40") }),
      b("08:30", { arrivedAt: ar("08:25"), attendingAt: ar("08:30") }),
    ];
    const out = sortForReception(rows, now);
    expect(out.map((e) => e.row.id)).toEqual(["b-08:30", "b-09:30", "b-09:00", "b-09:15", "b-09:45", "b-11:00", "b-08:00"]);
    expect(out.map((e) => e.state)).toEqual([
      "en-atencion",
      "en-atencion",
      "atendido",
      "demorado",
      "en-sala",
      "por-llegar",
      "cancelado",
    ]);
    const late = out.find((e) => e.row.id === "b-09:15")!;
    expect(late).toMatchObject({ highlight: true, lateMinutes: 45, waitingMinutes: null });
    expect(out.find((e) => e.row.id === "b-09:45")).toMatchObject({ highlight: false, waitingMinutes: 20 });
    expect(out[0].row).toBe(rows[6]); // devuelve el objeto del caller
    expect(rows[0].id).toBe("b-11:00"); // no muta
  });
});

describe("[SV03] estado «Llamado» (§18.4)", () => {
  const now = ar("10:00");
  const sala = (over: Partial<ReceptionBooking> = {}) => b("09:30", { arrivedAt: ar("09:20"), ...over });
  const llamado = (over: Partial<ReceptionBooking> = {}) => sala({ calledAt: ar("09:55"), ...over });

  it("Llamar desde en sala: calledAt = now → llamado", () => {
    expect(applyReceptionAction(sala(), "llamar", now)).toEqual({
      ok: true,
      from: "en-sala",
      to: "llamado",
      patch: { calledAt: now },
    });
  });

  it("Llamar exige que esté en sala: por llegar / demorado / llamado / en atención / atendido no", () => {
    expect(applyReceptionAction(b("10:30"), "llamar", now)).toEqual({
      ok: false,
      from: "por-llegar",
      error: "No se puede llamar a un turno por llegar. Primero marcá «Llegó».",
    });
    expect(applyReceptionAction(b("09:00"), "llamar", now)).toMatchObject({ ok: false, from: "demorado" });
    // No hay «Volver a llamar»: es Deshacer + Llamar.
    expect(applyReceptionAction(llamado(), "llamar", now)).toEqual({
      ok: false,
      from: "llamado",
      error: "No se puede llamar a un turno llamado.",
    });
    expect(applyReceptionAction(sala({ attendingAt: ar("09:58") }), "llamar", now)).toMatchObject({ ok: false });
    expect(applyReceptionAction(sala({ status: "COMPLETED" }), "llamar", now)).toMatchObject({ ok: false });
    expect(applyReceptionAction(sala({ status: "CANCELLED" }), "llamar", now)).toMatchObject({ ok: false });
  });

  it("desde llamado: En atención (conserva calledAt) y Atendido como desde en sala", () => {
    expect(applyReceptionAction(llamado(), "en-atencion", now)).toEqual({
      ok: true,
      from: "llamado",
      to: "en-atencion",
      patch: { attendingAt: now },
    });
    expect(applyReceptionAction(llamado(), "atendido", now)).toEqual({
      ok: true,
      from: "llamado",
      to: "atendido",
      patch: { status: "COMPLETED" },
    });
    expect(applyReceptionAction(llamado(), "ausente", now)).toMatchObject({ ok: false, from: "llamado" });
    expect(applyReceptionAction(llamado(), "llego", now)).toMatchObject({ ok: false, from: "llamado" });
  });

  it("Deshacer desde llamado limpia calledAt → en sala", () => {
    expect(applyReceptionAction(llamado(), "deshacer", now)).toEqual({
      ok: true,
      from: "llamado",
      to: "en-sala",
      patch: { calledAt: null },
    });
  });

  it("Deshacer desde en atención: → llamado si hubo llamado, si no → en sala (calledAt se conserva)", () => {
    expect(applyReceptionAction(llamado({ attendingAt: ar("09:58") }), "deshacer", now)).toEqual({
      ok: true,
      from: "en-atencion",
      to: "llamado",
      patch: { attendingAt: null },
    });
    expect(applyReceptionAction(sala({ attendingAt: ar("09:58") }), "deshacer", now)).toEqual({
      ok: true,
      from: "en-atencion",
      to: "en-sala",
      patch: { attendingAt: null },
    });
  });

  it("Deshacer desde en sala limpia arrivedAt Y calledAt (CHECK de M5)", () => {
    const r = applyReceptionAction(sala(), "deshacer", now);
    expect(r).toEqual({ ok: true, from: "en-sala", to: "demorado", patch: { arrivedAt: null, calledAt: null } });
  });

  it("Deshacer atendido con calledAt (sin en atención) vuelve a llamado", () => {
    expect(applyReceptionAction(llamado({ status: "COMPLETED" }), "deshacer", now)).toMatchObject({
      ok: true,
      from: "atendido",
      to: "llamado",
      patch: { status: "CONFIRMED" },
    });
  });

  it("undoTarget = el `to` de deshacer; null si no se puede", () => {
    expect(undoTarget(llamado(), now)).toBe("en-sala");
    expect(undoTarget(llamado({ attendingAt: ar("09:58") }), now)).toBe("llamado");
    expect(undoTarget(sala({ attendingAt: ar("09:58") }), now)).toBe("en-sala");
    expect(undoTarget(sala(), now)).toBe("demorado");
    expect(undoTarget(b("10:30"), now)).toBeNull();
    expect(undoTarget(b("10:30", { status: "CANCELLED" }), now)).toBeNull();
  });

  it("Llamar solo hoy (día AR): mañana rechazado", () => {
    const tomorrow = sala({ scheduledFor: ar("09:00", "2026-10-06"), arrivedAt: ar("09:00", "2026-10-06") });
    expect(applyReceptionAction(tomorrow, "llamar", now)).toEqual({
      ok: false,
      from: "en-sala",
      error: "Solo se llama a pacientes de turnos de hoy.",
    });
  });

  it("Llamar solo hoy: borde de medianoche AR (corre igual en TZ=UTC)", () => {
    // Turno 23:30 AR del 5 (= 02:30Z del 6). A las 23:50 AR del 5 (02:50Z del 6)
    // sigue siendo hoy aunque el día UTC ya cambió.
    const late = b("23:30", { arrivedAt: ar("23:20") });
    expect(applyReceptionAction(late, "llamar", ar("23:50"))).toMatchObject({ ok: true, to: "llamado" });
    // 00:10 AR del 6: ya es otro día AR → rechazado, aunque en UTC sea el mismo día (03:10Z del 6).
    expect(applyReceptionAction(late, "llamar", ar("00:10", "2026-10-06"))).toMatchObject({
      ok: false,
      error: "Solo se llama a pacientes de turnos de hoy.",
    });
    // Turno 00:10 AR del 6 visto a las 23:50 AR del 5 (mismo día UTC, 6): no es hoy.
    const early = b("00:10", { scheduledFor: ar("00:10", "2026-10-06"), arrivedAt: ar("23:45") });
    expect(applyReceptionAction(early, "llamar", ar("23:50"))).toMatchObject({ ok: false });
  });

  it("calledMinutes: minutos desde calledAt, solo en llamado", () => {
    expect(calledMinutes(llamado({ calledAt: ar("09:57") }), now)).toBe(3);
    expect(calledMinutes(llamado({ calledAt: ar("10:00") }), now)).toBe(0);
    // Reloj del cliente apenas atrás del server: nunca negativo.
    expect(calledMinutes(llamado({ calledAt: ar("10:01") }), now)).toBe(0);
    expect(calledMinutes(sala(), now)).toBeNull();
    expect(calledMinutes(llamado({ attendingAt: ar("09:58") }), now)).toBeNull();
    expect(calledMinutes(llamado({ status: "COMPLETED" }), now)).toBeNull();
    // waitingMinutes no aplica al llamado (su reloj es calledMinutes).
    expect(waitingMinutes(llamado(), now)).toBeNull();
  });

  it("sortForReception: en atención → llamados (por calledAt) → resto cronológico → cancelados", () => {
    const rows = [
      b("09:45", { arrivedAt: ar("09:40") }), // en sala
      b("09:10", { arrivedAt: ar("09:05"), calledAt: ar("09:58") }), // llamado tarde
      b("09:50", { arrivedAt: ar("09:30"), calledAt: ar("09:52") }), // llamado antes
      b("09:20", { arrivedAt: ar("09:15"), attendingAt: ar("09:40") }), // en atención
      b("08:00", { status: "CANCELLED" }),
      b("11:00"),
    ];
    const out = sortForReception(rows, now);
    expect(out.map((e) => e.state)).toEqual(["en-atencion", "llamado", "llamado", "en-sala", "por-llegar", "cancelado"]);
    expect(out.map((e) => e.row.id)).toEqual(["b-09:20", "b-09:50", "b-09:10", "b-09:45", "b-11:00", "b-08:00"]);
    expect(out[1]).toMatchObject({ calledMinutes: 8, waitingMinutes: null, actions: ["en-atencion", "atendido", "deshacer"] });
    expect(out[3]).toMatchObject({ calledMinutes: null, actions: ["llamar", "en-atencion", "atendido", "deshacer"] });
  });
});
