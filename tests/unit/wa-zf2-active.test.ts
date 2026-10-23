/**
 * [ZF2] La regla «WhatsApp activo» unificada (`lib/whatsapp/active-internal.ts`) y sus tres usuarios: turnero
 * (`turneroWhatsAppActive`, variante `notices`), agenda (`agendaWhatsAppFor`, `channel`) y pantallas del paciente
 * (`tenantWhatsAppActive`, `channel`). Se reemplaza SOLO la lectura de la cuenta (`getLiveAccountCached`, que es base +
 * cache de Next); las reglas son las reales.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const live = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/whatsapp/account-internal", () => ({ getLiveAccountCached: live.fn }));

import { isWhatsAppActive, tenantWhatsAppActiveFor, type WaActiveAccount } from "@/lib/whatsapp/active-internal";
import { readFileSync } from "node:fs";
import { tenantWhatsAppActive } from "@/lib/whatsapp-patient-ui-internal";

/** El turnero y la agenda arrastran `lib/bookings` (cache de React): su cableado se fija por fuente; el efecto, en
 *  integración (tests/integration/wa-s8-turnero.test.ts, wa-s7-agenda.test.ts). */
const src = (f: string) => readFileSync(f, "utf8");

const acc = (o: Partial<WaActiveAccount> = {}): WaActiveAccount => ({
  status: "ACTIVE",
  mode: "fake",
  autoBookingNotice: true,
  autoReminder: true,
  ...o,
});

describe("[ZF2] isWhatsAppActive", () => {
  it("[ZF2] channel: ACTIVE y mismo modo; nada más", () => {
    expect(isWhatsAppActive(acc(), "fake", "channel")).toBe(true);
    expect(isWhatsAppActive(acc({ autoBookingNotice: false, autoReminder: false }), "fake", "channel")).toBe(true);
    expect(isWhatsAppActive(acc({ status: "SETUP" }), "fake", "channel")).toBe(false);
    expect(isWhatsAppActive(acc({ status: "REAUTH_REQUIRED" }), "fake", "channel")).toBe(false);
    expect(isWhatsAppActive(acc(), "sandbox", "channel")).toBe(false);
    expect(isWhatsAppActive(acc(), "off", "channel")).toBe(false);
    expect(isWhatsAppActive(null, "fake", "channel")).toBe(false);
  });

  it("[ZF2] notices: además, al menos un aviso automático prendido", () => {
    expect(isWhatsAppActive(acc(), "fake", "notices")).toBe(true);
    expect(isWhatsAppActive(acc({ autoBookingNotice: false }), "fake", "notices")).toBe(true);
    expect(isWhatsAppActive(acc({ autoReminder: false }), "fake", "notices")).toBe(true);
    expect(isWhatsAppActive(acc({ autoBookingNotice: false, autoReminder: false }), "fake", "notices")).toBe(false);
    expect(isWhatsAppActive(acc({ mode: "live" }), "fake", "notices")).toBe(false);
  });
});

describe("[ZF2] los tres usuarios usan la regla común con su variante", () => {
  beforeEach(() => {
    live.fn.mockReset();
  });

  it("[ZF2] con `off` no se lee la cuenta", async () => {
    expect(await tenantWhatsAppActive("t1", "off")).toBe(false);
    expect(await tenantWhatsAppActiveFor("t1", "notices", { mode: "off", logEvent: "x" })).toBe(false);
    expect(live.fn).not.toHaveBeenCalled();
  });

  it("[ZF2] con los dos avisos apagados: `notices` false; el paciente sigue con el canal", async () => {
    live.fn.mockResolvedValue({ ...acc({ autoBookingNotice: false, autoReminder: false }), id: "a", tenantId: "t1" });
    expect(await tenantWhatsAppActiveFor("t1", "notices", { mode: "fake", logEvent: "x" })).toBe(false);
    expect(await tenantWhatsAppActive("t1", "fake")).toBe(true);
  });

  it("[ZF2] turnero (notices), agenda y paciente (channel) delegan en la regla común: no queda ninguna copia", () => {
    const turnero = src("lib/public-booking-internal.ts");
    expect(turnero).toMatch(/tenantWhatsAppActiveFor\(tenantId, "notices"/);
    expect(src("lib/agenda-page-loader.ts")).toMatch(/tenantWhatsAppActiveFor\(tenantId, "channel"/);
    expect(src("lib/whatsapp-patient-ui-internal.ts")).toMatch(/tenantWhatsAppActiveFor\(tenantId, "channel"/);
    for (const f of ["lib/public-booking-internal.ts", "lib/agenda-page-loader.ts", "lib/whatsapp-patient-ui-internal.ts"]) {
      expect(src(f)).not.toMatch(/a\??\.status === "ACTIVE" && a\.mode === mode/);
    }
  });

  it("[ZF2] si la lectura falla → false, no tira", async () => {
    live.fn.mockRejectedValue(new Error("db down"));
    expect(await tenantWhatsAppActiveFor("t1", "channel", { mode: "fake", logEvent: "x" })).toBe(false);
    expect(await tenantWhatsAppActive("t1", "fake")).toBe(false);
  });
});
