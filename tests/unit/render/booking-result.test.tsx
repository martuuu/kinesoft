import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * [VX2-d2] Resultado del turnero después de Mercado Pago (`/booking/[id]/{ok,pending,failed}`). Se monta el componente
 * real con `renderToStaticMarkup` (sin jsdom: los efectos del poller no corren). No se mockea nada: desde TP-3h el
 * componente ya no importa ninguna server action (se fue el botón dev que llamaba a `devMarkBookingPaid`).
 */

import {
  BookingResult,
  effectiveVariantFor,
  PENDING_TIMEOUT_NOTE,
  RESULT_COPY,
  RESULT_MONEY_COPY,
  type BookingResultVariant,
} from "@/components/booking/booking-result";
import type { PublicBookingStatus } from "@/lib/public-booking-types";
import { RECEIPT_COPY, TURNERO_PAYMENT_COPY } from "@/lib/online-payments-copy";

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

const render = (over: Partial<PublicBookingStatus>, variant: BookingResultVariant) =>
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

  it("[TP-3h] ni en desarrollo aparece el stub del webhook (lo reemplaza el MP falso, TP-D21)", () => {
    expect(render({ status: "PENDING", paymentStatus: "UNPAID" }, "pending")).not.toContain("Simular webhook");
    expect(render({ status: "PENDING", paymentStatus: "FAILED" }, "failed")).not.toContain("Simular webhook");
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

// TP-0 · turnero sin cobro: el turno nace CONFIRMED/UNPAID sin Payment y el status lo dice con `onlinePayment: false`.
// Antes caía en «ok» por la URL (o en «failed» si alguien abría /failed) y la fila decía «Monto $ 0» (H-TP2).
describe("[TP-0] effectiveVariantFor → reserved", () => {
  const reserved = { status: "CONFIRMED", paymentStatus: "UNPAID", onlinePayment: false } as const;

  it("CONFIRMED, sin pagar y sin cobro online → reserved, venga de la URL que venga", () => {
    for (const v of ["ok", "pending", "failed"] as const) {
      expect(effectiveVariantFor({ ...base, ...reserved }, v), v).toBe("reserved");
    }
  });

  it("si igual quedó PAID manda «ok»; con cobro online o sin el campo (fixtures viejos) nada cambia", () => {
    expect(effectiveVariantFor({ ...base, ...reserved, paymentStatus: "PAID" }, "ok")).toBe("ok");
    expect(effectiveVariantFor({ ...base, ...reserved, onlinePayment: true }, "failed")).toBe("failed");
    expect(effectiveVariantFor({ ...base, status: "CONFIRMED", paymentStatus: "UNPAID" }, "failed")).toBe("failed");
    expect(effectiveVariantFor({ ...base, status: "CONFIRMED", paymentStatus: "UNPAID" }, "ok")).toBe("ok");
    // Un PENDING sin cobro online (no debería existir) no se presenta como reservado.
    expect(effectiveVariantFor({ ...base, ...reserved, status: "PENDING" }, "ok")).toBe("pending");
  });

  it("render: «¡Turno reservado!», «Te esperamos…», estado «Reservado» y «A pagar en el consultorio»; nada de pago", () => {
    vi.stubEnv("NODE_ENV", "production");
    const html = render(reserved, "ok");
    vi.unstubAllEnvs();
    expect(RESULT_COPY.reserved).toEqual({
      title: "¡Turno reservado!",
      lead: "Te esperamos. El pago lo hacés en el consultorio.",
      state: "Reservado",
    });
    expect(html).toContain("¡Turno reservado!");
    expect(html).toContain("Te esperamos. El pago lo hacés en el consultorio.");
    expect(html).toContain("Reservado");
    expect(html).toMatch(/A pagar en el consultorio<\/dt><dd[^>]*>\$\s?15\.000/);
    expect(html).not.toContain(RESULT_COPY.pending.title);
    expect(html).not.toMatch(/Mercado Pago|Esperando el pago|Confirmado|>Monto</);
    expect(html).toContain('href="/portal"');
  });

  it("monto 0 o null: sin fila de monto (antes «$ 0»); en desarrollo, sin el stub del webhook", () => {
    for (const amountCents of [0, null]) {
      const html = render({ ...reserved, amountCents }, "ok");
      expect(html).not.toContain("A pagar en el consultorio");
      expect(html).not.toMatch(/\$\s?0\b/);
      expect(html).not.toContain("Simular webhook PAID");
    }
  });
});

// ─── TP-3h · resultados con el cobro online de T5 (C-TP8 `onlineCharge`, §25.10) ─────────────────────────────────
describe("[TP-3h] resultado con cobro online", () => {
  it("los literales copiados son los de online-payments-copy (paridad)", () => {
    const src: Record<string, string> = { ...RECEIPT_COPY, ...TURNERO_PAYMENT_COPY } as never;
    for (const [k, v] of Object.entries(RESULT_MONEY_COPY)) expect(v, k).toBe(src[k]);
  });

  type OC = NonNullable<PublicBookingStatus["onlineCharge"]>;
  const receipt = { operationId: "123456789", approvedAtLabel: "14/10/2026 20:31", methodLabel: "Visa · Tarjeta de crédito" };
  const oc = (over: Partial<OC>): OC => ({
    kind: "FULL", status: "ACTIVE", amountCents: 2_000_000, remainingCents: 2_000_000, receipt: null, ...over,
  });
  const st = (over: Partial<PublicBookingStatus>, charge: Partial<OC>): PublicBookingStatus => ({
    ...base, onlinePayment: true, amountCents: charge.amountCents ?? 2_000_000, onlineCharge: oc(charge), ...over,
  });
  const html = (s: PublicBookingStatus, v: BookingResultVariant) =>
    renderToStaticMarkup(<BookingResult initial={s} variant={v} />);

  it("variantes: seña pagada, pagado, procesando, fallido OPTIONAL/REQUIRED, reintegrado", () => {
    const deposit = st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, { kind: "DEPOSIT", status: "PAID", amountCents: 600_000, remainingCents: 1_400_000, receipt });
    expect(effectiveVariantFor(deposit, "pending")).toBe("deposit");
    const paid = st({ status: "CONFIRMED", paymentStatus: "PAID" }, { status: "PAID", remainingCents: 0, receipt });
    expect(effectiveVariantFor(paid, "pending")).toBe("paid");
    // OPTIONAL «Pagar ahora»: el turno ya está CONFIRMED; vuelve de MP antes que el webhook → procesando.
    const optActive = st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, {});
    expect(effectiveVariantFor(optActive, "ok")).toBe("pending");
    expect(effectiveVariantFor(optActive, "pending")).toBe("pending");
    expect(effectiveVariantFor({ ...optActive, onlineCharge: oc({ status: "AUTHORIZED" }) }, "ok")).toBe("pending");
    // Rechazado: OPTIONAL → el turno quedó reservado; REQUIRED (hold PENDING) → no quedó confirmado.
    expect(effectiveVariantFor(optActive, "failed")).toBe("failed-optional");
    expect(effectiveVariantFor({ ...optActive, onlineCharge: oc({ status: "EXPIRED" }) }, "failed")).toBe("failed-optional");
    const reqActive = st({ status: "PENDING", paymentStatus: "UNPAID" }, {});
    expect(effectiveVariantFor(reqActive, "failed")).toBe("failed");
    expect(effectiveVariantFor(reqActive, "ok")).toBe("pending");
    expect(effectiveVariantFor({ ...reqActive, status: "CANCELLED", onlineCharge: oc({ status: "EXPIRED" }) }, "ok")).toBe("failed");
    // Cobro anulado/vencido con el turno reservado (MP caído en OPTIONAL, o vencido a las 48 h) → reservado.
    expect(effectiveVariantFor({ ...optActive, onlineCharge: oc({ status: "CANCELLED" }) }, "ok")).toBe("reserved");
    expect(effectiveVariantFor(st({}, { status: "REFUNDED", remainingCents: 0, receipt }), "ok")).toBe("refunded");
  });

  it("seña pagada: «Seña pagada», la seña, el resto en el consultorio y el comprobante; CTA a /portal", () => {
    const h = html(
      st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, { kind: "DEPOSIT", status: "PAID", amountCents: 600_000, remainingCents: 1_400_000, receipt }),
      "ok"
    );
    expect(h).toContain(RESULT_COPY.deposit.title);
    expect(h).toMatch(/Seña pagada<\/dt><dd[^>]*>\$\s?6\.000/);
    expect(h).toMatch(/Resto en el consultorio<\/dt><dd[^>]*>\$\s?14\.000/);
    expect(h).toContain("123456789");
    expect(h).toContain("14/10/2026 20:31");
    expect(h).toContain("Visa · Tarjeta de crédito");
    expect(h).toContain('href="/portal"');
    expect(h).not.toMatch(/>Monto</);
  });

  it("pagado: estado «Pagado» y comprobante; sin «Resto»", () => {
    const h = html(st({ status: "CONFIRMED", paymentStatus: "PAID" }, { status: "PAID", remainingCents: 0, receipt }), "ok");
    expect(h).toContain(RESULT_COPY.paid.title);
    expect(h).toContain(">Pagado<");
    expect(h).toMatch(/\$\s?20\.000/);
    expect(h).toContain("N° de operación");
    expect(h).not.toContain("Resto en el consultorio");
  });

  it("procesando: anuncia el estado, sin CTA ni comprobante", () => {
    const h = html(st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, {}), "ok");
    expect(h).toContain(RESULT_COPY.pending.title);
    expect(h).toContain('role="status"');
    expect(h).not.toContain('href="/portal"');
    expect(h).not.toContain("N° de operación");
  });

  it("fallido OPTIONAL: «tu turno quedó reservado», lo que falta en el consultorio y CTA a /portal", () => {
    const h = html(st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, { kind: "DEPOSIT", amountCents: 600_000, remainingCents: 2_000_000 }), "failed");
    expect(h).toContain(RESULT_COPY["failed-optional"].title);
    expect(h).toContain("tu turno quedó reservado");
    expect(h).toMatch(/A pagar en el consultorio<\/dt><dd[^>]*>\$\s?20\.000/);
    expect(h).toContain('href="/portal"');
    expect(h).not.toContain("Volver a reservar");
  });

  it("fallido REQUIRED: no quedó confirmado y ofrece volver a reservar", () => {
    const h = html(st({ status: "PENDING", paymentStatus: "UNPAID" }, {}), "failed");
    expect(h).toContain(RESULT_COPY.failed.title);
    expect(h).toContain("El turno no quedó confirmado");
    expect(h).toContain('href="/c/norte/booking"');
  });

  it("reintegrado: «Reintegrado», sin «reembolso»", () => {
    const h = html(st({}, { status: "REFUNDED", remainingCents: 0, receipt }), "ok");
    expect(h).toContain(RESULT_COPY.refunded.title);
    expect(h).toContain(">Reintegrado<");
    expect(h).not.toMatch(/reembols/i);
  });

  it("nunca «$ 0» pendiente: sin cobro y sin monto no hay fila", () => {
    const h = html(st({ status: "CONFIRMED", paymentStatus: "UNPAID" }, { kind: "DEPOSIT", status: "PAID", amountCents: 600_000, remainingCents: 0, receipt }), "ok");
    expect(h).not.toContain("Resto en el consultorio");
    expect(h).not.toMatch(/\$\s?0\b/);
  });

  it("ningún componente importa `devMarkBookingPaid`", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
      });
    const offenders = walk("components").filter((f) => /import[^;]*\bdevMarkBookingPaid\b|\bdevMarkBookingPaid\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
