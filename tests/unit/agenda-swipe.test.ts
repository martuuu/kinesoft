import { describe, expect, it } from "vitest";
import { SWIPE_MIN_PX, adjacentVisibleDay, createSwipeTracker, swipeDayDelta } from "@/lib/agenda-swipe";

// MB-1a (C-MB3 Agenda): swipe horizontal en Día = día anterior/siguiente. Umbral 60 px y |dx| > 2·|dy|; lo que no
// pasa los dos es scroll vertical o un toque, y no navega.
describe("[MB-1a] swipeDayDelta", () => {
  it("umbral de 60 px", () => {
    expect(SWIPE_MIN_PX).toBe(60);
    expect(swipeDayDelta(-59, 0)).toBeNull();
    expect(swipeDayDelta(-60, 0)).toBe(1);
    expect(swipeDayDelta(60, 0)).toBe(-1);
  });

  it("hacia la izquierda = día siguiente; hacia la derecha = anterior", () => {
    expect(swipeDayDelta(-120, 10)).toBe(1);
    expect(swipeDayDelta(120, -10)).toBe(-1);
  });

  it("|dx| tiene que superar 2·|dy| (un scroll en diagonal no navega)", () => {
    expect(swipeDayDelta(-100, 50)).toBeNull(); // justo 2× → no
    expect(swipeDayDelta(-100, 49)).toBe(1);
    expect(swipeDayDelta(80, 80)).toBeNull();
    expect(swipeDayDelta(0, 300)).toBeNull();
  });

  it("valores inválidos no navegan", () => {
    expect(swipeDayDelta(Number.NaN, 0)).toBeNull();
    expect(swipeDayDelta(Number.POSITIVE_INFINITY, 0)).toBeNull();
  });
});

describe("[MB-1a] adjacentVisibleDay (DayKeys AR, sin reloj del host)", () => {
  const week = { showSaturday: false, showSunday: false };

  it("día hábil a día hábil", () => {
    expect(adjacentVisibleDay("2026-10-14", 1, week)).toBe("2026-10-15"); // mié → jue
    expect(adjacentVisibleDay("2026-10-14", -1, week)).toBe("2026-10-13");
  });

  it("salta el fin de semana oculto (mismas reglas que la tira y la Semana)", () => {
    expect(adjacentVisibleDay("2026-10-16", 1, week)).toBe("2026-10-19"); // vie → lun
    expect(adjacentVisibleDay("2026-10-19", -1, week)).toBe("2026-10-16"); // lun → vie
  });

  it("con sábado visible y domingo oculto", () => {
    const sat = { showSaturday: true, showSunday: false };
    expect(adjacentVisibleDay("2026-10-16", 1, sat)).toBe("2026-10-17");
    expect(adjacentVisibleDay("2026-10-17", 1, sat)).toBe("2026-10-19");
    expect(adjacentVisibleDay("2026-10-19", -1, sat)).toBe("2026-10-17");
  });

  it("con todo visible, día corrido; cruza mes y año", () => {
    const all = { showSaturday: true, showSunday: true };
    expect(adjacentVisibleDay("2026-10-17", 1, all)).toBe("2026-10-18");
    expect(adjacentVisibleDay("2026-10-31", 1, all)).toBe("2026-11-01");
    expect(adjacentVisibleDay("2026-12-31", 1, all)).toBe("2027-01-01");
  });

  it("parado en un día oculto (link viejo), igual va al hábil siguiente/anterior", () => {
    expect(adjacentVisibleDay("2026-10-17", 1, week)).toBe("2026-10-19");
    expect(adjacentVisibleDay("2026-10-18", -1, week)).toBe("2026-10-16");
  });
});

describe("[MB-1a] createSwipeTracker", () => {
  const touch = (id: number, x: number, y: number, over: Partial<{ pointerType: string; isPrimary: boolean }> = {}) => ({
    pointerId: id,
    pointerType: "touch",
    isPrimary: true,
    clientX: x,
    clientY: y,
    ...over,
  });
  const make = () => {
    const calls: Array<1 | -1> = [];
    return { calls, t: createSwipeTracker((d) => calls.push(d)) };
  };

  it("dedo a la izquierda 80 px → día siguiente; a la derecha → anterior", () => {
    const { calls, t } = make();
    t.onPointerDown(touch(1, 200, 300));
    t.onPointerUp(touch(1, 120, 310));
    t.onPointerDown(touch(2, 100, 300));
    t.onPointerUp(touch(2, 190, 300));
    expect(calls).toEqual([1, -1]);
  });

  it("toque o scroll vertical: nada", () => {
    const { calls, t } = make();
    t.onPointerDown(touch(1, 200, 300));
    t.onPointerUp(touch(1, 202, 301));
    t.onPointerDown(touch(2, 200, 300));
    t.onPointerUp(touch(2, 170, 100));
    expect(calls).toEqual([]);
  });

  it("mouse y lápiz no cambian de día", () => {
    const { calls, t } = make();
    t.onPointerDown(touch(1, 300, 300, { pointerType: "mouse" }));
    t.onPointerUp(touch(1, 100, 300, { pointerType: "mouse" }));
    t.onPointerDown(touch(2, 300, 300, { pointerType: "pen" }));
    t.onPointerUp(touch(2, 100, 300, { pointerType: "pen" }));
    expect(calls).toEqual([]);
  });

  it("pointercancel (el navegador tomó el scroll) y un segundo dedo cancelan", () => {
    const { calls, t } = make();
    t.onPointerDown(touch(1, 300, 300));
    t.onPointerCancel();
    t.onPointerUp(touch(1, 100, 300));
    t.onPointerDown(touch(2, 300, 300));
    t.onPointerDown(touch(3, 250, 300, { isPrimary: false }));
    t.onPointerUp(touch(2, 100, 300));
    expect(calls).toEqual([]);
  });

  it("un pointerup de otro puntero no cierra el gesto ajeno", () => {
    const { calls, t } = make();
    t.onPointerDown(touch(1, 300, 300));
    t.onPointerUp(touch(9, 100, 300));
    expect(calls).toEqual([]);
  });
});
