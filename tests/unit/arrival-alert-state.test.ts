/**
 * [SV11b] Avisos de la sala de espera: diff puro, formato, modo efectivo,
 * título de pestaña y chime (§18.5 «Avisos», §18.8 fila SV11b, SV-D9/D16).
 *
 * Se testea el símbolo real (`lib/arrival-alert-state`, `lib/arrival-chime`,
 * `lib/tab-title`); lo único falso es el DOM/WebAudio, inyectado como deps con
 * registro a mano (brief SV: nada de `vi.fn` que tire).
 */
import { describe, expect, it } from "vitest";
import {
  arrivalsToAnnounce,
  batchIsRelevant,
  callsToAnnounce,
  effectiveMode,
  effectivePrefs,
  formatArrival,
  formatCall,
  formatGroupTitle,
  groupAnnouncements,
  patientInitials,
  shortPatientName,
  stripTitleBadge,
  titleWithBadge,
  todayRangeAR,
  type AlertRow,
  type AlertViewer,
} from "@/lib/arrival-alert-state";
import { CHIME, createChime, type ChimeAudioContext } from "@/lib/arrival-chime";
import { createTabTitle } from "@/lib/tab-title";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";
import { shortPatientName as salaShortPatientName } from "@/lib/sala-board-state";

// 10:30 AR = 13:30 UTC. Los tests corren en TZ=UTC y TZ=AR (test:tz-ar).
const AT_1030 = "2026-10-14T13:30:00.000Z";
const ARRIVED_1 = "2026-10-14T13:25:00.000Z";
const ARRIVED_2 = "2026-10-14T13:27:00.000Z";
const CALLED_1 = "2026-10-14T13:31:00.000Z";

function row(over: Partial<AlertRow> & { id: string }): AlertRow {
  return {
    practitionerId: "pA",
    patientName: "María González",
    scheduledFor: AT_1030,
    status: "CONFIRMED",
    roomId: null,
    arrivedAt: null,
    calledAt: null,
    attendingAt: null,
    ...over,
  };
}

const AP: AlertViewer = { practitionerId: "pA", canOperateAll: false };
const SECRE: AlertViewer = { practitionerId: null, canOperateAll: true };
const OWNER_A: AlertViewer = { practitionerId: "pA", canOperateAll: true };

describe("[SV11b] arrivalsToAnnounce", () => {
  it("anuncia solo los turnos del profesional cuyo arrivedAt pasó de null a valor", () => {
    const prev = [row({ id: "b1" }), row({ id: "b2", practitionerId: "pB" })];
    const next = [
      row({ id: "b1", arrivedAt: ARRIVED_1 }),
      row({ id: "b2", practitionerId: "pB", arrivedAt: ARRIVED_1 }),
    ];
    const out = arrivalsToAnnounce(prev, next, AP);
    expect(out.map((a) => a.bookingId)).toEqual(["b1"]);
    expect(out[0]).toMatchObject({ type: "arrival", key: `arr:b1:${ARRIVED_1}`, patientName: "María González" });
  });

  it("un arrivedAt que cambió (deshacer + volver a marcar) se anuncia otra vez", () => {
    const out = arrivalsToAnnounce(
      [row({ id: "b1", arrivedAt: ARRIVED_1 })],
      [row({ id: "b1", arrivedAt: ARRIVED_2 })],
      AP,
    );
    expect(out.map((a) => a.key)).toEqual([`arr:b1:${ARRIVED_2}`]);
  });

  it("no anuncia por en-atencion ni por deshacer (arrivedAt igual o vuelve a null)", () => {
    const prev = [row({ id: "b1", arrivedAt: ARRIVED_1 }), row({ id: "b2", arrivedAt: ARRIVED_1 })];
    const next = [
      row({ id: "b1", arrivedAt: ARRIVED_1, attendingAt: CALLED_1 }),
      row({ id: "b2", arrivedAt: null }),
    ];
    expect(arrivalsToAnnounce(prev, next, AP)).toEqual([]);
  });

  it("acepta Date o ISO indistintamente (la action serializa Date)", () => {
    const out = arrivalsToAnnounce(
      [row({ id: "b1", arrivedAt: new Date(ARRIVED_1) })],
      [row({ id: "b1", arrivedAt: ARRIVED_1 })],
      AP,
    );
    expect(out).toEqual([]);
  });

  it("es idempotente por bookingId+arrivedAt con el seen", () => {
    const prev = [row({ id: "b1" })];
    const next = [row({ id: "b1", arrivedAt: ARRIVED_1 })];
    const first = arrivalsToAnnounce(prev, next, AP);
    const seen = new Set(first.map((a) => a.key));
    expect(arrivalsToAnnounce(prev, next, AP, seen)).toEqual([]);
  });

  it("sin prev (no sembrado) no anuncia nada: el primer fetch es la semilla", () => {
    expect(arrivalsToAnnounce(null, [row({ id: "b1", arrivedAt: ARRIVED_1 })], AP)).toEqual([]);
  });

  it("un turno que no estaba en prev y ya llegó se anuncia; cancelado no", () => {
    const out = arrivalsToAnnounce(
      [],
      [row({ id: "b1", arrivedAt: ARRIVED_1 }), row({ id: "b2", arrivedAt: ARRIVED_1, status: "CANCELLED" })],
      AP,
    );
    expect(out.map((a) => a.bookingId)).toEqual(["b1"]);
  });

  it("viewer sin practitionerId (Secretaria) no recibe llegadas", () => {
    expect(arrivalsToAnnounce([row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED_1 })], SECRE)).toEqual([]);
  });
});

describe("[SV11b] callsToAnnounce", () => {
  it("solo con operateAll y solo turnos que no son del viewer", () => {
    const prev = [row({ id: "b1" }), row({ id: "b2", practitionerId: "pB" })];
    const next = [
      row({ id: "b1", arrivedAt: ARRIVED_1, calledAt: CALLED_1 }),
      row({ id: "b2", practitionerId: "pB", arrivedAt: ARRIVED_1, calledAt: CALLED_1, roomId: "r2" }),
    ];
    expect(callsToAnnounce(prev, next, AP)).toEqual([]);
    expect(callsToAnnounce(prev, next, OWNER_A).map((c) => c.bookingId)).toEqual(["b2"]);
    const secre = callsToAnnounce(prev, next, SECRE);
    expect(secre.map((c) => c.key)).toEqual([`call:b1:${CALLED_1}`, `call:b2:${CALLED_1}`]);
    expect(secre[1]).toMatchObject({ type: "call", roomId: "r2", practitionerId: "pB" });
  });

  it("idempotente por bookingId+calledAt; calledAt igual no se repite", () => {
    const prev = [row({ id: "b1", practitionerId: "pB" })];
    const next = [row({ id: "b1", practitionerId: "pB", calledAt: CALLED_1 })];
    const first = callsToAnnounce(prev, next, SECRE);
    expect(callsToAnnounce(prev, next, SECRE, new Set(first.map((c) => c.key)))).toEqual([]);
    expect(callsToAnnounce(next, next, SECRE)).toEqual([]);
  });

  it("si ya pasó a atención en el mismo lote, el «Pase» llega tarde y no se anuncia", () => {
    const prev = [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED_1 })];
    const next = [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED_1, calledAt: CALLED_1, attendingAt: CALLED_1 })];
    expect(callsToAnnounce(prev, next, SECRE)).toEqual([]);
  });
});

describe("[SV11b] agrupado (SV-D16)", () => {
  const arr = (i: number) => arrivalsToAnnounce([], [row({ id: `b${i}`, arrivedAt: ARRIVED_1 })], AP)[0];
  it("menos de 3 → uno por aviso; 3 o más del mismo tipo → uno agrupado", () => {
    expect(groupAnnouncements([arr(1), arr(2)]).map((g) => g.kind)).toEqual(["single", "single"]);
    const g = groupAnnouncements([arr(1), arr(2), arr(3)]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: "group", type: "arrival" });
    expect(formatGroupTitle("arrival", 3)).toBe("Llegaron 3 pacientes");
    expect(formatGroupTitle("call", 4)).toBe("Llamaron a 4 pacientes");
  });
});

describe("[SV11b] modo efectivo y aplicabilidad", () => {
  it("en resync nunca suena", () => {
    expect(effectiveMode("sound", { viaResync: true })).toBe("visual");
    expect(effectiveMode("sound", { viaResync: false })).toBe("sound");
    expect(effectiveMode("visual", { viaResync: false })).toBe("visual");
    expect(effectiveMode("off", { viaResync: false })).toBe("off");
  });

  it("la pref que no aplica al viewer queda off", () => {
    expect(effectivePrefs(AP, { arrivalAlert: "sound", callAlert: "visual" })).toEqual({ arrival: "sound", call: "off" });
    expect(effectivePrefs(SECRE, { arrivalAlert: "sound", callAlert: "visual" })).toEqual({ arrival: "off", call: "visual" });
    expect(effectivePrefs(OWNER_A, { arrivalAlert: "off", callAlert: "sound" })).toEqual({ arrival: "off", call: "sound" });
  });
});

describe("[SV11b] formato", () => {
  it("nombre corto e iniciales", () => {
    // [FX2b A4] Es el MISMO símbolo que usa `/sala` (una sola regla en
    // lib/sala-board-state): el toast y la banda dicen lo mismo.
    expect(shortPatientName).toBe(salaShortPatientName);
    expect(shortPatientName("María González")).toBe("María G.");
    expect(patientInitials("María González")).toBe("MG");
    expect(patientInitials("Álvaro")).toBe("ÁL");
  });

  it("«Llegó María G. · 10:30» en hora AR, corra donde corra", () => {
    const a = arrivalsToAnnounce([], [row({ id: "b1", arrivedAt: ARRIVED_1 })], AP)[0];
    expect(formatArrival(a)).toBe("Llegó María G. · 10:30");
  });

  it("[FX2b A4] con dos apellidos va la inicial del PRIMERO, igual que en /sala", () => {
    const a = arrivalsToAnnounce(
      [],
      [row({ id: "b1", patientName: "María González Pérez", arrivedAt: ARRIVED_1 })],
      AP,
    )[0];
    expect(formatArrival(a)).toBe("Llegó María G. · 10:30");
    const c = callsToAnnounce(
      [],
      [row({ id: "b2", practitionerId: "pB", patientName: "María González Pérez", calledAt: CALLED_1 })],
      SECRE,
    )[0];
    expect(formatCall(c, { roomName: "Consultorio 2", practitionerName: null })).toBe("Pase María G. · Consultorio 2");
  });

  it("«Pase María G. · Consultorio 2 · Dra. Pérez», sin sala o sin profesional se omiten", () => {
    const c = callsToAnnounce([], [row({ id: "b1", practitionerId: "pB", calledAt: CALLED_1, roomId: "r2" })], SECRE)[0];
    expect(formatCall(c, { roomName: "Consultorio 2", practitionerName: "Dra. Pérez" })).toBe(
      "Pase María G. · Consultorio 2 · Dra. Pérez",
    );
    expect(formatCall(c, { roomName: null, practitionerName: "Dra. Pérez" })).toBe("Pase María G. · Dra. Pérez");
    expect(formatCall(c, { roomName: null, practitionerName: null })).toBe("Pase María G.");
  });
});

describe("[SV11b] título de pestaña", () => {
  it("titleWithBadge y stripTitleBadge", () => {
    expect(titleWithBadge("Agenda · KineSoft", 0, "Llegó María G.")).toBe("Agenda · KineSoft");
    expect(titleWithBadge("Agenda · KineSoft", 1, "Llegó María G.")).toBe("(1) Llegó María G. · KineSoft");
    expect(titleWithBadge("Agenda · KineSoft", 2)).toBe("(2) Agenda · KineSoft");
    expect(stripTitleBadge("(3) Agenda · KineSoft")).toBe("Agenda · KineSoft");
  });

  function fakeDoc(hidden: boolean) {
    const listeners = new Map<string, Array<() => void>>();
    const doc = {
      title: "Agenda · KineSoft",
      hidden,
      visibilityState: hidden ? "hidden" : "visible",
      hasFocus: () => !doc.hidden,
      addEventListener: (t: string, fn: () => void) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: (t: string, fn: () => void) =>
        listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
    };
    const fire = (t: string) => (listeners.get(t) ?? []).forEach((f) => f());
    return { doc, fire, listeners };
  }

  it("acumula con la pestaña en segundo plano y se limpia al volver", () => {
    const { doc, fire } = fakeDoc(true);
    const win = fakeDoc(true);
    const t = createTabTitle({ doc, win: win.doc });
    t.announce("Llegó María G.");
    t.announce("Llegó Juan P.");
    expect(doc.title).toBe("(2) Llegó Juan P. · KineSoft");
    doc.hidden = false;
    doc.visibilityState = "visible";
    fire("visibilitychange");
    expect(doc.title).toBe("Agenda · KineSoft");
    expect(t.count()).toBe(0);
    t.dispose();
  });

  it("con la pestaña al frente no toca el título (no hay foco que lo limpie)", () => {
    const { doc } = fakeDoc(false);
    const t = createTabTitle({ doc, win: fakeDoc(false).doc });
    t.announce("Llegó María G.");
    expect(doc.title).toBe("Agenda · KineSoft");
    t.dispose();
  });

  it("si Next cambia el <title> mientras hay badge, el badge se re-aplica sobre el título nuevo", () => {
    const { doc, fire } = fakeDoc(true);
    const win = fakeDoc(true);
    let observerCb: (() => void) | null = null;
    const t = createTabTitle({
      doc,
      win: win.doc,
      observeTitle: (cb) => {
        observerCb = cb;
        return () => {
          observerCb = null;
        };
      },
    });
    t.announce("Llegó María G.");
    doc.title = "Sala de espera · KineSoft"; // navegación de Next
    observerCb!();
    expect(doc.title).toBe("(1) Llegó María G. · KineSoft");
    win.fire("focus");
    expect(doc.title).toBe("Sala de espera · KineSoft");
    t.dispose();
    expect(observerCb).toBeNull();
    void fire;
  });
});

describe("[SV11b] chime (WebAudio)", () => {
  function fakeAudio(initial: "suspended" | "running") {
    const log: string[] = [];
    const ctx: ChimeAudioContext & { state: string } = {
      state: initial,
      currentTime: 0,
      destination: {},
      resume: async () => {
        log.push("resume");
        ctx.state = "running";
      },
      createOscillator: () => {
        const osc = {
          type: "sine",
          frequency: { setValueAtTime: (v: number) => log.push(`freq:${v}`) },
          connect: () => {},
          start: () => log.push("start"),
          stop: () => log.push("stop"),
        };
        return osc;
      },
      createGain: () => ({
        gain: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: (v: number) => log.push(`gain:${v}`),
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
      }),
    };
    return { ctx, log };
  }

  function fakeTarget() {
    const ls = new Map<string, Array<() => void>>();
    return {
      addEventListener: (t: string, fn: () => void) => ls.set(t, [...(ls.get(t) ?? []), fn]),
      removeEventListener: (t: string, fn: () => void) => ls.set(t, (ls.get(t) ?? []).filter((f) => f !== fn)),
      fire: (t: string) => [...(ls.get(t) ?? [])].forEach((f) => f()),
      count: () => [...ls.values()].reduce((n, a) => n + a.length, 0),
    };
  }

  it("constantes del plan: 880 → 1174 Hz, 180 ms, ganancia 0,12", () => {
    expect(CHIME).toEqual({ freqs: [880, 1174], toneMs: 180, gain: 0.12 });
  });

  it("sin gesto no hay AudioContext y playChime devuelve false", () => {
    let created = 0;
    const target = fakeTarget();
    const chime = createChime({ createContext: () => (created++, fakeAudio("suspended").ctx), target });
    chime.installUnlock();
    expect(created).toBe(0);
    expect(chime.play()).toBe(false);
  });

  it("el primer gesto crea y reanuda el contexto una sola vez; después suena dos tonos", async () => {
    const { ctx, log } = fakeAudio("suspended");
    let created = 0;
    const target = fakeTarget();
    const chime = createChime({ createContext: () => (created++, ctx), target });
    chime.installUnlock();
    chime.installUnlock(); // idempotente
    target.fire("pointerdown");
    await Promise.resolve();
    target.fire("keydown");
    expect(created).toBe(1);
    expect(log.filter((l) => l === "resume")).toHaveLength(1);
    expect(target.count()).toBe(0);
    expect(chime.play()).toBe(true);
    expect(log.filter((l) => l.startsWith("freq:"))).toEqual(["freq:880", "freq:1174"]);
    expect(log).toContain("gain:0.12");
  });

  it("si el contexto sigue suspended (navegador lo bloquea), degrada: false", () => {
    const { ctx } = fakeAudio("suspended");
    ctx.resume = async () => {};
    const target = fakeTarget();
    const chime = createChime({ createContext: () => ctx, target });
    chime.installUnlock();
    target.fire("pointerdown");
    expect(chime.play()).toBe(false);
  });

  it("«Probar sonido» crea y reanuda desde el clic aunque no haya unlock instalado", async () => {
    const { ctx, log } = fakeAudio("suspended");
    const chime = createChime({ createContext: () => ctx, target: fakeTarget() });
    expect(await chime.preview()).toBe(true);
    expect(log).toContain("resume");
  });

  it("sin WebAudio (SSR o navegador viejo) nunca tira", async () => {
    const chime = createChime({ createContext: () => null, target: null });
    chime.installUnlock();
    expect(chime.play()).toBe(false);
    expect(await chime.preview()).toBe(false);
  });
});

describe("[SV11b] lote relevante y rango de hoy", () => {
  const m = (over: Partial<RealtimeAgendaMessage>): RealtimeAgendaMessage => ({
    v: 1,
    kind: "reception",
    bookingId: "b1",
    practitionerId: "pA",
    day: "2026-10-14",
    at: AT_1030,
    ...over,
  });
  const eff = { arrival: "visual", call: "visual" } as const;

  it("reception de hoy del profesional → sí; de otro día o de otro profesional → no", () => {
    expect(batchIsRelevant([m({})], "2026-10-14", AP, eff)).toBe(true);
    expect(batchIsRelevant([m({ day: "2026-10-15" })], "2026-10-14", AP, eff)).toBe(false);
    expect(batchIsRelevant([m({ practitionerId: "pB" })], "2026-10-14", AP, eff)).toBe(false);
    expect(batchIsRelevant([m({ practitionerId: "pB" })], "2026-10-14", SECRE, eff)).toBe(false);
  });

  it("called → solo a quien opera todo; booking suelto no; colapsado (sin bookingId) sí", () => {
    expect(batchIsRelevant([m({ kind: "called", practitionerId: "pB" })], "2026-10-14", SECRE, eff)).toBe(true);
    expect(batchIsRelevant([m({ kind: "called" })], "2026-10-14", AP, eff)).toBe(false);
    expect(batchIsRelevant([m({ kind: "booking" })], "2026-10-14", AP, eff)).toBe(false);
    expect(
      batchIsRelevant([m({ kind: "booking", bookingId: undefined, practitionerId: null, day: null })], "2026-10-14", AP, eff),
    ).toBe(true);
    expect(batchIsRelevant([m({ kind: "availability", bookingId: undefined })], "2026-10-14", SECRE, eff)).toBe(false);
  });

  it("con la pref de llegada off, un reception no dispara refetch", () => {
    expect(batchIsRelevant([m({})], "2026-10-14", AP, { arrival: "off", call: "off" })).toBe(false);
  });

  it("todayRangeAR: medianoche AR a medianoche AR (23:30 AR sigue siendo hoy)", () => {
    const r = todayRangeAR(new Date("2026-10-15T02:30:00.000Z")); // 23:30 AR del 14
    expect(r.day).toBe("2026-10-14");
    expect(r.from.toISOString()).toBe("2026-10-14T03:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-15T03:00:00.000Z");
  });
});
