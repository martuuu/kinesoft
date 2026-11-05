/**
 * CF3 PR-W (W3, D-CF3-3/4/5/12): el turnero público con el precio del profesional, «cualquier profesional» sin precio en
 * el paso de servicio, el bloque de cobertura para un paciente con obra social (WhatsApp del profesional por action, al
 * tocar) y la entrada por `?pro=` («Turnos con {Nombre}» + «Ver otros profesionales»).
 *
 * Render estático (como `public-booking-wizard.test.tsx`): el wizard real entra al paso de servicio por el deep link
 * (`initialWizardSelection`), así que el cableado `particularQuoteFor` se prueba sobre el símbolo que corre en prod. Solo
 * se mockea la red (las server actions de `@/lib/public-booking`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const getInsuredContact = vi.fn(async () => ({ ok: false as const, reason: "none" as const }));
vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
  getInsuredContact: (...a: unknown[]) => (getInsuredContact as (...x: unknown[]) => unknown)(...a),
}));

import { PublicBookingWizard, ServiceStep, SummaryAside } from "@/components/booking/public-booking-wizard";
import { InsuredContactView, askInsuredContact, insuredStateFrom } from "@/components/booking/wizard/insured-contact";
import { amountDiffers, checkoutCopyFor, checkoutPricingFor, quotedForInterstitial, wizardOnlinePaymentFor } from "@/lib/public-wizard-state";
import { PaymentChoice, PaymentInterstitial } from "@/components/booking/wizard/payment-choice";
import { formatARS } from "@/lib/format";
import type { PublicClinic } from "@/lib/public-booking-types";

const pro = (id: string) => ({ id, name: `Lic. ${id}`, specialty: null, licenseNumber: null, yearsExp: null, acceptedInsurerIds: ["P", "O"] });

/** Ana cobra $ 18.000, Beto $ 12.000; Caro tiene el precio oculto (no está en `particularQuotes`). Servicio: $ 15.000. */
function clinic(practitioners = ["Ana", "Beto", "Caro"]): PublicClinic {
  return {
    slug: "demo",
    name: "Kine Demo",
    legalName: null,
    palette: "sky",
    practitioners: practitioners.map(pro),
    services: [{ id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1_500_000, practitionerId: null, practitionerIds: practitioners }],
    insurers: [
      { id: "P", name: "Particular", isParticular: true },
      { id: "O", name: "OSDE", isParticular: false },
    ],
    particularQuotes: { Ana: { S: 1_800_000 }, Beto: { S: 1_200_000 } },
    insuredContactAvailable: { Ana: true },
    clinicPhone: "+54 341 555-0000",
  };
}

const svc = (c: PublicClinic) => c.services;

describe("CF3 PR-W · precio por profesional en el paso de servicio", () => {
  it("[CF3-PRW-1] por ?pro= el wizard real pinta la cotización de ESE profesional, no el precio del servicio", () => {
    const ana = renderToStaticMarkup(<PublicBookingWizard clinic={clinic()} session={null} prefill={null} initialPractitionerId="Ana" />);
    expect(ana).toContain(formatARS(1_800_000));
    expect(ana).not.toContain(formatARS(1_500_000));
    const beto = renderToStaticMarkup(<PublicBookingWizard clinic={clinic()} session={null} prefill={null} initialPractitionerId="Beto" />);
    expect(beto).toContain(formatARS(1_200_000));
  });

  it("[CF3-PRW-2] precio oculto (D-CF3-3): ni la cotización ni el precio del servicio, y el subtítulo no promete precio", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic()} session={null} prefill={null} initialPractitionerId="Caro" />);
    expect(html).not.toContain(formatARS(1_500_000));
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toContain("su duración y su precio");
  });

  it("[CF3-PRW-3] «cualquier profesional» (D-CF3-4): sin precio en el paso de servicio; aparece en el resumen", () => {
    const c = clinic();
    const html = renderToStaticMarkup(
      <ServiceStep clinic={c} services={svc(c)} practitionerId={null} declaredObraSocial={false} value={null} onChange={() => {}} />
    );
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).toContain("en el resumen");
  });

  it("[CF3-PRW-4] con obra social declarada el paso de servicio no muestra precio (decisión 1)", () => {
    const c = clinic();
    const html = renderToStaticMarkup(
      <ServiceStep clinic={c} services={svc(c)} practitionerId="Ana" declaredObraSocial value={null} onChange={() => {}} />
    );
    expect(html).not.toContain(formatARS(1_800_000));
    expect(html).toContain("depende de tu cobertura");
  });
});

describe("CF3 PR-W · obra social → bloque de cobertura", () => {
  const c = clinic();
  const insuredCheckout = (pid: string) =>
    checkoutCopyFor({ payment: null, ...checkoutPricingFor(c, pid, "S", { insurerId: "O" }) });

  it("[CF3-PRW-5] el resumen muestra el texto de cobertura y no un total; la action NO corre al render", () => {
    getInsuredContact.mockClear();
    const html = renderToStaticMarkup(
      <SummaryAside clinic={c} practitioner={c.practitioners[0]} anyPractitioner={false} service={c.services[0]} slotISO={null} location={null} checkout={insuredCheckout("Ana")} />
    );
    expect(html).toContain("El valor depende de tu cobertura");
    expect(html).not.toContain(formatARS(1_800_000));
    expect(html).not.toContain("wa.me");
    expect(getInsuredContact).not.toHaveBeenCalled();
  });

  it("[CF3-PRW-6] con opt-in: botón «Consultar por WhatsApp con {Nombre}» sin el número en el HTML inicial", () => {
    getInsuredContact.mockClear();
    const html = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "idle" }} contactAvailable practitionerName="Lic. Ana" clinicPhone={c.clinicPhone ?? null} onAsk={() => {}} />
    );
    expect(html).toMatch(/<button[^>]*>.*Consultar por WhatsApp con Lic\. Ana/);
    expect(html).not.toContain("wa.me");
    expect(html).not.toContain("tel:");
    expect(getInsuredContact).not.toHaveBeenCalled();
  });

  it("[CF3-PRW-7] la respuesta ok pinta los links armados por el server; none / rate_limited caen al consultorio", () => {
    const ok = insuredStateFrom({ ok: true, name: "Lic. Ana", waUrl: "https://wa.me/5493415551111?text=x", telUrl: "tel:+5493415551111" });
    const okHtml = renderToStaticMarkup(
      <InsuredContactView state={ok} contactAvailable practitionerName="Lic. Ana" clinicPhone={null} onAsk={() => {}} />
    );
    expect(okHtml).toContain('href="https://wa.me/5493415551111?text=x"');
    expect(okHtml).toContain('href="tel:+5493415551111"');

    for (const reason of ["none", "rate_limited"] as const) {
      const st = insuredStateFrom({ ok: false, reason });
      // CF3 ZF3: sin `text` la vista no pinta texto (lo pinta el wizard); con `text`, lo reemplaza por el del consultorio.
      const named = "El valor depende de tu cobertura. Consultá con Lic. Ana si tiene convenio con tu obra social y cuánto te cubre.";
      const html = renderToStaticMarkup(
        <InsuredContactView state={st} text={named} contactAvailable practitionerName="Lic. Ana" clinicPhone="+54 341 555-0000" onAsk={() => {}} />
      );
      expect(html).toContain("Consultá tu cobertura con el consultorio");
      expect(html).toContain('href="tel:+543415550000"');
      expect(html).not.toContain("<button");
    }
  });

  // CF3 ZF2: con `text` la vista pinta el texto del bloque; si la action falla, lo reemplaza (antes el wizard dejaba
  // «Consultá con Lic. Ana…» arriba y la vista sumaba «Consultá tu cobertura con el consultorio» debajo: los dos).
  it("[CF3-ZF2-8b] con `text`: idle muestra el texto con el nombre una vez; fallback lo reemplaza por el del consultorio", () => {
    const named = "El valor depende de tu cobertura. Consultá con Lic. Ana si tiene convenio con tu obra social y cuánto te cubre.";
    const idle = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "idle" }} text={named} contactAvailable practitionerName="Lic. Ana" clinicPhone={null} onAsk={() => {}} />
    );
    expect(idle.split("si tiene convenio").length - 1).toBe(1);
    const fb = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "fallback" }} text={named} contactAvailable practitionerName="Lic. Ana" clinicPhone="+54 341 555-0000" onAsk={() => {}} />
    );
    expect(fb).not.toContain("Lic. Ana");
    expect(fb.split("Consultá tu cobertura con el consultorio").length - 1).toBe(1);
    expect(fb).toContain('href="tel:+543415550000"');
    const off = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "idle" }} text="Consultá tu cobertura con el consultorio." contactAvailable={false} practitionerName="Lic. Beto" clinicPhone={null} onAsk={() => {}} />
    );
    expect(off.split("Consultá tu cobertura con el consultorio").length - 1).toBe(1);
  });

  it("[CF3-PRW-8] sin opt-in: directo «Consultá tu cobertura con el consultorio» + teléfono; sin teléfono, solo el texto", () => {
    const summary = renderToStaticMarkup(
      <SummaryAside clinic={c} practitioner={c.practitioners[1]} anyPractitioner={false} service={c.services[0]} slotISO={null} location={null} checkout={insuredCheckout("Beto")} />
    );
    expect(summary).toContain("Consultá tu cobertura con el consultorio");
    expect(summary).toContain("Según tu cobertura");
    expect(summary).not.toContain("Lic. Beto si tiene convenio");
    const withPhone = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "idle" }} contactAvailable={false} practitionerName="Lic. Beto" clinicPhone="+54 341 555-0000" onAsk={() => {}} />
    );
    expect(withPhone).toContain("tel:+543415550000");
    expect(withPhone).not.toContain("<button");
    const noPhone = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "idle" }} contactAvailable={false} practitionerName="Lic. Beto" clinicPhone={null} onAsk={() => {}} />
    );
    expect(noPhone).not.toContain("tel:");
  });
});

describe("CF3 PR-W · entrada por ?pro= (D-CF3-12)", () => {
  it("[CF3-PRW-9] «Turnos con {Nombre}» como la única h1 y «Ver otros profesionales» con más de uno", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic()} session={null} prefill={null} initialPractitionerId="Ana" />);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Turnos con Lic\. Ana<\/h1>/);
    expect(html).toMatch(/<button[^>]*>Ver otros profesionales<\/button>/);
  });

  it("[CF3-PRW-10] con un solo profesional: encabezado sin «Ver otros»; id ajeno o sin ?pro=: «Reservá tu turno»", () => {
    const one = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(["Ana"])} session={null} prefill={null} initialPractitionerId="Ana" />);
    expect(one).toContain("Turnos con Lic. Ana");
    expect(one).not.toContain("Ver otros profesionales");
    const junk = renderToStaticMarkup(<PublicBookingWizard clinic={clinic()} session={null} prefill={null} initialPractitionerId="zzz" />);
    expect(junk).toContain("Reservá tu turno");
    expect(junk).not.toContain("Turnos con");
    expect(junk).not.toContain("Ver otros profesionales");
  });
});

describe("CF3 PR-W · precio oculto con cobro online (D-CF3-3)", () => {
  const onlineClinic = (): PublicClinic => ({
    ...clinic(),
    onlinePayment: {
      mode: "REQUIRED",
      chargeKind: "COPAGO",
      fixedCents: null,
      percentBps: null,
      cancellationNote: null,
      practitionerIds: ["Ana", "Caro"],
      particularCopagoCents: 0,
    } as NonNullable<PublicClinic["onlinePayment"]>,
  });

  it("[CF3-PRW-11] el resumen no inventa número y el monto aparece en el interstitial antes de Mercado Pago", () => {
    const c = onlineClinic();
    const payment = wizardOnlinePaymentFor(c, "Caro", c.services[0].priceCents, { insurerId: null }, "S");
    expect(payment?.amountHidden).toBe(true);
    const checkout = checkoutCopyFor({ payment, ...checkoutPricingFor(c, "Caro", "S", { insurerId: null }) });
    const summary = renderToStaticMarkup(
      <SummaryAside clinic={c} practitioner={c.practitioners[2]} anyPractitioner={false} service={c.services[0]} slotISO={null} location={null} checkout={checkout} />
    );
    expect(summary).not.toMatch(/\$\s?\d/);
    expect(summary).toContain("Ves el monto antes de ir a pagar");
    const choice = renderToStaticMarkup(<PaymentChoice payment={payment!} choice={null} onChange={() => {}} />);
    expect(choice).toContain("Mercado Pago. Ves el monto");
    // El server cobra $ 20.000: siempre interstitial, con el copy de «primera vez» (no «cambió»).
    expect(amountDiffers({ next: "checkout", amountCents: 2_000_000 }, quotedForInterstitial(payment, checkout.online))).toBe(true);
    const inter = renderToStaticMarkup(<PaymentInterstitial kind="hidden" amountCents={2_000_000} onContinue={() => {}} />);
    expect(inter).toContain(`El monto a pagar es ${formatARS(2_000_000)}`);
    expect(inter).not.toContain("cambió");
  });

  it("[CF3-PRW-12] Ana (precio visible) cotiza con SU precio en el cobro online, no con el Particular en $ 0", () => {
    const c = onlineClinic();
    const payment = wizardOnlinePaymentFor(c, "Ana", c.services[0].priceCents, { insurerId: null }, "S");
    expect(payment?.quote.amountCents).toBe(1_800_000);
    const checkout = checkoutCopyFor({ payment, ...checkoutPricingFor(c, "Ana", "S", { insurerId: null }) });
    expect(checkout.totalCents).toBe(1_800_000);
  });
});

// CF3 ZF3 (revisor de UI): con la action en `none` / `rate_limited` / error se veían dos textos contradictorios: el `<p>`
// del wizard («Consultá con Lic. Ana…») y, debajo, el de la vista («Consultá tu cobertura con el consultorio»). Ahora la
// vista no repite texto (sin `text`) y avisa con `onFallback`; el wizard cambia su `<p>` (insuredCoverageTextAfterContact).
describe("[CF3-ZF3-2] fallback del contacto del profesional", () => {
  it("[CF3-ZF3-2a] askInsuredContact avisa onFallback en none / rate_limited / error, no en ok", async () => {
    const cases: [string, () => Promise<never> | Promise<import("@/lib/public-booking-types").PublicInsuredContact>, boolean][] = [
      ["none", async () => ({ ok: false, reason: "none" }), true],
      ["rate_limited", async () => ({ ok: false, reason: "rate_limited" }), true],
      ["throw", async () => { throw new Error("red"); }, true],
      ["ok", async () => ({ ok: true, name: "Lic. Ana", waUrl: "https://wa.me/1", telUrl: "tel:+1" }), false],
    ];
    for (const [tag, fetchContact, fallback] of cases) {
      const onFallback = vi.fn();
      const openChat = vi.fn();
      const states: string[] = [];
      await askInsuredContact({ slug: "demo", practitionerId: "Ana", fetchContact, setState: (st) => states.push(st.kind), onFallback, openChat });
      expect(onFallback, tag).toHaveBeenCalledTimes(fallback ? 1 : 0);
      expect(openChat, tag).toHaveBeenCalledTimes(fallback ? 0 : 1);
      expect(states, tag).toEqual(["loading", fallback ? "fallback" : "ok"]);
    }
  });

  it("[CF3-ZF3-2b] la vista sin `text` en fallback no suma el texto del consultorio (solo el teléfono)", () => {
    const html = renderToStaticMarkup(
      <InsuredContactView state={{ kind: "fallback" }} contactAvailable practitionerName="Lic. Ana" clinicPhone="+54 341 555-0000" onAsk={() => {}} />
    );
    expect(html).not.toContain("Consultá tu cobertura con el consultorio");
    expect(html).toContain('href="tel:+543415550000"');
  });
});
