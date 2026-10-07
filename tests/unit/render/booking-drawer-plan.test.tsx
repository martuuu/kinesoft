import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// P3-S19c: fila Plan del drawer de turno. Render real (react-dom/server, sin
// jsdom, como el resto de `tests/unit/render`); se mockean solo las server
// actions (red/DB), toast/confirm y la navegación — nunca el drawer ni la fila.
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/programs", () => proxy());
vi.mock("@/lib/plan-templates", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import {
  PlanRow,
  drawerPlanModel,
  linkSessionOutcome,
  linkableSessions,
  pickNextPlanSession,
  planFreedNotice,
  puerta4Href,
  programHref,
  type DrawerPlanModel,
  type PlanRowBooking,
} from "@/components/agenda/booking-drawer/plan-row";
import { StatusActions, planStatusToastDescription } from "@/components/agenda/booking-drawer/status-actions";
import { PatientHeader } from "@/components/agenda/booking-drawer/patient-header";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { planUiPermissions, NO_PLAN_PERMISSIONS, type PlanPermissions } from "@/components/planes/plan-editor-types";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { parseProfilePlanParams } from "@/lib/plans-deeplink";
import { PLAN_PATIENT_CHANGE_ERROR } from "@/lib/bookings-constants";

const ASSISTANT = [...capabilitiesFor("ASSISTANT")];
const PRACTITIONER = [...capabilitiesFor("PRACTITIONER")];

function booking(over: Partial<DrawerBooking> & { serviceId?: string } = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-06T02:30:00.000Z", // lun 05/10 23:30 AR: el día AR ≠ el día UTC
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    canOperate: true,
    clinicalWritable: true,
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
    ...over,
  };
}

const PLAN_CHIP = { discipline: "KINESIOLOGY" as const, ordinal: 3, totalLive: 10, title: "Lumbalgia crónica" };
const planBooking = (over: Partial<DrawerBooking> = {}) =>
  booking({ programId: "prog1", sessionId: "s3", pricedByPlan: true, plan: PLAN_CHIP, patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"], ...over });
/** Suelto de un paciente con plan Kine activo vinculado → "Fuera de plan" (V2). */
const outOfPlan = (over: Partial<DrawerBooking> = {}) => booking({ patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"], ...over });

/** La Secretaria: nivel admin viaja como "basic", sin clínica, opera todo. */
const secretaria = (b: DrawerBooking): DrawerBooking => ({
  ...b,
  patientAccess: "basic",
  clinicalHidden: true,
  canOperate: true,
  clinicalWritable: false,
});

const perms = (caps: string[], access: "full" | "basic" | "none", plansModule = true): PlanPermissions =>
  planUiPermissions({ caps: new Set(caps) as never, access, role: null, plansModule, templatesModule: false });

const ALL: PlanPermissions = { manage: true, schedule: true, authorize: true, restore: false, templates: false };

const renderDrawer = (b: DrawerBooking, caps: readonly string[] | null) =>
  renderToStaticMarkup(<BookingDrawer booking={b} onClose={() => {}} onSaved={() => {}} capabilities={caps} />);

const GENERAL = Array.from(modulesFor({ vertical: "GENERAL" as never, plan: "PRO" as never, publicBookingEnabled: false }));

const row = (b: PlanRowBooking, model: DrawerPlanModel, next: Parameters<typeof PlanRow>[0]["nextSession"] = null) =>
  renderToStaticMarkup(
    <PlanRow
      booking={b}
      model={model}
      nextSession={next}
      pending={false}
      onSchedule={() => {}}
      onRemove={() => {}}
      onLink={() => {}}
      onRenewAuthorization={() => {}}
      onNavigate={() => {}}
    />
  );

const NEXT = {
  sessionId: "s4",
  programId: "prog1",
  ordinal: 4,
  totalLive: 10,
  discipline: "KINESIOLOGY" as const,
  serviceId: "svc",
  practitionerId: "p1",
  locationId: null,
  sinTurno: true,
};

describe("[P3-S19c] modelo de la fila Plan", () => {
  it("turno de plan: chip y 'Sesión 3 de 10'; acciones por permiso", () => {
    const m = drawerPlanModel(planBooking(), ALL, { plansModule: true });
    expect(m.kind).toBe("plan");
    expect(m.chip).toEqual({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10 });
    expect(m.sessionLabel).toBe("Sesión 3 de 10");
    expect(m).toMatchObject({ canSchedule: true, canRemove: true, canRenewAuthorization: true, canLink: false, canCreateFromBooking: false });
    expect(m.showProgramLink).toBe(true);
  });

  it("la Secretaria agenda y renueva, pero no saca del plan, no vincula ni crea (plans.manage) ni ve 'Ver plan'", () => {
    const sec = secretaria(planBooking());
    const p = perms(ASSISTANT, "basic");
    expect(p).toMatchObject({ manage: false, schedule: true, authorize: true });
    const m = drawerPlanModel(sec, p, { plansModule: true });
    expect(m).toMatchObject({ kind: "plan", canSchedule: true, canRenewAuthorization: true, canRemove: false, showProgramLink: false });
    const loose = drawerPlanModel(secretaria(outOfPlan()), p, { plansModule: true });
    expect(loose).toMatchObject({ kind: "loose", outOfPlan: true, canLink: false, canCreateFromBooking: false });
  });

  it("consultorio General (sin `planes`) o sin C9: no hay fila (no se adivina)", () => {
    expect(drawerPlanModel(planBooking(), ALL, { plansModule: false }).kind).toBe("none");
    expect(perms(PRACTITIONER, "full", false)).toEqual(NO_PLAN_PERMISSIONS);
    expect(drawerPlanModel(booking({ programId: undefined }), ALL, { plansModule: true }).kind).toBe("none");
  });

  it("suelto: 'Fuera de plan' + Vincular (manage); puerta 4 con manage y full; nada en guest ni cancelado", () => {
    const m = drawerPlanModel(outOfPlan(), ALL, { plansModule: true });
    expect(m).toMatchObject({ kind: "loose", outOfPlan: true, canLink: true, canCreateFromBooking: true });
    const plain = drawerPlanModel(booking(), ALL, { plansModule: true });
    expect(plain).toMatchObject({ kind: "loose", outOfPlan: false, canLink: false, canCreateFromBooking: true });
    expect(drawerPlanModel(booking({ patientId: null, patientAccess: "none" }), ALL, { plansModule: true }).kind).toBe("none");
    expect(drawerPlanModel(outOfPlan({ status: "CANCELLED" }), ALL, { plansModule: true }).kind).toBe("none");
    // Un PRACTITIONER en básico no gestiona: sin "Fuera de plan" que mostrar, no hay fila.
    expect(drawerPlanModel(booking({ patientAccess: "basic" }), perms(PRACTITIONER, "basic"), { plansModule: true }).kind).toBe("none");
  });

  it("copy de Ausente (C13 literal) y de Cancelado; 'Sacar del plan' no en un cancelado", () => {
    expect(planFreedNotice("NO_SHOW", 3)).toBe("Ausente · la sesión 3 queda sin turno para reprogramar");
    expect(planFreedNotice("CANCELLED", null)).toBe("Cancelado · la sesión queda sin turno para reprogramar");
    expect(planFreedNotice("CONFIRMED", 3)).toBeNull();
    const m = drawerPlanModel(planBooking({ status: "NO_SHOW" }), ALL, { plansModule: true });
    expect(m.freedNotice).toBe("Ausente · la sesión 3 queda sin turno para reprogramar");
    expect(drawerPlanModel(planBooking({ status: "CANCELLED" }), ALL, { plansModule: true }).canRemove).toBe(false);
  });

  it("toast de Ausente/Cancelar en un turno de plan (PQ-05: no consume la sesión)", () => {
    expect(planStatusToastDescription("NO_SHOW", { isPlan: true, ordinal: 3 })).toBe("La sesión 3 queda sin turno para reprogramar.");
    expect(planStatusToastDescription("CANCELLED", { isPlan: true, ordinal: null })).toBe("La sesión queda sin turno para reprogramar.");
    expect(planStatusToastDescription("NO_SHOW", { isPlan: false, ordinal: null })).toBeNull();
    expect(planStatusToastDescription("COMPLETED", { isPlan: true, ordinal: 3 })).toBeNull();
  });
});

describe("[P3-S19c] puerta 4 y deep-links (C10)", () => {
  it("navega al perfil con `turno` y `prefill` sin texto libre; el día de inicio es el AR (TZ=UTC)", () => {
    const href = puerta4Href(booking({ serviceId: "svc1", locationId: "loc1" } as Partial<DrawerBooking>))!;
    expect(href).toMatch(/^\/pacientes\/pt1\?/);
    const parsed = parseProfilePlanParams(new URLSearchParams(href.split("?")[1]));
    expect(parsed.tab).toBe("planes");
    expect(parsed.intent).toMatchObject({
      kind: "new",
      fromBookingId: "b1",
      prefill: {
        discipline: "KINESIOLOGY",
        serviceId: "svc1",
        practitionerId: "p1",
        locationId: "loc1",
        durationMin: 45,
        startDayKey: "2026-10-05",
        fromBookingId: "b1",
      },
    });
    expect(href).not.toContain("Juana");
  });

  it("con una duración que el prefill no acepta cae al link con solo `turno` (no arma un link roto)", () => {
    const href = puerta4Href(booking({ durationMin: 9999 }))!;
    expect(href).toContain("turno=b1");
    expect(href).not.toContain("prefill=");
  });

  it("'Ver plan' = tab Planes con `programa`", () => {
    expect(programHref(planBooking())).toBe("/pacientes/pt1?tab=planes&programa=prog1");
    expect(programHref(booking())).toBeNull();
  });
});

describe("[P3-S19c] Agendar próxima sesión y Vincular: selección pura", () => {
  it("elige la sesión sin turno de menor ordinal del plan del turno", () => {
    const other = { ...NEXT, sessionId: "o1", programId: "prog-osteo", ordinal: 1, discipline: "OSTEOPATHY" as const, totalLive: 6 };
    const later = { ...NEXT, sessionId: "s7", ordinal: 7 };
    const booked = { ...NEXT, sessionId: "s2", ordinal: 2, sinTurno: false };
    expect(pickNextPlanSession([later, other, booked, NEXT], planBooking())?.sessionId).toBe("s4");
    expect(pickNextPlanSession([other], planBooking())).toBeNull();
    expect(pickNextPlanSession([NEXT], booking())).toBeNull(); // suelto: no aplica
  });

  it("filtra exacto por `programId` aunque otro plan tenga la misma disciplina y total", () => {
    const a = { ...NEXT, sessionId: "a", ordinal: 2, programId: "otro" };
    const b = { ...NEXT, sessionId: "b", ordinal: 5, programId: "prog1" };
    expect(pickNextPlanSession([a, b], planBooking())?.sessionId).toBe("b");
  });

  it("Vincular: solo planes ACTIVE, vinculados, no archivados; sesiones vivas sin turno; misma disciplina primero; sin título", () => {
    const plan = (id: string, over: Record<string, unknown>) => ({
      id,
      status: "ACTIVE" as const,
      archivedAt: null,
      linked: true,
      discipline: "KINESIOLOGY" as const,
      totalLive: 10,
      updatedAt: new Date("2026-10-01T10:00:00.000Z"),
      title: "Lumbalgia crónica",
      sessions: [
        { id: `${id}-4`, ordinal: 4, sinTurno: true, archivedAt: null, scheduledFor: new Date("2026-10-13T12:00:00.000Z") },
        { id: `${id}-3`, ordinal: 3, sinTurno: false, archivedAt: null, scheduledFor: new Date("2026-10-09T12:00:00.000Z") },
        { id: `${id}-x`, ordinal: null, sinTurno: false, archivedAt: new Date(), scheduledFor: new Date("2026-10-20T12:00:00.000Z") },
      ],
      ...over,
    });
    const out = linkableSessions(
      [
        plan("osteo", { discipline: "OSTEOPATHY", totalLive: 6 }),
        plan("kine", {}),
        plan("legacy", { linked: false }),
        plan("paused", { status: "PAUSED" }),
      ] as never,
      "KINESIOLOGY"
    );
    expect(out.map((o) => o.sessionId)).toEqual(["kine-4", "osteo-4"]);
    expect(out[0]).toMatchObject({ programId: "kine", programUpdatedAt: "2026-10-01T10:00:00.000Z", sameDiscipline: true });
    expect(out[0].label).toMatch(/^Kine · 4\/10 · /);
    expect(out[0].label).toContain("13/10");
    expect(JSON.stringify(out)).not.toContain("Lumbalgia");
  });
});

describe("[P3-S19c] render de la fila", () => {
  it("turno de plan: chip accesible sin título, 'Agendar próxima sesión' solo con sesión libre", () => {
    const b = planBooking();
    const m = drawerPlanModel(b, ALL, { plansModule: true });
    const without = row(b, m, null);
    expect(without).toContain(">Kine · 3/10<");
    expect(without).toContain("Sesión 3 de 10");
    expect(without).not.toContain("Lumbalgia");
    expect(without).not.toContain("Agendar próxima sesión");
    const withNext = row(b, m, NEXT);
    expect(withNext).toContain("Agendar próxima sesión");
    expect(withNext).toContain('aria-label="Agendar próxima sesión (Sesión 4 de 10)"');
    expect(withNext).toContain("Sacar del plan");
    expect(withNext).toContain("Renovar autorización");
    expect(withNext).toContain('href="/pacientes/pt1?tab=planes&amp;programa=prog1"');
  });

  it("Secretaria: Agendar y Renovar, sin Sacar/Vincular/Ver plan y sin título", () => {
    const b = secretaria(planBooking());
    const html = row(b, drawerPlanModel(b, perms(ASSISTANT, "basic"), { plansModule: true }), NEXT);
    expect(html).toContain("Agendar próxima sesión");
    expect(html).toContain("Renovar autorización");
    expect(html).not.toContain("Sacar del plan");
    expect(html).not.toContain("Vincular a una sesión");
    expect(html).not.toContain("Ver plan");
    expect(html).not.toContain("Lumbalgia");
  });

  it("suelto 'Fuera de plan': aviso en texto, Vincular y puerta 4", () => {
    const b = outOfPlan();
    const html = row(b, drawerPlanModel(b, ALL, { plansModule: true }));
    expect(html).toContain(">Fuera de plan<");
    expect(html).toContain("Vincular a una sesión");
    expect(html).toContain("Crear plan desde este turno");
    expect(html).toContain("turno=b1");
  });

  it("Ausente: el aviso literal de C13 en la fila", () => {
    const b = planBooking({ status: "NO_SHOW" });
    const html = row(b, drawerPlanModel(b, ALL, { plansModule: true }));
    expect(html).toContain("Ausente · la sesión 3 queda sin turno para reprogramar");
  });

  it("StatusActions de un turno de plan explica que Ausente/Cancelar no consumen la sesión", () => {
    const html = renderToStaticMarkup(<StatusActions pending={false} onSetStatus={() => {}} planSession={{ ordinal: 3 }} />);
    expect(html).toContain("la sesión 3 queda sin turno para");
    const loose = renderToStaticMarkup(<StatusActions pending={false} onSetStatus={() => {}} />);
    expect(loose).not.toContain("sin turno");
  });

  it("encabezado: sin el subtítulo `patientCondition` (código muerto, PHI del plan 'take 1')", () => {
    const html = renderToStaticMarkup(<PatientHeader booking={booking({ patientCondition: "Condición vieja" })} />);
    expect(html).not.toContain("Condición vieja");
    expect(html).toContain("Juana Gómez");
  });
});

describe("[P3-S19c] drawer completo", () => {
  it("turno de plan: 'Cancelalo' en lugar de 'Eliminar turno'", () => {
    const html = renderDrawer(planBooking(), PRACTITIONER);
    expect(html).toContain("Cancelalo");
    expect(html).toContain("Es de un plan: no se elimina.");
    expect(html).not.toContain("Eliminar turno");
    expect(html).toContain('data-testid="drawer-plan-row"');
    expect(html).toContain("Sacar del plan");
    expect(html).not.toContain("Lumbalgia");
  });

  it("turno suelto: sigue 'Eliminar turno' (regla vigente) y la puerta 4", () => {
    const html = renderDrawer(booking(), PRACTITIONER);
    expect(html).toContain("Eliminar turno");
    expect(html).not.toContain("Cancelalo");
    expect(html).toContain("Crear plan desde este turno");
  });

  it("Secretaria en un turno de plan: opera (S07u), no elimina ni ve 'Cancelalo' (regla de Eliminar), no gestiona el plan", () => {
    const html = renderDrawer(secretaria(planBooking()), ASSISTANT);
    expect(html).toContain("Cambiar estado");
    expect(html).not.toContain("Eliminar turno");
    expect(html).not.toContain("Cancelalo");
    expect(html).toContain("Renovar autorización");
    expect(html).not.toContain("Sacar del plan");
    expect(html).not.toContain("Lumbalgia");
  });

  it("consultorio General: ni fila Plan ni puerta 4 (enmienda EV0)", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={GENERAL}>
        <BookingDrawer booking={outOfPlan()} onClose={() => {}} onSaved={() => {}} capabilities={PRACTITIONER} />
      </TenantModulesProvider>
    );
    expect(html).not.toContain("drawer-plan-row");
    expect(html).not.toContain("Crear plan desde este turno");
    expect(html).not.toContain("Fuera de plan");
    expect(html).toContain("Eliminar turno");
  });

  it("paciente bloqueado: el copy del core existe y es el que usa el drawer", () => {
    expect(PLAN_PATIENT_CHANGE_ERROR).toContain("no se puede cambiar el paciente");
  });
});

// ─── P3.Z · F3a ──────────────────────────────────────────────────────────────

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
/** Recorre el árbol de elementos que devuelve un componente sin hooks (sin montar). */
function findElements(node: unknown, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) findElements(n, pred, out);
    return out;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const e = node as El;
  if (pred(e)) out.push(e);
  findElements(e.props.children, pred, out);
  return out;
}
const textOf = (node: unknown): string =>
  Array.isArray(node)
    ? node.map(textOf).join("")
    : typeof node === "string" || typeof node === "number"
      ? String(node)
      : node && typeof node === "object" && "props" in node
        ? textOf((node as El).props.children)
        : "";

describe("[P3-F3a] fila Plan: links con dirty-guard", () => {
  it("'Crear plan desde este turno' y 'Ver plan' navegan por `onNavigate` (pasa por el confirm del drawer), con href real", () => {
    const calls: string[] = [];
    const prevented: boolean[] = [];
    const click = (label: string, b: PlanRowBooking) => {
      const tree = PlanRow({
        booking: b,
        model: drawerPlanModel(b, ALL, { plansModule: true }),
        nextSession: null,
        pending: false,
        onSchedule: () => {},
        onRemove: () => {},
        onLink: () => {},
        onRenewAuthorization: () => {},
        onNavigate: (href) => calls.push(href),
      });
      const [el] = findElements(tree, (e) => textOf(e.props.children).startsWith(label) && typeof e.props.href === "string");
      expect(el, label).toBeDefined();
      (el.props.onClick as (ev: { preventDefault: () => void }) => void)({ preventDefault: () => prevented.push(true) });
      return el.props.href as string;
    };
    const createHref = click("Crear plan desde este turno", outOfPlan());
    const planHref = click("Ver plan", planBooking());
    expect(calls).toEqual([createHref, planHref]);
    expect(planHref).toBe("/pacientes/pt1?tab=planes&programa=prog1");
    // Sin preventDefault el <Link> navegaba solo y el confirm llegaba tarde.
    expect(prevented).toEqual([true, true]);
  });
});

describe("[P3-F3a] Vincular a una sesión: stale", () => {
  it("un CAS perdido se trata aparte del error (refresca y cierra en lugar de quedar trabado)", () => {
    expect(linkSessionOutcome({ ok: true, data: { updatedAt: "x", sessionId: "s" } })).toBe("ok");
    expect(linkSessionOutcome({ ok: false, kind: "stale", error: "Cambió" } as never)).toBe("stale");
    expect(linkSessionOutcome({ ok: false, error: "Otro" } as never)).toBe("error");
  });
});

describe("[P3-F3a] 'Cancelalo' solo en turnos activos", () => {
  it("PENDING y CONFIRMED lo ofrecen; Realizado y Ausente no (ni 'Eliminar turno')", () => {
    for (const status of ["PENDING", "CONFIRMED"] as const) {
      expect(renderDrawer(planBooking({ status }), PRACTITIONER), status).toContain("Cancelalo");
    }
    for (const status of ["COMPLETED", "NO_SHOW", "CANCELLED"] as const) {
      const html = renderDrawer(planBooking({ status }), PRACTITIONER);
      expect(html, status).not.toContain("Cancelalo");
      expect(html, status).not.toContain("Es de un plan: no se elimina.");
      expect(html, status).not.toContain("Eliminar turno");
    }
  });
});
