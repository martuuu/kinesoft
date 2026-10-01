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
