/**
 * [AS-2c] Grilla de duraciones (plan §23.8) y validación del tope por intervalo (C-AS3, CHECK de M12) — puros.
 *
 * Por qué: la UI pasa a ofrecer 15..240 de a 15, pero hay servicios guardados de 40/50 min. Si el select no los
 * muestra, abrir y guardar un servicio viejo le cambia la duración sin que nadie lo elija. Y el tope: un par a medias
 * que llegara a la base rebota en el CHECK como un 500 sin copy.
 */
import { describe, it, expect } from "vitest";
import {
  SERVICE_DURATION_OPTIONS,
  durationOptionsWith,
  isGridDuration,
} from "@/lib/service-durations";
import {
  BOOKING_CAP_COPY,
  bookingCapLabel,
  parseBookingCapPair,
  parsePractitionerBookingCap,
} from "@/lib/booking-cap-config";

describe("[AS-2c] SERVICE_DURATION_OPTIONS / durationOptionsWith", () => {
  it("la grilla es 15..240 de a 15", () => {
    expect(SERVICE_DURATION_OPTIONS[0]).toBe(15);
    expect(SERVICE_DURATION_OPTIONS.at(-1)).toBe(240);
    expect(SERVICE_DURATION_OPTIONS).toHaveLength(16);
    expect(SERVICE_DURATION_OPTIONS.every((v, i) => v === 15 * (i + 1))).toBe(true);
    expect(isGridDuration(45)).toBe(true);
    expect(isGridDuration(50)).toBe(false);
  });

  it("un valor de la grilla no agrega nada", () => {
    const o = durationOptionsWith(45);
    expect(o.map((x) => x.value)).toEqual([...SERVICE_DURATION_OPTIONS]);
    expect(o.find((x) => x.value === 45)?.label).toBe("45 min");
  });

  it("un valor fuera de grilla aparece en orden como «50 min (actual)»", () => {
    const o = durationOptionsWith(50);
    const i = o.findIndex((x) => x.value === 50);
    expect(o[i]).toEqual({ value: 50, label: "50 min (actual)", offGrid: true });
    expect(o[i - 1].value).toBe(45);
    expect(o[i + 1].value).toBe(60);
    expect(o).toHaveLength(17);
  });

  it("debajo y arriba de la grilla (5 y 300, válidos en el server) van en los extremos", () => {
    expect(durationOptionsWith(5)[0]).toEqual({ value: 5, label: "5 min (actual)", offGrid: true });
    expect(durationOptionsWith(300).at(-1)).toEqual({ value: 300, label: "300 min (actual)", offGrid: true });
  });

  it("el rótulo se puede cambiar (práctica sugerida)", () => {
    expect(durationOptionsWith(40, { suffix: "sugerida" }).find((x) => x.value === 40)?.label).toBe("40 min (sugerida)");
  });

  it("sin valor válido: la grilla sola (null, NaN, 0, 7.5, 500)", () => {
    for (const v of [null, undefined, Number.NaN, 0, 7.5, 500]) {
      expect(durationOptionsWith(v as number | null).map((x) => x.value)).toEqual([...SERVICE_DURATION_OPTIONS]);
    }
  });
});

describe("[AS-2c] parseBookingCapPair (los dos o ninguno; 1..60; 15/30/60)", () => {
  it("los dos vacíos = sin tope", () => {
    expect(parseBookingCapPair(null, null)).toEqual({ ok: true, cap: null });
    expect(parseBookingCapPair("", "")).toEqual({ ok: true, cap: null });
    expect(parseBookingCapPair(undefined, undefined)).toEqual({ ok: true, cap: null });
  });

  it("uno solo = error con copy", () => {
    expect(parseBookingCapPair(2, null)).toEqual({ ok: false, error: BOOKING_CAP_COPY.pair });
    expect(parseBookingCapPair(null, 15)).toEqual({ ok: false, error: BOOKING_CAP_COPY.pair });
  });

  it("rango de N y de intervalo", () => {
    expect(parseBookingCapPair(0, 15)).toEqual({ ok: false, error: BOOKING_CAP_COPY.count });
    expect(parseBookingCapPair(61, 15)).toEqual({ ok: false, error: BOOKING_CAP_COPY.count });
    expect(parseBookingCapPair(1.5, 15)).toEqual({ ok: false, error: BOOKING_CAP_COPY.count });
    expect(parseBookingCapPair(2, 20)).toEqual({ ok: false, error: BOOKING_CAP_COPY.interval });
    expect(parseBookingCapPair(2, 45)).toEqual({ ok: false, error: BOOKING_CAP_COPY.interval });
  });

  it("válidos (también como strings del form)", () => {
    expect(parseBookingCapPair(1, 60)).toEqual({ ok: true, cap: { count: 1, intervalMin: 60 } });
    expect(parseBookingCapPair(60, 30)).toEqual({ ok: true, cap: { count: 60, intervalMin: 30 } });
    expect(parseBookingCapPair("2", "15")).toEqual({ ok: true, cap: { count: 2, intervalMin: 15 } });
  });
});

describe("[AS-2c] parsePractitionerBookingCap (INHERIT / NONE / CUSTOM)", () => {
  it("INHERIT y NONE guardan el par en NULL aunque vengan números tipeados", () => {
    expect(parsePractitionerBookingCap({ mode: "INHERIT", count: 3, intervalMin: 15 })).toEqual({
      ok: true,
      data: { bookingCapMode: "INHERIT", bookingCapCount: null, bookingCapIntervalMin: null },
    });
    expect(parsePractitionerBookingCap({ mode: "NONE" })).toEqual({
      ok: true,
      data: { bookingCapMode: "NONE", bookingCapCount: null, bookingCapIntervalMin: null },
    });
  });

  it("CUSTOM exige el par válido", () => {
    expect(parsePractitionerBookingCap({ mode: "CUSTOM", count: 2, intervalMin: 30 })).toEqual({
      ok: true,
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 2, bookingCapIntervalMin: 30 },
    });
    expect(parsePractitionerBookingCap({ mode: "CUSTOM" })).toEqual({ ok: false, error: BOOKING_CAP_COPY.customPair });
    expect(parsePractitionerBookingCap({ mode: "CUSTOM", count: 2 })).toEqual({ ok: false, error: BOOKING_CAP_COPY.pair });
    expect(parsePractitionerBookingCap({ mode: "CUSTOM", count: 99, intervalMin: 15 })).toEqual({
      ok: false,
      error: BOOKING_CAP_COPY.count,
    });
  });

  it("modo desconocido = error", () => {
    expect(parsePractitionerBookingCap({ mode: "OTRO" })).toEqual({ ok: false, error: BOOKING_CAP_COPY.mode });
  });

  it("rótulo", () => {
    expect(bookingCapLabel(null)).toBe("Sin tope");
    expect(bookingCapLabel({ count: 1, intervalMin: 60 })).toBe("1 turno cada 60 min");
    expect(bookingCapLabel({ count: 2, intervalMin: 15 })).toBe("2 turnos cada 15 min");
  });
});
