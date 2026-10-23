import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [WA-U4] (T6, §26.5) Consentimiento de WhatsApp en el turnero: la casilla de «Tus datos», el `waConsent` del submit y
 * la línea de la confirmación. Render estático con el componente real (sin jsdom: los efectos no corren); la lógica que
 * cruza la navegación dura (wizard → `/booking/<id>/ok` o Mercado Pago → vuelta) es pura y se testea sola.
 */
vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DataStep, TURNERO_WA_CONSENT_LABEL, TURNERO_WA_CONSENT_TEXT } from "@/components/booking/wizard/data-step";
import { waConsentForSubmit } from "@/components/booking/public-booking-wizard";
import { BookingResult, RESULT_WA_LINE } from "@/components/booking/booking-result";
import { readWaSaved, rememberWaSaved, waSavedKey } from "@/components/booking/wa-saved-flag";
import { WA_CONSENT_TEXT } from "@/lib/whatsapp/copy";
import type { PatientHC } from "@/components/booking/public-booking-wizard";
import type { PublicBookingStatus, PublicClinic } from "@/lib/public-booking-types";

const HC: PatientHC = {
  firstName: "", lastName: "", email: "", phone: "", documentId: "", dateOfBirth: "", coverageInsurer: "",
  coveragePlan: "", emergencyName: "", emergencyPhone: "", notes: "", title: "", description: "",
};
const clinic = (whatsappNotices?: boolean): PublicClinic => ({
  slug: "demo", name: "Kine Demo", legalName: null, palette: "sky",
  practitioners: [{ id: "Ana", name: "Lic. Ana", specialty: null, licenseNumber: null, yearsExp: null }],
  services: [],
  ...(whatsappNotices === undefined ? {} : { whatsappNotices }),
} as PublicClinic);

const step = (c: PublicClinic, waConsent = false) =>
  renderToStaticMarkup(
    <DataStep clinic={c} session={null} hc={HC} setHc={() => {}} error={null} waConsent={waConsent} onWaConsentChange={() => {}} />,
  );

describe("[WA-U4] casilla del turnero", () => {
  it("[WA-U4] sin `whatsappNotices` (ausente o false) no hay casilla ni texto de WhatsApp", () => {
    for (const c of [clinic(), clinic(false)]) {
      const html = step(c);
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain("WhatsApp");
    }
  });

  it("[WA-U4] con `whatsappNotices === true`: casilla DESTILDADA con label real, texto legal en <details> y 44 px", () => {
    const html = step(clinic(true));
    const input = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('id="booking-waConsent"');
    expect(input).not.toMatch(/checked/);
    expect(input).toContain('aria-describedby="booking-waConsent-legal"');
    expect(html).toMatch(new RegExp(`<label[^>]*for="booking-waConsent"[^>]*>[\\s\\S]*${TURNERO_WA_CONSENT_LABEL}`));
    expect(html).toMatch(/<details[\s\S]*<summary[^>]*min-height:44px[\s\S]*<\/summary>/);
    expect(html).toContain(`id="booking-waConsent-legal"`);
    expect(html).toContain(TURNERO_WA_CONSENT_TEXT);
    expect(html).toMatch(/<label[^>]*style="[^"]*min-height:44px/);
  });

  it("[WA-U4] tildada se ve tildada", () => {
    expect(step(clinic(true), true)).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
  });

  it("[WA-U4] el literal del turnero es el de `lib/whatsapp/copy.ts` (paridad: el turnero no importa el módulo)", () => {
    expect(TURNERO_WA_CONSENT_LABEL).toBe("Quiero recibir avisos de mis turnos por WhatsApp");
    expect(TURNERO_WA_CONSENT_TEXT).toBe(WA_CONSENT_TEXT);
    const src = readFileSync(join(process.cwd(), "components/booking/wizard/data-step.tsx"), "utf8");
    expect(src).not.toMatch(/from\s+["']@\/lib\/whatsapp\//);
  });
});

describe("[WA-U4] submit", () => {
  it("[WA-U4] `waConsent` solo viaja con la casilla tildada Y `whatsappNotices === true`", () => {
    expect(waConsentForSubmit(clinic(true), true)).toBe(true);
    expect(waConsentForSubmit(clinic(true), false)).toBeUndefined();
    expect(waConsentForSubmit(clinic(false), true)).toBeUndefined();
    expect(waConsentForSubmit(clinic(), true)).toBeUndefined();
  });

  it("[WA-U4] el wizard manda `waConsent` en `submitPublicBooking`", () => {
    const src = readFileSync(join(process.cwd(), "components/booking/public-booking-wizard.tsx"), "utf8");
    expect(src).toMatch(/submitPublicBooking\(\{[\s\S]*waConsent: waConsentForSubmit\(clinic, waConsent\)/);
    expect(src).toMatch(/rememberWaSaved\(r\.data\.bookingId, r\.data\.whatsappConsent\)/);
  });
});

describe("[WA-U4] marca «saved» a través de la navegación", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it("[WA-U4] solo `saved` se recuerda; `invalid_phone`/`unavailable`/ausente no", () => {
    const st = mem();
    rememberWaSaved("bk_1", "saved", st);
    rememberWaSaved("bk_2", "invalid_phone", st);
    rememberWaSaved("bk_3", "unavailable", st);
    rememberWaSaved("bk_4", undefined, st);
    expect([...st.m.keys()]).toEqual([waSavedKey("bk_1")]);
  });

  it("[WA-U4] la confirmación lo lee de la sesión, por turno; sin storage (o si tira) no rompe y no dice nada", () => {
    const st = mem();
    rememberWaSaved("bk_1", "saved", st);
    expect(readWaSaved("bk_1", st)).toBe(true);
    expect(readWaSaved("bk_2", st)).toBe(false);
    expect(readWaSaved("bk_1", null)).toBe(false);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readWaSaved("bk_1", throwing)).toBe(false);
    expect(() => rememberWaSaved("bk_1", "saved", throwing)).not.toThrow();
  });
});

describe("[WA-U4] línea de la confirmación", () => {
  const base: PublicBookingStatus = {
    bookingId: "bk_1", status: "CONFIRMED", paymentStatus: "UNPAID", tenantSlug: "norte", tenantName: "Consultorio Norte",
    serviceName: "Sesión", practitionerName: "Ana", scheduledFor: "2026-10-14T23:30:00.000Z", durationMin: 45,
    patientInitials: "J. P.", amountCents: null, onlinePayment: false,
  } as PublicBookingStatus;

  it("[WA-U4] «Te vamos a avisar por WhatsApp.» solo con `saved`; nada si no", () => {
    expect(RESULT_WA_LINE).toBe("Te vamos a avisar por WhatsApp.");
    expect(renderToStaticMarkup(<BookingResult initial={base} variant="ok" waNoticeSaved />)).toContain(RESULT_WA_LINE);
    expect(renderToStaticMarkup(<BookingResult initial={base} variant="ok" />)).not.toContain("WhatsApp");
  });

  it("[WA-U4] con el turno caído (pago no completado) no promete avisos", () => {
    const html = renderToStaticMarkup(
      <BookingResult initial={{ ...base, status: "CANCELLED", paymentStatus: "FAILED", onlinePayment: undefined } as PublicBookingStatus} variant="failed" waNoticeSaved />,
    );
    expect(html).not.toContain("WhatsApp");
  });
});
