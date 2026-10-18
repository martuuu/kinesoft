/**
 * [AS-2k] C-AS3 — `lib/availability/interval-cap.ts` (tope de turnos por intervalo, decisión 6 del 19-oct).
 *
 * Corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`): los intervalos son de pared AR alineados a la
 * hora, y el caso 23:30 / 00:30 AR (02:30 / 03:30 UTC del día siguiente) es el que un `getHours()` del host
 * rompería en Vercel. Se testea el símbolo real; no se mockea nada.
 */
import { describe, expect, it } from "vitest";
import {
  arHourKeyOf,
  arIntervalKeyOf,
  arIntervalLabels,
  arIntervalWindow,
  arIntervalWindowAt,
  effectiveIntervalCap,
  intervalCapState,
  intervalStartsUsed,
  isIntervalCapMinutes,
  type IntervalCapBooking,
} from "@/lib/availability/interval-cap";
import { toARMinutes } from "@/lib/datetime-ar";

const ar = (local: string) => new Date(`${local}-03:00`);
const NOW = new Date("2026-10-01T12:00:00.000Z");

function bk(local: string, over: Partial<IntervalCapBooking> = {}): IntervalCapBooking {
  return {
    id: `bk-${local}-${Math.random().toString(36).slice(2)}`,
    practitionerId: "p1",
    scheduledFor: ar(local),
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-09-30T12:00:00.000Z"),
    patientId: "pat",
    idempotencyKey: "0123456789abcdef0123456789abcdef",
    ...over,
  };
}

describe("effectiveIntervalCap", () => {
  const tenant = { count: 2, intervalMin: 15 };
  it("INHERIT → el del consultorio; NONE → sin tope; CUSTOM → el propio", () => {
    expect(effectiveIntervalCap({ mode: "INHERIT", count: null, intervalMin: null }, tenant)).toEqual({
      count: 2,
      intervalMin: 15,
    });
    expect(effectiveIntervalCap({ mode: "NONE", count: null, intervalMin: null }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: 3, intervalMin: 60 }, tenant)).toEqual({
      count: 3,
      intervalMin: 60,
    });
  });
  it("consultorio sin tope + INHERIT = sin tope", () => {
    expect(effectiveIntervalCap({ mode: "INHERIT", count: null, intervalMin: null }, { count: null, intervalMin: null })).toBeNull();
  });
  it("par inválido = sin tope (un CUSTOM roto NO hereda el del consultorio); modo desconocido = sin tope", () => {
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: 3, intervalMin: 20 }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: 0, intervalMin: 15 }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: 61, intervalMin: 15 }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: 1.5, intervalMin: 15 }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "CUSTOM", count: null, intervalMin: 15 }, tenant)).toBeNull();
    expect(effectiveIntervalCap({ mode: "INHERIT", count: null, intervalMin: null }, { count: 2, intervalMin: null })).toBeNull();
    expect(effectiveIntervalCap({ mode: "LATER", count: 2, intervalMin: 15 }, tenant)).toBeNull();
  });
  it("isIntervalCapMinutes: solo 15/30/60", () => {
    expect([15, 30, 60].every(isIntervalCapMinutes)).toBe(true);
    expect([0, 10, 20, 45, 90, "15", null].some(isIntervalCapMinutes)).toBe(false);
  });
});

describe("intervalos AR alineados a la hora", () => {
  it.each([
    [15, "2026-10-20T10:07:30", "2026-10-20T10:00:00", "2026-10-20T10:15:00", "2026-10-20T10:00"],
    [15, "2026-10-20T10:15:00", "2026-10-20T10:15:00", "2026-10-20T10:30:00", "2026-10-20T10:15"],
    [15, "2026-10-20T10:59:59", "2026-10-20T10:45:00", "2026-10-20T11:00:00", "2026-10-20T10:45"],
    [30, "2026-10-20T10:29:00", "2026-10-20T10:00:00", "2026-10-20T10:30:00", "2026-10-20T10:00"],
    [30, "2026-10-20T10:31:00", "2026-10-20T10:30:00", "2026-10-20T11:00:00", "2026-10-20T10:30"],
    [60, "2026-10-20T10:45:00", "2026-10-20T10:00:00", "2026-10-20T11:00:00", "2026-10-20T10:00"],
  ] as const)("%i' · %s → [%s, %s) · %s", (min, at, start, end, key) => {
    const w = arIntervalWindow(ar(at), min);
    expect(w.start.toISOString()).toBe(ar(start).toISOString());
    expect(w.end.toISOString()).toBe(ar(end).toISOString());
    expect(arIntervalKeyOf(ar(at), min)).toBe(key);
  });

  it("bucket 23:30 / 00:30 AR: días AR distintos aunque en UTC sean el mismo (02:30 / 03:30Z)", () => {
    const late = ar("2026-10-20T23:30:00");
    const early = ar("2026-10-21T00:30:00");
    expect(late.toISOString()).toBe("2026-10-21T02:30:00.000Z");
    expect(early.toISOString()).toBe("2026-10-21T03:30:00.000Z");
    expect(arHourKeyOf(late)).toBe("2026-10-20T23");
    expect(arHourKeyOf(early)).toBe("2026-10-21T00");
    expect(arIntervalKeyOf(late, 60)).toBe("2026-10-20T23:00");
    expect(arIntervalKeyOf(early, 60)).toBe("2026-10-21T00:00");
    expect(arIntervalKeyOf(late, 30)).toBe("2026-10-20T23:30");
    expect(arIntervalKeyOf(early, 15)).toBe("2026-10-21T00:30");
    // El intervalo de las 23:00 cierra a la medianoche AR.
    const w = arIntervalWindow(late, 60);
    expect(w.end.toISOString()).toBe(ar("2026-10-21T00:00:00").toISOString());
    expect(arIntervalLabels(late, 60)).toEqual({ from: "23:00", to: "00:00" });
    expect(arIntervalLabels(late, 30)).toEqual({ from: "23:30", to: "00:00" });
  });

  it("medianoche AR exacta: hora 00 del día nuevo (no «24» del Intl)", () => {
    expect(arHourKeyOf(ar("2026-10-21T00:00:00"))).toBe("2026-10-21T00");
    expect(arIntervalKeyOf(ar("2026-10-21T00:00:00"), 15)).toBe("2026-10-21T00:00");
  });

  it("barrido de un día: cada intervalo está contenido en su hora y sus bordes caen en múltiplos de X", () => {
    for (const min of [15, 30, 60] as const) {
      for (let m = 0; m < 1440; m += 7) {
        const d = new Date(ar("2026-10-20T00:00:00").getTime() + m * 60_000);
        const w = arIntervalWindow(d, min);
        expect(toARMinutes(w.start) % min).toBe(0);
        expect(w.end.getTime() - w.start.getTime()).toBe(min * 60_000);
        expect(w.start.getTime() <= d.getTime() && d.getTime() < w.end.getTime()).toBe(true);
        // La hora contiene al intervalo entero: es lo que hace que el lock por hora no dependa de X.
        expect(arHourKeyOf(w.start)).toBe(arHourKeyOf(new Date(w.end.getTime() - 1)));
      }
    }
  });

  it("arIntervalWindowAt (reloj ya calculado, minutos fraccionarios) = arIntervalWindow, al ms", () => {
    const day0 = ar("2026-10-20T00:00:00").getTime();
    for (const min of [15, 30, 60] as const) {
      // Paso con segundos y ms (como un `when` real), y bordes exactos.
      for (let ms = 0; ms < 1440 * 60_000; ms += 7 * 60_000 + 1_337) {
        const d = new Date(day0 + ms);
        const wallMin = ms / 60_000; // = ArWall.startMin (fraccionario)
        expect(arIntervalWindowAt(d, min, wallMin)).toEqual(arIntervalWindow(d, min));
      }
      for (let m = 0; m < 1440; m += min) {
        const d = new Date(day0 + m * 60_000);
        expect(arIntervalWindowAt(d, min, m).start.getTime()).toBe(d.getTime());
      }
    }
  });

  it("labels de 15'", () => {
    expect(arIntervalLabels(ar("2026-10-20T10:05:00"), 15)).toEqual({ from: "10:00", to: "10:15" });
  });
});

describe("intervalStartsUsed", () => {
  const when = ar("2026-10-20T10:05:00");
  const base = { practitionerId: "p1", when, intervalMin: 15 as const, now: NOW };

  it("cuenta los que EMPIEZAN en el intervalo, de cualquier servicio, del profesional", () => {
    const rows = [
      bk("2026-10-20T10:00:00"),
      bk("2026-10-20T10:14:59"),
      bk("2026-10-20T10:15:00"), // intervalo siguiente
      bk("2026-10-20T09:45:00"), // empezó antes: aunque solape, no cuenta (no es un cupo)
      bk("2026-10-20T10:05:00", { practitionerId: "p2" }), // otro profesional
    ];
    expect(intervalStartsUsed(rows, base)).toBe(2);
    expect(intervalStartsUsed(rows, { ...base, intervalMin: 30 })).toBe(3);
    expect(intervalStartsUsed(rows, { ...base, intervalMin: 60 })).toBe(3);
  });

  it("excluye el propio (edición), los CANCELLED y la reserva pública impaga vencida (§5.18)", () => {
    const self = bk("2026-10-20T10:00:00");
    const expiredPublic = bk("2026-10-20T10:02:00", {
      status: "PENDING",
      paymentStatus: "UNPAID",
      idempotencyKey: "pub:t1:3f1c2a4e-0000-4000-8000-000000000000",
      createdAt: new Date(NOW.getTime() - 31 * 60_000),
    });
    const livePublic = { ...expiredPublic, id: "live", createdAt: new Date(NOW.getTime() - 30 * 60_000) };
    const rows = [self, bk("2026-10-20T10:01:00", { status: "CANCELLED" }), expiredPublic, livePublic];
    expect(intervalStartsUsed(rows, base)).toBe(2); // self + livePublic
    expect(intervalStartsUsed(rows, { ...base, excludeId: self.id })).toBe(1);
  });

  it("con `wallMin` (barrido) cuenta lo mismo, incluido el turno JUSTO en el borde", () => {
    const rows = [bk("2026-10-20T10:00:00"), bk("2026-10-20T10:15:00")];
    const at = ar("2026-10-20T10:05:30");
    const wallMin = 10 * 60 + 5.5;
    expect(intervalStartsUsed(rows, { ...base, when: at, wallMin })).toBe(intervalStartsUsed(rows, { ...base, when: at }));
    expect(intervalStartsUsed(rows, { ...base, when: at, wallMin })).toBe(1);
  });

  it("23:30 AR en TZ=UTC: cuenta en el intervalo de la noche, no en el del día siguiente", () => {
    const rows = [bk("2026-10-20T23:40:00"), bk("2026-10-21T00:10:00")];
    expect(intervalStartsUsed(rows, { ...base, when: ar("2026-10-20T23:31:00"), intervalMin: 60 })).toBe(1);
    expect(intervalStartsUsed(rows, { ...base, when: ar("2026-10-21T00:00:00"), intervalMin: 60 })).toBe(1);
  });
});

describe("intervalCapState", () => {
  it("tope 2 cada 15': el 2.º avisa, el 3.º es sobreturno", () => {
    const cap = { count: 2, intervalMin: 15 as const };
    expect(intervalCapState(0, cap)).toBe("free");
    expect(intervalCapState(1, cap)).toBe("notice");
    expect(intervalCapState(2, cap)).toBe("full");
    expect(intervalCapState(5, cap)).toBe("full");
  });
  it("tope 1: sin aviso intermedio; sin tope: siempre libre", () => {
    expect(intervalCapState(0, { count: 1, intervalMin: 60 })).toBe("free");
    expect(intervalCapState(1, { count: 1, intervalMin: 60 })).toBe("full");
    expect(intervalCapState(3, null)).toBe("free");
  });
});
