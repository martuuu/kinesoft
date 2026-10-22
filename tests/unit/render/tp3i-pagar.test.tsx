import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicPaymentLink } from "@/lib/payment-links-types";
import { formatARS } from "@/lib/format";

/**
 * [TP-3i] Página pública `/pagar/[token]` (plan §25.7 «Página pública», §25.10, C-TP9, TP-D23). Render sin jsdom de la
 * página REAL (`app/(booking)/pagar/[token]/page.tsx`) y de `PayLinkView`/`PayLinkPoller`.
 *
 * Se mockea solo la frontera de datos (`getPublicPaymentLink`: base + rate limit, lo cubre `tp2l-payment-links` y
 * `tests/integration/tp3i-pagar-page.test.ts` con la función real) y el router de Next (el poller usa
 * `router.refresh()`; fuera del App Router `useRouter` tira). Lo que se afirma es el HTML que ve el paciente.
 */
const state = vi.hoisted(() => ({
  link: null as PublicPaymentLink | null,
  calls: [] as string[],
  refresh: 0,
}));

vi.mock("@/lib/public-payment-link", () => ({
  getPublicPaymentLink: async (token: string) => {
    state.calls.push(token);
    return state.link;
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => void state.refresh++ }),
}));

import PagarPage, * as pageModule from "@/app/(booking)/pagar/[token]/page";
import { PAY_LINK_COPY, payLinkDisplay } from "@/components/payments/pay-link-view";
import { PAY_LINK_POLL, nextPollStep } from "@/components/payments/pay-link-poller";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const CHECKOUT = "http://localhost:3000/api/mp/fake/checkout/pref-123";

function link(o: Partial<PublicPaymentLink> = {}): PublicPaymentLink {
  return {
    status: "payable",
    clinicName: "Consultorio Norte",
    practitionerName: "Lucía Kine",
    amountCents: 20_000_00,
    concept: "Turno del jue 23/10 a las 10:00",
    // 23:30 AR del 29-oct = 02:30 UTC del 30-oct: la fecha visible tiene que ser la de Argentina.
    expiresAt: "2026-10-30T02:30:00.000Z",
    checkoutUrl: o.status && o.status !== "payable" ? null : CHECKOUT,
    receipt: null,
    ...o,
  };
}

const RECEIPT = { operationId: "987654321", approvedAtLabel: "22/10/2026, 23:30", methodLabel: "Tarjeta de crédito Visa" };

async function render(l: PublicPaymentLink | null, r?: string | string[]) {
  state.link = l;
  const el = await PagarPage({ params: { token: TOKEN }, searchParams: r === undefined ? {} : { r } });
  return renderToStaticMarkup(el);
}

const titleOf = (html: string) => html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? "";
const anchorsTo = (html: string, href: string) => html.split(`href="${href}"`).length - 1;

beforeEach(() => {
  state.link = null;
  state.calls = [];
  state.refresh = 0;
});

describe("[TP-3i] /pagar/[token]", () => {
  it("[TP-3i] 8 estados: para pagar / procesando / pagado con comprobante / vencido / anulado / reintegrado / inexistente / no disponible", async () => {
    const cases: [PublicPaymentLink | null, string][] = [
      [link(), PAY_LINK_COPY.payable.title],
      [link({ status: "processing" }), PAY_LINK_COPY.processing.title],
      [link({ status: "paid", receipt: RECEIPT }), PAY_LINK_COPY.paid.title],
      [link({ status: "expired" }), PAY_LINK_COPY.expired.title],
      [link({ status: "cancelled" }), PAY_LINK_COPY.cancelled.title],
      [link({ status: "refunded", receipt: RECEIPT }), PAY_LINK_COPY.refunded.title],
      [null, PAY_LINK_COPY.missing.title],
      [link({ status: "unavailable" }), PAY_LINK_COPY.unavailable.title],
    ];
    const titles = new Set<string>();
    for (const [l, title] of cases) {
      const html = await render(l);
      expect(titleOf(html), l?.status ?? "missing").toBe(title);
      // Una sola h1 por página (el nombre del consultorio es un <p> del marco).
      expect(html.match(/<h1/g)?.length, l?.status ?? "missing").toBe(1);
      // Ir a Mercado Pago SOLO cuando se puede pagar.
      expect(anchorsTo(html, CHECKOUT), l?.status ?? "missing").toBe(l?.status === "payable" ? 1 : 0);
      titles.add(titleOf(html));
    }
    expect(titles.size).toBe(8);
    // Copy literal de la E2E y del QA 12.
    expect(PAY_LINK_COPY.paid.title).toBe("¡Pago recibido!");
    expect(PAY_LINK_COPY.cancelled.title).toContain("ya no está disponible");
    // La página consulta con el token de la URL (y una sola vez: el rate limit es 60/min/IP).
    expect(state.calls.every((t) => t === TOKEN)).toBe(true);
  });

  it("[TP-3i] para pagar: ir a Mercado Pago es un <a> al checkoutUrl (navegación, sin JS) con monto, concepto, a nombre de y vencimiento AR", async () => {
    const html = await render(link());
    const a = html.match(new RegExp(`<a[^>]*href="${CHECKOUT}"[^>]*>`))?.[0] ?? "";
    expect(a).not.toBe("");
    // Misma pestaña (las back_urls vuelven a esta página) y sin Referer (el token viaja en la URL).
    expect(a).not.toContain("target=");
    expect(a).toContain('rel="noreferrer"');
    expect(html).toContain(PAY_LINK_COPY.payCta);
    expect(html).toContain(formatARS(20_000_00));
    expect(html).toContain("Turno del jue 23/10 a las 10:00");
    expect(html).toContain("Lucía Kine");
    expect(html).toContain("29/10/2026, 23:30");
    expect(html).toContain("Consultorio Norte");
    // Nada de <form>/<button> que dispare un POST: la página no escribe.
    expect(html).not.toMatch(/<form|<button/);
  });

  it("[TP-3i] cuenta del consultorio: sin «a nombre de» (no hay persona)", async () => {
    const html = await render(link({ practitionerName: null }));
    expect(html).not.toContain(PAY_LINK_COPY.payee);
  });

  it("[TP-3i] pagado y reintegrado muestran el comprobante (N° de operación, fecha AR, medio)", async () => {
    for (const status of ["paid", "refunded"] as const) {
      const html = await render(link({ status, receipt: RECEIPT }));
      for (const v of [RECEIPT.operationId, RECEIPT.approvedAtLabel, RECEIPT.methodLabel]) expect(html, status).toContain(v);
      expect(html, status).toContain("Comprobante");
    }
  });

  it("[TP-3i] inexistente: sin datos de nadie (ni consultorio) y sin pistas del token", async () => {
    const html = await render(null);
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain("Consultorio Norte");
  });

  it("[TP-3i] noindex + referrer same-origin; force-dynamic sin caché", () => {
    expect(pageModule.dynamic).toBe("force-dynamic");
    expect(pageModule.revalidate).toBe(0);
    expect(pageModule.fetchCache).toBe("force-no-store");
    expect(pageModule.metadata.robots).toMatchObject({ index: false, follow: false });
    expect(pageModule.metadata.referrer).toBe("same-origin");
  });

  it("[TP-3i] el GET no escribe: la página solo importa la lectura pública (nada de actions de escritura)", () => {
    const src = readFileSync(resolve(process.cwd(), "app/(booking)/pagar/[token]/page.tsx"), "utf8");
    const view = readFileSync(resolve(process.cwd(), "components/payments/pay-link-view.tsx"), "utf8");
    const poller = readFileSync(resolve(process.cwd(), "components/payments/pay-link-poller.tsx"), "utf8");
    const imports = (s: string) => [...s.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of [...imports(src), ...imports(view), ...imports(poller)]) {
      expect(spec).not.toMatch(/payment-links($|-internal)|online-charge|prisma|db$|bookings|mp-connect|cron/);
    }
    expect(src).toContain("getPublicPaymentLink");
  });

  it("[TP-3i] vuelta de Mercado Pago: ?r=ok|pending con el link aún «para pagar» → procesando + poller; ?r=failed → aviso + botón; sin ?r= sin poller", async () => {
    for (const r of ["ok", "pending"]) {
      const html = await render(link(), r);
      expect(titleOf(html), r).toBe(PAY_LINK_COPY.processing.title);
      // Mientras se espera el webhook no se ofrece pagar de nuevo (pagaría dos veces).
      expect(anchorsTo(html, CHECKOUT), r).toBe(0);
      expect(html, r).toContain("data-pay-poller");
    }
    const failed = await render(link(), "failed");
    expect(titleOf(failed)).toBe(PAY_LINK_COPY.payable.title);
    expect(failed).toContain(PAY_LINK_COPY.returnFailed);
    expect(anchorsTo(failed, CHECKOUT)).toBe(1);
    expect(failed).not.toContain("data-pay-poller");

    expect(await render(link())).not.toContain("data-pay-poller");
    // Procesando sin ?r= (abrió el link de nuevo): no hay poller, se le dice que vuelva más tarde.
    const proc = await render(link({ status: "processing" }));
    expect(proc).not.toContain("data-pay-poller");
    expect(proc).toContain(PAY_LINK_COPY.processing.leadLater);
    // Estado final con ?r=ok: sin poller.
    expect(await render(link({ status: "paid", receipt: RECEIPT }), "ok")).not.toContain("data-pay-poller");
    // ?r= basura o repetido: se ignora.
    expect(await render(link(), "<script>")).not.toContain("data-pay-poller");
    expect(await render(link(), ["ok", "ok"])).not.toContain("data-pay-poller");
  });

  it("[TP-3i] región en vivo: el cambio procesando → pagado se anuncia (role=status)", async () => {
    const html = await render(link(), "ok");
    expect(html).toMatch(/role="status"[^>]*aria-live="polite"/);
  });

  it("[TP-3i] payLinkDisplay: el estado del server manda; ?r= solo cambia «para pagar»", () => {
    expect(payLinkDisplay(null, "ok")).toEqual({ state: "missing", polling: false, returnFailed: false });
    expect(payLinkDisplay("payable", null)).toEqual({ state: "payable", polling: false, returnFailed: false });
    expect(payLinkDisplay("payable", "ok")).toEqual({ state: "processing", polling: true, returnFailed: false });
    expect(payLinkDisplay("payable", "failed")).toEqual({ state: "payable", polling: false, returnFailed: true });
    expect(payLinkDisplay("processing", "pending")).toEqual({ state: "processing", polling: true, returnFailed: false });
    expect(payLinkDisplay("processing", "failed")).toEqual({ state: "processing", polling: true, returnFailed: false });
    for (const s of ["paid", "expired", "cancelled", "refunded", "unavailable"] as const)
      expect(payLinkDisplay(s, "ok"), s).toEqual({ state: s, polling: false, returnFailed: false });
  });

  it("[TP-3i] poller: 3 s × 60 y frena; inactivo no consulta", () => {
    expect(PAY_LINK_POLL).toEqual({ intervalMs: 3000, maxAttempts: 60 });
    expect(nextPollStep(true, 0)).toBe("wait");
    expect(nextPollStep(true, 59)).toBe("wait");
    expect(nextPollStep(true, 60)).toBe("timedOut");
    expect(nextPollStep(false, 0)).toBe("idle");
    expect(nextPollStep(false, 60)).toBe("idle");
  });
});
