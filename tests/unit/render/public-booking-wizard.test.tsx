import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { PublicBookingWizard, SummaryAside, type PatientHC } from "@/components/booking/public-booking-wizard";
import { DataStep } from "@/components/booking/wizard/data-step";
import { checkoutCopyFor, wizardOnlinePaymentFor, type WizardOnlinePayment } from "@/lib/public-wizard-state";
import { PAY_COPY, PaymentChoice, PaymentInterstitial } from "@/components/booking/wizard/payment-choice";
import { TURNERO_PAYMENT_COPY } from "@/lib/online-payments-copy";
import { PractitionerStep } from "@/components/booking/wizard/practitioner-step";
import { STEP_HEADING_SELECTOR, focusStepHeading } from "@/components/booking/wizard/shared";
import type { PublicClinic } from "@/lib/public-booking-types";


const pro = (id: string, extra: object = {}) => ({
  id, name: `Lic. ${id}`, specialty: null, licenseNumber: null, yearsExp: null, ...extra,
});
function clinic(locs: number, withOS: boolean): PublicClinic {
  const locations = [
    { id: "L1", name: "Centro", address: "Av. Pellegrini 1200", addressLine2: null, city: "Rosario", province: null, isPrimary: true },
    { id: "L2", name: "Fisherton", address: "Eva Perón 8000", addressLine2: null, city: "Rosario", province: null, isPrimary: false },
  ].slice(0, locs);
  return {
    slug: "demo", name: "Kine Demo", legalName: null, palette: "sky",
    practitioners: [
      pro("Ana", { locationIds: ["L1"], acceptedInsurerIds: ["P", "O"] }),
      pro("Beto", { locationIds: ["L1", "L2"], acceptedInsurerIds: ["P"] }),
    ],
    services: [{ id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1500000, practitionerId: null, practitionerIds: ["Ana", "Beto"] }],
    locations,
    insurers: withOS
      ? [{ id: "P", name: "Particular", isParticular: true }, { id: "O", name: "OSDE", isParticular: false }]
      : [{ id: "P", name: "Particular", isParticular: true }],
  };
}

describe("B5.6 render", () => {
  it("2 sedes + OS: sede, cobertura, cualquiera, profesionales", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} />);
    expect(html).toContain("¿En qué sede?");
    expect(html).toContain("Fisherton");
    expect(html).toContain("Eva Perón 8000 · Rosario");
    expect(html).toContain("¿Con qué cobertura venís? (opcional)");
    expect(html).toContain("OSDE");
    expect(html).toContain("Primer turno disponible");
    expect(html).toContain("Lic. Ana");
    expect(html).not.toMatch(/copago/i);
    // VX-Z: el nav ya no arranca Google (siempre lleva al portal); Google queda en «Tus datos» (ver DataStep abajo).
    expect(html).not.toContain("/api/auth/oauth/google");
    expect(html).toMatch(/<a[^>]*href="\/portal"[^>]*>Iniciar sesión<\/a>/);
  });

  it("1 sede, solo Particular: sin filtros", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} />);
    expect(html).not.toContain("¿En qué sede?");
    expect(html).not.toContain("cobertura venís");
    expect(html).toContain("Primer turno disponible");
  });

  it("filtro de OSDE + sede L2: nadie → mensaje; OSDE solo → sin 'cualquiera' (1 profesional)", () => {
    const c = clinic(2, true);
    const none = renderToStaticMarkup(
      <PractitionerStep clinic={c} filters={{ insurerId: "O", locationId: "L2" }} onFiltersChange={() => {}} mode="pick" value={null} onPick={() => {}} onAny={() => {}} />
    );
    expect(none).toContain("Ningún profesional coincide");
    const one = renderToStaticMarkup(
      <PractitionerStep clinic={c} filters={{ insurerId: "O", locationId: null }} onFiltersChange={() => {}} mode="pick" value={null} onPick={() => {}} onAny={() => {}} />
    );
    expect(one).toContain("Lic. Ana");
    expect(one).not.toContain("Lic. Beto");
    expect(one).not.toContain("Primer turno disponible");
  });

  it("1 profesional: arranca en Servicio (como antes)", () => {
    const c = clinic(1, false);
    c.practitioners = [c.practitioners[0]];
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={c} session={null} prefill={null} />);
    expect(html).toContain("¿Qué servicio necesitás?");
  });
});

const HC: PatientHC = {
  firstName: "", lastName: "", email: "", phone: "", documentId: "", dateOfBirth: "", coverageInsurer: "",
  coveragePlan: "", emergencyName: "", emergencyPhone: "", notes: "", title: "", description: "",
};

describe("VX2-d1 · turnero", () => {
  it("horario real del consultorio en el nav; sin franjas no se muestra ninguno", () => {
    const c = { ...clinic(1, false), openingSummary: "Lun a vie 8 a 19 · Sáb 9 a 13" };
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={c} session={null} prefill={null} />);
    expect(html).toContain("Lun a vie 8 a 19 · Sáb 9 a 13");
    expect(html).toContain("Horario de atención");
    const none = renderToStaticMarkup(
      <PublicBookingWizard clinic={{ ...clinic(1, false), openingSummary: null }} session={null} prefill={null} />
    );
    expect(none).not.toContain("Horario de atención");
    expect(none).not.toMatch(/lun-sáb|8 a 19hs/);
  });

  it("sin <style> embebido ni clases globales .booking-*; una sola h1", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} />);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/class="[^"]*\bbooking-/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/en 30 segundos/);
    expect(html).toContain('aria-current="step"');
  });

  it("resumen sin claims sin evidencia (handoff 12)", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} />);
    expect(html).not.toMatch(/100%|cifrad/i);
    // TP-0: sin `onlineCheckout` el turnero no cobra → «Valor del turno» (antes «Total a pagar»).
    expect(html).toContain("Valor del turno");
  });

  it("datos con Field: label asociada y autocomplete del paciente; emergencia sin autocompletar", () => {
    const html = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} hc={HC} setHc={() => {}} error="Ese horario ya no está." />
    );
    const input = (id: string) => html.match(new RegExp(`<input[^>]*id="booking-${id}"[^>]*>`))?.[0] ?? "";
    expect(html).toContain('<label for="booking-firstName" class="k-label">Nombre</label>');
    expect(input("firstName")).toContain('autoComplete="given-name"');
    expect(input("lastName")).toContain('autoComplete="family-name"');
    expect(input("email")).toMatch(/type="email"[^>]*autoComplete="email"|autoComplete="email"[^>]*type="email"/);
    expect(input("phone")).toContain('autoComplete="tel"');
    expect(input("phone")).toContain('type="tel"');
    expect(input("dateOfBirth")).toContain('autoComplete="bday"');
    expect(input("emergencyPhone")).toContain('autoComplete="off"');
    expect(input("emergencyName")).toContain('autoComplete="off"');
    expect(html).toContain('class="k-alert" role="alert"');
    expect(html).toContain("Ingresar con Google");
  });

  it("[VX-Z · D-VX16] Google apagado → ni «Ingresar con Google» en datos ni el form del nav; queda el portal", () => {
    const step = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} googleEnabled={false} hc={HC} setHc={() => {}} error={null} />
    );
    expect(step).not.toContain("Ingresar con Google");
    const html = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} googleEnabled={false} />
    );
    expect(html).not.toContain("/api/auth/oauth/google");
    expect(html).toMatch(/<a[^>]*href="\/portal"[^>]*>Iniciar sesión<\/a>/);
  });

  it("[VX2-d1] el CSS del turnero vive en su módulo (sin outline:none)", () => {
    const css = readFileSync("components/booking/public-booking.module.css", "utf8");
    expect(css).toMatch(/\.body\s*\{/);
    expect(css).not.toMatch(/outline:\s*none/);
    expect(css).not.toMatch(/filter:\s*blur/);
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).not.toContain("RESPONSIVE_CSS");
  });
});

describe("VX-Z · turnero", () => {
  it("«Iniciar sesión» es SIEMPRE un link al portal (con Google prendido también); con sesión, «Mis turnos»", () => {
    for (const googleEnabled of [true, false]) {
      const html = renderToStaticMarkup(
        <PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} googleEnabled={googleEnabled} />
      );
      expect(html).toMatch(/<a[^>]*href="\/portal"[^>]*>Iniciar sesión<\/a>/);
      expect(html).not.toMatch(/<button[^>]*>Iniciar sesión/);
    }
    const logged = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic(1, false)} session={{ email: "a@b.c", fullName: null }} prefill={null} />
    );
    expect(logged).toMatch(/<a[^>]*href="\/portal"[^>]*>Mis turnos<\/a>/);
    // Google sigue ofrecido en «Tus datos», como form POST a la ruta canónica.
    const step = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} googleEnabled hc={HC} setHc={() => {}} error={null} />
    );
    expect(step).toMatch(/<form action="\/api\/auth\/oauth\/google\?next=%2Fc%2Fdemo%2Fbooking" method="post"/);
  });

  it(".pillButton y .navLink con objetivo táctil de 44 px", () => {
    const css = readFileSync("components/booking/public-booking.module.css", "utf8");
    expect(css).toMatch(/\.pillButton\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/\.navLink\s*\{[^}]*min-height:\s*44px/);
  });

  it("marca del consultorio adelante (monograma + nombre) y KineSoft chico en el pie; una sola h1", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(1, false)} session={null} prefill={null} />);
    const nav = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(nav).toContain(">KD<");
    expect(nav).toMatch(/<p[^>]*>Kine Demo<\/p>/);
    expect(nav).not.toContain("<svg"); // sin el logo de KineSoft en el nav (salvo íconos chicos: el reloj va sin franjas)
    const foot = html.slice(html.lastIndexOf("<footer"));
    expect(foot).toContain("Turnos online con");
    expect(foot).toMatch(/<a(?=[^>]*href="\/")(?=[^>]*aria-label="[^"]+, inicio")[^>]*>/);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("el título de cada paso es destino de foco (tabIndex=-1, data-step-heading)", () => {
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={clinic(2, false)} session={null} prefill={null} />);
    expect(html).toMatch(/<h2[^>]*tabindex="-1"[^>]*data-step-heading=""[^>]*>¿Con quién querés atenderte\?<\/h2>/);
    const step = renderToStaticMarkup(
      <DataStep clinic={clinic(1, false)} session={null} googleEnabled hc={HC} setHc={() => {}} error={null} />
    );
    expect(step).toMatch(/<h2[^>]*tabindex="-1"[^>]*data-step-heading=""[^>]*>Completá tus datos<\/h2>/);
  });

  it("focusStepHeading: enfoca el título del paso y no hace nada sin contenedor o sin título", () => {
    const focus = vi.fn();
    const seen: string[] = [];
    const root = { querySelector: (sel: string) => (seen.push(sel), { focus }) };
    expect(focusStepHeading(root)).toBe(true);
    expect(seen).toEqual([STEP_HEADING_SELECTOR]);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusStepHeading(null)).toBe(false);
    expect(focusStepHeading({ querySelector: () => null })).toBe(false);
  });

  it("el wizard mueve el foco al cambiar de paso, no en el primer render", () => {
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).toMatch(/if \(prevStep\.current === step\) return;[\s\S]*focusStepHeading\(cardRef\.current\);[\s\S]*\}, \[step\]\);/);
    expect(src).toContain("<div ref={cardRef}");
  });
});

describe("DIR-2d · deep link ?pro=", () => {
  it("profesional reservable → arranca en Servicio con él elegido; inválido → paso Profesional como siempre", () => {
    const html = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} initialPractitionerId="Beto" />
    );
    expect(html).toContain("¿Qué servicio necesitás?");
    expect(html).not.toContain("Primer turno disponible");
    expect(html).toContain("Lic. Beto");
    expect(html).not.toContain("Lic. Ana");

    const bad = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic(2, true)} session={null} prefill={null} initialPractitionerId="otro" />
    );
    expect(bad).not.toContain("¿Qué servicio necesitás?");
    expect(bad).toContain("Primer turno disponible");
    expect(bad).toContain("Lic. Ana");
  });
});

describe("[TP-0] wizard sin cobro: «Confirmar turno», sin «Mercado Pago»", () => {
  const c = clinic(1, false);
  const sv = c.services[0];
  const aside = (clinicOver: Partial<PublicClinic>, priceCents: number) => {
    const cl = { ...c, ...clinicOver };
    const payment = wizardOnlinePaymentFor(cl, cl.practitioners[0].id, priceCents);
    return renderToStaticMarkup(
      <SummaryAside
        clinic={cl}
        practitioner={cl.practitioners[0]}
        anyPractitioner={false}
        service={{ ...sv, priceCents }}
        slotISO="2026-10-19T12:00:00.000Z"
        location={null}
        checkout={checkoutCopyFor({ payment, choice: null, priceCents })}
        cancellationNote={payment?.cancellationNote ?? null}
      />
    );
  };

  it("wizard completo sin `onlinePayment` (null o ausente): ni «Mercado Pago» ni «Pagar»", () => {
    for (const over of [{}, { onlinePayment: null }]) {
      const html = renderToStaticMarkup(<PublicBookingWizard clinic={{ ...c, ...over }} session={null} prefill={null} />);
      expect(html).not.toMatch(/Mercado Pago|Pagar y reservar|Total a pagar/);
      expect(html).toContain("Lo pagás en el consultorio.");
    }
  });

  it("resumen con servicio: «Valor del turno» + monto + «Lo pagás en el consultorio.»; precio 0 → sin fila de total", () => {
    const html = aside({}, 1_500_000);
    expect(html).toMatch(/Valor del turno<\/span><span[^>]*>\$\s?15\.000/);
    expect(html).toContain("Lo pagás en el consultorio.");
    expect(html).not.toMatch(/Mercado Pago|Total a pagar/);
    const free = aside({}, 0);
    expect(free).not.toContain("Valor del turno");
    expect(free).not.toMatch(/\$\s?0\b/);
    expect(free).toContain("Lo pagás en el consultorio.");
  });

  it("con cobro online REQUIRED el resumen dice Total a pagar + Mercado Pago", () => {
    const html = aside({ onlinePayment: policy({ mode: "REQUIRED", practitionerIds: [c.practitioners[0].id] }) }, 1_500_000);
    expect(html).toContain("Total a pagar");
    expect(html).toContain("El pago se hace en Mercado Pago.");
  });

  it("el botón del último paso y la navegación salen de los helpers (sin el «Pagar y reservar» fijo)", () => {
    // El paso 3 no se alcanza con render estático: se fija que el wizard use el copy y el destino de los helpers
    // (testeados en tests/unit/public-wizard-state.test.ts), no un literal.
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).not.toContain('"Pagar y reservar"');
    expect(src).not.toContain('"Redirigiendo…"');
    expect(src).toMatch(/pending\s*\?\s*checkout\.ctaPending\s*:\s*checkout\.cta/);
    // TP-3h: a Mercado Pago (y al resultado) por navegación con `location.assign`.
    expect(src).toContain("window.location.assign(destinationAfterSubmit(r.data))");
    expect(src).not.toMatch(/window\.location\.href = /);
    expect(checkoutCopyFor({ priceCents: 1_500_000 })).toMatchObject({ cta: "Confirmar turno", ctaPending: "Reservando…" });
  });
});

// ─── TP-3h · turnero con cobro (§25.10 «Turnero», TP-UI-D5/D6, TP-D29) ──────────────────────────────────────────
function policy(over: Partial<NonNullable<PublicClinic["onlinePayment"]>> = {}): NonNullable<PublicClinic["onlinePayment"]> {
  return {
    mode: "OPTIONAL", chargeKind: "COPAGO", fixedCents: null, percentBps: null, cancellationNote: null,
    practitionerIds: ["Beto"], ...over,
  };
}

describe("[TP-3h] PaymentChoice", () => {
  it("los literales copiados son los de TURNERO_PAYMENT_COPY (paridad)", () => {
    for (const [k, v] of Object.entries(PAY_COPY)) expect(v, k).toBe(TURNERO_PAYMENT_COPY[k as keyof typeof TURNERO_PAYMENT_COPY]);
  });

  const opt: WizardOnlinePayment = { mode: "OPTIONAL", quote: { amountCents: 600_000, chargeKind: "DEPOSIT" }, cancellationNote: null };

  it("OPTIONAL: dos opciones literales, ninguna preseleccionada (TP-UI-D5), en un radiogroup con leyenda", () => {
    const html = renderToStaticMarkup(<PaymentChoice payment={opt} choice={null} onChange={() => {}} />);
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain(TURNERO_PAYMENT_COPY.payLater);
    expect(html).toContain(TURNERO_PAYMENT_COPY.payNow);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(2);
    expect(html).not.toMatch(/checked=""/);
    // La seña se dice en la opción de pagar ahora.
    expect(html).toMatch(/Seña de \$\s?6\.000/);
  });

  it("OPTIONAL con elección: queda marcada solo esa", () => {
    const html = renderToStaticMarkup(<PaymentChoice payment={opt} choice="now" onChange={() => {}} />);
    expect((html.match(/checked=""/g) ?? []).length).toBe(1);
    expect(html).toMatch(/value="now"[^>]*checked=""|checked=""[^>]*value="now"/);
  });

  it("REQUIRED: aviso sin radios", () => {
    const html = renderToStaticMarkup(
      <PaymentChoice payment={{ ...opt, mode: "REQUIRED", quote: { amountCents: 1_500_000, chargeKind: "FULL" } }} choice={null} onChange={() => {}} />
    );
    expect(html).not.toContain('type="radio"');
    expect(html).toContain("Mercado Pago");
    expect(html).toMatch(/\$\s?15\.000/);
  });
});

describe("[TP-3h] resumen con seña y nota de cancelación", () => {
  const c = clinic(1, false);
  const beto = c.practitioners[1];
  const sv = { ...c.services[0], priceCents: 2_000_000 };
  const render = (op: NonNullable<PublicClinic["onlinePayment"]>, choice: "now" | "later" | null) => {
    const cl = { ...c, onlinePayment: op };
    const payment = wizardOnlinePaymentFor(cl, beto.id, sv.priceCents);
    return renderToStaticMarkup(
      <SummaryAside
        clinic={cl}
        practitioner={beto}
        anyPractitioner={false}
        service={sv}
        slotISO="2026-10-19T12:00:00.000Z"
        location={null}
        checkout={checkoutCopyFor({ payment, choice, priceCents: sv.priceCents })}
        cancellationNote={payment?.cancellationNote ?? null}
      />
    );
  };

  it("seña: «Seña a pagar ahora» y «Resto en el consultorio»", () => {
    const html = render(policy({ mode: "REQUIRED", chargeKind: "PERCENT", percentBps: 3000 }), null);
    expect(html).toMatch(/Seña a pagar ahora<\/span><span[^>]*>\$\s?6\.000/);
    expect(html).toMatch(/Resto en el consultorio<\/span><span[^>]*>\$\s?14\.000/);
    expect(html).toContain("30 minutos");
  });

  it("OPTIONAL «en el consultorio»: sin seña en el resumen", () => {
    const html = render(policy({ chargeKind: "PERCENT", percentBps: 3000 }), "later");
    expect(html).not.toContain("Seña a pagar ahora");
    expect(html).toContain("Lo pagás en el consultorio.");
  });

  it("nota de cancelación en texto plano (sin HTML interpretado)", () => {
    const html = render(policy({ cancellationNote: "<b>Avisá</b> 24 h antes." }), null);
    expect(html).toContain("&lt;b&gt;Avisá&lt;/b&gt; 24 h antes.");
    expect(html).not.toContain("<b>Avisá</b>");
  });

  it("sin cobro para ese profesional: ni seña ni nota de cancelación", () => {
    const html = render(policy({ practitionerIds: ["Ana"], cancellationNote: "Avisá 24 h antes." }), null);
    expect(html).not.toContain("Avisá 24 h antes.");
    expect(html).not.toContain("Mercado Pago");
  });
});

describe("[TP-3h] PaymentInterstitial", () => {
  it("monto distinto (TP-UI-D6): muestra el monto del server y sigue a Mercado Pago", () => {
    const html = renderToStaticMarkup(<PaymentInterstitial kind="amount" amountCents={900_000} onContinue={() => {}} />);
    expect(html).toMatch(/\$\s?9\.000/);
    expect(html).toContain("Mercado Pago");
    expect(html).toMatch(/<button[^>]*>[^<]*Continuar a Mercado Pago/);
    expect(html).toContain('role="alert"');
  });

  it("Mercado Pago caído en OPTIONAL: el aviso literal y «Ver mi turno»", () => {
    const html = renderToStaticMarkup(<PaymentInterstitial kind="unavailable" amountCents={null} onContinue={() => {}} />);
    expect(html).toContain(TURNERO_PAYMENT_COPY.optionalUnavailable);
    expect(html).toContain("Ver mi turno");
  });

  it("[TP-ZF2] cotizó y el server no cobró: «Tu turno quedó reservado», sin Mercado Pago, y sigue al resultado", () => {
    const html = renderToStaticMarkup(<PaymentInterstitial kind="reserved" amountCents={null} onContinue={() => {}} />);
    expect(html).toMatch(/<h2[^>]*data-step-heading[^>]*>Tu turno quedó reservado<\/h2>/);
    expect(html).toContain("No hace falta pagar online: lo arreglás en el consultorio.");
    expect(html).toMatch(/<button[^>]*>[^<]*Ver mi turno/);
    expect(html).not.toContain("Continuar a Mercado Pago");
  });

  it("[TP-ZF2] el interstitial trae su título enfocable (ZB-2: el foco no cae al body)", () => {
    const html = renderToStaticMarkup(<PaymentInterstitial kind="amount" amountCents={900_000} onContinue={() => {}} />);
    expect(html).toMatch(/<h2[^>]*data-step-heading[^>]*>Antes de ir a Mercado Pago<\/h2>/);
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).toMatch(/if \(interstitial\)[^\n]*focusStepHeading\(cardRef\.current\)/);
  });

  it("el wizard cablea notice, interstitial y payNow", () => {
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).toContain('r.data.notice === "payment-unavailable"');
    expect(src).toContain("amountDiffers(");
    expect(src).toContain("payNow: payNowFor(");
    expect(src).toContain("<PaymentChoice");
  });
});

describe("[TP-1] paso Servicio", () => {
  it("[TP-1] servicio con precio 0 no muestra $ 0", () => {
    const c = clinic(1, false);
    c.practitioners = [c.practitioners[0]];
    c.services = [
      { ...c.services[0], id: "F", name: "Primera consulta", priceCents: 0 },
      { ...c.services[0], id: "S", name: "Sesión", priceCents: 1_500_000 },
    ];
    const html = renderToStaticMarkup(<PublicBookingWizard clinic={c} session={null} prefill={null} />);
    expect(html).toContain("Primera consulta");
    expect(html).toMatch(/\$\s?15\.000/);
    expect(html).not.toMatch(/\$\s?0\b/);
  });

  it("el wizard usa el paso nuevo de la ventana (no la grilla de un día)", () => {
    const src = readFileSync("components/booking/public-booking-wizard.tsx", "utf8");
    expect(src).toContain("<SlotWindowStep");
    expect(src).not.toMatch(/function SlotStep\b/);
    expect(src).not.toContain("listPublicSlots(");
  });
});
