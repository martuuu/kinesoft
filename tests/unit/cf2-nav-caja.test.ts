import { describe, it, expect } from "vitest";
import { bottomNavFor, NAV_ITEMS, navFor, shortcutsFor } from "@/lib/nav";
import { capabilitiesForMember, SUPPORT_CAPS } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

/**
 * CF2 P-NAV (§29, D-CF2-16/17): «Caja» (`/caja`) entra al nav para quien tiene alguna de `billing.manage` (Titular,
 * Admin, Facturación), `billing.collect` (Secretaria) o `billing.collectOwn` (Profesional), con o sin cobros online.
 * Antes `shellNavCaps` le sacaba `billing.collect` al shell con `MP_CONNECT_MODE=off` para esconder «Cobros»: con
 * «Caja» detrás de esa capability, la Secretaria de un consultorio sin Mercado Pago se habría quedado sin su caja.
 * Ahora «Cobros» declara `onlinePaymentsOnly` y el modo viaja como `opts.onlinePayments`.
 * Capabilities reales de la matriz (`capabilitiesForMember`, la misma que usa el layout para un miembro).
 */
const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });
const GENERAL_INDIVIDUAL = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });

const member = (role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING", clinical = role !== "ASSISTANT" && role !== "BILLING") =>
  capabilitiesForMember({ role, clinical, grantSettings: false, grantBilling: false });

const hrefs = (xs: { href: string }[]) => xs.map((x) => x.href);
const ON = { onlinePayments: true } as const;
const OFF = { onlinePayments: false } as const;

describe("[CF2-PN1] Secretaria: «Caja» siempre, «Cobros» solo con cobros online", () => {
  it("MP apagado: ve «Caja» y no «Cobros»", () => {
    const h = hrefs(navFor(KINE, member("ASSISTANT"), OFF));
    expect(h).toContain("/caja");
    expect(h).not.toContain("/cobros");
  });

  it("MP prendido: ve las dos, «Caja» antes que «Cobros»", () => {
    const h = hrefs(navFor(KINE, member("ASSISTANT"), ON));
    expect(h).toContain("/caja");
    expect(h).toContain("/cobros");
    expect(h.indexOf("/caja")).toBe(h.indexOf("/cobros") - 1);
  });

  it("sin opts falla cerrado para «Cobros» (no para «Caja»)", () => {
    const h = hrefs(navFor(KINE, member("ASSISTANT")));
    expect(h).toContain("/caja");
    expect(h).not.toContain("/cobros");
  });
});

describe("[CF2-PN2] quién ve «Caja»", () => {
  it("Profesional (solo `billing.collectOwn`) la ve; «Cobros» no, ni con MP prendido", () => {
    const caps = member("PRACTITIONER");
    expect(caps.has("billing.collect")).toBe(false);
    const h = hrefs(navFor(KINE, caps, ON));
    expect(h).toContain("/caja");
    expect(h).not.toContain("/cobros");
  });

  it("Facturación (`billing.manage`) la ve", () => {
    expect(hrefs(navFor(KINE, member("BILLING"), OFF))).toContain("/caja");
  });

  it("Titular la ve, atienda o no", () => {
    expect(hrefs(navFor(KINE, member("OWNER", true), OFF))).toContain("/caja");
    expect(hrefs(navFor(KINE, member("OWNER", false), OFF))).toContain("/caja");
    expect(hrefs(navFor(GENERAL_INDIVIDUAL, member("OWNER", true), OFF))).toContain("/caja");
  });

  it("soporte (sin `billing.*`), un rol sin caps o sin caps conocidas: no", () => {
    expect(hrefs(navFor(KINE, SUPPORT_CAPS, ON))).not.toContain("/caja");
    expect(hrefs(navFor(KINE, new Set(), ON))).not.toContain("/caja");
    expect(hrefs(navFor(KINE, undefined, ON))).not.toContain("/caja");
  });

  it("sin el módulo `facturacion` no aparece", () => {
    const sin = new Set([...KINE].filter((m) => m !== "facturacion"));
    expect(hrefs(navFor(sin, member("ASSISTANT"), ON))).not.toContain("/caja");
  });
});

describe("[CF2-PN3] la entrada y sus derivados", () => {
  it("NAV_ITEMS: «Caja» con ícono wallet, módulo facturacion y las tres capabilities de cobro", () => {
    const caja = NAV_ITEMS.find((it) => it.href === "/caja");
    expect(caja).toMatchObject({ label: "Caja", icon: "wallet", module: "facturacion", shortcut: "Caja" });
    expect([...(caja?.anyCapability ?? [])].sort()).toEqual(["billing.collect", "billing.collectOwn", "billing.manage"]);
    expect(NAV_ITEMS.find((it) => it.href === "/cobros")?.onlinePaymentsOnly).toBe(true);
  });

  it("⌘K: atajo «Caja» para quien cobra; no para soporte", () => {
    expect(shortcutsFor(KINE, member("ASSISTANT"))).toContainEqual({ id: "nav:caja", category: "shortcut", label: "Caja", href: "/caja" });
    expect(hrefs(shortcutsFor(KINE, SUPPORT_CAPS))).not.toContain("/caja");
  });

  it("barra inferior: «Cobros» respeta el modo (sale del mismo filtro que `navFor`)", () => {
    const caps = member("BILLING");
    const all = (o: typeof ON | typeof OFF) => bottomNavFor(KINE, caps, o).flatMap((e) => (e.kind === "link" ? [e.href] : []));
    expect(all(OFF)).not.toContain("/cobros");
    // BILLING: Inicio, Agenda, Pacientes y el siguiente de navFor (Caja), con o sin cobros online.
    expect(all(OFF)).toEqual(["/dashboard", "/agenda", "/pacientes", "/caja"]);
    expect(all(ON)).toEqual(["/dashboard", "/agenda", "/pacientes", "/caja"]);
  });
});
