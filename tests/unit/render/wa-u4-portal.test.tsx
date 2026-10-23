import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [WA-U4] (T6, §26.5) Tarjeta «Avisos por WhatsApp» del portal (`/portal/c/<slug>/cuenta`). Render estático del
 * componente real; la action (`setMyWhatsAppConsent`, WA-S5) es red: se mockea solo para que el módulo cargue (sus
 * reglas las cubre `tests/integration/wa-s5-actions.test.ts`).
 */
vi.mock("@/lib/portal-whatsapp-consent", () => ({
  setMyWhatsAppConsent: vi.fn(),
  getMyWhatsAppConsent: vi.fn(),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WA_PORTAL_COPY,
  WhatsAppConsentCard,
  waConsentCardView,
  type PortalWaConsent,
} from "@/components/portal/whatsapp-consent-card";
import { WA_CONSENT_TEXT } from "@/lib/whatsapp/copy";

const base: PortalWaConsent = {
  status: null,
  phoneMasked: "+54 9 11 ****-5678",
  phoneValid: true,
  phoneChanged: false,
  versionOutdated: false,
  currentVersion: "wa-2026-10-v1",
};
const render = (over: Partial<PortalWaConsent>, canGrant = true) =>
  renderToStaticMarkup(<WhatsAppConsentCard slug="norte" consent={{ ...base, ...over }} canGrant={canGrant} />);

describe("[WA-U4] waConsentCardView", () => {
  it("[WA-U4] estados", () => {
    expect(waConsentCardView({ ...base, status: "GRANTED" })).toBe("active");
    expect(waConsentCardView({ ...base, status: "GRANTED", phoneChanged: true })).toBe("paused");
    expect(waConsentCardView({ ...base, status: "GRANTED", versionOutdated: true })).toBe("paused");
    expect(waConsentCardView({ ...base, status: null })).toBe("off");
    expect(waConsentCardView({ ...base, status: "REVOKED" })).toBe("off");
    expect(waConsentCardView({ ...base, status: "REVOKED", phoneValid: false, phoneMasked: null })).toBe("no_phone");
  });
});

describe("[WA-U4] WhatsAppConsentCard (render)", () => {
  it("[WA-U4] sin consentimiento: casilla DESTILDADA, texto legal, número enmascarado y botón que no se aprieta sin tildar", () => {
    const html = render({});
    const input = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(input).not.toMatch(/checked/);
    expect(html).toMatch(/<label[^>]*for="portal-wa-norte"/);
    expect(html).toContain(WA_CONSENT_TEXT);
    expect(html).toContain("+54 9 11 ****-5678");
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>[^<]*Activar avisos/);
    expect(html).toContain(WA_PORTAL_COPY.offLead);
  });

  it("[WA-U4] activados: dice a qué número, y revocar pide confirmación (segundo paso en <details>)", () => {
    const html = render({ status: "GRANTED" });
    expect(html).toContain(WA_PORTAL_COPY.activeTitle);
    expect(html).toContain("+54 9 11 ****-5678");
    expect(html).toMatch(/<details[\s\S]*<summary[^>]*>[^<]*Dejar de recibir avisos[\s\S]*<button[^>]*>[^<]*Sí, dejar de recibir avisos/);
    expect(html).not.toContain('type="checkbox"');
  });

  it("[WA-U4] en pausa (cambió el celular o el texto): explica y ofrece volver a activar", () => {
    const changed = render({ status: "GRANTED", phoneChanged: true });
    expect(changed).toContain(WA_PORTAL_COPY.pausedPhone);
    expect(changed).toContain('type="checkbox"');
    const text = render({ status: "GRANTED", versionOutdated: true });
    expect(text).toContain(WA_PORTAL_COPY.pausedText);
  });

  it("[WA-U4] el teléfono no es un celular: no se ofrece activar, se manda a «Mis datos»", () => {
    const html = render({ status: null, phoneValid: false, phoneMasked: null });
    expect(html).toContain(WA_PORTAL_COPY.noPhone);
    expect(html).not.toContain("Activar avisos");
    expect(html).not.toContain('type="checkbox"');
  });

  it("[WA-U4] sin WhatsApp activo en el consultorio (`canGrant` false): no se ofrece activar, pero sí revocar", () => {
    expect(render({ status: null }, false)).not.toContain("Activar avisos");
    expect(render({ status: "GRANTED" }, false)).toContain("Sí, dejar de recibir avisos");
  });

  it("[WA-U4] nunca muestra el número completo ni nombra la HC; voseo", () => {
    for (const over of [{}, { status: "GRANTED" as const }, { status: "GRANTED" as const, phoneChanged: true }]) {
      const html = render(over);
      expect(html).not.toMatch(/\d{6,}/);
      expect(html).not.toMatch(/\+?54\s?9?\s?11\s?\d{4}/);
    }
    const src = readFileSync(join(process.cwd(), "components/portal/whatsapp-consent-card.tsx"), "utf8");
    expect(src).not.toMatch(/clinicalNote|ClinicalNote|clinical-notes/);
    expect(src).not.toMatch(/components\/ui\/(toast|confirm-dialog|drawer|modal)|framer-motion|useConfirm/);
  });

  it("[WA-U4] la página de Cuenta monta la tarjeta", () => {
    const page = readFileSync(join(process.cwd(), "app/(portal)/portal/c/[slug]/cuenta/page.tsx"), "utf8");
    expect(page).toMatch(/<WhatsAppConsentCard\b/);
    expect(page).toMatch(/getMyWhatsAppConsent\(/);
  });
});
