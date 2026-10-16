import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [VX2-d2] Resultado del turnero después de Mercado Pago (`/booking/[id]/{ok,pending,failed}`). Se monta el componente
 * real con `renderToStaticMarkup` (sin jsdom: los efectos del poller no corren). Se mockea solo la server action de
 * desarrollo (red/DB), nunca el componente.
 */
vi.mock("@/lib/public-booking", () => ({ devMarkBookingPaid: vi.fn() }));

import {
  BookingResult,
  effectiveVariantFor,
  PENDING_TIMEOUT_NOTE,
  RESULT_COPY,
} from "@/components/booking/booking-result";
import type { PublicBookingStatus } from "@/lib/public-booking-types";

const base: PublicBookingStatus = {
  bookingId: "bk_1",
  status: "CONFIRMED",
  paymentStatus: "PAID",
  tenantSlug: "norte",
  tenantName: "Consultorio Norte",
  serviceName: "Kinesiología",
  practitionerName: "Ana Pérez",
  // 23:30 UTC del 14-oct = 20:30 del 14-oct en Buenos Aires (en UTC sería el 15: atrapa el bug de timezone).
  scheduledFor: "2026-10-14T23:30:00.000Z",
  durationMin: 45,
  patientInitials: "J. P.",
  amountCents: 1_500_000,
};

const render = (over: Partial<PublicBookingStatus>, variant: "ok" | "pending" | "failed") =>
  renderToStaticMarkup(<BookingResult initial={{ ...base, ...over }} variant={variant} />);

const h1Count = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length;

describe("[VX2-d2] effectiveVariantFor", () => {
  it("el estado real manda sobre la URL", () => {
    expect(effectiveVariantFor({ ...base, paymentStatus: "PAID" }, "pending")).toBe("ok");
    expect(effectiveVariantFor({ ...base, paymentStatus: "FAILED", status: "PENDING" }, "ok")).toBe("failed");
    expect(effectiveVariantFor({ ...base, paymentStatus: "UNPAID", status: "PENDING" }, "ok")).toBe("pending");
    expect(effectiveVariantFor({ ...base, paymentStatus: "AUTHORIZED" }, "ok")).toBe("pending");
    expect(effectiveVariantFor({ ...base, paymentStatus: "UNPAID", status: "CONFIRMED" }, "failed")).toBe("failed");
  });
});

describe("[VX2-d2] BookingResult (render)", () => {
  it("ok: marca del consultorio, detalle con hora AR y monto con formatARS, CTA único <a> a /portal", () => {
    const html = render({}, "ok");
    expect(html).toContain('data-surface="turnero"');
    expect(html).toMatch(/<header[\s\S]*Consultorio Norte[\s\S]*<\/header>/);
    expect(html).toContain('href="/c/norte/booking"');
    expect(h1Count(html)).toBe(1);
    expect(html).toContain(RESULT_COPY.ok.title);
    expect(html).toContain("Ana Pérez");
    expect(html).toContain("45 min");
    expect(html).toMatch(/miércoles, 14 de octubre/);
    expect(html).toMatch(/20:30/);
    expect(html).toMatch(/\$\s?15\.000/);
    expect(html).toContain("Confirmado");
    // ButtonLink: un solo <a> con clases de botón, sin <button> anidado.
    expect(html).toMatch(/<a class="k-btn k-btn-primary k-btn-lg k-btn-block" href="\/portal">/);
    expect(html).not.toMatch(/<a[^>]*>\s*<button/);
  });

  it("sin jerga interna: ni PENDING/UNPAID ni el contador de reintentos (en prod, sin el stub de desarrollo)", () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [over, v] of [
      [{ status: "PENDING", paymentStatus: "UNPAID" }, "pending"],
      [{ status: "PENDING", paymentStatus: "FAILED" }, "failed"],
      [{}, "ok"],
    ] as const) {
      const html = render(over, v);
      expect(html, v).not.toMatch(/PENDING|UNPAID|CONFIRMED|FAILED|\bPAID\b/);
      expect(html, v).not.toMatch(/Reintentos/);
      expect(html, v).not.toContain("Simular webhook");
    }
    vi.unstubAllEnvs();
  });

  it("en desarrollo, mientras no está pago, aparece el stub para simular el webhook", () => {
    expect(render({ status: "PENDING", paymentStatus: "UNPAID" }, "pending")).toContain("Simular webhook PAID");
    expect(render({}, "ok")).not.toContain("Simular webhook PAID");
  });

  it("pending: anuncia el estado (role=status) y no muestra CTA ni el aviso de timeout al arrancar", () => {
    const html = render({ status: "PENDING", paymentStatus: "UNPAID" }, "pending");
    expect(html).toContain('role="status"');
    expect(html).toContain(RESULT_COPY.pending.title);
    expect(html).toContain("Esperando el pago");
    expect(html).not.toContain('href="/portal"');
    expect(html).not.toContain(PENDING_TIMEOUT_NOTE);
  });

  it("failed: dice que el turno no quedó confirmado y ofrece volver a reservar como <a>", () => {
    const html = render({ status: "PENDING", paymentStatus: "FAILED" }, "failed");
    expect(html).toContain(RESULT_COPY.failed.title);
    expect(html).toContain("El turno no quedó confirmado");
    expect(html).toMatch(/<a class="k-btn[^"]*" href="\/c\/norte\/booking">Volver a reservar/);
  });

  it("sin monto: no hay fila de Monto", () => {
    expect(render({ amountCents: null }, "ok")).not.toContain("Monto");
  });

  it("copy sin promesas (§0.2): ni email de confirmación ni cancelación ni recordatorios", () => {
    const all = Object.values(RESULT_COPY)
      .flatMap((c) => [c.title, c.lead, c.state])
      .concat(PENDING_TIMEOUT_NOTE)
      .join(" ");
    expect(all).not.toMatch(/te mandamos|email|correo|cancel|recordatori|whatsapp/i);
  });
});
