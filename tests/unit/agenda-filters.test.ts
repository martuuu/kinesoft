/**
 * lib/agenda-filters (A2b-S-ui) — toggles "Mostrar cancelados/ausentes",
 * conteo de ocultos, persistencia tolerante y la etiqueta de la reserva
 * pública impaga (30 min, `isHoldingCapacity`). Aritmética de instantes:
 * corre igual en TZ=UTC y TZ=AR.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENDA_VISIBILITY,
  agendaVisibilityStorageKey,
  applyAgendaVisibility,
  countHidden,
  hiddenCountLabel,
  isVisibleInAgenda,
  parseAgendaVisibility,
  paymentHoldState,
  hasTickingPaymentHold,
  PAYMENT_HOLD_LABEL,
} from "@/lib/agenda-filters";

const rows = [
  { id: "a", status: "CONFIRMED" },
  { id: "b", status: "CANCELLED" },
  { id: "c", status: "NO_SHOW" },
  { id: "d", status: "CANCELLED" },
  { id: "e", status: "COMPLETED" },
  { id: "f", status: "PENDING" },
];

describe("visibilidad de la agenda", () => {
  it("por defecto muestra todo (conducta de siempre)", () => {
    expect(DEFAULT_AGENDA_VISIBILITY).toEqual({ showCancelled: true, showNoShow: true });
    expect(applyAgendaVisibility(rows, DEFAULT_AGENDA_VISIBILITY).map((r) => r.id)).toEqual([
      "a", "b", "c", "d", "e", "f",
    ]);
    expect(countHidden(rows, DEFAULT_AGENDA_VISIBILITY)).toEqual({ cancelled: 0, noShow: 0, total: 0 });
    expect(hiddenCountLabel(countHidden(rows, DEFAULT_AGENDA_VISIBILITY))).toBeNull();
  });

  it("ocultar cancelados saca solo CANCELLED y los cuenta", () => {
    const vis = { showCancelled: false, showNoShow: true };
    expect(applyAgendaVisibility(rows, vis).map((r) => r.id)).toEqual(["a", "c", "e", "f"]);
    expect(countHidden(rows, vis)).toEqual({ cancelled: 2, noShow: 0, total: 2 });
    expect(hiddenCountLabel(countHidden(rows, vis))).toBe("2 ocultos · 2 cancelados");
  });

  it("ocultar ambos: singular/plural en la etiqueta", () => {
    const vis = { showCancelled: false, showNoShow: false };
    expect(applyAgendaVisibility(rows, vis).map((r) => r.id)).toEqual(["a", "e", "f"]);
    expect(hiddenCountLabel(countHidden(rows, vis))).toBe("3 ocultos · 2 cancelados, 1 ausente");
    expect(hiddenCountLabel({ cancelled: 0, noShow: 1, total: 1 })).toBe("1 oculto · 1 ausente");
  });

  it("nunca oculta estados activos, realizados ni pendientes", () => {
    const vis = { showCancelled: false, showNoShow: false };
    for (const status of ["CONFIRMED", "COMPLETED", "PENDING"]) {
      expect(isVisibleInAgenda({ status }, vis)).toBe(true);
    }
  });

  it("no muta la lista de entrada", () => {
    const copy = [...rows];
    applyAgendaVisibility(rows, { showCancelled: false, showNoShow: false });
    expect(rows).toEqual(copy);
  });
});

describe("persistencia (localStorage)", () => {
  it("clave por usuario, con fallback común", () => {
    expect(agendaVisibilityStorageKey("user_1")).toBe("kinesoft:agenda-visibility:user_1");
    expect(agendaVisibilityStorageKey("user_2")).not.toBe(agendaVisibilityStorageKey("user_1"));
    expect(agendaVisibilityStorageKey(null)).toBe("kinesoft:agenda-visibility:default");
  });

  it("ida y vuelta", () => {
    const v = { showCancelled: false, showNoShow: true };
    expect(parseAgendaVisibility(JSON.stringify(v))).toEqual(v);
  });

  it("basura → defaults (nunca oculta por un valor roto)", () => {
    for (const raw of [null, undefined, "", "no-json{", "null", "42", '"x"', "[]"]) {
      expect(parseAgendaVisibility(raw as string | null)).toEqual(DEFAULT_AGENDA_VISIBILITY);
    }
    // Campo con tipo malo → ese campo vuelve al default, el otro se respeta.
    expect(parseAgendaVisibility(JSON.stringify({ showCancelled: "no", showNoShow: false }))).toEqual({
      showCancelled: true,
      showNoShow: false,
    });
  });
});

describe("paymentHoldState (reserva pública impaga, 30 min)", () => {
  const now = new Date("2027-03-10T13:00:00.000Z"); // 10:00 AR
  const agoIso = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const pub = (createdAt: string, extra: Record<string, unknown> = {}) => ({
    status: "PENDING",
    paymentStatus: "UNPAID",
    publicReservation: true,
    createdAt,
    ...extra,
  });

  it("dentro de los 30 min → pendiente; exactamente 30 todavía retiene", () => {
    expect(paymentHoldState(pub(agoIso(5)), now)).toBe("pendiente");
    expect(paymentHoldState(pub(agoIso(30)), now)).toBe("pendiente");
  });

  it("pasados los 30 min → vencida, con la etiqueta del contrato", () => {
    const s = paymentHoldState(pub(agoIso(31)), now);
    expect(s).toBe("vencida");
    expect(PAYMENT_HOLD_LABEL[s!]).toBe("Pendiente de pago · vencida");
  });

  it("acepta Date además de ISO", () => {
    expect(paymentHoldState(pub(agoIso(45), { createdAt: new Date(agoIso(45)) }), now)).toBe("vencida");
  });

  it("no aplica a pagados, confirmados, guests ni sin datos del server", () => {
    expect(paymentHoldState(pub(agoIso(60), { paymentStatus: "PAID" }), now)).toBeNull();
    expect(paymentHoldState(pub(agoIso(60), { status: "CONFIRMED" }), now)).toBeNull();
    // Guest de la recepción (con o sin paciente asignado después) también nace
    // PENDING/UNPAID: no es reserva pública (el server lo decide por la key).
    expect(paymentHoldState(pub(agoIso(60), { publicReservation: false }), now)).toBeNull();
    expect(paymentHoldState({ status: "PENDING" }, now)).toBeNull();
    // Server viejo sin el flag → no se inventa el rótulo.
    expect(paymentHoldState(pub(agoIso(60), { publicReservation: undefined }), now)).toBeNull();
    expect(paymentHoldState(pub("no-es-fecha"), now)).toBeNull();
  });

  it("revisión A2: PENDING/FAILED (tarjeta rechazada) se rotula igual que UNPAID", () => {
    expect(paymentHoldState(pub(agoIso(5), { paymentStatus: "FAILED" }), now)).toBe("pendiente");
    expect(paymentHoldState(pub(agoIso(31), { paymentStatus: "FAILED" }), now)).toBe("vencida");
  });

  it("hasTickingPaymentHold: solo si hay alguna todavía pendiente (la vencida ya no cambia)", () => {
    expect(hasTickingPaymentHold([pub(agoIso(5))], now)).toBe(true);
    expect(hasTickingPaymentHold([pub(agoIso(5), { paymentStatus: "FAILED" })], now)).toBe(true);
    expect(hasTickingPaymentHold([pub(agoIso(31))], now)).toBe(false);
    expect(hasTickingPaymentHold([pub(agoIso(5), { publicReservation: false })], now)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S19b (ES3): alcance De plan / Sueltos = resaltado (no oculta), persistido
// por usuario como los toggles.
// ─────────────────────────────────────────────────────────────────────────────
import {
  AGENDA_PLAN_SCOPES,
  AGENDA_PLAN_SCOPE_LABEL,
  agendaPlanScopeStorageKey,
  countPlanScope,
  parseAgendaPlanScope,
  planScopeHighlight,
  planScopeOf,
  serializeAgendaPlanScope,
} from "@/lib/agenda-filters";
import { highlightState, toggleHighlight } from "@/lib/agenda-highlight";

describe("[P3-S19b] alcance de plan de la agenda", () => {
  it("Todos / De plan / Sueltos ↔ resaltado, ida y vuelta", () => {
    expect(AGENDA_PLAN_SCOPES.map((s) => AGENDA_PLAN_SCOPE_LABEL[s])).toEqual(["Todos", "De plan", "Sueltos"]);
    for (const s of AGENDA_PLAN_SCOPES) expect(planScopeOf(planScopeHighlight(s))).toBe(s);
    expect(planScopeHighlight("all")).toBeNull();
    expect(planScopeHighlight("plan")).toEqual({ kind: "plan" });
    expect(planScopeHighlight("loose")).toEqual({ kind: "loose" });
  });

  it("un resaltado de servicio (o de plan por disciplina) se ve como Todos", () => {
    expect(planScopeOf({ kind: "service", serviceId: "s1" })).toBe("all");
    expect(planScopeOf({ kind: "plan", discipline: "KINESIOLOGY" })).toBe("all");
    expect(planScopeOf(null)).toBe("all");
  });

  it("el resaltado de plan atenúa y no oculta: el suelto queda dimmed, el de plan match", () => {
    const h = planScopeHighlight("plan");
    expect(highlightState(h, { serviceId: "s", programId: "pg1", plan: { discipline: null } })).toBe("match");
    expect(highlightState(h, { serviceId: "s", programId: null })).toBe("dimmed");
    // Sin C9 (proyección completa) no se adivina.
    expect(highlightState(planScopeHighlight("loose"), { serviceId: "s" })).toBe("dimmed");
    // Elegir un servicio después reemplaza al alcance (selección única) → Todos.
    expect(planScopeOf(toggleHighlight(h, { kind: "service", serviceId: "s" }))).toBe("all");
    // Mismo ítem otra vez = apagar.
    expect(toggleHighlight(h, { kind: "plan" })).toBeNull();
  });

  it("persistencia: clave por usuario, lectura tolerante, Todos borra la clave", () => {
    expect(agendaPlanScopeStorageKey("u1")).toBe("kinesoft:agenda-plan-scope:u1");
    expect(agendaPlanScopeStorageKey(null)).toBe("kinesoft:agenda-plan-scope:default");
    expect(agendaPlanScopeStorageKey("u1")).not.toBe(agendaVisibilityStorageKey("u1"));
    expect(parseAgendaPlanScope("plan")).toBe("plan");
    expect(parseAgendaPlanScope("loose")).toBe("loose");
    for (const junk of [null, undefined, "", "all", "PLAN", '{"x":1}', "service"]) {
      expect(parseAgendaPlanScope(junk)).toBe("all");
    }
    expect(serializeAgendaPlanScope("all")).toBeNull();
    expect(serializeAgendaPlanScope("loose")).toBe("loose");
  });

  it("conteo de la leyenda: sin cancelados y sin adivinar los que no traen C9", () => {
    expect(
      countPlanScope([
        { status: "CONFIRMED", programId: "pg1" },
        { status: "COMPLETED", programId: "pg1" },
        { status: "CANCELLED", programId: "pg1" },
        { status: "PENDING", programId: null },
        { status: "CANCELLED", programId: null },
        { status: "NO_SHOW", programId: null },
        { status: "CONFIRMED" },
      ])
    ).toEqual({ plan: 2, loose: 2 });
  });
});
