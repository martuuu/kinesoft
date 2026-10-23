/**
 * [PEND-b] Render real (sin jsdom, como el resto de `tests/unit/render`) de lo que suma PEND-b (brief T6+T7 §26.9):
 *  - Plataforma → Sistema: la Card «Cobros en proceso trabados» (B4) y el grupo sí/no de las variables de T6/T7, con
 *    el DTO que arman los builders REALES (`buildStuckCharges`, `buildSystemStatus`).
 *  - Facturación del paciente: «Copago percibido» no cuenta una seña reintegrada después del cobro a mano.
 * Se mockean solo las server actions (red/DB).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: [] }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/payment-links", () => proxy());
vi.mock("@/lib/online-charges-read", () => proxy());
vi.mock("@/lib/platform-realtime-probe", () => ({ probeRealtimeFromServer: vi.fn() }));
vi.mock("@/components/plataforma/reauth-modal", () => ({
  usePlatformAction: () => <T,>(fn: () => Promise<T>) => fn(),
}));

import { SystemView } from "@/components/plataforma/system/system-view";
import { buildStuckCharges, buildSystemStatus, type StuckChargesInfo } from "@/lib/platform-system-logic";
import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import { billingSummary } from "@/components/planes/plan-booking-groups";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { capabilitiesFor } from "@/lib/capabilities";
import { formatARS, formatDateAR } from "@/lib/format";
import type { PatientBookingFull } from "@/lib/patients-types";

function system(stuck: StuckChargesInfo | undefined, envPresence: Record<string, boolean> | null = null) {
  const status = {
    ...buildSystemStatus(
      { stuckCharges: stuck ?? null, envPresence, mpConnect: null },
      { available: true, applied: 46, last: "20261025120000_saas_mp_subscriptions" },
      { up: true, ms: 3 },
      new Date("2026-10-22T15:00:00.000Z")
    ),
    emailFailures: { available: true as const, items: [] },
    stuckCharges: stuck,
  };
  return renderToStaticMarkup(<SystemView status={status} />);
}

const cardOf = (html: string) => {
  const i = html.indexOf('data-testid="system-stuck-charges"');
  return i < 0 ? "" : html.slice(i, html.indexOf('data-testid="system-email-failures"'));
};

describe("[PEND-b] Sistema · cobros en proceso trabados y variables de T6/T7", () => {
  it("[PEND-b] lista por consultorio el conteo y el vencimiento más viejo (hora AR); la fila del grupo avisa", () => {
    const stuck = buildStuckCharges([
      { tenantName: "Kine Norte", tenantSlug: "kine-norte", count: 3, oldestExpiredAt: new Date("2026-10-01T02:30:00Z"), total: 4, tenants: 2 },
      { tenantName: "Osteo Sur", tenantSlug: "osteo-sur", count: 1, oldestExpiredAt: new Date("2026-10-10T15:00:00Z"), total: 4, tenants: 2 },
    ]);
    const html = system(stuck);
    const card = cardOf(html);
    expect(card).toContain("Cobros en proceso trabados");
    expect(card).toContain("Kine Norte");
    expect(card).toContain("kine-norte");
    // 01/10 02:30 UTC = 30/09 23:30 AR: el vencimiento se lee en hora AR.
    expect(card).toContain(`3 cobros · venció el ${formatDateAR("2026-09-30T15:00:00Z", "short")}`);
    expect(card).toContain(`1 cobro · venció el ${formatDateAR("2026-10-10T15:00:00Z", "short")}`);
    expect(html).toContain("4 en 2 consultorios");
  });

  it("[PEND-b] sin trabados: «Ninguno»; sin el dato (DTO viejo) la Card no aparece; una fila sin forma no sale", () => {
    expect(cardOf(system(buildStuckCharges([])))).toContain("Ninguno");
    expect(system(undefined)).not.toContain("system-stuck-charges");
    const bad = buildStuckCharges([
      { tenantName: "X", tenantSlug: "Not A Slug!", count: 2, oldestExpiredAt: new Date(), total: 2, tenants: 1 },
      { tenantName: "Y", tenantSlug: "ok-slug", count: 0, oldestExpiredAt: new Date(), total: 0, tenants: 1 },
    ]);
    expect(bad).toEqual({ available: true, total: 0, tenants: 0, items: [] });
  });

  it("[PEND-b] grupo de variables: solo sí/no, nunca el valor", () => {
    const html = system(undefined, { WHATSAPP_APP_SECRET: true, MP_MIN_DEBIT_CENTS: false });
    const start = html.indexOf('data-testid="system-group-env-t6t7"');
    expect(start).toBeGreaterThan(-1);
    const g = html.slice(start);
    expect(g).toContain("WHATSAPP_APP_SECRET");
    expect(g).toContain("OK · sí");
    expect(g).toContain("MP_MIN_DEBIT_CENTS");
    expect(g).toContain("SAAS_MP_CHECKOUT_NOTIFY");
    expect(g).toMatch(/>no</);
  });
});

let seq = 0;
function booking(over: Partial<PatientBookingFull> = {}): PatientBookingFull {
  seq += 1;
  return {
    id: `bk_${seq}`,
    tenantId: "t1",
    patientId: "pat_1",
    serviceId: "svc_1",
    practitionerId: "pr_1",
    practitionerName: "Ana Pérez",
    status: "COMPLETED",
    paymentStatus: "PAID",
    copagoPaymentMethod: "CASH",
    copagoCollectedById: "u1",
    onlineDepositCents: 0,
    refundedDepositAfterCollectCents: 0,
    insurerPaidAt: null,
    durationMin: 45,
    programId: null,
    sessionId: null,
    serviceName: "Kinesiología",
    obraSocial: "Particular",
    copagoCents: 1_000_000,
    osAmountCents: 0,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    scheduledFor: new Date(Date.UTC(2026, 9, 1, 13) + seq * 3_600_000),
    title: null,
    notes: null,
    idempotencyKey: `idem_${seq}`,
    ...over,
  } as unknown as PatientBookingFull;
}

const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );

describe("[PEND-b] Facturación · seña reintegrada después del cobro a mano", () => {
  it("[PEND-b] «Copago percibido» = el resto cobrado ($10.000 / seña $3.000 reintegrada → $7.000)", () => {
    const refunded = booking({ refundedDepositAfterCollectCents: 300_000 });
    expect(billingSummary([refunded], { grouped: false }).copagoPaidCents).toBe(700_000);
    const html = wrap(
      <FacturacionView
        bookings={[refunded]}
        loading={false}
        patchBooking={() => {}}
        billingAccess={{ capabilities: [...capabilitiesFor("ASSISTANT")], practitionerId: null }}
      />
    );
    const summary = html.slice(0, html.indexOf("Copago percibido"));
    expect(summary).toContain(`${formatARS(700_000)}</div><div style="font-size:11.5px;color:var(--navy-500)">`);
    expect(summary).not.toContain(formatARS(1_000_000));
  });

  it("[PEND-b] controles: seña vigente + resto = copago; seña mayor que el copago = la seña; sin cobrar = la seña", () => {
    expect(billingSummary([booking({ onlineDepositCents: 300_000 })], { grouped: false }).copagoPaidCents).toBe(1_000_000);
    expect(billingSummary([booking({ onlineDepositCents: 1_200_000 })], { grouped: false }).copagoPaidCents).toBe(1_200_000);
    expect(
      billingSummary([booking({ paymentStatus: "UNPAID", onlineDepositCents: 300_000 })], { grouped: false }).copagoPaidCents
    ).toBe(300_000);
    // Un dato roto no es plata.
    expect(billingSummary([booking({ refundedDepositAfterCollectCents: -5 })], { grouped: false }).copagoPaidCents).toBe(1_000_000);
  });
});
