/** PV-K (§27, Q1): contratos puros de Legales (LG). */
import { describe, expect, it } from "vitest";
import {
  LEGAL_ACCEPT_ERROR,
  LEGAL_ENTITY,
  LEGAL_LINKS,
  LEGAL_VERSION,
  LEGAL_VERSION_LABEL,
  PRIVACY_PATH,
  TERMS_PATH,
  legalAcceptedFromForm,
} from "@/lib/legal";

describe("[LG-1] constantes y legalAcceptedFromForm", () => {
  it("[LG-1] constantes literales", () => {
    expect(LEGAL_VERSION).toBe("2026-10-31");
    expect(LEGAL_VERSION_LABEL).toBe("Versión 1 · vigente desde el 31 de octubre de 2026");
    expect(TERMS_PATH).toBe("/terminos");
    expect(PRIVACY_PATH).toBe("/privacidad");
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual(["/terminos", "/privacidad"]);
    expect(LEGAL_ENTITY).toEqual({
      name: null,
      cuit: null,
      address: null,
      jurisdiction: "Tribunales ordinarios de la Ciudad Autónoma de Buenos Aires",
    });
    expect(LEGAL_ACCEPT_ERROR).toBe("Para seguir, aceptá los Términos y la Política de privacidad.");
  });

  it("[LG-1] acepta on/true/true/1; todo lo demás false", () => {
    for (const v of ["on", "true", true, "1"]) expect(legalAcceptedFromForm(v)).toBe(true);
    for (const v of [null, undefined, "", "off", "false", false, "0", 0, 1, "yes", "ON ", ["on"], {}]) {
      expect(legalAcceptedFromForm(v)).toBe(false);
    }
  });
});
