/**
 * [AS-1k1] C-AS2 · `lib/booking-collect.ts`: lo puro del cobro del copago de un turno.
 *
 * `copagoRemainingCents` es lo que muestra «Marcar pagado · $ 6.000» en el modal de /sala (§23.4): el copago menos
 * lo que ya entró como seña. En T3 no hay señas (llega `deposits: []` y es el copago entero); T5 enchufa los
 * `Payment.kind = DEPOSIT` de Mercado Pago. Solo resta una seña COBRADA (`PAID`): una FAILED nunca entró y una
 * REFUNDED se devolvió, así que restarlas le haría cobrar de menos a la recepción.
 */
import { describe, expect, it } from "vitest";
import {
  COLLECT_COPY,
  UNDO_COLLECT_CONFIRM,
  collectImputationLine,
  collectModalDescription,
  copagoCollectView,
  copagoCollectViewFor,
  copagoRemainingCents,
  type CopagoMarkInput,
} from "@/lib/booking-collect";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";

describe("[AS-1k1] copagoRemainingCents", () => {
  it("[AS-1k1] sin señas: el copago entero", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [] })).toBe(600_000);
  });

  it("[AS-1k1] con seña PAID: el copago menos la seña", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [{ amountCents: 200_000, status: "PAID" }] })).toBe(400_000);
    expect(
      copagoRemainingCents({
        resolvedCopagoCents: 600_000,
        deposits: [
          { amountCents: 100_000, status: "PAID" },
          { amountCents: 150_050, status: "PAID" },
        ],
      })
    ).toBe(349_950);
  });

  it("[AS-1k1] FAILED, REFUNDED y pendientes no restan", () => {
    expect(
      copagoRemainingCents({
        resolvedCopagoCents: 600_000,
        deposits: [
          { amountCents: 200_000, status: "FAILED" },
          { amountCents: 200_000, status: "REFUNDED" },
          { amountCents: 200_000, status: "PENDING" },
          { amountCents: 50_000, status: "PAID" },
        ],
      })
    ).toBe(550_000);
  });

  it("[AS-1k1] nunca < 0: una seña mayor al copago (el copago bajó después) deja 0", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 300_000, deposits: [{ amountCents: 500_000, status: "PAID" }] })).toBe(0);
    expect(copagoRemainingCents({ resolvedCopagoCents: 0, deposits: [] })).toBe(0);
  });

  it("[AS-1k1] una seña PAID con monto negativo o no entero no suma al restante (dato corrupto: falla del lado seguro)", () => {
    expect(copagoRemainingCents({ resolvedCopagoCents: 600_000, deposits: [{ amountCents: -100_000, status: "PAID" }] })).toBe(600_000);
  });
});

describe("[AS-1k1] CopagoMarkInput y copy", () => {
  it("[AS-1k1] la union discrimina por `paid` (marcar exige medio; desmarcar no lleva)", () => {
    const mark: CopagoMarkInput = { paid: true, method: "CASH" };
    const unmark: CopagoMarkInput = { paid: false };
    // @ts-expect-error marcar sin medio no compila
    const bad: CopagoMarkInput = { paid: true };
    expect([mark.paid, unmark.paid, bad.paid]).toEqual([true, false, true]);
  });

  it("[AS-1k1] mensajes literales de C-AS2", () => {
    expect(COLLECT_COPY).toEqual({
      ownOnly: "Solo podés registrar el cobro de tus propios turnos.",
      roleCannotCollect: "Tu rol no registra cobros.",
      insurerOnly: "Solo Facturación, el titular o el administrador confirman pagos de obra social.",
      mercadoPagoLocked: "Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.",
      methodRequired: "Elegí cómo pagó.",
      collectFailed: "No pudimos registrar el cobro",
      undoFailed: "No pudimos deshacer el cobro",
    });
  });
});

// T3-Z (Z-u1): lo que comparten el drawer, /sala y Facturación para que el mismo cobro se lea igual en las tres.
describe("[Z-u1] UNDO_COLLECT_CONFIRM (A2)", () => {
  it("[Z-u1] el confirm de deshacer lleva el monto formateado y es danger", () => {
    expect(UNDO_COLLECT_CONFIRM("$ 6.000")).toEqual({
      title: "¿Deshacer el cobro?",
      message: "El turno vuelve a quedar por cobrar ($ 6.000) y se borra el medio de pago.",
      confirmLabel: "Deshacer cobro",
      tone: "danger",
    });
  });
});

describe("[Z-u1] copagoCollectView (A3: movido de billing-rows a lib)", () => {
  const SECRETARIA = capabilitiesFor("ASSISTANT");
  const NADIE: ReadonlySet<Capability> = new Set();
  const b = (over: Partial<Parameters<typeof copagoCollectViewFor>[0]> = {}) => ({
    paymentStatus: "UNPAID" as const,
    copagoPaymentMethod: null,
    publicReservation: false,
    practitionerId: "p1",
    copagoCents: 600_000,
    status: "CONFIRMED" as const,
    ...over,
  });

  it("[Z-u1] por cobrar → «Cobrar» solo a quien cobra y si el turno ocurrió", () => {
    expect(copagoCollectView(b(), SECRETARIA, null)).toEqual({ label: "Por cobrar", action: "collect" });
    expect(copagoCollectView(b(), NADIE, null)).toEqual({ label: "Por cobrar", action: null });
    expect(copagoCollectViewFor(b({ status: "NO_SHOW" }), true).action).toBeNull();
    expect(copagoCollectViewFor(b({ copagoCents: 0 }), true)).toEqual({ label: null, action: null });
  });

  it("[Z-u1] Mercado Pago: retenido y reintegrado sin botón; pública PAID sin medio sin botones", () => {
    expect(copagoCollectViewFor(b({ paymentStatus: "AUTHORIZED" }), true)).toEqual({ label: "Pago retenido por Mercado Pago", action: null });
    expect(copagoCollectViewFor(b({ paymentStatus: "REFUNDED" }), true)).toEqual({ label: "Reintegrado por Mercado Pago", action: null });
    expect(copagoCollectViewFor(b({ paymentStatus: "PAID", publicReservation: true }), true)).toEqual({ label: "Pagado por Mercado Pago", action: null });
  });

  it("[Z-u1] pagado a mano: «Pagado · medio» y deshacer a quien cobra", () => {
    expect(copagoCollectViewFor(b({ paymentStatus: "PAID", copagoPaymentMethod: "CARD" }), true)).toEqual({ label: "Pagado · Tarjeta", action: "undo" });
    expect(copagoCollectViewFor(b({ paymentStatus: "PAID" }), false)).toEqual({ label: "Pagado · Sin informar", action: null });
    expect(copagoCollectViewFor(b({ paymentStatus: undefined }), true)).toEqual({ label: null, action: null });
  });
});

describe("[Z-u1] collectModalDescription (B2)", () => {
  // 2026-10-19T13:30Z = lunes 19/10 10:30 en AR: en un host UTC el día y la hora del host darían 13:30.
  const base = { patientName: "Juana Gómez", serviceName: "Kinesio", scheduledFor: "2026-10-19T13:30:00.000Z" };
  it("[Z-u1] paciente · servicio · día y hora en AR", () => {
    expect(collectModalDescription(base)).toBe("Juana Gómez · Kinesio · lun 19/10 10:30");
  });
  // T3-Y: el profesional ya no va en la descripción; lo dice la línea de imputación (abajo).
  it("[Z-u1] medianoche AR no se va al día anterior ni sale «24:00»", () => {
    expect(collectModalDescription({ ...base, scheduledFor: "2026-10-20T03:00:00.000Z" })).toBe("Juana Gómez · Kinesio · mar 20/10 00:00");
  });
});

describe("[T3-Y] collectImputationLine (a quién se imputa el cobro)", () => {
  it("[T3-Y] con profesional: «Se imputa a {nombre}»", () => {
    expect(collectImputationLine({ practitionerId: "pr_1", practitionerName: "Ana Pérez" })).toBe("Se imputa a Ana Pérez");
    expect(collectImputationLine({ practitionerId: "pr_1", practitionerName: "  Ana Pérez " })).toBe("Se imputa a Ana Pérez");
  });
  it("[T3-Y] sin profesional: «Se imputa al consultorio»", () => {
    expect(collectImputationLine({ practitionerId: null, practitionerName: null })).toBe("Se imputa al consultorio");
    expect(collectImputationLine({ practitionerId: "", practitionerName: "Ana Pérez" })).toBe("Se imputa al consultorio");
  });
  it("[T3-Y] con profesional sin nombre a mano: no dice «consultorio» (sería falso)", () => {
    expect(collectImputationLine({ practitionerId: "pr_1", practitionerName: null })).toBe("Se imputa al profesional del turno");
    expect(collectImputationLine({ practitionerId: "pr_1", practitionerName: " " })).toBe("Se imputa al profesional del turno");
  });
});
