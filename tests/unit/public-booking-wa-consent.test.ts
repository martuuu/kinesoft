/**
 * [WA-S8] decisión pura del consentimiento de WhatsApp del turnero (`decideTurneroWaConsent`). La escritura en la tx
 * del alta y los dos roles: tests/integration/wa-s8-turnero.test.ts.
 */
import { describe, it, expect } from "vitest";
import { SubmitSchema, decideTurneroWaConsent } from "@/lib/public-booking-types";

describe("[WA-S8] decideTurneroWaConsent", () => {
  it("[WA-S8] sin la casilla → null (no se escribe nada ni hay flag)", () => {
    expect(decideTurneroWaConsent({ requested: undefined, accountActive: true, phone: "11 2345 6789" })).toBeNull();
    expect(decideTurneroWaConsent({ requested: false, accountActive: true, phone: "11 2345 6789" })).toBeNull();
  });

  it("[WA-S8] sin cuenta activa → unavailable aunque el número sea válido", () => {
    expect(decideTurneroWaConsent({ requested: true, accountActive: false, phone: "11 2345 6789" })).toEqual({
      outcome: "unavailable",
    });
  });

  it("[WA-S8] celular válido en cualquier formato → saved con el E.164", () => {
    for (const phone of ["011 15 2345-6789", "+54 9 11 2345 6789", "11 2345 6789"]) {
      expect(decideTurneroWaConsent({ requested: true, accountActive: true, phone })).toEqual({
        outcome: "saved",
        e164: "+5491123456789",
      });
    }
  });

  it("[WA-S8] fijo, sin área o extranjero → invalid_phone", () => {
    for (const phone of ["011 4321-5678", "4321-5678", "+598 99 123 456"]) {
      expect(decideTurneroWaConsent({ requested: true, accountActive: true, phone })).toEqual({ outcome: "invalid_phone" });
    }
  });

  it("[WA-S8] el schema acepta `waConsent` booleano opcional y rechaza otra cosa", () => {
    const base = {
      tenantSlug: "x",
      idempotencyKey: "6f1c2c3e-9b7a-4d2e-8f00-0a1b2c3d4e5f",
      practitionerId: "p",
      serviceId: "s",
      scheduledFor: "2027-01-01T12:00:00.000Z",
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: "ana@test.local",
        phone: "1123456789",
        documentId: "30123456",
        dateOfBirth: "1990-05-10",
      },
    };
    expect(SubmitSchema.safeParse(base).success).toBe(true);
    expect(SubmitSchema.safeParse({ ...base, waConsent: true }).success).toBe(true);
    expect(SubmitSchema.safeParse({ ...base, waConsent: "sí" }).success).toBe(false);
  });
});
