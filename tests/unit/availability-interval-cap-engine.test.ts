/**
 * [AS-2e] C-AS3 — el tope «N turnos cada X min» (decisión 6 del 19-oct, plan §23.7) en el motor puro:
 * `buildSlots` (grilla), `classifyInstant` / `classifyBatchInstant` (clase y lote), `nextFreeSlot` /
 * `firstFreeAcrossPractitioners` (próximo hueco) y `classifyPlanRows` (Planes: aviso sin bloqueo).
 *
 * Reglas que se fijan:
 *   • cuentan los turnos del profesional que RETIENEN cupo y EMPIEZAN en el mismo intervalo AR alineado a la hora,
 *     de CUALQUIER servicio (`intervalStartsUsed`); con tope 2 cada 15', el 2.º turno de las 10:00 todavía entra
 *     (libre, con `intervalCapUse.used = 1` para el aviso informativo) y el 3.º es "tope-intervalo";
 *   • precedencia: duplicado > bloqueado > fuera-de-horario > paciente-superpuesto > sobreturno > tope-intervalo >
 *     libre; `intervalCapped` se informa aunque gane otra clase (cada flag se fuerza por separado);
 *   • el bucket de las 23:30 AR del domingo es el lunes 02:30 UTC: cuenta en el del domingo y no se mezcla con el de
 *     las 00:00 AR del lunes;
 *   • sin tope (ausente o null) la salida es IDÉNTICA a la de antes de T3: sin claves nuevas. Los tests de paridad
 *     de cada archivo (`availability-{slots,classify,next-free,plan}.test.ts`) no se tocan.
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`). Se testean los símbolos reales; nada mockeado.
 */
import { describe, expect, it } from "vitest";
import { buildSlots } from "@/lib/availability/slots";
import {
  classifyBatchInstant,
  classifyInstant,
  type ClassifyInstantInput,
  type RangesFor,
} from "@/lib/availability/classify";
import { firstFreeAcrossPractitioners, nextFreeSlot } from "@/lib/availability/next-free";
import { classifyPlanRows, type ClassifyPlanRowsInput, type PlanAvailabilityBooking } from "@/lib/availability/plan";
import type { IntervalCap } from "@/lib/availability/interval-cap";
import type { AvailabilityBooking, BuildSlotsInput, ServiceInfo } from "@/lib/availability/types";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const LOC = "loc-main";
const P = "p1";
const NOW = new Date("2026-10-01T12:00:00.000Z");
// 2026-10-05 = lunes; 2026-10-04 = domingo.
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";
const CAP2: IntervalCap = { count: 2, intervalMin: 15 };

let seq = 0;
function bk(local: string, over: Partial<AvailabilityBooking> = {}): AvailabilityBooking {
  seq++;
  return {
    id: `bk-${seq}`,
    locationId: LOC,
    practitionerId: P,
    serviceId: "s-otro",
    scheduledFor: ar(local),
    durationMin: 15,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
    patientId: `pat-otro-${seq}`,
    idempotencyKey: `0b6f2c1e3f7a4d0e9a512f7c1d9e8a${String(seq).padStart(2, "0")}`,
    ...over,
  };
}
const bkUtc = (isoUtc: string, over: Partial<AvailabilityBooking> = {}) =>
  bk("2000-01-01T00:00", { scheduledFor: new Date(isoUtc), ...over });

// ─────────────────────────────────────────────────────────────────────────────
// buildSlots
// ─────────────────────────────────────────────────────────────────────────────

function slotsInput(over: Partial<BuildSlotsInput> = {}): BuildSlotsInput {
  return {
    dayKey: MONDAY,
    ranges: [{ startMin: 600, endMin: 660, locationId: LOC }], // 10-11
    stepMin: 15,
    durationMin: 15,
    lead: { minMinutes: 0, maxDays: null },
    now: NOW,
    bookings: [], // los del profesional + servicio (s1): ninguno
    cap: null,
    ...over,
  };
}

describe("[AS-2e] buildSlots — tope por intervalo", () => {
  it("tope 2 cada 15': con 1 turno el 2.º entra (libre, used 1); con 2 el 3.º es tope-intervalo", () => {
    const one = [bk("2026-10-05T10:00")];
    const s1 = buildSlots(slotsInput({ intervalCap: { practitionerId: P, cap: CAP2, bookings: one } }));
    expect(s1[0]).toMatchObject({ time: "10:00", available: true, reason: null, intervalCapUse: { used: 1, cap: CAP2 } });

    const two = [bk("2026-10-05T10:00"), bk("2026-10-05T10:10", { serviceId: "s-tercero" })];
    const s2 = buildSlots(slotsInput({ intervalCap: { practitionerId: P, cap: CAP2, bookings: two } }));
    expect(s2.map((s) => [s.time, s.reason])).toEqual([
      ["10:00", "tope-intervalo"],
      ["10:15", null],
      ["10:30", null],
      ["10:45", null],
    ]);
    expect(s2[0]).toMatchObject({ available: false, used: 0, cap: null, intervalCapUse: { used: 2, cap: CAP2 } });
    expect(s2[1].intervalCapUse).toEqual({ used: 0, cap: CAP2 });
  });

  it("cuenta cualquier servicio pero solo del profesional, y solo lo que retiene cupo", () => {
    const rows = [
      bk("2026-10-05T10:00", { practitionerId: "p2" }),
      bk("2026-10-05T10:05", { status: "CANCELLED" }),
      // Reserva pública impaga de hace más de 30 min: ya no retiene (AUDIT §5.18).
      bk("2026-10-05T10:05", {
        status: "PENDING",
        paymentStatus: "UNPAID",
        createdAt: new Date(NOW.getTime() - 60 * 60_000),
        idempotencyKey: "pub:t1:0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10",
      }),
      bk("2026-10-05T10:14"),
    ];
    const s = buildSlots(slotsInput({ intervalCap: { practitionerId: P, cap: CAP2, bookings: rows } }));
    expect(s[0]).toMatchObject({ available: true, intervalCapUse: { used: 1, cap: CAP2 } });
  });

  it("cupo-completo gana sobre tope-intervalo; pasado/anticipación también", () => {
    const same = bk("2026-10-05T10:00", { serviceId: "s1" });
    const rows = [same, bk("2026-10-05T10:05")];
    const s = buildSlots(
      slotsInput({ bookings: [same], cap: 1, intervalCap: { practitionerId: P, cap: CAP2, bookings: rows } })
    );
    expect(s[0].reason).toBe("cupo-completo");
    expect(s[0].intervalCapUse).toEqual({ used: 2, cap: CAP2 });
    const past = buildSlots(
      slotsInput({ now: ar("2026-10-05T10:20"), intervalCap: { practitionerId: P, cap: CAP2, bookings: rows } })
    );
    expect(past[0].reason).toBe("pasado");
  });

  it("23:30 AR del domingo = lunes 02:30 UTC: cuenta en el bucket del domingo, no en el de las 00:00 del lunes", () => {
    const rows = [
      bkUtc("2026-10-05T02:30:00.000Z"),
      bkUtc("2026-10-05T02:44:00.000Z"),
      bkUtc("2026-10-05T03:00:00.000Z"), // 00:00 AR del lunes: otro bucket
    ];
    const s = buildSlots(
      slotsInput({
        dayKey: SUNDAY,
        ranges: [{ startMin: 1380, endMin: 1440, locationId: LOC }],
        intervalCap: { practitionerId: P, cap: CAP2, bookings: rows },
      })
    );
    expect(s.map((x) => [x.time, x.iso, x.reason, x.intervalCapUse?.used])).toEqual([
      ["23:00", "2026-10-05T02:00:00.000Z", null, 0],
      ["23:15", "2026-10-05T02:15:00.000Z", null, 0],
      ["23:30", "2026-10-05T02:30:00.000Z", "tope-intervalo", 2],
      ["23:45", "2026-10-05T02:45:00.000Z", null, 0],
    ]);
  });

  it("intervalo de 60: 10:00-11:00 entero es un bucket", () => {
    const rows = [bk("2026-10-05T10:00"), bk("2026-10-05T10:50")];
    const s = buildSlots(
      slotsInput({ intervalCap: { practitionerId: P, cap: { count: 2, intervalMin: 60 }, bookings: rows } })
    );
    expect(s.every((x) => x.reason === "tope-intervalo")).toBe(true);
  });

  it("sin tope (ausente o null) = salida idéntica, sin la clave intervalCapUse", () => {
    const rows = [bk("2026-10-05T10:00"), bk("2026-10-05T10:05")];
    const plain = buildSlots(slotsInput({ bookings: rows }));
    expect(buildSlots(slotsInput({ bookings: rows, intervalCap: null }))).toStrictEqual(plain);
    for (const s of plain) expect(s).not.toHaveProperty("intervalCapUse");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyInstant / classifyBatchInstant
// ─────────────────────────────────────────────────────────────────────────────

const hours: RangesFor = () => [{ startMin: 540, endMin: 1080, locationId: LOC }]; // 09-18 todos los días

function ci(over: Partial<ClassifyInstantInput> = {}): ClassifyInstantInput {
  return {
    when: ar("2026-10-05T10:00"),
    durationMin: 15,
    patientId: "pat-nuevo",
    practitionerId: P,
    serviceId: "s1",
    locationId: LOC,
    cap: 2,
    rangesFor: hours,
    blocks: [],
    bookings: [],
    now: NOW,
    ...over,
  };
}

describe("[AS-2e] classifyInstant — tope-intervalo y precedencia", () => {
  const full = () => [bk("2026-10-05T10:00"), bk("2026-10-05T10:10", { serviceId: "s-tercero" })];

  it("2.º turno: libre con intervalCapUse used 1 (aviso informativo); 3.º: tope-intervalo", () => {
    const one = classifyInstant(ci({ bookings: [bk("2026-10-05T10:00")], intervalCap: CAP2 }));
    expect(one).toMatchObject({ class: "libre", intervalCapped: false, intervalCapUse: { used: 1, cap: CAP2 } });
    const c = classifyInstant(ci({ bookings: full(), intervalCap: CAP2 }));
    expect(c).toMatchObject({ class: "tope-intervalo", intervalCapped: true, intervalCapUse: { used: 2, cap: CAP2 } });
    // El cupo del servicio (s1) no se tocó: son de otros servicios.
    expect(c.used).toBe(0);
  });

  it("el turno editado no cuenta contra sí mismo", () => {
    const rows = full();
    const c = classifyInstant(ci({ bookings: rows, intervalCap: CAP2, excludeBookingId: rows[0].id }));
    expect(c).toMatchObject({ class: "libre", intervalCapped: false, intervalCapUse: { used: 1, cap: CAP2 } });
  });

  it("sobreturno > tope-intervalo, con intervalCapped informado igual", () => {
    const rows = [...full(), bk("2026-10-05T10:00", { serviceId: "s1" })];
    const c = classifyInstant(ci({ bookings: rows, cap: 1, intervalCap: CAP2 }));
    expect(c.class).toBe("sobreturno");
    expect(c.intervalCapped).toBe(true);
    expect(c.intervalCapUse).toEqual({ used: 3, cap: CAP2 });
  });

  it("paciente-superpuesto > tope-intervalo", () => {
    const rows = [...full(), bk("2026-10-05T09:50", { practitionerId: "p2", patientId: "pat-nuevo", durationMin: 30 })];
    expect(classifyInstant(ci({ bookings: rows, intervalCap: CAP2 })).class).toBe("paciente-superpuesto");
  });

  it("fuera-de-horario > tope-intervalo", () => {
    const rows = [bk("2026-10-05T08:00"), bk("2026-10-05T08:05")];
    const c = classifyInstant(ci({ when: ar("2026-10-05T08:00"), bookings: rows, intervalCap: CAP2 }));
    expect(c.class).toBe("fuera-de-horario");
    expect(c.intervalCapped).toBe(true);
  });

  it("bloqueado > tope-intervalo; duplicado > todo", () => {
    const blocks = [
      { id: "b1", practitionerId: P, locationId: null, startsAt: ar("2026-10-05T09:00"), endsAt: ar("2026-10-05T11:00"), allDay: false, reason: "Reunión", groupId: null },
    ];
    expect(classifyInstant(ci({ bookings: full(), blocks, intervalCap: CAP2 })).class).toBe("bloqueado");
    const dup = [...full(), bk("2026-10-05T10:00", { practitionerId: "p2", patientId: "pat-nuevo" })];
    expect(classifyInstant(ci({ bookings: dup, intervalCap: CAP2 })).class).toBe("duplicado");
  });

  it("23:30 AR del domingo (lunes 02:30 UTC) cuenta en el bucket del domingo", () => {
    const allDay: RangesFor = () => [{ startMin: 0, endMin: 1440, locationId: LOC }];
    const rows = [bkUtc("2026-10-05T02:30:00.000Z"), bkUtc("2026-10-05T02:40:00.000Z")];
    const sun = classifyInstant(
      ci({ when: new Date("2026-10-05T02:35:00.000Z"), rangesFor: allDay, bookings: rows, intervalCap: CAP2 })
    );
    expect(sun.class).toBe("tope-intervalo");
    const mon = classifyInstant(
      ci({ when: new Date("2026-10-05T03:00:00.000Z"), rangesFor: allDay, bookings: rows, intervalCap: CAP2 })
    );
    expect(mon).toMatchObject({ class: "libre", intervalCapUse: { used: 0, cap: CAP2 } });
  });

  it("sin tope: salida idéntica, sin claves nuevas", () => {
    const rows = full();
    const plain = classifyInstant(ci({ bookings: rows }));
    expect(plain.class).toBe("libre");
    expect(plain).not.toHaveProperty("intervalCapped");
    expect(plain).not.toHaveProperty("intervalCapUse");
    expect(classifyInstant(ci({ bookings: rows, intervalCap: null }))).toStrictEqual(plain);
  });
});

describe("[AS-2e] classifyBatchInstant — el lote marca intervalCapped sin cambiar el status", () => {
  it("tope lleno: status libre (el de hoy) + intervalCapped/intervalCapUse", () => {
    const rows = [bk("2026-10-05T10:00"), bk("2026-10-05T10:10")];
    const b = classifyBatchInstant(ci({ bookings: rows, intervalCap: CAP2 }));
    expect(b).toMatchObject({ status: "libre", intervalCapped: true, intervalCapUse: { used: 2, cap: CAP2 } });
  });

  it("sin tope: sin claves nuevas", () => {
    const rows = [bk("2026-10-05T10:00"), bk("2026-10-05T10:10")];
    const b = classifyBatchInstant(ci({ bookings: rows }));
    expect(b).not.toHaveProperty("intervalCapped");
    expect(classifyBatchInstant(ci({ bookings: rows, intervalCap: null }))).toStrictEqual(b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextFreeSlot / firstFreeAcrossPractitioners
// ─────────────────────────────────────────────────────────────────────────────

describe("[AS-2e] nextFreeSlot — saltea un tope lleno contando otros servicios", () => {
  // from 09:45 → primer cursor 10:00 AR.
  const from = ar("2026-10-05T09:45");
  const rows = () => [bk("2026-10-05T10:00"), bk("2026-10-05T10:05", { serviceId: "s-tercero" })];
  const base = { from, durationMin: 15, patientId: "pat-nuevo", practitionerId: P, serviceId: "s1", locationId: LOC, cap: 1, rangesFor: hours, blocks: [], now: NOW };

  it("sin tope: 10:00 (los de otros servicios no ocupan el cupo de s1)", () => {
    expect(nextFreeSlot({ ...base, bookings: rows() })).toBe(ar("2026-10-05T10:00").toISOString());
    expect(nextFreeSlot({ ...base, bookings: rows(), intervalCap: null })).toBe(ar("2026-10-05T10:00").toISOString());
  });

  it("con tope 2/15': el prefiltro conserva los de otros servicios → 10:15", () => {
    expect(nextFreeSlot({ ...base, bookings: rows(), intervalCap: CAP2 })).toBe(ar("2026-10-05T10:15").toISOString());
  });

  it("los de otro profesional no cuentan", () => {
    const other = rows().map((b) => ({ ...b, practitionerId: "p2" }));
    expect(nextFreeSlot({ ...base, bookings: other, intervalCap: CAP2 })).toBe(ar("2026-10-05T10:00").toISOString());
  });

  it("firstFreeAcrossPractitioners: el tope de cada profesional sale de intervalCaps", () => {
    const services: ServiceInfo[] = [{ id: "s1", durationMin: 15, maxConcurrent: 1 } as ServiceInfo];
    const q = {
      practitionerIds: [P, "p2"],
      serviceId: "s1",
      from,
      services,
      practitionerServices: [],
      rangesFor: hours,
      blocks: [],
      bookings: rows(),
      now: NOW,
    };
    expect(firstFreeAcrossPractitioners(q)).toMatchObject({ practitionerId: P, iso: ar("2026-10-05T10:00").toISOString() });
    expect(firstFreeAcrossPractitioners({ ...q, intervalCaps: { [P]: CAP2, p2: null } })).toMatchObject({
      practitionerId: "p2",
      iso: ar("2026-10-05T10:00").toISOString(),
    });
    expect(firstFreeAcrossPractitioners({ ...q, practitionerIds: [P], intervalCaps: { [P]: CAP2 } })).toMatchObject({
      practitionerId: P,
      iso: ar("2026-10-05T10:15").toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyPlanRows
// ─────────────────────────────────────────────────────────────────────────────

function planInput(over: Partial<ClassifyPlanRowsInput> = {}): ClassifyPlanRowsInput {
  return {
    rows: [{ index: 1, at: ar("2026-10-05T10:00") }],
    patientId: "pat-plan",
    practitionerId: P,
    serviceId: "s1",
    locationId: LOC,
    durationMin: 15,
    cap: 1,
    rangesFor: hours,
    blocks: [],
    bookings: [bk("2026-10-05T10:00"), bk("2026-10-05T10:05")] as PlanAvailabilityBooking[],
    now: NOW,
    ...over,
  };
}

describe("[AS-2e] classifyPlanRows — tope = aviso overIntervalCap, sin bloqueo", () => {
  it("una fila en un intervalo lleno es libre, crea por defecto y marca overIntervalCap", () => {
    const [r] = classifyPlanRows(planInput({ intervalCap: CAP2 }));
    expect(r.class).toBe("libre");
    expect(r.defaultResolution).toBe("create");
    expect(r.allowedResolutions).toEqual(["create", "move", "none"]);
    expect(r.effectiveResolution).toBe("create");
    expect(r.overbooked).toBe(false);
    expect(r.suggestion).toBeUndefined();
    expect(r.flags.overIntervalCap).toBe(true);
    expect(r.at).toBe(ar("2026-10-05T10:00").toISOString());
  });

  it("Crear explícito vale (no hace falta force) y el fold suma la fila al conteo de la siguiente", () => {
    const rows = [
      { index: 1, at: ar("2026-10-05T10:00"), resolution: { index: 1, kind: "create" as const } },
      // Mismo intervalo de 15' que la fila 1 (sin solaparse: 5 min cada una): la fila 1 ya ocupa el tope de 1.
      { index: 2, at: ar("2026-10-05T10:05") },
      { index: 3, at: ar("2026-10-06T10:00") },
    ];
    const out = classifyPlanRows(
      planInput({ rows, durationMin: 5, bookings: [], intervalCap: { count: 1, intervalMin: 15 } })
    );
    expect(out[0]).toMatchObject({ class: "libre", resolutionOk: true, overbooked: false });
    expect(out[0].flags.overIntervalCap).toBe(false);
    expect(out[1]).toMatchObject({ class: "libre", defaultResolution: "create", overbooked: false });
    expect(out[1].flags.overIntervalCap).toBe(true);
    expect(out[2].flags.overIntervalCap).toBe(false);
  });

  it("debajo del tope: overIntervalCap false", () => {
    const [r] = classifyPlanRows(planInput({ intervalCap: { count: 3, intervalMin: 15 } }));
    expect(r.class).toBe("libre");
    expect(r.flags.overIntervalCap).toBe(false);
  });

  it("move a un intervalo lleno: el destino es libre con el aviso", () => {
    const rows = [
      {
        index: 1,
        at: ar("2026-10-05T12:00"),
        resolution: { index: 1, kind: "move" as const, at: ar("2026-10-05T10:00").toISOString() },
      },
    ];
    const [r] = classifyPlanRows(planInput({ rows, intervalCap: CAP2 }));
    expect(r.resolutionOk).toBe(true);
    expect(r.targetClass).toBe("libre");
    expect(r.targetFlags?.overIntervalCap).toBe(true);
  });

  it("sin tope: idéntico, sin la clave overIntervalCap", () => {
    const plain = classifyPlanRows(planInput());
    expect(plain[0].flags).not.toHaveProperty("overIntervalCap");
    expect(classifyPlanRows(planInput({ intervalCap: null }))).toStrictEqual(plain);
  });
});
