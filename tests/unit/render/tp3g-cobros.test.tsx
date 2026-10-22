import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TP-3g] /cobros (§25.10; Anexo C «3g /cobros: filtros ↔ URL; estado en texto; cards a 390; nav con `billing.collect`
 * (PRACTITIONER no)»). Se montan los componentes reales (`CobrosView`, `CobrosRow`) y la página server; se mockea solo
 * la red (actions), la sesión y el router de Next.
 */
const h = vi.hoisted(() => ({
  actor: { tenantId: "t1", userId: "u1", practitionerId: null as string | null, support: false },
  caps: new Set<string>(),
  listCalls: [] as unknown[],
  redirected: null as string | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
  redirect: (to: string) => {
    h.redirected = to;
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ getActor: async () => h.actor }));
vi.mock("@/lib/authz", () => ({ getCapabilities: async () => h.caps }));
vi.mock("@/lib/online-charges-read", () => ({
  listOnlineCharges: async (input: unknown) => {
    h.listCalls.push(input);
    return { ok: true, data: { rows: [], nextCursor: null, summary: { paidCents: 0, liveCount: 0, liveCents: 0 } } };
  },
}));
vi.mock("@/lib/bookings", () => ({
  listPractitioners: async () => [
    { id: "pr_1", user: { fullName: "Ana Paz" } },
    { id: "pr_2", user: { fullName: "Beto Ruiz" } },
  ],
}));
vi.mock("@/lib/payment-links", () => ({ cancelPaymentLink: async () => ({ ok: true, data: { status: "CANCELLED" } }) }));

import { CobrosClient, CobrosView, afterCancel, type CobrosViewProps } from "@/components/cobros/cobros-client";
import CobrosPage from "@/app/(app)/cobros/page";
import { cobrosPeriodOptions, parseCobrosFilters } from "@/lib/cobros-view";
import type { OnlineChargeView } from "@/lib/online-payments-types";

const NOW = new Date("2026-10-22T15:00:00.000Z");

function charge(p: Partial<OnlineChargeView> = {}): OnlineChargeView {
  return {
    id: "c1",
    origin: "LINK",
    kind: "FREE",
    status: "ACTIVE",
    statusLabel: "Pendiente de pago",
    amountCents: 1_500_000,
    concept: "Sesión de octubre",
    createdAt: "2026-10-20T13:30:00.000Z",
    expiresAt: "2026-10-27T13:30:00.000Z",
    practitionerName: "Ana Paz",
    accountKind: "PRACTITIONER",
    receipt: null,
    link: { url: "https://app.test/pagar/AAAAAAAAAAAAAAAAAAAAAA", canCancel: true, canResend: true },
    notices: [],
    ...p,
  };
}

const noop = () => {};
function render(p: Partial<CobrosViewProps> = {}) {
  return renderToStaticMarkup(
    <CobrosView
      filters={parseCobrosFilters({})}
      rows={[]}
      summary={{ paidCents: 0, liveCount: 0, liveCents: 0 }}
      hasMore={false}
      loadingMore={false}
      error={null}
      practitioners={[
        { id: "pr_1", name: "Ana Paz" },
        { id: "pr_2", name: "Beto Ruiz" },
      ]}
      periodOptions={cobrosPeriodOptions(NOW)}
      navigating={false}
      busy={false}
      onFilter={noop}
      onMore={noop}
      handlers={{ onReceipt: noop, onCopy: noop, onResend: noop, onCancel: noop }}
      {...p}
    />
  );
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  // La página exige MP prendido (TP-ZF3); `sandbox` no depende de VERCEL_ENV como `fake`.
  vi.stubEnv("MP_CONNECT_MODE", "sandbox");
  h.actor = { tenantId: "t1", userId: "u1", practitionerId: null, support: false };
  h.caps = new Set();
  h.listCalls = [];
  h.redirected = null;
});

describe("[TP-3g] estado vacío (TP-UI-D7)", () => {
  it("sin cobros y sin filtros: «Todavía no hay cobros online», sin tabla", () => {
    const html = render();
    expect(html).toContain("Todavía no hay cobros online");
    expect(html).toContain('data-empty="none"');
    expect(html).not.toContain("<table");
  });

  it("con filtros y sin resultados: lo dice y ofrece volver a todos", () => {
    const html = render({ filters: parseCobrosFilters({ estado: "expired" }) });
    expect(html).toContain("No hay cobros con estos filtros");
    expect(html).toContain('href="/cobros"');
  });
});

describe("[TP-3g] filtros ↔ URL (selects con el valor de la URL)", () => {
  it("cada select muestra lo que dice la URL", () => {
    const html = render({ filters: parseCobrosFilters({ tipo: "link", estado: "live", periodo: "2026-09", profesional: "pr_2" }) });
    expect(html).toMatch(/<option value="LINK" selected="">Link de pago<\/option>/);
    expect(html).toMatch(/<option value="live" selected="">Pendientes y en proceso<\/option>/);
    expect(html).toMatch(/<option value="2026-09" selected="">Septiembre 2026<\/option>/);
    expect(html).toMatch(/<option value="pr_2" selected="">Beto Ruiz<\/option>/);
  });

  it("sin lista de profesionales (quien ve solo lo suyo) no hay filtro de profesional", () => {
    const html = render({ practitioners: null });
    expect(html).not.toContain("Todos los profesionales");
  });
});

describe("[TP-3g] estado en texto, acciones y comprobante", () => {
  const paid = charge({
    id: "c2",
    status: "PAID",
    statusLabel: "Pagado",
    link: null,
    receipt: {
      operationId: "123",
      approvedAt: "2026-10-21T12:00:00.000Z",
      approvedAtLabel: "21/10/2026, 09:00",
      paidAmountCents: 1_500_000,
      methodLabel: "Tarjeta de débito Visa",
      statusLabel: "Aprobado",
      refundedAt: null,
      paymentMethodId: "debvisa",
      paymentTypeId: "debit_card",
      installments: 1,
      mpStatus: "approved",
      account: { kind: "PRACTITIONER", practitionerName: "Ana Paz" },
    },
  });

  it("cada fila dice su estado en texto y el resumen muestra cobrado y por cobrar", () => {
    const html = render({
      rows: [charge(), paid, charge({ id: "c3", status: "EXPIRED", statusLabel: "Vencido", link: null })],
      summary: { paidCents: 1_500_000, liveCount: 1, liveCents: 1_500_000 },
    });
    for (const s of ["Pendiente de pago", "Pagado", "Vencido"]) expect(html).toContain(`>${s}<`);
    expect(html).toContain("1 pendiente");
    expect(html).toMatch(/data-summary="paid">\$\s?15\.000/);
  });

  it("link vivo: Copiar, Reenviar y Anular; pagado: Comprobante; sin `link`: ninguna acción del link", () => {
    const live = render({ rows: [charge()] });
    for (const a of ["Copiar", "Reenviar", "Anular"]) expect(live).toContain(`>${a}<`);
    expect(live).not.toContain(">Comprobante<");
    const done = render({ rows: [paid] });
    expect(done).toContain(">Comprobante<");
    for (const a of ["Copiar", "Reenviar", "Anular"]) expect(done).not.toContain(`>${a}<`);
  });

  it("el token del link no aparece en el HTML (la URL se copia por handler, no se pinta)", () => {
    expect(render({ rows: [charge()] })).not.toContain("AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("con más páginas: «Ver más»", () => {
    expect(render({ rows: [charge()], hasMore: true })).toContain(">Ver más<");
  });
});

describe("[TP-3g] cards a 390", () => {
  it("cada dato lleva su rótulo para la card y el CSS pasa la tabla a cards bajo 768 px", () => {
    const html = render({ rows: [charge()] });
    for (const l of ["Concepto", "Profesional", "Monto", "Estado", "Fecha"]) expect(html).toContain(`data-label="${l}"`);
    const css = readFileSync(join(process.cwd(), "components/cobros/cobros.module.css"), "utf8");
    const mobile = css.slice(css.indexOf("@media (max-width: 767.98px)"));
    expect(mobile.length).toBeGreaterThan(30);
    expect(mobile).toMatch(/\.table tr\s*\{[^}]*display:\s*grid/);
    expect(mobile).toMatch(/\.table thead\s*\{[^}]*position:\s*absolute/);
    expect(mobile).toMatch(/content:\s*attr\(data-label\)/);
  });
});

/** Busca el elemento `CobrosClient` en el árbol que devuelve la página (sin montarlo: usa providers de cliente). */
function findClient(node: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (!isValidElement(node)) return null;
  if (node.type === CobrosClient) return node as ReactElement<Record<string, unknown>>;
  const children = (node.props as { children?: ReactNode }).children;
  for (const c of Array.isArray(children) ? children : [children]) {
    const f = findClient(c);
    if (f) return f;
  }
  return null;
}

describe("[TP-3g] la página: gate como la lectura", () => {
  it("con `billing.collect`: lee con los filtros de la URL y ofrece el filtro de profesional", async () => {
    h.caps = new Set(["billing.collect"]);
    const el = findClient(await CobrosPage({ searchParams: { estado: "paid", profesional: "pr_2" } }));
    expect(h.listCalls).toEqual([{ status: "PAID", period: "30d", practitionerId: "pr_2" }]);
    expect(el?.props.practitioners).toEqual([
      { id: "pr_1", name: "Ana Paz" },
      { id: "pr_2", name: "Beto Ruiz" },
    ]);
  });

  it("con `billing.collectOwn` y profesional propio: entra, sin filtro de profesional (un `?profesional=` ajeno se ignora)", async () => {
    h.caps = new Set(["billing.collectOwn"]);
    h.actor = { ...h.actor, practitionerId: "pr_1" };
    const el = findClient(await CobrosPage({ searchParams: { profesional: "pr_2" } }));
    expect(h.listCalls).toEqual([{ period: "30d" }]);
    expect(el?.props.practitioners).toBeNull();
    expect((el?.props.filters as { practitionerId: string | null }).practitionerId).toBeNull();
  });

  it("sin `billing.collect` ni `collectOwn` con profesional (soporte, Profesional sin profesional) → /dashboard, sin leer", async () => {
    h.caps = new Set(["billing.collectOwn"]);
    await expect(CobrosPage({ searchParams: {} })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirected).toBe("/dashboard");
    h.caps = new Set(["agenda.viewAll"]);
    await expect(CobrosPage({})).rejects.toThrow("NEXT_REDIRECT");
    expect(h.listCalls).toEqual([]);
  });
});

describe("[TP-ZF3] /cobros con MP_CONNECT_MODE=off", () => {
  it("redirige a /dashboard sin leer, aun con `billing.collect`", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "off");
    h.caps = new Set(["billing.collect"]);
    await expect(CobrosPage({ searchParams: {} })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.redirected).toBe("/dashboard");
    expect(h.listCalls).toEqual([]);
  });

  it("sin la variable (default `off`) también", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "");
    h.caps = new Set(["billing.collect"]);
    await expect(CobrosPage({})).rejects.toThrow("NEXT_REDIRECT");
    expect(h.listCalls).toEqual([]);
  });
});

describe("[TP-ZF3] anular parchea la fila en el lugar y a11y de las acciones", () => {
  it("afterCancel: la fila queda «Anulado» sin link, el resto igual, y sale del «Por cobrar» si estaba viva", () => {
    const rows = [charge({ id: "a" }), charge({ id: "b", amountCents: 600_000 }), charge({ id: "c", status: "PAID", statusLabel: "Pagado", link: null })];
    const r = afterCancel(rows, { paidCents: 1_500_000, liveCount: 2, liveCents: 2_100_000 }, "b");
    expect(r.rows.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(r.rows[1]).toMatchObject({ status: "CANCELLED", statusLabel: "Anulado", link: null });
    expect(r.rows[0]).toBe(rows[0]);
    expect(r.summary).toEqual({ paidCents: 1_500_000, liveCount: 1, liveCents: 1_500_000 });
    // Una fila que no estaba viva no toca el resumen; un id que no está no cambia nada.
    expect(afterCancel(rows, { paidCents: 0, liveCount: 2, liveCents: 2_100_000 }, "c").summary.liveCount).toBe(2);
    expect(afterCancel(rows, { paidCents: 0, liveCount: 0, liveCents: 0 }, "zz").rows).toEqual(rows);
  });

  it("la fuente ya no relee solo la primera página después de anular", () => {
    const src = readFileSync(join(process.cwd(), "components/cobros/cobros-client.tsx"), "utf8");
    expect(src).not.toContain("reloadFirstPage");
    expect(src).toMatch(/afterCancel\(rows, summary, id\)/);
  });

  it("cada acción de la fila dice de qué cobro es (aria-label con el concepto)", () => {
    const html = render({ rows: [charge()] });
    for (const a of ["Copiar", "Reenviar", "Anular"]) expect(html).toContain(`aria-label="${a} · Sesión de octubre"`);
  });
});
