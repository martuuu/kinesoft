import { describe, it, expect } from "vitest";
import { resolveBookingCopagoCents } from "@/lib/copago";

// Copago precedence is money the patient is charged, shown in billing. The
// tests pin the full ladder (booking → coverage → insurer → particular →
// service) and that 0 is a real amount at every level, not "unset".

const base = {
  bookingOverride: null,
  coverageOverride: null,
  hasCoverage: false,
  insurerCopago: null,
  particularCopago: null,
  servicePriceCents: 5000,
};

describe("resolveBookingCopagoCents", () => {
  it("per-turno booking override wins over everything", () => {
    expect(
      resolveBookingCopagoCents({
        ...base,
        bookingOverride: 1234,
        coverageOverride: 999,
        hasCoverage: true,
        insurerCopago: 888,
        particularCopago: 777,
      })
    ).toBe(1234);
  });

  it("respects a booking override of 0 (charge nothing), not the service price", () => {
    expect(resolveBookingCopagoCents({ ...base, bookingOverride: 0 })).toBe(0);
  });

  describe("with coverage", () => {
    it("coverage override beats the insurer copago", () => {
      expect(
        resolveBookingCopagoCents({ ...base, hasCoverage: true, coverageOverride: 300, insurerCopago: 800 })
      ).toBe(300);
    });
    it("coverage override of 0 is honoured", () => {
      expect(
        resolveBookingCopagoCents({ ...base, hasCoverage: true, coverageOverride: 0, insurerCopago: 800 })
      ).toBe(0);
    });
    it("falls back to the insurer copago when no coverage override", () => {
      expect(resolveBookingCopagoCents({ ...base, hasCoverage: true, insurerCopago: 800 })).toBe(800);
    });
    it("free-form OS with no configured copago falls back to the service price", () => {
      expect(resolveBookingCopagoCents({ ...base, hasCoverage: true })).toBe(5000);
    });
  });

  describe("without coverage (particular)", () => {
    it("uses the tenant's Particular price", () => {
      expect(resolveBookingCopagoCents({ ...base, particularCopago: 2500 })).toBe(2500);
    });
    it("Particular price of 0 is honoured (free consult)", () => {
      expect(resolveBookingCopagoCents({ ...base, particularCopago: 0 })).toBe(0);
    });
    it("falls back to the service price when no Particular row", () => {
      expect(resolveBookingCopagoCents({ ...base })).toBe(5000);
    });
  });
});
