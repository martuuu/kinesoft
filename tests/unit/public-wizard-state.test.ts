import { describe, expect, it } from "vitest";
import {
  attemptSignature,
  amountDiffers,
  canConfirmPayment,
  checkoutCopyFor,
  clinicInitials,
  destinationAfterSubmit,
  payNowFor,
  wizardOnlinePaymentFor,
  type WizardOnlinePayment,
  coverageInsurerPrefill,
  coverageOptions,
  durationFor,
  filterPractitioners,
  firstSlotQuery,
  formatLocationAddress,
  hasMultipleLocations,
  locationsForPractitioner,
  nextAttempt,
  nextDayKey,
  reconcileSelection,
  selectionFromFirstSlot,
  servicesForAny,
  servicesForPractitioner,
} from "@/lib/public-wizard-state";
import type { PublicClinic, PublicLocation } from "@/lib/public-booking-types";
import { MIN_ONLINE_CHARGE_CENTS, quoteOnlineCharge } from "@/lib/online-charge-logic";
import { PENDING_PUBLIC_HOLD_MS } from "@/lib/booking-capacity";
import { clinicInitials as frameInitials } from "@/components/booking/booking-unavailable";

// B5.6 — lógica pura del turnero público (sin DOM). El componente
// `components/booking/public-booking-wizard.tsx` usa exactamente estas
// funciones; acá se fija el contrato con el payload de `getPublicClinic` (B3.2).

const loc = (id: string, extra: Partial<PublicLocation> = {}): PublicLocation => ({
  id,
  name: `Sede ${id}`,
  address: null,
  addressLine2: null,
  city: null,
  province: null,
  isPrimary: false,
  ...extra,
});

const pro = (id: string, extra: Partial<PublicClinic["practitioners"][number]> = {}) => ({
  id,
  name: `Lic. ${id}`,
  specialty: null,
  licenseNumber: null,
  yearsExp: null,
  ...extra,
});

const svc = (id: string, extra: Partial<PublicClinic["services"][number]> = {}) => ({
  id,
  name: `Servicio ${id}`,
  description: null,
  durationMin: 45,
  priceCents: 1_000_000,
  practitionerId: null,
  ...extra,
});

/** 3 profesionales, 2 sedes, Particular + 2 OS. */
function clinic(): PublicClinic {
  return {
    slug: "demo",
    name: "Demo",
    legalName: null,
    palette: "sky",
    practitioners: [
      pro("A", { locationIds: ["L1"], acceptedInsurerIds: ["PART", "OSDE"] }),
      pro("B", { locationIds: ["L1", "L2"], acceptedInsurerIds: ["PART", "OSDE", "SWISS"] }),
      pro("C", { locationIds: ["L2"], acceptedInsurerIds: ["PART"] }),
    ],
    services: [
      // Lo ofrecen A y B: el `practitionerId` legacy es null y el filtro viejo
      // se lo mostraba también a C (bug que cierra B5.6).
      svc("S-AB", { practitionerIds: ["A", "B"], durationByPractitioner: { A: 45, B: 60 } }),
      svc("S-C", { practitionerId: "C", practitionerIds: ["C"], durationByPractitioner: { C: 30 } }),
    ],
    locations: [loc("L1", { isPrimary: true, address: "Av. Pellegrini 1200", city: "Rosario" }), loc("L2")],
    insurers: [
      { id: "SWISS", name: "Swiss Medical", isParticular: false },
      { id: "PART", name: "Particular", isParticular: true },
      { id: "OSDE", name: "OSDE", isParticular: false },
    ],
  };
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("servicios por profesional (practitionerIds)", () => {
  it("filtra con practitionerIds, no con el practitionerId legacy", () => {
    const c = clinic();
    expect(ids(servicesForPractitioner(c, "A"))).toEqual(["S-AB"]);
    expect(ids(servicesForPractitioner(c, "B"))).toEqual(["S-AB"]);
    // Antes C veía S-AB (practitionerId null = "de todos").
    expect(ids(servicesForPractitioner(c, "C"))).toEqual(["S-C"]);
  });

  it("compat: sin practitionerIds usa practitionerId === elegido || null", () => {
    const c = clinic();
    c.services = [svc("X", { practitionerId: "A" }), svc("Y", { practitionerId: null })];
    expect(ids(servicesForPractitioner(c, "A"))).toEqual(["X", "Y"]);
    expect(ids(servicesForPractitioner(c, "B"))).toEqual(["Y"]);
  });

  it("duración por profesional, con fallback a la del servicio", () => {
    const s = clinic().services[0];
    expect(durationFor(s, "A")).toBe(45);
    expect(durationFor(s, "B")).toBe(60);
    expect(durationFor(s, "Z")).toBe(45);
    expect(durationFor(s, null)).toBe(45);
    expect(durationFor(svc("Q", { durationMin: 50 }), "A")).toBe(50);
  });

  it("modo cualquiera: servicios que ofrece al menos un profesional filtrado", () => {
    const c = clinic();
    expect(ids(servicesForAny(c, { insurerId: null, locationId: null }))).toEqual(["S-AB", "S-C"]);
    // Sede L1: A y B → solo S-AB.
    expect(ids(servicesForAny(c, { insurerId: null, locationId: "L1" }))).toEqual(["S-AB"]);
    // Swiss: solo B.
    expect(ids(servicesForAny(c, { insurerId: "SWISS", locationId: null }))).toEqual(["S-AB"]);
  });
});

describe("filtros de cobertura y sede", () => {
  it("cobertura filtra por acceptedInsurerIds; Particular la aceptan todos", () => {
    const c = clinic();
    expect(ids(filterPractitioners(c, { insurerId: null, locationId: null }))).toEqual(["A", "B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "PART", locationId: null }))).toEqual(["A", "B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: null }))).toEqual(["A", "B"]);
    expect(ids(filterPractitioners(c, { insurerId: "SWISS", locationId: null }))).toEqual(["B"]);
  });

  it("sede filtra por locationIds; combinado con cobertura", () => {
    const c = clinic();
    expect(ids(filterPractitioners(c, { insurerId: null, locationId: "L2" }))).toEqual(["B", "C"]);
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: "L2" }))).toEqual(["B"]);
    expect(ids(filterPractitioners(c, { insurerId: "SWISS", locationId: "L1" }))).toEqual(["B"]);
  });

  it("payload sin campos de B3.2 no filtra a nadie", () => {
    const c = clinic();
    c.practitioners = [pro("A"), pro("B")];
    expect(ids(filterPractitioners(c, { insurerId: "OSDE", locationId: "L2" }))).toEqual(["A", "B"]);
  });

  it("opciones de cobertura: Particular primero, OS por nombre; vacío si solo hay Particular", () => {
    const c = clinic();
    expect(coverageOptions(c).map((i) => i.name)).toEqual(["Particular", "OSDE", "Swiss Medical"]);
    c.insurers = [{ id: "PART", name: "Particular", isParticular: true }];
    expect(coverageOptions(c)).toEqual([]);
    c.insurers = undefined;
    expect(coverageOptions(c)).toEqual([]);
  });

  it("sedes: elegir solo con más de una; las del profesional en orden del consultorio", () => {
    const c = clinic();
    expect(hasMultipleLocations(c)).toBe(true);
    expect(ids(locationsForPractitioner(c, "B"))).toEqual(["L1", "L2"]);
    expect(ids(locationsForPractitioner(c, "C"))).toEqual(["L2"]);
    c.locations = [loc("L1")];
    expect(hasMultipleLocations(c)).toBe(false);
  });

  it("dirección legible con lo que haya", () => {
    expect(
      formatLocationAddress(
        loc("x", { address: "Av. Pellegrini 1200", addressLine2: "Piso 2", city: "Rosario", province: "Santa Fe" })
      )
    ).toBe("Av. Pellegrini 1200, Piso 2 · Rosario, Santa Fe");
    expect(formatLocationAddress(loc("x"))).toBe("");
  });

  it("cambiar filtros limpia profesional/servicio que dejaron de aplicar", () => {
    const c = clinic();
    // C no acepta OSDE → se limpia, y S-C (solo de C) también.
    expect(
      reconcileSelection(c, { insurerId: "OSDE", locationId: null }, { practitionerId: "C", serviceId: "S-C" })
    ).toEqual({ practitionerId: null, serviceId: null });
    // B sigue valiendo en L2 → se conserva todo.
    expect(
      reconcileSelection(c, { insurerId: null, locationId: "L2" }, { practitionerId: "B", serviceId: "S-AB" })
    ).toEqual({ practitionerId: "B", serviceId: "S-AB" });
    // Modo cualquiera (sin profesional): S-C ya no lo ofrece nadie en L1.
    expect(
      reconcileSelection(c, { insurerId: null, locationId: "L1" }, { practitionerId: null, serviceId: "S-C" })
    ).toEqual({ practitionerId: null, serviceId: null });
  });
});

describe("idempotencia por instancia (AUDIT §5)", () => {
  let n = 0;
  const mint = () => `k${++n}`;

  it("misma firma = misma key (doble click / reintento tras error de MP)", () => {
    const sig = attemptSignature({ practitionerId: "A", serviceId: "S", slotISO: "2026-10-01T13:00:00.000Z" });
    const a1 = nextAttempt(null, sig, mint);
    const a2 = nextAttempt(a1, sig, mint);
    expect(a2.key).toBe(a1.key);
  });

  it("rota si cambia profesional, servicio u horario", () => {
    const base = { practitionerId: "A", serviceId: "S", slotISO: "2026-10-01T13:00:00.000Z" };
    const a1 = nextAttempt(null, attemptSignature(base), mint);
    for (const change of [{ practitionerId: "B" }, { serviceId: "T" }, { slotISO: "2026-10-01T14:00:00.000Z" }]) {
      const a2 = nextAttempt(a1, attemptSignature({ ...base, ...change }), mint);
      expect(a2.key).not.toBe(a1.key);
    }
  });
});

describe('"cualquier profesional"', () => {
  it("arma la query solo con los filtros elegidos", () => {
    const f = { insurerId: null, locationId: null };
    expect(firstSlotQuery({ tenantSlug: "demo", serviceId: "S", filters: f })).toEqual({
      tenantSlug: "demo",
      serviceId: "S",
    });
    expect(
      firstSlotQuery({
        tenantSlug: "demo",
        serviceId: "S",
        filters: { insurerId: "OSDE", locationId: "L2" },
        fromDate: "2026-10-02",
      })
    ).toEqual({ tenantSlug: "demo", serviceId: "S", insurerId: "OSDE", locationId: "L2", fromDate: "2026-10-02" });
  });

  it("el primer turno se convierte en una selección concreta (profesional + día + horario + sede)", () => {
    expect(
      selectionFromFirstSlot({
        practitionerId: "B",
        iso: "2026-10-02T00:30:00.000Z",
        time: "21:30",
        date: "2026-10-01",
        durationMin: 60,
        locationId: "L2",
      })
    ).toEqual({ practitionerId: "B", dateISO: "2026-10-01", slotISO: "2026-10-02T00:30:00.000Z", slotLocationId: "L2" });
  });

  it("buscar más adelante: día siguiente sin depender del huso (fin de mes)", () => {
    expect(nextDayKey("2026-10-31")).toBe("2026-11-01");
    expect(nextDayKey("2026-12-31")).toBe("2027-01-01");
  });
});

describe("precarga de obra social en Tus datos", () => {
  it("usa el nombre de la OS elegida solo si el campo está vacío; Particular no precarga", () => {
    const c = clinic();
    expect(coverageInsurerPrefill("", c, "OSDE")).toBe("OSDE");
    expect(coverageInsurerPrefill("  ", c, "SWISS")).toBe("Swiss Medical");
    expect(coverageInsurerPrefill("IOMA", c, "OSDE")).toBe("IOMA");
    expect(coverageInsurerPrefill("", c, "PART")).toBe("");
    expect(coverageInsurerPrefill("", c, null)).toBe("");
  });
});

// TP-0 · turnero sin cobro. El server decide (`decidePublicCheckout`); el wizard solo elige el copy que corresponde y
// adónde ir con la respuesta. Sin checkout no se menciona Mercado Pago (H-TP1: hoy la única cuenta es la de la
// plataforma y el turnero no cobra).
describe("[TP-0] checkoutCopyFor", () => {
  it("sin cobro online (null o ausente): «Confirmar turno», «Valor del turno» y «Lo pagás en el consultorio.»", () => {
    for (const payment of [null, undefined]) {
      const c = checkoutCopyFor({ payment, priceCents: 1_500_000 });
      expect(c).toEqual({
        online: false,
        cta: "Confirmar turno",
        ctaPending: "Reservando…",
        totalLabel: "Valor del turno",
        showTotal: true,
        note: "Lo pagás en el consultorio.",
        split: null,
      });
      expect(JSON.stringify(c)).not.toMatch(/Mercado Pago|Pagar/);
    }
  });

  it("sin cobro y precio 0: sin fila de total (antes decía «$ 0»), la nota queda", () => {
    const c = checkoutCopyFor({ payment: null, priceCents: 0 });
    expect(c.showTotal).toBe(false);
    expect(c.note).toBe("Lo pagás en el consultorio.");
  });

  it("con cobro online y monto ≥ $1: «Pagar y reservar» + «Total a pagar» + Mercado Pago", () => {
    const c = checkoutCopyFor({ payment: pay("REQUIRED", "FULL", 1_500_000), priceCents: 1_500_000 });
    expect(c).toMatchObject({
      online: true,
      cta: "Pagar y reservar",
      ctaPending: "Redirigiendo…",
      totalLabel: "Total a pagar",
      showTotal: true,
      split: null,
    });
    expect(c.note).toMatch(/^El pago se hace en Mercado Pago\./);
  });

  it("mismo piso que el server (`MIN_ONLINE_CHARGE_CENTS`): bajo $1 no hay cobro que ofrecer", () => {
    const m = MIN_ONLINE_CHARGE_CENTS;
    const c = withPolicy({ mode: "REQUIRED", chargeKind: "COPAGO" });
    expect(wizardOnlinePaymentFor(c, "A", m - 1)).toBeNull();
    expect(wizardOnlinePaymentFor(c, "A", 0)).toBeNull();
    expect(wizardOnlinePaymentFor(c, "A", m)?.quote.amountCents).toBe(m);
  });
});

// ─── TP-3h · turnero con cobro (C-TP8, §25.5 / §25.10) ──────────────────
function pay(mode: "OPTIONAL" | "REQUIRED", chargeKind: "FULL" | "DEPOSIT", amountCents: number): WizardOnlinePayment {
  return { mode, quote: { amountCents, chargeKind }, cancellationNote: null };
}
function withPolicy(over: Partial<NonNullable<PublicClinic["onlinePayment"]>>): PublicClinic {
  return {
    slug: "x", name: "X", legalName: null, palette: "sky", practitioners: [], services: [],
    onlinePayment: {
      mode: "OPTIONAL", chargeKind: "COPAGO", fixedCents: null, percentBps: null, cancellationNote: null,
      practitionerIds: ["A"], ...over,
    },
  };
}

describe("[TP-3h] wizardOnlinePaymentFor", () => {
  it("sin política, sin profesional o profesional sin cuenta usable → sin cobro", () => {
    expect(wizardOnlinePaymentFor({ ...withPolicy({}), onlinePayment: null }, "A", 1_500_000)).toBeNull();
    expect(wizardOnlinePaymentFor({ ...withPolicy({}), onlinePayment: undefined }, "A", 1_500_000)).toBeNull();
    expect(wizardOnlinePaymentFor(withPolicy({}), null, 1_500_000)).toBeNull();
    expect(wizardOnlinePaymentFor(withPolicy({}), "B", 1_500_000)).toBeNull();
  });

  it("cotiza con la misma regla que el server (quoteOnlineCharge): copago, seña fija, porcentaje", () => {
    expect(wizardOnlinePaymentFor(withPolicy({ chargeKind: "COPAGO" }), "A", 2_000_000)?.quote).toEqual({
      amountCents: 2_000_000, chargeKind: "FULL",
    });
    expect(wizardOnlinePaymentFor(withPolicy({ chargeKind: "FIXED", fixedCents: 600_000 }), "A", 2_000_000)?.quote).toEqual(
      quoteOnlineCharge({ policy: { mode: "OPTIONAL", chargeKind: "FIXED", fixedCents: 600_000, percentBps: null }, servicePriceCents: 2_000_000 })
    );
    expect(wizardOnlinePaymentFor(withPolicy({ chargeKind: "PERCENT", percentBps: 3000 }), "A", 2_000_000)?.quote).toEqual({
      amountCents: 600_000, chargeKind: "DEPOSIT",
    });
    // Seña ≥ valor → FULL por el valor.
    expect(wizardOnlinePaymentFor(withPolicy({ chargeKind: "FIXED", fixedCents: 9_000_000 }), "A", 2_000_000)?.quote).toEqual({
      amountCents: 2_000_000, chargeKind: "FULL",
    });
  });

  it("modo y nota de cancelación (recortada; vacía = null)", () => {
    const r = wizardOnlinePaymentFor(withPolicy({ mode: "REQUIRED", cancellationNote: "  Avisá 24 h antes.  " }), "A", 100_000);
    expect(r).toMatchObject({ mode: "REQUIRED", cancellationNote: "Avisá 24 h antes." });
    expect(wizardOnlinePaymentFor(withPolicy({ cancellationNote: "   " }), "A", 100_000)?.cancellationNote).toBeNull();
  });
});

describe("[TP-3h] elección OPTIONAL (sin preselección, TP-UI-D5) y payNow", () => {
  it("OPTIONAL sin elegir no confirma; elegido sí; REQUIRED y sin cobro no piden elección", () => {
    const opt = pay("OPTIONAL", "FULL", 100_000);
    expect(canConfirmPayment(opt, null)).toBe(false);
    expect(canConfirmPayment(opt, "now")).toBe(true);
    expect(canConfirmPayment(opt, "later")).toBe(true);
    expect(canConfirmPayment(pay("REQUIRED", "FULL", 100_000), null)).toBe(true);
    expect(canConfirmPayment(null, null)).toBe(true);
  });

  it("payNow: explícito solo con OPTIONAL; REQUIRED y sin cobro no lo mandan", () => {
    const opt = pay("OPTIONAL", "FULL", 100_000);
    expect(payNowFor(opt, "now")).toBe(true);
    expect(payNowFor(opt, "later")).toBe(false);
    expect(payNowFor(opt, null)).toBeUndefined();
    expect(payNowFor(pay("REQUIRED", "FULL", 100_000), "now")).toBeUndefined();
    expect(payNowFor(null, "now")).toBeUndefined();
  });

  it("CTA según la elección: sin elegir y «en el consultorio» → «Confirmar turno»; «ahora» → «Pagar y reservar»", () => {
    const opt = pay("OPTIONAL", "FULL", 1_500_000);
    const none = checkoutCopyFor({ payment: opt, choice: null, priceCents: 1_500_000 });
    expect(none).toMatchObject({ online: false, cta: "Confirmar turno" });
    expect(none.note).toBe("Podés pagar ahora con Mercado Pago o en el consultorio.");
    expect(checkoutCopyFor({ payment: opt, choice: "later", priceCents: 1_500_000 })).toMatchObject({
      online: false, cta: "Confirmar turno", note: "Lo pagás en el consultorio.",
    });
    const now = checkoutCopyFor({ payment: opt, choice: "now", priceCents: 1_500_000 });
    expect(now).toMatchObject({ online: true, cta: "Pagar y reservar", totalLabel: "Total a pagar" });
    expect(now.note).toContain("el turno queda reservado");
  });

  it("REQUIRED: nota de los 30 minutos del hold (paridad con PENDING_PUBLIC_HOLD_MS)", () => {
    const c = checkoutCopyFor({ payment: pay("REQUIRED", "FULL", 100_000), priceCents: 100_000 });
    expect(c.note).toContain(`${PENDING_PUBLIC_HOLD_MS / 60_000} minutos`);
  });

  it("con seña: «Seña a pagar ahora» / «Resto en el consultorio» = valor − seña", () => {
    const c = checkoutCopyFor({ payment: pay("REQUIRED", "DEPOSIT", 600_000), priceCents: 2_000_000 });
    expect(c.split).toEqual({ nowCents: 600_000, restCents: 1_400_000 });
    expect(c.totalLabel).toBe("Valor del turno");
    expect(checkoutCopyFor({ payment: pay("OPTIONAL", "DEPOSIT", 600_000), choice: "later", priceCents: 2_000_000 }).split).toBeNull();
  });
});

describe("[TP-3h] paridad de la cotización con quoteOnlineCharge (copia local por bundle)", () => {
  it("misma salida en una matriz de políticas y precios", () => {
    const prices = [0, 1, 99, 100, 101, 150, 999, 1_000, 123_457, 600_000, 2_000_000, 100_000_000, 100_000_001, -5, 1.5];
    const policies = [
      { chargeKind: "COPAGO", fixedCents: null, percentBps: null },
      ...[1, 99, 100, 600_000, 2_000_000, 0, -1, null, 1.5].map((f) => ({ chargeKind: "FIXED", fixedCents: f, percentBps: null })),
      ...[1, 49, 50, 3000, 9999, 10_000, 10_001, 0, null].map((b) => ({ chargeKind: "PERCENT", fixedCents: null, percentBps: b })),
    ] as const;
    for (const mode of ["OPTIONAL", "REQUIRED"] as const)
      for (const pol of policies)
        for (const price of prices) {
          const policy = { mode, ...pol } as unknown as Parameters<typeof quoteOnlineCharge>[0]["policy"];
          const c = withPolicy(policy as never);
          expect(wizardOnlinePaymentFor(c, "A", price)?.quote ?? null, JSON.stringify([pol, price])).toEqual(
            quoteOnlineCharge({ policy, servicePriceCents: price })
          );
        }
  });
});

describe("[TP-3h] clinicInitials (copia local por bundle)", () => {
  it("misma salida que la de booking-unavailable", () => {
    for (const n of ["Consultorio Norte", "  kine  sur  ", "Ñandú & Co.", "123 Salud", "", "—", "Á"]) {
      expect(clinicInitials(n), n).toBe(frameInitials(n));
    }
  });
});

describe("[TP-3h] amountDiffers (interstitial, TP-UI-D6)", () => {
  it("solo con checkout y un monto distinto al cotizado", () => {
    expect(amountDiffers({ next: "checkout", amountCents: 1_500_000 }, 1_500_000)).toBe(false);
    expect(amountDiffers({ next: "checkout", amountCents: 900_000 }, 1_500_000)).toBe(true);
    expect(amountDiffers({ next: "checkout", amountCents: 900_000 }, null)).toBe(true);
    expect(amountDiffers({ next: "checkout", amountCents: null }, 1_500_000)).toBe(false);
    // Sin cotización (OPTIONAL «en el consultorio», o sin cobro): reservar sin cobrar es lo esperado.
    expect(amountDiffers({ next: "reserved", amountCents: null }, null)).toBe(false);
  });

  it("[TP-ZF2] cotizó un cobro y el server reservó sin cobrar (Particular u OS con copago $ 0): hay interstitial", () => {
    expect(amountDiffers({ next: "reserved", amountCents: null }, 1_500_000)).toBe(true);
    expect(amountDiffers({ next: "reserved", amountCents: 0 }, 500_000)).toBe(true);
  });
});

describe("[TP-0] destinationAfterSubmit", () => {
  it("next reserved navega a /booking/<id>/ok", () => {
    expect(destinationAfterSubmit({ bookingId: "bk_1", next: "reserved", initPoint: null })).toBe("/booking/bk_1/ok");
    // Aunque viniera un initPoint (no debería), reservado no manda a Mercado Pago.
    expect(destinationAfterSubmit({ bookingId: "bk_1", next: "reserved", initPoint: "https://mp/x" })).toBe(
      "/booking/bk_1/ok"
    );
  });

  it("next checkout → initPoint, como hoy; sin initPoint cae al resultado (el poller dice el estado real)", () => {
    expect(destinationAfterSubmit({ bookingId: "bk_1", next: "checkout", initPoint: "https://mp/x" })).toBe("https://mp/x");
    expect(destinationAfterSubmit({ bookingId: "bk_1", next: "checkout", initPoint: null })).toBe("/booking/bk_1/pending");
  });

  it("el id va escapado en la URL", () => {
    expect(destinationAfterSubmit({ bookingId: "a/b", next: "reserved", initPoint: null })).toBe("/booking/a%2Fb/ok");
  });
});

// ─── TP-1 · ventana de 5 días hábiles ───────────────────────────────────
// Import con namespace: mientras las funciones no existían, `W.nextWindow` es undefined y el `it.fails` falla por eso
// (no por un error de import que tumbaría todo el archivo).
import * as W from "@/lib/public-wizard-state";
import type { PublicSlotWindow } from "@/lib/public-booking-types";

const slot = (date: string, time: string, locationId: string | null = null) => ({
  iso: `${date}T${time}:00.000-03:00`,
  time,
  available: true,
  locationId,
});
const win = (over: Partial<PublicSlotWindow> = {}): PublicSlotWindow => ({
  days: [
    { date: "2026-10-19", status: "full", slots: [] },
    { date: "2026-10-20", status: "open", slots: [slot("2026-10-20", "09:00", "L1"), slot("2026-10-20", "10:00")] },
    { date: "2026-10-21", status: "open", slots: [slot("2026-10-21", "08:00")] },
    { date: "2026-10-22", status: "open", slots: [slot("2026-10-22", "08:00")] },
    { date: "2026-10-23", status: "open", slots: [slot("2026-10-23", "08:00")] },
  ],
  nextFrom: "2026-10-24",
  reachedEnd: false,
  skippedFrom: null,
  ...over,
});
const TODAY = "2026-10-17"; // sábado: el ejemplo de Martin (la ventana arranca el lun 19)

describe("[TP-1] windowNav siguientes/anteriores/ir a fecha", () => {
  it("arranca en hoy, sin «Anteriores»", () => {
    const nav = W.initialWindowNav(TODAY);
    expect(nav).toEqual({ from: TODAY, history: [] });
    expect(W.canGoPrevWindow(nav, TODAY)).toBe(false);
    // En hoy, «Anteriores» no hace nada (no hay ventana antes de hoy).
    expect(W.prevWindow(nav, TODAY)).toEqual(nav);
  });

  it("«Siguientes ›» pide desde `nextFrom` y apila el arranque real de la ventana; «‹ Anteriores» vuelve", () => {
    const nav0 = W.initialWindowNav(TODAY);
    const nav1 = W.nextWindow(nav0, win());
    // Se apila el primer día MOSTRADO (lun 19), no el `from` pedido (sáb 17): volver pide desde un día hábil y el
    // server no vuelve a saltear (si salteó, volver a pedir desde el `from` viejo saltearía otra vez).
    expect(nav1).toEqual({ from: "2026-10-24", history: ["2026-10-19"] });
    expect(W.canGoPrevWindow(nav1, TODAY)).toBe(true);
    const nav2 = W.nextWindow(nav1, win({ days: [{ date: "2026-10-26", status: "open", slots: [] }], nextFrom: "2026-10-31" }));
    expect(nav2.history).toEqual(["2026-10-19", "2026-10-26"]);
    // Vuelve al primer día mostrado de esa ventana (lun 26), no al `from` pedido (sáb 24).
    expect(W.prevWindow(nav2, TODAY)).toEqual({ from: "2026-10-26", history: ["2026-10-19"] });
    expect(W.prevWindow(nav1, TODAY)).toEqual({ from: "2026-10-19", history: [] });
  });

  it("sin `nextFrom` (fin de la búsqueda) «Siguientes» no se mueve", () => {
    const nav = W.initialWindowNav(TODAY);
    expect(W.nextWindow(nav, win({ nextFrom: null, reachedEnd: true }))).toEqual(nav);
  });

  it("«Anteriores» sin pila (llegó por fecha o por el primer turno) vuelve a hoy", () => {
    expect(W.prevWindow({ from: "2026-11-02", history: [] }, TODAY)).toEqual({ from: TODAY, history: [] });
  });

  it("«Ir a una fecha»: piso en hoy, ignora basura y deja «Anteriores» volviendo a algo anterior", () => {
    const nav = W.nextWindow(W.initialWindowNav(TODAY), win()); // from 24, pila [19]
    const j = W.jumpToDate(nav, "2026-11-12", TODAY);
    expect(j.from).toBe("2026-11-12");
    // La pila solo guarda arranques ANTERIORES a la fecha elegida, con hoy en el fondo.
    expect(j.history).toEqual([TODAY, "2026-10-19"]);
    expect(W.prevWindow(j, TODAY).from).toBe("2026-10-19");
    // Una fecha pasada (el input tiene `min`, pero se puede tipear) cae en hoy y limpia la pila.
    expect(W.jumpToDate(nav, "2026-10-01", TODAY)).toEqual({ from: TODAY, history: [] });
    expect(W.jumpToDate(nav, "", TODAY)).toEqual(nav);
    expect(W.jumpToDate(nav, "2026-02-30", TODAY)).toEqual(nav);
  });

  it("aviso de día no hábil al ir a una fecha; aviso de salto si los 5 estaban completos", () => {
    // Pidió el jueves 22 y la ventana arranca el viernes 23.
    const w = win({ days: win().days.slice(4) });
    expect(W.windowNotice({ requestedFrom: "2026-10-22", jumped: true, window: w })).toBe(
      "El jueves 22 no tiene horarios. Te mostramos los siguientes."
    );
    // Sin «Ir a una fecha» (navegación normal o arranque) no se avisa.
    expect(W.windowNotice({ requestedFrom: "2026-10-22", jumped: false, window: w })).toBeNull();
    expect(W.windowNotice({ requestedFrom: "2026-10-23", jumped: true, window: w })).toBeNull();
    // `skippedFrom` = el `from` pedido (sáb 17); el aviso nombra el día anterior al primero mostrado.
    const skipped = win({ days: [{ date: "2026-10-26", status: "open", slots: [] }], skippedFrom: "2026-10-17" });
    expect(W.windowNotice({ requestedFrom: "2026-10-17", jumped: false, window: skipped })).toBe(
      "No había turnos libres hasta el domingo 25; te mostramos desde el lunes 26."
    );
  });

  it("sin libres en 6 semanas = primera tanda toda «Completo» sin salto (o ventana vacía)", () => {
    const allFull = win({ days: win().days.map((d) => ({ ...d, status: "full" as const, slots: [] })) });
    expect(W.windowHasNoFreeSlots(allFull)).toBe(true);
    expect(W.windowHasNoFreeSlots({ ...allFull, skippedFrom: "2026-10-17" })).toBe(false);
    expect(W.windowHasNoFreeSlots(win())).toBe(false);
    expect(W.windowHasNoFreeSlots(win({ days: [] }))).toBe(true);
  });

  it("«Buscar más adelante» con la ventana vacía: `nextFrom` o 6 semanas después, nunca más allá de 90 días", () => {
    const empty = win({ days: [], nextFrom: null, reachedEnd: true });
    expect(W.laterFrom({ from: TODAY, history: [] }, empty, TODAY)).toBe("2026-11-28");
    // El `nextFrom` de la tanda toda «Completo» está dentro de lo ya buscado: se salta al horizonte.
    expect(W.laterFrom({ from: TODAY, history: [] }, { ...empty, nextFrom: "2026-10-24" }, TODAY)).toBe("2026-11-28");
    expect(W.laterFrom({ from: TODAY, history: [] }, { ...empty, nextFrom: "2026-12-02" }, TODAY)).toBe("2026-12-02");
    expect(W.laterFrom({ from: "2026-12-20", history: [] }, empty, TODAY)).toBeNull();
  });
});

describe("[TP-1] Próximo turno disponible selecciona el primer libre", () => {
  it("firstAvailable: el primer horario del primer día con libres (saltea los «Completo»)", () => {
    expect(W.firstAvailable(win())).toEqual({ date: "2026-10-20", slot: slot("2026-10-20", "09:00", "L1") });
    expect(W.firstAvailable(win({ days: [{ date: "2026-10-19", status: "full", slots: [] }] }))).toBeNull();
    expect(W.firstAvailable(win({ days: [] }))).toBeNull();
  });

  it("keepSelectionInWindow: conserva el horario si sigue libre en la ventana (con su sede), si no lo suelta", () => {
    expect(W.keepSelectionInWindow(win(), slot("2026-10-20", "09:00").iso)).toEqual(slot("2026-10-20", "09:00", "L1"));
    expect(W.keepSelectionInWindow(win(), slot("2026-10-20", "11:00").iso)).toBeNull();
    expect(W.keepSelectionInWindow(win(), null)).toBeNull();
  });

  it("«Ver más horarios de X» y el primer turno posicionan la ventana en el día encontrado", () => {
    const sel = W.selectionFromFirstSlot({
      practitionerId: "A", iso: slot("2026-10-28", "09:00").iso, time: "09:00", date: "2026-10-28", durationMin: 45, locationId: null,
    } as never);
    // `dateISO` de la selección (lo lee también `first-slot-step.tsx`) es el `from` de la ventana del wizard.
    expect(sel.dateISO).toBe("2026-10-28");
    expect(W.windowNavAt(sel.dateISO, TODAY)).toEqual({ from: "2026-10-28", history: [TODAY] });
    expect(W.windowNavAt(TODAY, TODAY)).toEqual({ from: TODAY, history: [] });
  });
});

describe("[TP-1] etiquetas de la ventana (pared AR, sin depender del huso del navegador)", () => {
  it("rango, encabezado del día y nombre accesible del horario", () => {
    expect(W.windowRangeLabel(["2026-10-19", "2026-10-23"])).toBe("lun 19 al vie 23 de octubre");
    expect(W.windowRangeLabel(["2026-10-30", "2026-11-05"])).toBe("vie 30 de octubre al jue 5 de noviembre");
    expect(W.windowRangeLabel(["2026-10-19"])).toBe("lun 19 de octubre");
    expect(W.windowRangeLabel([])).toBe("");
    expect(W.dayHeading({ date: "2026-10-19", status: "open", slots: Array(8).fill(slot("2026-10-19", "09:00")) })).toBe(
      "Lunes 19 de oct · 8 horarios"
    );
    expect(W.dayHeading({ date: "2026-10-19", status: "open", slots: [slot("2026-10-19", "09:00")] })).toBe(
      "Lunes 19 de oct · 1 horario"
    );
    expect(W.dayHeading({ date: "2026-10-19", status: "full", slots: [] })).toBe("Lunes 19 de oct · Completo");
    expect(W.slotAccessibleName("2026-10-19", "09:00")).toBe("Lunes 19 de octubre a las 09:00");
    expect(W.slotAccessibleName("2026-10-19", "09:00", "Centro")).toBe("Lunes 19 de octubre a las 09:00, en Centro");
  });
});
