import { describe, it, expect } from "vitest";
import {
  BLOCK_REASON_SUGGESTIONS,
  affectedHeadline,
  affectedLines,
  affectedOverflow,
  blockThrownMessage,
  buildBlockPayload,
  initialBlockForm,
  isBlockFormDirty,
  isValidDayKey,
  mapServerFieldErrors,
  minutesToHHmm,
  routeEndsAtError,
  type BlockFormState,
} from "@/lib/block-mode-state";
import { TimeBlockCreate, normalizeBlockWindow, type CreateTimeBlockResult } from "@/lib/time-blocks-schemas";

// Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`): los oráculos son
// instantes literales, así que un `setHours`/`getDate` del host rompe uno de los dos.

const PRAC = "prac_1";
const opts = { practitionerId: PRAC, canBlockAll: false };

function form(over: Partial<BlockFormState> = {}): BlockFormState {
  return { ...initialBlockForm("2026-10-06T14:30:00-03:00"), ...over };
}

describe("initialBlockForm", () => {
  it("prefija el día y la hora AR del slot, una hora, este profesional", () => {
    expect(initialBlockForm("2026-10-06T14:30:00-03:00")).toEqual({
      scope: "practitioner",
      kind: "range",
      dayKey: "2026-10-06",
      endDayKey: "2026-10-06",
      fromMin: 14 * 60 + 30,
      toMin: 15 * 60 + 30,
      reason: "",
    });
  });
  it("un ISO en Z de noche AR cae en el día AR (no en el día UTC)", () => {
    // 01:30Z del 7 = 22:30 AR del 6.
    const f = initialBlockForm("2026-10-07T01:30:00.000Z");
    expect(f.dayKey).toBe("2026-10-06");
    expect(f.fromMin).toBe(22 * 60 + 30);
    expect(f.toMin).toBe(23 * 60 + 30);
  });
  it("redondea hacia abajo a 5' y no pasa de las 24:00", () => {
    const f = initialBlockForm("2026-10-06T23:37:00-03:00");
    expect(f.fromMin).toBe(23 * 60 + 35);
    expect(f.toMin).toBe(24 * 60);
  });
  it("medianoche AR = minuto 0 (no 1440)", () => {
    const f = initialBlockForm("2026-10-06T00:00:00-03:00");
    expect(f.dayKey).toBe("2026-10-06");
    expect(f.fromMin).toBe(0);
  });
  it("ISO inválido → día AR de `now`, 09:00", () => {
    const f = initialBlockForm("basura", new Date("2026-10-07T02:00:00Z"));
    expect(f.dayKey).toBe("2026-10-06");
    expect(f.fromMin).toBe(9 * 60);
  });
});

describe("buildBlockPayload — franja", () => {
  it("arma [día+desde, día+hasta) en instantes AR", () => {
    const r = buildBlockPayload(form({ fromMin: 9 * 60, toMin: 12 * 60 + 15, reason: "  Trámite " }), opts);
    expect(r).toEqual({
      ok: true,
      payload: {
        practitionerId: PRAC,
        startsAt: "2026-10-06T12:00:00.000Z",
        endsAt: "2026-10-06T15:15:00.000Z",
        allDay: false,
        reason: "Trámite",
      },
    });
  });
  it("hasta 24:00 = 00:00 AR del día siguiente", () => {
    const r = buildBlockPayload(form({ fromMin: 20 * 60, toMin: 24 * 60 }), opts);
    expect(r.ok && r.payload.endsAt).toBe("2026-10-07T03:00:00.000Z");
  });
  it("motivo vacío → null", () => {
    const r = buildBlockPayload(form({ reason: "   " }), opts);
    expect(r.ok && r.payload.reason).toBeNull();
  });
  it("el payload pasa el zod real de `createTimeBlock`", () => {
    const r = buildBlockPayload(form(), opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(TimeBlockCreate.safeParse(r.payload).success).toBe(true);
  });
  it("fin <= inicio → error en `toMin`", () => {
    const r = buildBlockPayload(form({ fromMin: 600, toMin: 600 }), opts);
    expect(r).toEqual({ ok: false, errors: { toMin: "El fin tiene que ser posterior al inicio." } });
  });
  it("fuera de la grilla de 5' → error", () => {
    const r = buildBlockPayload(form({ fromMin: 601 }), opts);
    expect(!r.ok && r.errors.fromMin).toBeTruthy();
  });
});

describe("buildBlockPayload — día completo", () => {
  it("un día: [00:00 AR, 00:00 AR del siguiente), allDay true, = normalizeBlockWindow", () => {
    const r = buildBlockPayload(form({ kind: "allDay", reason: "Feriado" }), opts);
    expect(r).toEqual({
      ok: true,
      payload: {
        practitionerId: PRAC,
        startsAt: "2026-10-06T03:00:00.000Z",
        endsAt: "2026-10-07T03:00:00.000Z",
        allDay: true,
        reason: "Feriado",
      },
    });
    if (r.ok) {
      const win = normalizeBlockWindow({
        startsAt: new Date(r.payload.startsAt),
        endsAt: new Date(r.payload.endsAt),
        allDay: true,
      });
      // Lo que se manda es exactamente lo que el servidor guarda.
      expect(win.startsAt.toISOString()).toBe(r.payload.startsAt);
      expect(win.endsAt.toISOString()).toBe(r.payload.endsAt);
    }
  });
  it("varios días inclusivos (Vacaciones del 6 al 10)", () => {
    const r = buildBlockPayload(form({ kind: "allDay", endDayKey: "2026-10-10" }), opts);
    expect(r.ok && [r.payload.startsAt, r.payload.endsAt]).toEqual([
      "2026-10-06T03:00:00.000Z",
      "2026-10-11T03:00:00.000Z",
    ]);
  });
  it("ignora la franja (desde/hasta inválidos no importan)", () => {
    const r = buildBlockPayload(form({ kind: "allDay", fromMin: 700, toMin: 600 }), opts);
    expect(r.ok).toBe(true);
  });
  it("último día anterior al primero → error", () => {
    const r = buildBlockPayload(form({ kind: "allDay", endDayKey: "2026-10-05" }), opts);
    expect(!r.ok && r.errors.endDayKey).toMatch(/anterior/);
  });
  it("más de 31 días → error; 31 justos pasa", () => {
    expect(buildBlockPayload(form({ kind: "allDay", endDayKey: "2026-11-05" }), opts).ok).toBe(true);
    const r = buildBlockPayload(form({ kind: "allDay", endDayKey: "2026-11-06" }), opts);
    expect(!r.ok && r.errors.endDayKey).toMatch(/31 días/);
  });
});

describe("buildBlockPayload — alcance y validación", () => {
  it("todo el equipo con permiso → practitionerId null (decisión 8)", () => {
    const r = buildBlockPayload(form({ scope: "all" }), { practitionerId: PRAC, canBlockAll: true });
    expect(r.ok && r.payload.practitionerId).toBeNull();
    if (r.ok) expect(TimeBlockCreate.safeParse(r.payload).success).toBe(true);
  });
  it("todo el equipo sin permiso → error de alcance, no payload", () => {
    const r = buildBlockPayload(form({ scope: "all" }), opts);
    expect(!r.ok && r.errors.scope).toMatch(/permiso/);
  });
  it("este profesional sin profesional → error", () => {
    const r = buildBlockPayload(form(), { practitionerId: "", canBlockAll: true });
    expect(!r.ok && r.errors.scope).toBeTruthy();
  });
  it("fecha inválida (30/02) → error", () => {
    expect(isValidDayKey("2026-02-30")).toBe(false);
    expect(isValidDayKey("2026-02-28")).toBe(true);
    const r = buildBlockPayload(form({ dayKey: "2026-02-30" }), opts);
    expect(!r.ok && r.errors.dayKey).toBeTruthy();
  });
  it("motivo de más de 200 → error", () => {
    const r = buildBlockPayload(form({ reason: "x".repeat(201) }), opts);
    expect(!r.ok && r.errors.reason).toBeTruthy();
  });
  it("sugerencias de motivo (decisión 10)", () => {
    expect(BLOCK_REASON_SUGGESTIONS).toEqual(["Feriado", "Congreso", "Vacaciones", "Capacitación", "Trámite"]);
  });
});

describe("dirty-guard", () => {
  const init = form();
  it("recién abierto no está sucio", () => {
    expect(isBlockFormDirty(init, { ...init })).toBe(false);
  });
  it("motivo, alcance, tipo, hora → sucio", () => {
    expect(isBlockFormDirty(init, { ...init, reason: "Congreso" })).toBe(true);
    expect(isBlockFormDirty(init, { ...init, scope: "all" })).toBe(true);
    expect(isBlockFormDirty(init, { ...init, kind: "allDay" })).toBe(true);
    expect(isBlockFormDirty(init, { ...init, toMin: init.toMin + 5 })).toBe(true);
  });
  it("solo espacios en el motivo no ensucia", () => {
    expect(isBlockFormDirty(init, { ...init, reason: "  " })).toBe(false);
  });
});

describe("errores", () => {
  it("fieldErrors del servidor → campos del form", () => {
    expect(
      mapServerFieldErrors({ endsAt: ["Máximo 31 días."], reason: ["largo"], practitionerId: ["x"] })
    ).toEqual({ toMin: "Máximo 31 días.", reason: "largo", scope: "x" });
    expect(routeEndsAtError({ toMin: "Máximo 31 días." }, "allDay")).toEqual({ endDayKey: "Máximo 31 días." });
    expect(routeEndsAtError({ toMin: "x" }, "range")).toEqual({ toMin: "x" });
  });
  it("throw de authz: muestra el mensaje en castellano; el genérico de Next no", () => {
    expect(blockThrownMessage(new Error("Solo podés bloquear tu propia agenda."))).toBe(
      "Solo podés bloquear tu propia agenda."
    );
    expect(
      blockThrownMessage(new Error("An error occurred in the Server Components render. digest"))
    ).toMatch(/permiso/);
    expect(blockThrownMessage("x")).toMatch(/No pudimos/);
  });
});

describe("resultado", () => {
  const base: CreateTimeBlockResult = {
    ids: ["b1"],
    groupId: null,
    startsAt: "2026-10-06T12:00:00.000Z",
    endsAt: "2026-10-06T15:00:00.000Z",
    affected: {
      count: 3,
      bookings: [
        { id: "k2", practitionerId: PRAC, scheduledFor: "2026-10-06T13:30:00.000Z", durationMin: 45, patientName: "Ana Gómez" },
        { id: "k1", practitionerId: PRAC, scheduledFor: "2026-10-06T11:30:00.000Z", durationMin: 60, patientName: null },
      ],
    },
  };
  it("titular singular/plural/ninguno", () => {
    expect(affectedHeadline(0)).toBe("Bloqueado. No hay turnos en ese horario.");
    expect(affectedHeadline(1)).toBe("Bloqueado. Hay 1 turno en ese horario.");
    expect(affectedHeadline(3)).toBe("Bloqueado. Hay 3 turnos en ese horario.");
  });
  it("líneas en hora AR, ordenadas; sin nombre → copy", () => {
    expect(affectedLines(base)).toEqual([
      { id: "k1", when: "08:30", patient: "Paciente sin nombre" },
      { id: "k2", when: "10:30", patient: "Ana Gómez" },
    ]);
    expect(affectedOverflow(base)).toBe(1);
  });
  it("bloqueo de varios días: la línea lleva el día AR", () => {
    const multi = {
      ...base,
      startsAt: "2026-10-06T03:00:00.000Z",
      endsAt: "2026-10-08T03:00:00.000Z",
      affected: {
        count: 1,
        bookings: [
          // 00:00 AR del 7 (03:00Z): ni "24:00" ni el día UTC.
          { id: "k3", practitionerId: PRAC, scheduledFor: "2026-10-07T03:00:00.000Z", durationMin: 30, patientName: "Leo" },
        ],
      },
    };
    const [line] = affectedLines(multi);
    expect(line.when).toBe("mié 07/10 · 00:00");
  });
  it("minutesToHHmm", () => {
    expect(minutesToHHmm(0)).toBe("00:00");
    expect(minutesToHHmm(545)).toBe("09:05");
    expect(minutesToHHmm(1440)).toBe("24:00");
  });
});
