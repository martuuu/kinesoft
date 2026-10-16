/**
 * SV02 · C-SV1/C-SV2: mensaje del canal realtime de la agenda.
 *
 * Lo que se cuida: el `day` en hora AR (corre en TZ=UTC y TZ=AR), el `prev` de
 * los movimientos, el dedupe, el colapso de SV-D10 y que el payload no tenga
 * NINGUNA clave fuera del allowlist (es el control de PHI del canal).
 */
import { describe, expect, it } from "vitest";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import {
  availabilityMessage,
  buildRealtimeMessages,
  type RealtimeAgendaMessage,
} from "@/lib/realtime-events";
// PF1.0-a (C-PF3): el schema zod salió de `realtime-events` (el cliente valida con `realtime-message-guard`).
import { RealtimeAgendaMessageSchema } from "@/lib/realtime-events-schema";
import {
  MAX_MESSAGES_PER_POST,
  REALTIME_DRIVERS,
  REALTIME_EVENT,
  REALTIME_PUBLISH_TIMEOUT_MS,
  REALTIME_TOKEN_TTL_SEC,
  topicFor,
} from "@/lib/realtime-constants";

const NOW = new Date("2026-10-13T15:00:00.000Z");
const AT = NOW.toISOString();

const TOP_KEYS = new Set(["v", "kind", "bookingId", "practitionerId", "day", "roomId", "prev", "at"]);
const PREV_KEYS = new Set(["practitionerId", "day", "roomId"]);

function assertAllowlisted(m: RealtimeAgendaMessage) {
  for (const k of Object.keys(m)) expect(TOP_KEYS.has(k), `clave fuera del allowlist: ${k}`).toBe(true);
  if (m.prev) for (const k of Object.keys(m.prev)) expect(PREV_KEYS.has(k), `prev.${k}`).toBe(true);
  expect(RealtimeAgendaMessageSchema.safeParse(m).success).toBe(true);
}

/** Turno a las 10:00 AR del día `day` (13:00Z). */
function ref(i: number, practitionerId: string, day = "2026-10-13", extra: Partial<BookingChangeRef> = {}): BookingChangeRef {
  return { bookingId: `b${i}`, practitionerId, scheduledFor: new Date(`${day}T13:00:00.000Z`), ...extra };
}

describe("C-SV1 realtime-constants", () => {
  it("valores congelados", () => {
    expect(REALTIME_EVENT).toBe("agenda");
    expect(topicFor("abc123")).toBe("tenant:abc123:agenda");
    expect(MAX_MESSAGES_PER_POST).toBe(20);
    expect(REALTIME_PUBLISH_TIMEOUT_MS).toBe(1500);
    expect(REALTIME_TOKEN_TTL_SEC).toBe(600);
    expect(REALTIME_DRIVERS).toEqual(["off", "local", "supabase"]);
  });
});

describe("buildRealtimeMessages", () => {
  it("[] → []", () => {
    expect(buildRealtimeMessages([], NOW)).toEqual([]);
  });

  it("day en hora AR: un turno 23:30 AR (02:30Z del día siguiente) es del día AR", () => {
    const [m] = buildRealtimeMessages(
      [{ bookingId: "b1", practitionerId: "p1", scheduledFor: new Date("2026-10-14T02:30:00.000Z") }],
      NOW
    );
    expect(m).toEqual({ v: 1, kind: "booking", bookingId: "b1", practitionerId: "p1", day: "2026-10-13", at: AT });
    assertAllowlisted(m);
  });

  it("roomId y kind del ref; roomId ausente no aparece, null sí", () => {
    const out = buildRealtimeMessages(
      [
        ref(1, "p1", "2026-10-13", { roomId: "r1", kind: "called" }),
        ref(2, "p1", "2026-10-13", { roomId: null, kind: "reception" }),
        ref(3, "p1"),
      ],
      NOW
    );
    expect(out[0]).toMatchObject({ kind: "called", roomId: "r1" });
    expect(out[1]).toMatchObject({ kind: "reception", roomId: null });
    expect(out[1]).toHaveProperty("roomId", null);
    expect(out[2]).not.toHaveProperty("roomId");
    out.forEach(assertAllowlisted);
  });

  it("prev de un movimiento con su día AR y su sala", () => {
    const [m] = buildRealtimeMessages(
      [
        ref(1, "p2", "2026-10-15", {
          roomId: "r2",
          prev: { practitionerId: "p1", scheduledFor: new Date("2026-10-14T02:30:00.000Z"), roomId: "r1" },
        }),
      ],
      NOW
    );
    expect(m.prev).toEqual({ practitionerId: "p1", day: "2026-10-13", roomId: "r1" });
    expect(m.day).toBe("2026-10-15");
    assertAllowlisted(m);
    const [noRoom] = buildRealtimeMessages(
      [ref(2, "p2", "2026-10-15", { prev: { practitionerId: "p1", scheduledFor: new Date("2026-10-15T13:00:00Z") } })],
      NOW
    );
    expect(noRoom.prev).toEqual({ practitionerId: "p1", day: "2026-10-15" });
    // prev null (forma admitida por BookingChangeRef) = sin prev.
    const [nullPrev] = buildRealtimeMessages([ref(3, "p1", "2026-10-13", { prev: null })], NOW);
    expect(nullPrev).not.toHaveProperty("prev");
  });

  it("dedupe por (bookingId, kind) quedándose con el último; kinds distintos no se pisan", () => {
    const out = buildRealtimeMessages(
      [
        ref(1, "p1", "2026-10-13", { roomId: "r1" }),
        ref(1, "p1", "2026-10-13", { kind: "reception" }),
        ref(1, "p2", "2026-10-14", { roomId: "r9" }),
      ],
      NOW
    );
    expect(out).toHaveLength(2);
    expect(out).toContainEqual({ v: 1, kind: "reception", bookingId: "b1", practitionerId: "p1", day: "2026-10-13", at: AT });
    expect(out).toContainEqual({
      v: 1,
      kind: "booking",
      bookingId: "b1",
      practitionerId: "p2",
      day: "2026-10-14",
      roomId: "r9",
      at: AT,
    });
  });

  it("20 refs distintos → 20 mensajes (sin colapso)", () => {
    const refs = Array.from({ length: 20 }, (_, i) => ref(i, `p${i % 3}`));
    expect(buildRealtimeMessages(refs, NOW)).toHaveLength(20);
  });

  it("21 refs → colapso por (practitionerId, day) sin bookingId; los prev también son clave", () => {
    const refs = Array.from({ length: 21 }, (_, i) => ref(i, `p${i % 2}`));
    refs[0] = ref(0, "p0", "2026-10-13", {
      prev: { practitionerId: "p9", scheduledFor: new Date("2026-10-16T13:00:00Z") },
    });
    const out = buildRealtimeMessages(refs, NOW);
    expect(out).toEqual([
      { v: 1, kind: "booking", practitionerId: "p0", day: "2026-10-13", at: AT },
      { v: 1, kind: "booking", practitionerId: "p9", day: "2026-10-16", at: AT },
      { v: 1, kind: "booking", practitionerId: "p1", day: "2026-10-13", at: AT },
    ]);
    out.forEach(assertAllowlisted);
  });

  it("colapso: kind se conserva si todos coinciden; mezclados → booking", () => {
    const same = Array.from({ length: 21 }, (_, i) => ref(i, "p1", "2026-10-13", { kind: "reception" }));
    expect(buildRealtimeMessages(same, NOW)).toEqual([
      { v: 1, kind: "reception", practitionerId: "p1", day: "2026-10-13", at: AT },
    ]);
    const mixed = Array.from({ length: 21 }, (_, i) => ref(i, "p1", "2026-10-13", { kind: i ? "reception" : "called" }));
    expect(buildRealtimeMessages(mixed, NOW)[0].kind).toBe("booking");
  });

  it("60 refs de 15 profesionales en 4 días (60 pares > 20) → uno por profesional con day:null", () => {
    const days = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];
    const refs = Array.from({ length: 60 }, (_, i) => ref(i, `p${i % 15}`, days[Math.floor(i / 15)]));
    const out = buildRealtimeMessages(refs, NOW);
    expect(out).toHaveLength(15);
    for (const m of out) {
      expect(m).toEqual({ v: 1, kind: "booking", practitionerId: m.practitionerId, day: null, at: AT });
      assertAllowlisted(m);
    }
    expect(new Set(out.map((m) => m.practitionerId)).size).toBe(15);
  });

  it("60 refs de 25 profesionales (> 20 profesionales) → un único mensaje de todo el consultorio", () => {
    const days = ["2026-10-13", "2026-10-14", "2026-10-15"];
    const refs = Array.from({ length: 60 }, (_, i) => ref(i, `p${i % 25}`, days[i % 3]));
    const out = buildRealtimeMessages(refs, NOW);
    expect(out).toEqual([{ v: 1, kind: "booking", practitionerId: null, day: null, at: AT }]);
    assertAllowlisted(out[0]);
  });

  it("ninguna clave fuera del allowlist aunque el ref traiga campos de más (PHI)", () => {
    const dirty = {
      ...ref(1, "p1", "2026-10-13", { roomId: "r1" }),
      patientName: "María G.",
      notes: "dolor lumbar",
      prev: { practitionerId: "p0", scheduledFor: new Date("2026-10-13T12:00:00Z"), title: "x" },
    } as BookingChangeRef;
    const [m] = buildRealtimeMessages([dirty], NOW);
    assertAllowlisted(m);
    expect(JSON.stringify(m)).not.toMatch(/María|lumbar|title/);
  });
});

describe("availabilityMessage", () => {
  it("arma un availability válido, con o sin profesional", () => {
    const m = availabilityMessage({ practitionerId: "p1", day: "2026-10-13" }, NOW);
    expect(m).toEqual({ v: 1, kind: "availability", practitionerId: "p1", day: "2026-10-13", at: AT });
    assertAllowlisted(m);
    assertAllowlisted(availabilityMessage({ practitionerId: null, day: "2026-10-13" }, NOW));
  });
  it("[FX1b] day null (bloqueo de varios días) → un availability con day null que el schema acepta", () => {
    const m = availabilityMessage({ practitionerId: "p1", day: null }, NOW);
    expect(m).toEqual({ v: 1, kind: "availability", practitionerId: "p1", day: null, at: AT });
    expect(RealtimeAgendaMessageSchema.safeParse(m).success).toBe(true);
    assertAllowlisted(m);
  });
});

describe("RealtimeAgendaMessageSchema (.strict())", () => {
  const ok = { v: 1, kind: "booking", bookingId: "b1", practitionerId: "p1", day: "2026-10-13", at: AT };
  it("acepta el payload válido", () => {
    expect(RealtimeAgendaMessageSchema.safeParse(ok).success).toBe(true);
  });
  it("rechaza payloads inválidos", () => {
    for (const bad of [
      { ...ok, v: 2 },
      { ...ok, kind: "patient" },
      { ...ok, patientName: "María" },
      { ...ok, day: "13/10/2026" },
      { ...ok, day: undefined },
      { ...ok, practitionerId: undefined },
      { ...ok, at: "ayer" },
      { ...ok, prev: { practitionerId: "p1", day: "2026-10-13", notes: "x" } },
      { ...ok, prev: { practitionerId: "p1" } },
      { ...ok, bookingId: "" },
      null,
      "x",
    ]) {
      expect(RealtimeAgendaMessageSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
