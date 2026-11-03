import { describe, it, expect } from "vitest";
import { bottomNavFor, navFor, shortcutsFor, NAV_ITEMS } from "@/lib/nav";
import { capabilitiesFor, capabilitiesForMember, SUPPORT_CAPS } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

/**
 * CF-NAV (§28, decisión 7 de Martin): la Secretaria, Facturación y el Titular que no atiende (todo rol sin
 * `clinical.read`) no ven Diagnóstico, Planes, Ejercicios (biblioteca), Seguimiento ni Terapia manual. Las cinco
 * entradas de `lib/nav.ts` llevan `capability: "clinical.read"`; el ⌘K (`shortcutsFor`) filtra con las mismas caps.
 * Capabilities reales de la matriz (`capabilitiesFor` / `capabilitiesForMember`), no sets armados a mano.
 */
const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });
const GENERAL = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });

const CLINICAL_HREFS = ["/planes", "/diagnostico", "/seguimiento", "/biblioteca", "/terapia-manual"];

const OWNER_CLINICAL = capabilitiesForMember({ role: "OWNER", clinical: true, grantSettings: false, grantBilling: false });
const OWNER_NOT_CLINICAL = capabilitiesForMember({ role: "OWNER", clinical: false, grantSettings: false, grantBilling: false });
const PRACTITIONER = capabilitiesForMember({ role: "PRACTITIONER", clinical: true, grantSettings: false, grantBilling: false });

const hrefs = (xs: { href: string }[]) => xs.map((x) => x.href);

describe("[CF-I1] navFor por rol: lo clínico solo con clinical.read", () => {
  it("las cinco entradas clínicas exigen clinical.read en NAV_ITEMS", () => {
    for (const h of CLINICAL_HREFS) {
      expect(NAV_ITEMS.find((it) => it.href === h)?.capability, h).toBe("clinical.read");
    }
  });

  it.each([
    ["ASSISTANT (Secretaría)", capabilitiesFor("ASSISTANT")],
    ["BILLING (Facturación)", capabilitiesFor("BILLING")],
    ["Titular que no atiende", OWNER_NOT_CLINICAL],
    ["Soporte de Plataforma (ve lo que ve la Secretaría)", SUPPORT_CAPS],
  ])("%s: sin Planes/Diagnóstico/Seguimiento/Ejercicios/Terapia manual", (_name, caps) => {
    const h = hrefs(navFor(KINE, caps));
    for (const c of CLINICAL_HREFS) expect(h, c).not.toContain(c);
    // Lo operativo sigue: Inicio, Agenda, Pacientes.
    expect(h).toEqual(expect.arrayContaining(["/dashboard", "/agenda", "/pacientes"]));
    // La barra inferior sale de navFor: tampoco las ofrece en sus 4 lugares.
    const bottom = bottomNavFor(KINE, caps).flatMap((e) => (e.kind === "link" ? [e.href] : []));
    for (const c of CLINICAL_HREFS) expect(bottom, c).not.toContain(c);
  });

  it.each([
    ["PRACTITIONER", PRACTITIONER],
    ["Titular que atiende", OWNER_CLINICAL],
  ])("%s en Kine: con las cinco", (_name, caps) => {
    expect(hrefs(navFor(KINE, caps))).toEqual(expect.arrayContaining(CLINICAL_HREFS));
  });

  it("el módulo sigue mandando: General sin las cinco aunque el rol tenga clinical.read", () => {
    const h = hrefs(navFor(GENERAL, OWNER_CLINICAL));
    for (const c of CLINICAL_HREFS) expect(h, c).not.toContain(c);
  });
});

describe("[CF-I3] atajos del ⌘K por capabilities", () => {
  // CF2 (P-NAV): + «Caja», que ven las tres capabilities de cobro (el Profesional por `billing.collectOwn`).
  const ALL = ["/dashboard", "/agenda", "/pacientes", "/planes", "/diagnostico", "/seguimiento", "/biblioteca", "/caja"];

  it("Profesional / Titular que atiende en Kine: los siete atajos de siempre + Caja", () => {
    expect(hrefs(shortcutsFor(KINE, PRACTITIONER))).toEqual(ALL);
    expect(hrefs(shortcutsFor(KINE, OWNER_CLINICAL))).toEqual(ALL);
  });

  it.each([
    ["ASSISTANT", capabilitiesFor("ASSISTANT")],
    ["BILLING", capabilitiesFor("BILLING")],
    ["Titular que no atiende", OWNER_NOT_CLINICAL],
  ])("%s: solo Inicio, Agenda, Pacientes y Caja", (_name, caps) => {
    expect(hrefs(shortcutsFor(KINE, caps))).toEqual(["/dashboard", "/agenda", "/pacientes", "/caja"]);
  });

  it("sin caps falla cerrado (como navFor)", () => {
    expect(hrefs(shortcutsFor(KINE))).toEqual(["/dashboard", "/agenda", "/pacientes"]);
  });

  it("una entrada sin `shortcut` no es atajo aunque el rol la vea (Sala, Cobros, Terapia manual, Configuración)", () => {
    const h = hrefs(shortcutsFor(KINE, capabilitiesFor("OWNER")));
    for (const x of ["/sala", "/cobros", "/terapia-manual", "/configuracion"]) expect(h, x).not.toContain(x);
  });
});
