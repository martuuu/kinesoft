// S22f (ES3 P3.1) · Turnos y Facturación del perfil agrupados por plan.
//
// Contrato (PLANES §11 S22f + plan §16.2):
//  - agrupada por plan con el saldo DEL SERVER (P7), cancelados con cobro
//    visibles, sin "Eliminar" en turnos de plan;
//  - el saldo de un plan cancelado usa el pactado nuevo (lo consume, no lo
//    reimplementa): lo que manda el server se muestra tal cual;
//  - DisciplineChip, nunca el título sin `clinical.read`/full (PD-11/PD-13);
//  - la Secretaria (admin) ve estado de cobro sin datos clínicos;
//  - General / sin planes → la vista de siempre.
//
// Se renderizan las vistas reales con `renderToStaticMarkup`; se mockean solo
// las server actions de turnos (red) y el router.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/bookings", () => ({
  setBookingStatus: vi.fn(),
  deleteBooking: vi.fn(),
  setBookingCopagoPaid: vi.fn(),
  setBookingInsurerPaid: vi.fn(),
}));

import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { planBalanceItems, planBalanceNotes, balanceOutcome } from "@/components/planes/plan-balance";
import {
  billingSummary,
  canDeleteFromProfile,
  groupBookingsByPlan,
  isBillingVisible,
  planGroupMetas,
  shouldGroupByPlan,
} from "@/components/planes/plan-booking-groups";
import { formatARS } from "@/lib/format";
import type { PatientBookingFull } from "@/lib/patients-types";
import type { PatientPlanBalances, PlanBalanceDTO, PlanDTO } from "@/lib/plans-read-types";

const SECRET_TITLE = "Lumbalgia crónica post-quirúrgica";

let seq = 0;
function booking(over: Omit<Partial<PatientBookingFull>, "scheduledFor"> & { scheduledFor: string }): PatientBookingFull {
  seq += 1;
  return {
    id: `bk_${seq}`,
    tenantId: "t1",
    patientId: "pat_1",
    serviceId: "svc_1",
    practitionerId: "pr_1",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    insurerPaidAt: null,
    durationMin: 45,
    programId: null,
    sessionId: null,
    serviceName: "Kinesiología",
    obraSocial: "Particular",
    copagoCents: 1_000_000,
    osAmountCents: 0,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    title: null,
    notes: null,
    ...over,
    scheduledFor: new Date(over.scheduledFor),
  } as unknown as PatientBookingFull;
}

function balance(over: Partial<PlanBalanceDTO> = {}): PlanBalanceDTO {
  return {
    agreedCents: 10_000_000,
    accruedCents: 3_000_000,
    collectedCents: 2_000_000,
    inProcessCents: 0,
    pendingCents: 1_000_000,
    creditCents: 0,
    insurerPaidBookings: 0,
    ...over,
  };
}

function plan(id: string, over: Partial<PlanDTO> = {}): PlanDTO {
  return {
    id,
    patientId: "pat_1",
    level: "full",
    discipline: "KINESIOLOGY",
    status: "ACTIVE",
    archivedAt: null,
    linked: true,
    title: SECRET_TITLE,
    practitionerId: "pr_1",
    practitionerName: "Ana",
    serviceId: "svc_1",
    serviceName: "Kinesiología",
    locationId: null,
    totalLive: 10,
    done: 3,
    sinTurno: 0,
    nextSession: null,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    createdAt: new Date("2026-09-01T12:00:00Z"),
    notes: null,
    pricingMode: "PER_SESSION",
    balance: balance(),
    sessions: [
      { id: "s1", index: 0, ordinal: 1, state: "done", sinTurno: false, scheduledFor: new Date("2026-09-10T13:00:00Z"), completedAt: new Date("2026-09-10T14:00:00Z"), archivedAt: null, booking: null, title: null, notes: null, priceCents: null, exerciseCount: null },
      { id: "s2", index: 1, ordinal: 2, state: "booked", sinTurno: false, scheduledFor: new Date("2026-10-20T13:00:00Z"), completedAt: null, archivedAt: null, booking: null, title: null, notes: null, priceCents: null, exerciseCount: null },
    ],
    ...over,
  } as PlanDTO;
}

function balances(rows: { programId: string; status?: PlanDTO["status"]; b?: PlanBalanceDTO; title?: string | null }[]): PatientPlanBalances {
  const plans = rows.map((r) => ({
    programId: r.programId,
    discipline: "KINESIOLOGY" as const,
    status: r.status ?? ("ACTIVE" as const),
    title: r.title === undefined ? SECRET_TITLE : r.title,
    balance: r.b ?? balance(),
  }));
  const totals = plans.reduce(
    (t, p) => ({
      pendingCents: t.pendingCents + p.balance.pendingCents,
      creditCents: t.creditCents + p.balance.creditCents,
      collectedCents: t.collectedCents + p.balance.collectedCents,
      inProcessCents: t.inProcessCents + p.balance.inProcessCents,
    }),
    { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 }
  );
  return { plans, totals };
}

const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

describe("[S22f] agrupado por plan (puro)", () => {
  it("el título solo sale con showPlanTitles Y nivel full", () => {
    const p = plan("p1");
    const bal = balances([{ programId: "p1" }]);
    expect(planGroupMetas({ plans: [p], planBalances: bal }).get("p1")!.title).toBeNull();
    expect(planGroupMetas({ plans: [p], planBalances: bal, showPlanTitles: true }).get("p1")!.title).toBe(SECRET_TITLE);
    // El server mandó el título por error a un nivel admin: igual no se ve.
    const admin = plan("p1", { level: "admin" });
    expect(planGroupMetas({ plans: [admin], planBalances: bal, showPlanTitles: true }).get("p1")!.title).toBeNull();
  });

  it("planes en orden de estado, archivados después y sueltos al final; el saldo es el del server", () => {
    const bks = [
      booking({ scheduledFor: "2026-10-02T13:00:00Z" }),
      booking({ scheduledFor: "2026-10-03T13:00:00Z", programId: "pc" }),
      booking({ scheduledFor: "2026-10-04T13:00:00Z", programId: "pa", sessionId: "s1" }),
      booking({ scheduledFor: "2026-10-05T13:00:00Z", programId: "parch" }),
    ];
    const serverBalance = balance({ pendingCents: 777 });
    const metas = planGroupMetas({
      plans: [plan("pc", { status: "CANCELLED" }), plan("pa")],
      planBalances: balances([
        { programId: "pa", b: serverBalance },
        { programId: "parch", status: "COMPLETED" },
      ]),
    });
    const groups = groupBookingsByPlan(bks, metas);
    expect(groups.map((g) => g.key)).toEqual(["pa", "pc", "parch", "loose"]);
    const pa = groups[0];
    expect(pa.kind === "plan" && pa.plan.balance).toBe(serverBalance);
    expect(groups[2].kind === "plan" && groups[2].plan.archived).toBe(true);
  });

  it("Facturación incluye planes sin turnos cargados con plata pendiente o a favor", () => {
    const metas = planGroupMetas({
      planBalances: balances([
        { programId: "debe", b: balance({ pendingCents: 500 }) },
        { programId: "aldia", b: balance({ pendingCents: 0, creditCents: 0 }) },
      ]),
    });
    expect(groupBookingsByPlan([], metas, { includeBalanceOnly: true }).map((g) => g.key)).toEqual(["debe"]);
    expect(groupBookingsByPlan([], metas)).toEqual([]);
  });

  it("General / sin turnos de plan → no se agrupa", () => {
    const bks = [booking({ scheduledFor: "2026-10-02T13:00:00Z", programId: "p1" })];
    expect(shouldGroupByPlan(false, bks)).toBe(false);
    expect(shouldGroupByPlan(true, [booking({ scheduledFor: "2026-10-02T13:00:00Z" })])).toBe(false);
    expect(shouldGroupByPlan(true, bks)).toBe(true);
  });

  it("cancelados/ausentes con cobro visibles solo agrupada; sin plata, nunca", () => {
    const paid = booking({ scheduledFor: "2026-10-02T13:00:00Z", status: "CANCELLED", paymentStatus: "PAID" });
    const osPaid = booking({ scheduledFor: "2026-10-02T13:00:00Z", status: "NO_SHOW", insurerPaidAt: new Date() });
    const unpaid = booking({ scheduledFor: "2026-10-02T13:00:00Z", status: "CANCELLED" });
    expect(isBillingVisible(paid, true)).toBe(true);
    expect(isBillingVisible(osPaid, true)).toBe(true);
    expect(isBillingVisible(paid, false)).toBe(false);
    expect(isBillingVisible(unpaid, true)).toBe(false);
  });

  it("sin 'Eliminar' en turnos de plan", () => {
    expect(canDeleteFromProfile({ programId: "p1" })).toBe(false);
    expect(canDeleteFromProfile({ programId: null })).toBe(true);
  });

  it("pendiente agrupado = OS + copago suelto + Σ pendiente de planes del server (no el copago fila a fila)", () => {
    const bks = [
      booking({ scheduledFor: "2026-10-02T13:00:00Z", copagoCents: 100 }), // suelto impago
      booking({ scheduledFor: "2026-10-03T13:00:00Z", programId: "p1", copagoCents: 9_999 }), // plan impago: no suma
      booking({ scheduledFor: "2026-10-04T13:00:00Z", programId: "p1", status: "CANCELLED", paymentStatus: "PAID", copagoCents: 50 }),
      booking({ scheduledFor: "2026-10-05T13:00:00Z", obraSocial: "OSDE", osAmountCents: 30 }),
    ];
    const bal = balances([{ programId: "p1", b: balance({ pendingCents: 400, creditCents: 0 }) }]);
    const s = billingSummary(bks, { grouped: true, planBalances: bal });
    expect(s.pendingCents).toBe(30 + 100 + 1_000_000 + 400); // OS + suelto + suelto OSDE (copago default) + plan
    expect(s.copagoPaidCents).toBe(50); // el cancelado cobrado es plata que entró
    // Sin agrupar: la cuenta de siempre (copago de todos los facturables, sin cancelados).
    const flat = billingSummary(bks, { grouped: false });
    expect(flat.pendingCents).toBe(100 + 9_999 + 30 + 1_000_000);
    expect(flat.copagoPaidCents).toBe(0);
  });
});

describe("[S22f] PlanBalance muestra el saldo del server tal cual", () => {
  it("montos con formatARS; pendiente, a favor o al día", () => {
    const items = planBalanceItems(balance());
    expect(items.map((i) => [i.label, i.value])).toEqual([
      ["Pactado", formatARS(10_000_000)],
      ["Realizado", formatARS(3_000_000)],
      ["Cobrado", formatARS(2_000_000)],
      ["Pendiente", formatARS(1_000_000)],
    ]);
    expect(balanceOutcome(balance({ pendingCents: 0, creditCents: 5_000 })).label).toBe("A favor del paciente");
    expect(balanceOutcome(balance({ pendingCents: 0, creditCents: 0 })).value).toBe("Al día");
    expect(planBalanceItems(balance({ agreedCents: null }))[0].value).toBe("Sin precio");
    expect(planBalanceItems(balance({ inProcessCents: 300 })).some((i) => i.label === "En proceso")).toBe(true);
  });

  it("plan cancelado: el pactado es el que manda el server (S14r), no se recalcula", () => {
    // El server ya resolvió pactado = devengado; la UI no lo "corrige" con el paquete.
    const b = balance({ agreedCents: 3_000_000, accruedCents: 3_000_000 });
    expect(planBalanceItems(b)[0].value).toBe(formatARS(3_000_000));
    expect(planBalanceNotes(b, "CANCELLED")).toContain("Plan cancelado: el pactado es lo realizado.");
  });

  it("la OS pagada se informa aparte, sin monto", () => {
    expect(planBalanceNotes(balance({ insurerPaidBookings: 2 }))[0]).toMatch(/obra social ya pagó 2 turnos/);
  });
});

describe("[S22f] FacturacionView", () => {
  const bks = [
    booking({ scheduledFor: "2026-09-10T13:00:00Z", programId: "p1", sessionId: "s1", status: "COMPLETED", paymentStatus: "PAID" }),
    booking({ scheduledFor: "2026-09-12T13:00:00Z", programId: "p1", status: "CANCELLED", paymentStatus: "PAID", serviceName: "Cancelado cobrado" }),
    booking({ scheduledFor: "2026-09-14T13:00:00Z", programId: "p1", status: "CANCELLED", serviceName: "Cancelado sin plata" }),
    booking({ scheduledFor: "2026-09-20T13:00:00Z", serviceName: "Consulta suelta" }),
  ];
  const plans = [plan("p1")];
  const bal = balances([{ programId: "p1" }]);

  it("agrupada: chip de disciplina, sin título, saldo del server, cancelado cobrado visible, sueltos aparte", () => {
    const html = wrap(
      <FacturacionView bookings={bks} loading={false} patchBooking={noop} plansEnabled plans={plans} planBalances={bal} />
    );
    expect(html).toContain('data-testid="plan-group-header"');
    expect(html).toContain("Kinesiología");
    expect(html).toContain("Plan de 10 sesiones");
    expect(html).not.toContain(SECRET_TITLE);
    expect(html).toContain("Turnos sueltos");
    expect(html).toContain("Cancelado cobrado");
    expect(html).not.toContain("Cancelado sin plata");
    expect(html).toContain('data-testid="plan-balance"');
    expect(html).toContain(formatARS(10_000_000)); // pactado del server
    expect(html).toContain("Kine · 1/10"); // ordinal M13 de la sesión
  });

  it("con permiso clínico muestra el título", () => {
    const html = wrap(
      <FacturacionView bookings={bks} loading={false} patchBooking={noop} plansEnabled plans={plans} planBalances={bal} showPlanTitles />
    );
    expect(html).toContain(SECRET_TITLE);
  });

  it("sin módulo planes (General): la vista de siempre", () => {
    const html = wrap(
      <FacturacionView bookings={bks} loading={false} patchBooking={noop} plans={plans} planBalances={bal} showPlanTitles />
    );
    expect(html).not.toContain("plan-group-header");
    expect(html).not.toContain("plan-balance");
    expect(html).not.toContain("Cancelado cobrado");
    expect(html).not.toContain(SECRET_TITLE);
    expect(html).toContain("Consulta suelta");
  });
});

describe("[S22f] TurnosView", () => {
  const bks = [
    booking({ scheduledFor: "2026-09-10T13:00:00Z", programId: "p1", sessionId: "s1", status: "COMPLETED", paymentStatus: "PAID" }),
    booking({ scheduledFor: "2026-09-20T13:00:00Z", serviceName: "Consulta suelta" }),
  ];
  const common = { patientId: "pat_1", loading: false, patchBooking: noop, dropBooking: noop };

  it("agrupada por plan con saldo compacto y sueltos", () => {
    const html = wrap(
      <TurnosView {...common} bookings={bks} plansEnabled plans={[plan("p1")]} planBalances={balances([{ programId: "p1" }])} />
    );
    expect(html.match(/data-testid="turnos-group"/g)).toHaveLength(2);
    expect(html).toContain('data-variant="compact"');
    expect(html).toContain("Turnos sueltos");
    expect(html).not.toContain(SECRET_TITLE);
  });

  it("Secretaria (admin): estado de cobro, link a la agenda, sin menú de acciones ni título", () => {
    // Anti-false-green (P3.Z F3b): el fixture TRAE el título secreto (como si
    // el server lo mandara por error) y además `showPlanTitles` viene prendido:
    // la barrera es el nivel `admin` del plan, no que el dato falte.
    const adminPlan = plan("p1", { level: "admin", title: SECRET_TITLE });
    const html = wrap(
      <TurnosView
        {...common}
        bookings={bks}
        admin
        plansEnabled
        plans={[adminPlan]}
        planBalances={balances([{ programId: "p1", title: SECRET_TITLE }])}
        showPlanTitles
      />
    );
    expect(html).toContain("Cobrado");
    expect(html).toContain("Pendiente");
    expect(html).toContain("Ver en agenda");
    expect(html).not.toContain("Acciones del turno");
    expect(html).not.toContain("Nuevo turno");
    expect(html).not.toContain(SECRET_TITLE);
  });

  it("[P3-Z-F3b] full sin showPlanTitles: el fixture trae el título y no aparece", () => {
    const html = wrap(
      <TurnosView {...common} bookings={bks} plansEnabled plans={[plan("p1")]} planBalances={balances([{ programId: "p1" }])} showPlanTitles={false} />
    );
    expect(html).toContain('data-testid="plan-group-header"');
    expect(html).not.toContain(SECRET_TITLE);
  });

  it("sin módulo planes: lista plana como hoy", () => {
    const html = wrap(<TurnosView {...common} bookings={bks} plans={[plan("p1")]} />);
    expect(html).not.toContain("turnos-group");
    expect(html).toContain("Acciones del turno");
  });
});

// P3.Z (F3b): las grillas de Turnos (7 columnas) y Facturación (6) superaban
// los 360 px de un teléfono dentro de una Card con `overflow:hidden`, y "Ver en
// agenda" quedaba cortado. La tabla scrollea DENTRO de la card (como Sesiones),
// la página no (AGENTS §5).
describe("[P3-Z-F3b] mobile: las tablas scrollean dentro de la card", () => {
  const bks = [
    booking({ scheduledFor: "2026-09-10T13:00:00Z", programId: "p1", sessionId: "s1", status: "COMPLETED", paymentStatus: "PAID" }),
    booking({ scheduledFor: "2026-09-20T13:00:00Z", serviceName: "Consulta suelta" }),
  ];
  const common = { patientId: "pat_1", loading: false, patchBooking: noop, dropBooking: noop };
  const SCROLL = /<div data-testid="profile-table-scroll" style="overflow-x:auto"><div style="min-width:(\d+)px">/g;

  function scrollers(html: string): number[] {
    return Array.from(html.matchAll(SCROLL), (m) => Number(m[1]));
  }

  it("Turnos (plana, agrupada y admin): un scroller por tabla, con ancho mínimo", () => {
    const flat = wrap(<TurnosView {...common} bookings={bks} />);
    expect(scrollers(flat)).toHaveLength(1);
    const grouped = wrap(
      <TurnosView {...common} bookings={bks} plansEnabled plans={[plan("p1")]} planBalances={balances([{ programId: "p1" }])} />
    );
    expect(scrollers(grouped)).toHaveLength(2);
    const admin = wrap(<TurnosView {...common} bookings={bks} admin />);
    const [w] = scrollers(admin);
    expect(w).toBeGreaterThan(360);
    // "Ver en agenda" queda adentro del scroller (no lo corta el overflow de la card).
    expect(admin.indexOf("profile-table-scroll")).toBeLessThan(admin.indexOf("Ver en agenda"));
  });

  it("Facturación (plana y agrupada): un scroller por tabla", () => {
    const flat = wrap(<FacturacionView bookings={bks} loading={false} patchBooking={noop} />);
    expect(scrollers(flat)).toHaveLength(1);
    const grouped = wrap(
      <FacturacionView bookings={bks} loading={false} patchBooking={noop} plansEnabled plans={[plan("p1")]} planBalances={balances([{ programId: "p1" }])} />
    );
    expect(scrollers(grouped)).toHaveLength(2);
    expect(scrollers(grouped).every((w) => w > 360)).toBe(true);
  });
});
