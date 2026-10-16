/**
 * B4.2 AG-resource: `UserPreferences.agendaPrefs` (modo, zoom, densidad,
 * favoritos, sede). Lectura total y por campo (un blob viejo/roto nunca rompe
 * la agenda ni borra los favoritos); escritura estricta (patch fuera de dominio
 * → rechazo, no se corrige en silencio).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENDA_VIEW_PREFS,
  DEFAULT_PREFERENCES,
  toggleFavoritePractitioner,
  AGENDA_MAX_FAVORITES,
} from "@/lib/preferences-constants";
import { AgendaViewPrefsPatchSchema, mergeAgendaViewPrefs, sanitizeAgendaViewPrefs } from "@/lib/preferences-schemas";
import { nextSelection } from "@/components/agenda/practitioner-chips";

describe("sanitizeAgendaViewPrefs (lectura)", () => {
  it("null / no-objeto / array → default", () => {
    for (const raw of [null, undefined, "x", 42, [], true]) {
      expect(sanitizeAgendaViewPrefs(raw)).toEqual(DEFAULT_AGENDA_VIEW_PREFS);
    }
  });

  it("DEFAULT_PREFERENCES trae el default de agenda", () => {
    expect(DEFAULT_PREFERENCES.agendaView).toEqual({
      mode: "day",
      zoom: 30,
      density: "comfortable",
      favoritePractitionerIds: [],
      locationId: null,
      // SV (C-SV9): avisos visuales para todos, sonido apagado; /sala por profesional.
      arrivalAlert: "visual",
      callAlert: "visual",
      salaGroupBy: "practitioner",
      // RX (C-RX1, RX-D2): /sala arranca en el Tablero para todos.
      receptionLayout: "board",
    });
  });

  it("blob válido pasa igual", () => {
    const v = {
      mode: "practitioner",
      zoom: 15,
      density: "compact",
      favoritePractitionerIds: ["p2", "p1"],
      locationId: "loc-1",
      arrivalAlert: "sound",
      callAlert: "off",
      salaGroupBy: "room",
      receptionLayout: "flow",
    };
    expect(sanitizeAgendaViewPrefs(v)).toEqual(v);
  });

  it("campo inválido cae a SU default sin tocar los demás", () => {
    const out = sanitizeAgendaViewPrefs({
      mode: "semana",
      zoom: 45,
      density: "XL",
      favoritePractitionerIds: ["p1"],
      locationId: 7,
    });
    expect(out).toEqual({ ...DEFAULT_AGENDA_VIEW_PREFS, favoritePractitionerIds: ["p1"] });
  });

  it("zoom como string no se coerciona ('30' ≠ 30)", () => {
    expect(sanitizeAgendaViewPrefs({ zoom: "15" }).zoom).toBe(30);
  });

  it("favoritos: filtra no-strings y vacíos, recorta, deduplica y mantiene el orden", () => {
    const out = sanitizeAgendaViewPrefs({
      favoritePractitionerIds: [" p3 ", 1, null, "", "p1", "p3", "x".repeat(65), "p2"],
    });
    expect(out.favoritePractitionerIds).toEqual(["p3", "p1", "p2"]);
  });

  it("favoritos: tope", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `p${i}`);
    expect(sanitizeAgendaViewPrefs({ favoritePractitionerIds: ids }).favoritePractitionerIds).toHaveLength(
      AGENDA_MAX_FAVORITES
    );
  });

  it("favoritos no-array → []", () => {
    expect(sanitizeAgendaViewPrefs({ favoritePractitionerIds: "p1" }).favoritePractitionerIds).toEqual([]);
  });

  it("locationId null explícito = todas las sedes", () => {
    expect(sanitizeAgendaViewPrefs({ locationId: null }, { ...DEFAULT_AGENDA_VIEW_PREFS, locationId: "x" }).locationId).toBeNull();
  });

  it("defaults del caller (zoom del tenant) solo para campos ausentes o inválidos", () => {
    const defaults = { ...DEFAULT_AGENDA_VIEW_PREFS, zoom: 60 as const };
    expect(sanitizeAgendaViewPrefs({}, defaults).zoom).toBe(60);
    expect(sanitizeAgendaViewPrefs({ zoom: 99 }, defaults).zoom).toBe(60);
    expect(sanitizeAgendaViewPrefs({ zoom: 15 }, defaults).zoom).toBe(15);
  });

  it("descarta claves desconocidas", () => {
    expect(sanitizeAgendaViewPrefs({ hack: 1 })).not.toHaveProperty("hack");
  });
});

describe("AgendaViewPrefsPatchSchema (escritura, estricta)", () => {
  it("acepta un patch parcial válido", () => {
    const r = AgendaViewPrefsPatchSchema.safeParse({ mode: "practitioner", zoom: 60 });
    expect(r.success && r.data).toEqual({ mode: "practitioner", zoom: 60 });
  });

  it("rechaza valores fuera de dominio y claves desconocidas", () => {
    for (const bad of [
      { mode: "semana" },
      { zoom: 45 },
      { zoom: "30" },
      { density: "xl" },
      { favoritePractitionerIds: "p1" },
      { favoritePractitionerIds: [""] },
      { favoritePractitionerIds: Array.from({ length: AGENDA_MAX_FAVORITES + 1 }, (_, i) => `p${i}`) },
      { locationId: "" },
      { palette: "sky" },
    ]) {
      expect(AgendaViewPrefsPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("deduplica favoritos y acepta locationId null", () => {
    const r = AgendaViewPrefsPatchSchema.parse({ favoritePractitionerIds: ["a", "b", "a"], locationId: null });
    expect(r).toEqual({ favoritePractitionerIds: ["a", "b"], locationId: null });
  });

  it("merge: el patch pisa solo sus campos", () => {
    const current = { ...DEFAULT_AGENDA_VIEW_PREFS, favoritePractitionerIds: ["p1"], zoom: 15 as const };
    const patch = AgendaViewPrefsPatchSchema.parse({ mode: "practitioner" });
    expect(mergeAgendaViewPrefs(current, patch)).toEqual({ ...current, mode: "practitioner" });
  });
});

describe("toggleFavoritePractitioner", () => {
  it("agrega al final y saca sin reordenar", () => {
    expect(toggleFavoritePractitioner(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleFavoritePractitioner(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("nextSelection (chips de profesionales)", () => {
  const all = ["p1", "p2", "p3"];
  it("desde Todos, un click deja solo ese", () => {
    expect(nextSelection(all, [], "p2")).toEqual(["p2"]);
  });
  it("multi-select en el orden de la lista", () => {
    expect(nextSelection(all, ["p3"], "p1")).toEqual(["p1", "p3"]);
  });
  it("sacar el último vuelve a Todos", () => {
    expect(nextSelection(all, ["p2"], "p2")).toEqual([]);
  });
  it("marcar todos vuelve a Todos", () => {
    expect(nextSelection(all, ["p1", "p2"], "p3")).toEqual([]);
  });
  it("ids ajenos se ignoran", () => {
    expect(nextSelection(all, ["zz"], "p1")).toEqual(["p1"]);
  });
  it("con un solo profesional no hay filtro", () => {
    expect(nextSelection(["p1"], [], "p1")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR-U3: modo "Por sala" y filtro de sala (`agendaPrefs.roomId`, D2).
// `roomId` se OMITE del blob cuando es null (= todas): un usuario sin salas ve
// exactamente las mismas prefs que antes de SR (los tests de arriba no cambian).
// Una sala ajena o archivada se trata como "todas" al leer contra el catálogo
// (`effectiveRoomFilter` de lib/agenda-client-state); acá solo la forma.
// ─────────────────────────────────────────────────────────────────────────────
import { AGENDA_MODES } from "@/lib/preferences-constants";

describe("[SR-U3] agendaPrefs: mode room + roomId", () => {
  it('AGENDA_MODES suma "room"', () => {
    expect(AGENDA_MODES).toEqual(["day", "practitioner", "room"]);
  });

  it("sanitize: mode room y roomId válidos pasan", () => {
    const out = sanitizeAgendaViewPrefs({ mode: "room", roomId: "R1", locationId: "L1" });
    expect(out.mode).toBe("room");
    expect(out.roomId).toBe("R1");
    expect(sanitizeAgendaViewPrefs({ roomId: "none" }).roomId).toBe("none");
  });

  it("sanitize: roomId null/ausente/inválido → se omite (= todas), sin tocar los demás", () => {
    for (const roomId of [null, undefined, 7, "", "x".repeat(65), ["R1"]]) {
      const out = sanitizeAgendaViewPrefs({ mode: "practitioner", roomId });
      expect(out).not.toHaveProperty("roomId");
      expect(out.mode).toBe("practitioner");
    }
    expect(sanitizeAgendaViewPrefs({})).toEqual(DEFAULT_AGENDA_VIEW_PREFS);
  });

  it("patch: acepta mode room y roomId (string | null), rechaza fuera de dominio", () => {
    expect(AgendaViewPrefsPatchSchema.parse({ mode: "room", roomId: "R1" })).toEqual({ mode: "room", roomId: "R1" });
    expect(AgendaViewPrefsPatchSchema.parse({ roomId: null })).toEqual({ roomId: null });
    expect(AgendaViewPrefsPatchSchema.parse({ roomId: "none" })).toEqual({ roomId: "none" });
    for (const bad of [{ roomId: "" }, { roomId: 3 }, { roomId: "x".repeat(65) }, { mode: "sala" }]) {
      expect(AgendaViewPrefsPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("merge: roomId null limpia el filtro (se omite)", () => {
    const current = sanitizeAgendaViewPrefs({ locationId: "L1", roomId: "R1" });
    const next = mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ roomId: null }));
    expect(next).not.toHaveProperty("roomId");
    expect(next.locationId).toBe("L1");
  });

  it("merge (D2): cambiar de sede limpia la sala", () => {
    const current = sanitizeAgendaViewPrefs({ locationId: "L1", roomId: "R1", mode: "room" });
    const toL2 = mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ locationId: "L2" }));
    expect(toL2).not.toHaveProperty("roomId");
    expect(toL2.mode).toBe("room");
    const toAll = mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ locationId: null }));
    expect(toAll).not.toHaveProperty("roomId");
  });

  it("merge (D2): misma sede o sala nueva en el mismo patch → se respeta", () => {
    const current = sanitizeAgendaViewPrefs({ locationId: "L1", roomId: "R1" });
    expect(mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ locationId: "L1" })).roomId).toBe("R1");
    expect(mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ zoom: 15 })).roomId).toBe("R1");
    expect(
      mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ locationId: "L2", roomId: "R3" })).roomId
    ).toBe("R3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SV02 · C-SV9: avisos de la Sala de Espera y agrupación de /sala.
// Un blob anterior a SV (sin las claves) lee los defaults; un valor roto cae a
// SU default sin tocar el resto; el patch acepta solo el dominio.
// ─────────────────────────────────────────────────────────────────────────────
import { ALERT_MODES, SALA_GROUP_BYS } from "@/lib/preferences-constants";

describe("[SV02] agendaPrefs: arrivalAlert, callAlert, salaGroupBy", () => {
  it("dominios exportados", () => {
    expect(ALERT_MODES).toEqual(["visual", "sound", "off"]);
    expect(SALA_GROUP_BYS).toEqual(["practitioner", "room"]);
  });

  it("blob anterior a SV (sin las claves) → defaults visual/visual/practitioner", () => {
    const out = sanitizeAgendaViewPrefs({ mode: "practitioner", favoritePractitionerIds: ["p1"] });
    expect(out.arrivalAlert).toBe("visual");
    expect(out.callAlert).toBe("visual");
    expect(out.salaGroupBy).toBe("practitioner");
  });

  it("valores válidos pasan", () => {
    for (const m of ALERT_MODES) {
      const out = sanitizeAgendaViewPrefs({ arrivalAlert: m, callAlert: m });
      expect([out.arrivalAlert, out.callAlert]).toEqual([m, m]);
    }
    expect(sanitizeAgendaViewPrefs({ salaGroupBy: "room" }).salaGroupBy).toBe("room");
  });

  it("valor inválido → su default, sin tocar los demás campos", () => {
    for (const bad of ["SOUND", "", null, 1, true, ["sound"], { v: "sound" }]) {
      const out = sanitizeAgendaViewPrefs({
        zoom: 15,
        favoritePractitionerIds: ["p1"],
        arrivalAlert: bad,
        callAlert: "sound",
        salaGroupBy: bad,
      });
      expect(out.arrivalAlert, JSON.stringify(bad)).toBe("visual");
      expect(out.salaGroupBy, JSON.stringify(bad)).toBe("practitioner");
      expect(out.callAlert).toBe("sound");
      expect(out.zoom).toBe(15);
      expect(out.favoritePractitionerIds).toEqual(["p1"]);
    }
  });

  it("patch acepta las 3 claves con su dominio", () => {
    expect(AgendaViewPrefsPatchSchema.parse({ arrivalAlert: "sound", callAlert: "off", salaGroupBy: "room" })).toEqual({
      arrivalAlert: "sound",
      callAlert: "off",
      salaGroupBy: "room",
    });
  });

  it("patch rechaza valores fuera de dominio y claves desconocidas", () => {
    for (const bad of [
      { arrivalAlert: "loud" },
      { arrivalAlert: null },
      { callAlert: "" },
      { callAlert: 1 },
      { salaGroupBy: "service" },
      { salaGroupBy: null },
      { soundAlert: "sound" },
      { arrivalAlert: "sound", extra: 1 },
    ]) {
      expect(AgendaViewPrefsPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("merge: el patch de avisos no toca la agenda (ni la sala del filtro)", () => {
    const current = sanitizeAgendaViewPrefs({ locationId: "L1", roomId: "R1", mode: "room" });
    const next = mergeAgendaViewPrefs(
      current,
      AgendaViewPrefsPatchSchema.parse({ arrivalAlert: "sound", salaGroupBy: "room" })
    );
    expect(next).toEqual({ ...current, arrivalAlert: "sound", salaGroupBy: "room" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RX-0 · C-RX1: `agendaPrefs.receptionLayout` (cara de /sala: Tablero, A · Lista
// y panel, B · Flujo). Mismo patrón que `salaGroupBy`: un blob anterior a RX lee
// "board", un valor roto cae a "board" sin tocar el resto, el patch es estricto.
// ─────────────────────────────────────────────────────────────────────────────
import { RECEPTION_LAYOUTS } from "@/lib/preferences-constants";

describe("[RX-0] agendaPrefs: receptionLayout", () => {
  it("dominio exportado", () => {
    expect(RECEPTION_LAYOUTS).toEqual(["board", "list", "flow"]);
  });

  it("blob anterior a RX (sin la clave) → board, sin tocar lo demás", () => {
    const out = sanitizeAgendaViewPrefs({ salaGroupBy: "room", favoritePractitionerIds: ["p1"] });
    expect(out.receptionLayout).toBe("board");
    expect(out.salaGroupBy).toBe("room");
    expect(out.favoritePractitionerIds).toEqual(["p1"]);
  });

  it("valores válidos pasan", () => {
    for (const l of RECEPTION_LAYOUTS) expect(sanitizeAgendaViewPrefs({ receptionLayout: l }).receptionLayout).toBe(l);
  });

  it("valor inválido → board, sin tocar los demás campos", () => {
    for (const bad of ["grid", "LIST", "", null, 1, true, ["list"], { v: "flow" }]) {
      const out = sanitizeAgendaViewPrefs({ receptionLayout: bad, zoom: 15, callAlert: "off" });
      expect(out.receptionLayout, JSON.stringify(bad)).toBe("board");
      expect(out.zoom).toBe(15);
      expect(out.callAlert).toBe("off");
    }
  });

  it("default del caller (RX-D2: un día puede ser `list` para quien opera todo)", () => {
    const defaults = { ...DEFAULT_AGENDA_VIEW_PREFS, receptionLayout: "list" as const };
    expect(sanitizeAgendaViewPrefs({}, defaults).receptionLayout).toBe("list");
    expect(sanitizeAgendaViewPrefs({ receptionLayout: "grid" }, defaults).receptionLayout).toBe("list");
    expect(sanitizeAgendaViewPrefs({ receptionLayout: "flow" }, defaults).receptionLayout).toBe("flow");
  });

  it("patch acepta el dominio", () => {
    for (const l of RECEPTION_LAYOUTS) {
      expect(AgendaViewPrefsPatchSchema.parse({ receptionLayout: l })).toEqual({ receptionLayout: l });
    }
  });

  it("patch rechaza fuera de dominio (\"grid\", null, mayúsculas) y claves parecidas", () => {
    for (const bad of [
      { receptionLayout: "grid" },
      { receptionLayout: null },
      { receptionLayout: "List" },
      { receptionLayout: 1 },
      { receptionView: "list" },
      { layout: "flow" },
    ]) {
      expect(AgendaViewPrefsPatchSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("merge: cambiar la cara conserva el resto (favoritos, sede, sala, avisos)", () => {
    const current = sanitizeAgendaViewPrefs({
      locationId: "L1",
      roomId: "R1",
      mode: "room",
      favoritePractitionerIds: ["p2", "p1"],
      callAlert: "sound",
      salaGroupBy: "room",
    });
    const next = mergeAgendaViewPrefs(current, AgendaViewPrefsPatchSchema.parse({ receptionLayout: "list" }));
    expect(next).toEqual({ ...current, receptionLayout: "list" });
    expect(next.roomId).toBe("R1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RX-0 · C-RX2: `receptionLayout` en el contexto de Apariencia (ex Tweaks).
// Se monta el provider REAL con `renderToStaticMarkup` (sin DOM no hay effects ni
// clicks) y se testea `persistReceptionLayout`, el commit optimista que usa
// `setReceptionLayout`, con un `save` falso (la red se mockea; la función no).
// ─────────────────────────────────────────────────────────────────────────────
import { vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rxSaved = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/preferences", () => ({
  updateUserPreferences: async () => ({ ok: true }),
  updateAgendaViewPrefs: async (patch: unknown) => {
    rxSaved.calls.push(patch);
    return { ok: true };
  },
}));

import {
  TweaksProvider,
  persistReceptionLayout,
  useTweaksOptional,
} from "@/components/layout/tweaks-context";
import type { ReceptionLayout } from "@/lib/preferences-constants";

function readCtx(props: { initialReceptionLayout?: ReceptionLayout } | null) {
  const out: { ctx?: ReturnType<typeof useTweaksOptional> } = {};
  function Probe() {
    out.ctx = useTweaksOptional();
    return null;
  }
  renderToStaticMarkup(props ? createElement(TweaksProvider, { ...props, children: createElement(Probe) }) : createElement(Probe));
  return out.ctx;
}

describe("[RX-0] tweaks-context: receptionLayout", () => {
  it("useTweaksOptional fuera del provider → null (no tira, a diferencia de useTweaks)", () => {
    expect(readCtx(null)).toBeNull();
  });

  it("sin prop → board; con prop → la del server; arranca minimizado (enmienda F-c)", () => {
    expect(readCtx({})?.receptionLayout).toBe("board");
    expect(readCtx({ initialReceptionLayout: "flow" })?.receptionLayout).toBe("flow");
    expect(readCtx({})?.t.minimised).toBe(true);
    expect(typeof readCtx({})?.setReceptionLayout).toBe("function");
  });

  it("prop fuera de dominio (blob viejo que se coló) → board", () => {
    expect(readCtx({ initialReceptionLayout: "grid" as ReceptionLayout })?.receptionLayout).toBe("board");
  });

  it("persist OK: guarda el valor nuevo y no hace rollback", async () => {
    const applied: ReceptionLayout[] = [];
    const saved: ReceptionLayout[] = [];
    const ok = await persistReceptionLayout("list", "board", {
      save: async (v) => (saved.push(v), { ok: true }),
      apply: (v) => applied.push(v),
      isLatest: () => true,
    });
    expect(ok).toBe(true);
    expect(saved).toEqual(["list"]);
    expect(applied).toEqual([]);
  });

  it("persist rechazado ({ ok: false }) o con excepción de red → vuelve al previo", async () => {
    for (const save of [async () => ({ ok: false }), async () => Promise.reject(new Error("red"))]) {
      const applied: ReceptionLayout[] = [];
      const ok = await persistReceptionLayout("flow", "list", { save, apply: (v) => applied.push(v), isLatest: () => true });
      expect(ok).toBe(false);
      expect(applied).toEqual(["list"]);
    }
  });

  it("un rechazo tardío de un pedido viejo no pisa lo elegido después", async () => {
    const applied: ReceptionLayout[] = [];
    const ok = await persistReceptionLayout("list", "board", {
      save: async () => ({ ok: false }),
      apply: (v) => applied.push(v),
      isLatest: () => false,
    });
    expect(ok).toBe(false);
    expect(applied).toEqual([]);
  });
});
