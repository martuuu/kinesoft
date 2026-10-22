/**
 * [TP-P3] `buildChargePreference` (`lib/mp-connect/preference.ts`, C-TP3 del plan §25): el body que se le manda a MP
 * con el token del vendedor. Lo crítico es plata y ruteo: `unit_price` exacto, `oc:<id>` y `?acct=` (sin `acct` el pago
 * caería en la rama legada de la plataforma), REQUIRED sin medios offline y sin comisión de plataforma.
 * El título usa la fecha AR: corre igual en TZ=UTC y TZ=America/Argentina/Buenos_Aires.
 */
import { describe, expect, it } from "vitest";
import {
  buildChargePreference,
  connectNotificationUrl,
  statementDescriptorFrom,
  type ChargePreferenceInput,
} from "@/lib/mp-connect/preference";

const NOTIF = "https://app.kinesoft.test/api/webhooks/mercadopago?acct=REF_abc123";
const input = (over: Partial<ChargePreferenceInput> = {}): ChargePreferenceInput => ({
  charge: { id: "ch_1", amountCents: 600_000, scheduledFor: "2026-10-20T13:00:00.000Z" },
  tenantName: "Kinesiología Ñandú & Cía.",
  mode: "REQUIRED",
  notificationUrl: NOTIF,
  backUrls: { success: "https://a/ok", failure: "https://a/err", pending: "https://a/pend" },
  expiresAt: new Date("2026-10-20T12:30:00.000Z"),
  ...over,
});

describe("[TP-P3] buildChargePreference", () => {
  it("[TP-P3] REQUIRED con binary_mode y sin ticket/atm", () => {
    const b = buildChargePreference(input());
    expect(b.binary_mode).toBe(true);
    expect(b.payment_methods).toEqual({ excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] });
    for (const mode of ["OPTIONAL", "LINK"] as const) {
      const o = buildChargePreference(input({ mode }));
      expect(o.binary_mode).toBeUndefined();
      expect(o.payment_methods).toBeUndefined();
    }
  });

  it("[TP-P3] descriptor ASCII ≤22; vacío → sin campo", () => {
    const b = buildChargePreference(input());
    expect(b.statement_descriptor).toBe("Kinesiologia Nandu Cia");
    expect(b.statement_descriptor!.length).toBeLessThanOrEqual(22);
    expect(b.statement_descriptor).toMatch(/^[A-Za-z0-9 ]+$/);
    expect(statementDescriptorFrom("Centro de Rehabilitación Kinésica Integral")).toBe("Centro de Rehabilitaci");
    expect(statementDescriptorFrom("Consultorio  Dr. Pérez   ")).toBe("Consultorio Dr Perez");
    expect(statementDescriptorFrom("abcdefghijklmnopqrstu vwx")).toBe("abcdefghijklmnopqrstu");
    expect("statement_descriptor" in buildChargePreference(input({ tenantName: "☺☺ — ☺" }))).toBe(false);
  });

  it("[TP-P3] unit_price exacto (centavos → decimal sin pérdida)", () => {
    for (const cents of [100, 101, 123_456, 600_000, 1_999_99, 100_000_000, 33_333]) {
      const b = buildChargePreference(input({ charge: { id: "c", amountCents: cents, scheduledFor: "2026-10-20T13:00:00Z" } }));
      expect(b.items[0].unit_price).toBe(cents / 100);
      expect(Math.round(b.items[0].unit_price * 100)).toBe(cents);
      expect(JSON.parse(JSON.stringify(b)).items[0].unit_price).toBe(Number((cents / 100).toFixed(2)));
    }
    expect(buildChargePreference(input()).items[0]).toEqual({
      id: "ch_1",
      title: "Turno del 20/10 · Kinesiología Ñandú & Cía.",
      quantity: 1,
      unit_price: 6000,
      currency_id: "ARS",
    });
    expect(() => buildChargePreference(input({ charge: { id: "c", amountCents: 10.5, scheduledFor: "2026-10-20T13:00:00Z" } }))).toThrow();
    expect(() => buildChargePreference(input({ charge: { id: "c", amountCents: 0, scheduledFor: "2026-10-20T13:00:00Z" } }))).toThrow();
  });

  it("[TP-P3] links sin payer y con título de link", () => {
    const b = buildChargePreference(input({ mode: "LINK", charge: { id: "ch_9", amountCents: 50_000 } }));
    expect("payer" in b).toBe(false);
    expect(b.items[0].title).toBe("Link de pago · Kinesiología Ñandú & Cía.");
    expect("payer" in buildChargePreference(input())).toBe(false);
  });

  it("[TP-P3] ?acct=; oc:; sin marketplace_fee; vence; back_urls y metadata", () => {
    const b = buildChargePreference(input());
    expect(b.notification_url).toBe(NOTIF);
    expect(new URL(b.notification_url).searchParams.get("acct")).toBe("REF_abc123");
    expect(b.external_reference).toBe("oc:ch_1");
    expect(JSON.stringify(b)).not.toContain("marketplace");
    expect(b.expires).toBe(true);
    expect(b.expiration_date_to).toBe("2026-10-20T09:30:00.000-03:00");
    expect(new Date(b.expiration_date_to).getTime()).toBe(new Date("2026-10-20T12:30:00.000Z").getTime());
    expect(b.back_urls).toEqual({ success: "https://a/ok", failure: "https://a/err", pending: "https://a/pend" });
    expect(b.auto_return).toBe("approved");
    expect(b.metadata).toEqual({ chargeId: "ch_1" });
    // sin acct → error (caería en la rama legada de la plataforma)
    expect(() => buildChargePreference(input({ notificationUrl: "https://app.kinesoft.test/api/webhooks/mercadopago" }))).toThrow(/acct/);
    expect(() => buildChargePreference(input({ notificationUrl: "https://app.kinesoft.test/api/webhooks/mercadopago?acct=" }))).toThrow(/acct/);
    expect(connectNotificationUrl("https://app.kinesoft.test/", "REF_abc123")).toBe(NOTIF);
  });

  it("[TP-P3] título en hora AR: 23:30 AR sigue siendo el mismo día", () => {
    // 2026-10-21T02:30Z = 20/10 23:30 AR
    const b = buildChargePreference(input({ charge: { id: "c", amountCents: 100, scheduledFor: new Date("2026-10-21T02:30:00Z") } }));
    expect(b.items[0].title).toBe("Turno del 20/10 · Kinesiología Ñandú & Cía.");
    expect(() => buildChargePreference(input({ charge: { id: "c", amountCents: 100, scheduledFor: null } }))).toThrow();
  });
});
