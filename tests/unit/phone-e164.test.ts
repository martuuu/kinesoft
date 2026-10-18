/**
 * WA-0 (§21.6) · `lib/phone-e164.ts`: celulares argentinos como los carga la gente → E.164 `+549…`; fijos y números
 * sin área → null con motivo (el drawer cae al `wa.me/?text=` sin destinatario y avisa).
 */
import { describe, it, expect } from "vitest";
import { normalizeArMobile, toArMobileE164 } from "@/lib/phone-e164";

describe("[WA-0] normalizeArMobile · celulares", () => {
  const cases: Array<[string, string]> = [
    // AMBA, formato nacional con 0 y 15 (el más común en fichas viejas).
    ["011 15 2345-6789", "+5491123456789"],
    ["(011) 15-2345-6789", "+5491123456789"],
    ["01115 2345 6789", "+5491123456789"],
    // Internacional bien escrito (lo que muestra WhatsApp en «Info del contacto»).
    ["+54 9 11 2345-6789", "+5491123456789"],
    ["+5491123456789", "+5491123456789"],
    ["5491123456789", "+5491123456789"],
    ["0054 9 11 2345 6789", "+5491123456789"],
    // Córdoba: área de 3 + 15 + abonado de 7 (el «155» de la consigna).
    ["0351 155 123456", "+5493515123456"],
    ["0351 15 512-3456", "+5493515123456"],
    ["+54 9 351 512 3456", "+5493515123456"],
    // La Plata / Rosario / Mendoza / Tucumán.
    ["0221 15 456-7890", "+5492214567890"],
    ["0341 156 789012", "+5493416789012"],
    ["0261 15 412 3456", "+5492614123456"],
    ["0381 15 555 1234", "+5493815551234"],
    // Área de 4 dígitos (Villa Carlos Paz 3541, Chascomús 2241) + 15 + abonado de 6.
    ["03541 15 412345", "+5493541412345"],
    ["02241 15 123456", "+5492241123456"],
    // 10 dígitos sin 0 ni 15: como se carga un celular en un formulario (decisión con default).
    ["11 2345 6789", "+5491123456789"],
    ["11-2345-6789", "+5491123456789"],
    ["351 512 3456", "+5493515123456"],
    // El 9 del internacional sin el 54.
    ["9 11 2345 6789", "+5491123456789"],
    // Mezclas que aparecen: +54 9 con el 0 y el 15 de más; +54 sin 9 pero con 15.
    ["+54 9 011 15 2345 6789", "+5491123456789"],
    ["+54 11 15 2345 6789", "+5491123456789"],
    ["+54 0351 15 512 3456", "+5493515123456"],
    ["  +54 (9) 11 2345.6789  ", "+5491123456789"],
  ];
  for (const [raw, e164] of cases) {
    it(`${JSON.stringify(raw)} → ${e164}`, () => {
      expect(normalizeArMobile(raw)).toEqual({ ok: true, e164 });
      expect(toArMobileE164(raw)).toBe(e164);
    });
  }
});

describe("[WA-0] normalizeArMobile · no es un celular (null con motivo)", () => {
  const cases: Array<[string | null | undefined, string]> = [
    [null, "empty"],
    [undefined, "empty"],
    ["", "empty"],
    ["   ", "empty"],
    ["sin teléfono", "empty"],
    // Fijos: 0 + área + abonado, o +54 sin el 9.
    ["011 4321-5678", "landline"],
    ["(0351) 423-4567", "landline"],
    ["0221 423 4567", "landline"],
    ["+54 11 4321 5678", "landline"],
    ["+54 351 423 4567", "landline"],
    // Sin código de área.
    ["4321-5678", "missing_area_code"],
    ["15 2345 6789", "missing_area_code"],
    ["15-2345-6789", "missing_area_code"],
    ["423-4567", "missing_area_code"],
    // Otro país.
    ["+598 99 123 456", "not_ar"],
    ["+1 415 555 0100", "not_ar"],
    // Imposibles: área que no existe, largo raro, dos números en el campo.
    ["45 2345 6789", "invalid"],
    ["011 15 2345 678", "invalid"],
    ["11 2345 6789 / 11 9876 5432", "invalid"],
    ["+54 9 11 2345", "invalid"],
    ["0800 333 1234", "invalid"],
  ];
  for (const [raw, reason] of cases) {
    it(`${JSON.stringify(raw)} → ${reason}`, () => {
      expect(normalizeArMobile(raw)).toEqual({ ok: false, reason });
      expect(toArMobileE164(raw)).toBeNull();
    });
  }
});
