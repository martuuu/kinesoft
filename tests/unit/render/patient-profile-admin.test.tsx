// P0-S07v · Perfil administrativo (nivel `admin`, PD-13 / Planes E1).
//
// Contrato: para `admin` el perfil muestra solo datos y turnos, sin pestañas
// clínicas (Evolución, Plan, Seguimiento, archivos, actividad clínica). Antes
// la página mandaba todo lo que no fuera `full` a la vista básica ("Sin
// acceso"): la Secretaria no veía ni el teléfono del paciente.
//
// Dos niveles:
//  1. el componente real (`PatientAdminProfile`) renderizado con props;
//  2. la página real (`app/(app)/pacientes/[id]/page.tsx`) con la capa de datos
//     mockeada (red/DB): con `access: "admin"` no pide ningún slice clínico.
// S22b (ES3, H1 de S22f): la tabla de Turnos del perfil administrativo es la
// `TurnosView` real en modo `admin` (antes `AdminTurnosView`, una copia); la
// fila pasa de `admin-turno-row` a `turno-row`. La página pide planes y saldos
// solo con el módulo `planes` (enmienda EV0), y los EVA solo con
// `evaluaciones`: los mocks de `getActor` suman `entitlements`.
// Los tests contra el server de S07sp (proyección `admin` real de
// `getPatientCore`, turnos redactados) son post-integración y viven en
// `tests/integration/patients-secretaria.test.ts`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// `React.cache` solo existe en el runtime de RSC (lo usan lib/session, lib/authz).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

// Capa de datos de la página: se mockea la frontera con la DB, nunca la página
// ni el componente bajo test.
const data = vi.hoisted(() => ({
  getPatientCore: vi.fn(),
  getPatientBookingsAll: vi.fn(),
  getPatientBookingsSummary: vi.fn(),
  getPatientBillableCount: vi.fn(),
  getPatientEvaScores: vi.fn(),
  getPatientName: vi.fn(),
  getPatientPlans: vi.fn(),
  getPatientPlanBalances: vi.fn(),
  listInsurers: vi.fn(),
  runWithRls: vi.fn(),
  getCapabilities: vi.fn(),
}));
const entitlements = vi.hoisted(() => ({
  current: { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false } as {
    vertical: "KINESIOLOGY" | "GENERAL";
    plan: "INDIVIDUAL" | "CONSULTORIO" | "CLINICA" | "LIBRE";
    publicBookingEnabled: boolean;
  },
}));
vi.mock("@/lib/patients", () => ({
  getPatientCore: data.getPatientCore,
  getPatientBookingsAll: data.getPatientBookingsAll,
  getPatientBookingsSummary: data.getPatientBookingsSummary,
  getPatientBillableCount: data.getPatientBillableCount,
  getPatientEvaScores: data.getPatientEvaScores,
  getPatientName: data.getPatientName,
  // Actions que importa el hero completo (no se invocan en render estático).
  assignPatientToPractitioner: vi.fn(),
  sendPatientPortalInvite: vi.fn(),
  setPatientArchived: vi.fn(),
  setPatientCoverage: vi.fn(),
  updatePatient: vi.fn(),
}));
vi.mock("@/lib/plans-read", () => ({
  getPatientPlans: data.getPatientPlans,
  getPatientPlanBalances: data.getPatientPlanBalances,
}));
vi.mock("@/lib/insurers", () => ({ listInsurers: data.listInsurers }));
vi.mock("@/lib/rls", () => ({ runWithRls: data.runWithRls }));
vi.mock("@/lib/session", () => ({
  getActor: async () => ({
    userId: "u1",
    tenantId: "t1",
    entitlements: entitlements.current,
    // PL-1 (H1b-17): el miembro viaja en el Actor; la página ya no lo lee con una query.
    membership: { role: "PRACTITIONER", clinical: true, grantSettings: false, grantBilling: false },
  }),
}));
// `getMemberAccess`/`memberCapabilitiesForActor` con la lógica real (capabilitiesForMember sobre el miembro del
// Actor): se mockea solo la frontera de `server-only`, no el cálculo de capacidades.
vi.mock("@/lib/authz", async () => {
  const { capabilitiesForMember } = await import("@/lib/capabilities");
  type A = { membership: Parameters<typeof capabilitiesForMember>[0] };
  return {
    getCapabilities: data.getCapabilities,
    getMemberAccess: async (a: A) => a.membership,
    memberCapabilitiesForActor: async (a: A) => capabilitiesForMember(a.membership),
  };
});

import { PatientAdminProfile, ADMIN_PROFILE_TABS } from "@/components/patients/patient-profile";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { capabilitiesFor } from "@/lib/capabilities";
import type { PatientAdminCore, PatientBookingFull } from "@/lib/patients-types";
import PatientPage from "@/app/(app)/pacientes/[id]/page";

const admin: PatientAdminCore = {
  id: "pat_000000abcdef",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: "lucia@example.com",
  phone: "+54 11 5555-0001",
  dateOfBirth: new Date("1990-03-15T00:00:00Z"),
  coverage: { insurer: "OSDE", planName: "310", memberId: "AF-998877" },
  emergency: [{ name: "Marta Gómez", relation: "Madre", phone: "+54 11 5555-0002" }],
  assignedPractitionerName: "Juan Kine",
  nextBookingAt: new Date("2030-01-10T13:00:00Z"),
  access: "admin",
};

// Centinelas: si un campo clínico llegara en la fila (redacción rota en el
// server), la UI administrativa igual no lo pinta.
const CLINICAL = ["LUMBALGIA_SECRETA", "DESC_SECRETA", "NOTA_SECRETA"];

function booking(over: Partial<PatientBookingFull>): PatientBookingFull {
  return {
    id: "bk_1",
    tenantId: "t1",
    patientId: admin.id,
    practitionerId: "pr_1",
    serviceId: "sv_1",
    scheduledFor: new Date("2026-09-01T13:00:00Z"),
    durationMin: 45,
    copagoCents: 250000,
    status: "COMPLETED",
    paymentStatus: "UNPAID",
    insurerPaidAt: null,
    title: CLINICAL[0],
    description: CLINICAL[1],
    notes: CLINICAL[2],
    serviceName: "Kinesiología",
    obraSocial: "OSDE",
    osAmountCents: 800000,
    updatedAt: new Date("2026-09-01T12:00:00Z"),
    createdAt: new Date("2026-08-01T12:00:00Z"),
    ...over,
  } as unknown as PatientBookingFull;
}

const rows = [
  booking({ id: "bk_1", paymentStatus: "UNPAID" }),
  booking({ id: "bk_2", scheduledFor: new Date("2026-08-25T13:00:00Z"), paymentStatus: "PAID", insurerPaidAt: new Date() }),
];

function render(props: Partial<Parameters<typeof PatientAdminProfile>[0]> = {}) {
  return renderToStaticMarkup(
    <Providers>
      <PatientAdminProfile
        patient={admin}
        initialBookings={{ rows, hasMore: false, nextCursor: null }}
        canBook
        {...props}
      />
    </Providers>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}

const CLINICAL_TABS = ["Evoluciones", "EVA", "Evolución", "Plan", "Sesiones", "Seguimiento", "Archivos", "Antecedentes", "Actividad", "Facturación", "Resumen"];

/** Etiquetas de los botones de pestaña (la barra de tabs del perfil). */
function tabLabels(html: string) {
  return [...html.matchAll(/<button type="button"[^>]*>([^<]+)/g)].map((m) => m[1].trim());
}

describe("[P0-S07v] PatientAdminProfile", () => {
  it("solo pestañas Datos y Turnos; ninguna clínica", () => {
    expect(ADMIN_PROFILE_TABS).toEqual(["resumen", "turnos"]);
    const labels = tabLabels(render());
    expect(labels).toEqual(["Datos", "Turnos"]);
    for (const t of CLINICAL_TABS) expect(labels).not.toContain(t);
  });

  it("Datos: contacto, cobertura, emergencia y a cargo; sin plan ni acciones de HC", () => {
    const html = render();
    for (const s of ["Lucía Gómez", "30111222", "lucia@example.com", "+54 11 5555-0001", "15/03/1990", "OSDE", "310", "AF-998877", "Marta Gómez", "Madre", "+54 11 5555-0002", "Juan Kine"]) {
      expect(html).toContain(s);
    }
    // Copago pendiente: solo bk_1 (COMPLETED, UNPAID).
    expect(html).toContain("1 turno");
    // Nada de plan (el título/estado del plan es HC) ni acciones que exigen full.
    for (const s of ["Plan activo", "Sin plan", "Plan pausado", "Editar", "Compartir", "Archivar", "portal", "HC-"]) {
      expect(html).not.toContain(s);
    }
    for (const s of CLINICAL) expect(html).not.toContain(s);
  });

  it("Turnos: estado del turno y de cobro, sin título/descripción/notas", async () => {
    // PF1.1 (C-PF2): Turnos es diferida (`next/dynamic` con SSR). `renderToStaticMarkup` no espera Suspense: el
    // primer render dispara la carga y pinta el skeleton; una vez resuelto el chunk, el segundo pinta la tabla
    // (en Next el SSR sí la espera: `?tab=turnos` sale completo en el HTML).
    expect(render({ initialTab: "turnos" })).toContain('aria-busy="true"');
    await import("@/components/patients/profile/views/turnos-view");
    await new Promise((r) => setTimeout(r, 0));
    const html = render({ initialTab: "turnos" });
    expect(html.match(/data-testid="turno-row"/g)?.length).toBe(2);
    expect(html).not.toContain("admin-turno-row");
    expect(html).toContain("Kinesiología");
    expect(html).toContain("Cobrado");
    expect(html).toContain("Pendiente");
    expect(html).toContain("Ver en agenda");
    for (const s of CLINICAL) expect(html).not.toContain(s);
    // Sin operaciones que el nivel admin no tiene en el perfil.
    for (const s of ["Eliminar", "Marcar hecho", "Confirmar"]) expect(html).not.toContain(s);
  });

  it("Agregar turno solo con agenda.operateAll (BILLING no)", () => {
    expect(render({ canBook: true })).toContain("Agregar turno");
    expect(render({ canBook: false })).not.toContain("Agregar turno");
  });
});

describe("[P0-S07v] página del paciente con nivel admin", () => {
  beforeEach(() => {
    for (const f of Object.values(data)) f.mockReset();
    entitlements.current = { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false };
    data.getPatientCore.mockResolvedValue(admin);
    data.getPatientPlans.mockResolvedValue({ ok: true, data: [] });
    data.getPatientPlanBalances.mockResolvedValue({
      ok: true,
      data: { plans: [], totals: { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 } },
    });
    data.getPatientBookingsAll.mockResolvedValue({ rows, hasMore: false, nextCursor: null });
  });

  it("renderiza el perfil administrativo sin pedir slices clínicos", async () => {
    data.getCapabilities.mockResolvedValue(capabilitiesFor("ASSISTANT"));
    const el = await PatientPage({ params: { id: admin.id } });
    const html = renderToStaticMarkup(<Providers>{el}</Providers>);

    expect(html).toContain("Ficha administrativa");
    expect(html).toContain("+54 11 5555-0001");
    expect(html).not.toContain("Sin acceso");
    expect(html).toContain("Agregar turno");
    expect(tabLabels(html)).toEqual(["Datos", "Turnos"]);

    expect(data.getPatientBookingsAll).toHaveBeenCalledWith(admin.id, 100);
    // Planes en proyección `admin` (sin título): sí, para agrupar Turnos (H1 de S22f).
    expect(data.getPatientPlans).toHaveBeenCalledWith({ patientId: admin.id });
    expect(data.getPatientPlanBalances).toHaveBeenCalledWith({ patientId: admin.id });
    for (const f of [
      data.getPatientEvaScores,
      data.getPatientBookingsSummary,
      data.getPatientBillableCount,
      data.listInsurers,
      data.runWithRls,
    ]) {
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("BILLING: mismo perfil, sin Agregar turno", async () => {
    data.getCapabilities.mockResolvedValue(capabilitiesFor("BILLING"));
    const el = await PatientPage({ params: { id: admin.id } });
    const html = renderToStaticMarkup(<Providers>{el}</Providers>);
    expect(html).toContain("Ficha administrativa");
    expect(html).not.toContain("Agregar turno");
  });

  it("basic sigue en la vista básica (sin turnos ni capabilities)", async () => {
    data.getPatientCore.mockResolvedValue({
      id: admin.id,
      firstName: "Lucía",
      lastName: "Gómez",
      documentId: null,
      nextBookingAt: null,
      access: "basic",
    });
    const el = await PatientPage({ params: { id: admin.id } });
    const html = renderToStaticMarkup(<Providers>{el}</Providers>);
    expect(html).toContain("Sin acceso");
    expect(data.getPatientBookingsAll).not.toHaveBeenCalled();
    expect(data.getPatientPlans).not.toHaveBeenCalled();
    expect(data.getPatientPlanBalances).not.toHaveBeenCalled();
  });
});

// ─── S22b: perfil completo — qué pide la página según los módulos ───────────

describe("[S22b] página del paciente con acceso full", () => {
  const full = { ...admin, access: "full", coverages: [], emergency: [], diagnosisTitle: null };

  beforeEach(() => {
    for (const f of Object.values(data)) f.mockReset();
    data.getPatientCore.mockResolvedValue(full);
    data.getPatientPlans.mockResolvedValue({ ok: true, data: [] });
    data.getPatientPlanBalances.mockResolvedValue({
      ok: true,
      data: { plans: [], totals: { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 } },
    });
    data.getPatientBookingsSummary.mockResolvedValue([]);
    data.getPatientBillableCount.mockResolvedValue(0);
    data.getPatientEvaScores.mockResolvedValue([]);
    data.listInsurers.mockResolvedValue([]);
    // Única llamada: profesionales (PL-1: la membresía sale del Actor).
    data.runWithRls.mockResolvedValueOnce([]);
  });

  /** El `PatientProfile` que arma la página (sin renderizar vistas de otras sesiones). */
  function profileProps(el: unknown): Record<string, unknown> {
    const kids = (el as ReactElement<{ children: ReactNode }>).props.children as ReactNode[];
    const profile = kids.find((k) => isValidElement(k) && (k.props as Record<string, unknown>).patientCore);
    return (profile as ReactElement<Record<string, unknown>>).props;
  }

  it("consultorio General: no pide planes, saldos ni EVA", async () => {
    entitlements.current = { vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false };
    const props = profileProps(await PatientPage({ params: { id: admin.id } }));
    expect(data.getPatientPlans).not.toHaveBeenCalled();
    expect(data.getPatientPlanBalances).not.toHaveBeenCalled();
    expect(data.getPatientEvaScores).not.toHaveBeenCalled();
    expect(props.initialPlans).toEqual([]);
    expect(props.initialPlanBalances).toBeNull();
    expect(props.evaScores).toEqual([]);
  });

  it("Kinesiología: pide planes y saldos con getPatientPlans/getPatientPlanBalances", async () => {
    entitlements.current = { vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false };
    const props = profileProps(await PatientPage({ params: { id: admin.id } }));
    expect(data.getPatientPlans).toHaveBeenCalledWith({ patientId: admin.id });
    expect(data.getPatientPlanBalances).toHaveBeenCalledWith({ patientId: admin.id });
    expect(data.getPatientEvaScores).toHaveBeenCalledWith(admin.id);
    expect(props.role).toBe("PRACTITIONER");
    expect(props.capabilities).toEqual(expect.arrayContaining(["plans.manage", "clinical.read"]));
  });

  it("deep-link C10: ?tab=plan&nuevo=1&turno= → tab normalizada e intent new", async () => {
    const props = profileProps(
      await PatientPage({ params: { id: admin.id }, searchParams: { tab: "plan", nuevo: "1", turno: "bk_9" } })
    );
    expect(props.initialTab).toBe("planes");
    expect(props.planIntent).toEqual({ kind: "new", fromBookingId: "bk_9", prefill: null, prefillInvalid: false });
  });

  it("error de getPatientPlans: llega a la pestaña, sin planes", async () => {
    data.getPatientPlans.mockResolvedValue({ ok: false, error: "No tenés acceso a este paciente." });
    const props = profileProps(await PatientPage({ params: { id: admin.id } }));
    expect(props.initialPlans).toEqual([]);
    expect(props.initialPlansError).toBe("No tenés acceso a este paciente.");
  });
});
