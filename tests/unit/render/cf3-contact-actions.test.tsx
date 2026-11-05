/**
 * [CF3-SHU] Render por rol del teléfono del perfil (D-CF3-8) con los componentes reales: hero `full`, hero y «Datos»
 * `admin` (Secretaria), vista `basic`; el panel del menú (`ContactMenuView`) con el modelo real; y el menú por fila de
 * Turnos. Se mockean solo los módulos de server actions (red) y el router.
 *
 * El menú en sí no se abre en un render estático: lo que se fija acá es (a) quién ve el botón, (b) qué pinta el panel
 * con un bundle dado (sin PHI) y (c) qué filas de Turnos tienen el compartir. Que el panel sea un chunk aparte lo fija
 * `cf3-contact-actions-guard.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/patients", () => ({
  sendPatientPortalInvite: vi.fn(),
  setPatientArchived: vi.fn(),
  assignPatientToPractitioner: vi.fn(),
  getPatientBookingsAll: vi.fn(),
}));
vi.mock("@/lib/booking-share-actions", () => ({ getPatientShareBundle: vi.fn(), getPatientShareContact: vi.fn() }));
vi.mock("@/lib/bookings", () => ({ setBookingStatus: vi.fn(), deleteBooking: vi.fn() }));
vi.mock("@/lib/plans-read", () => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
vi.mock("@/lib/clinical-notes-read", () => ({ getPatientClinicalSummary: vi.fn() }));

import { PatientHero, PatientAdminHero } from "@/components/patients/profile/hero";
import { PatientBasicView } from "@/components/patients/patient-basic-view";
import { ContactMenuView } from "@/components/patients/contact-actions";
import { contactMenuModel, CONTACT_MENU_COPY as C } from "@/components/patients/contact-actions-logic";
import { TurnosView } from "@/components/patients/profile/views/turnos-view";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { phoneActionsFor } from "@/lib/booking-share";
import type { PatientAdminCore, PatientBookingFull } from "@/lib/patients-types";
import type { PatientWithRelations } from "@/components/patients/profile/types";
import type { PatientShareBundleVisible } from "@/lib/patient-share-types";

const SECRET = ["LUMBALGIA_SECRETA", "NOTA_SECRETA", "DESC_SECRETA"];
const wrap = (n: ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{n}</ConfirmProvider>
    </ToastProvider>
  );
const count = (html: string, s: string) => html.split(s).length - 1;

const fullPatient = {
  id: "pat_full",
  firstName: "Juan",
  lastName: "Pérez",
  documentId: "30111222",
  phone: "11 5555-0001",
  email: "juan@example.com",
  assignedPractitionerId: null,
  archivedAt: null,
  userId: null,
  updatedAt: new Date("2026-09-01T12:00:00Z"),
  diagnosisTitle: SECRET[0],
  bookings: [],
  coverages: [],
} as unknown as PatientWithRelations;

const adminPatient: PatientAdminCore = {
  id: "pat_admin",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: "30111222",
  email: "lucia@example.com",
  phone: "+54 11 5555-0001",
  dateOfBirth: null,
  coverage: null,
  emergency: [],
  assignedPractitionerName: null,
  nextBookingAt: null,
  updatedAt: new Date("2026-09-01T12:00:00Z"),
  access: "admin",
};

describe("[CF3-SHU] el teléfono por rol", () => {
  it("[CF3-SHU-17] full: el teléfono es un botón de menú con el ícono de WhatsApp", () => {
    const html = wrap(
      <PatientHero
        patient={fullPatient}
        age={40}
        coverageLabel="Particular"
        plans={[]}
        plansEnabled={false}
        insurers={[]}
        practitioners={[]}
        canReassign={false}
      />
    );
    expect(count(html, 'data-testid="patient-phone-action"')).toBe(1);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Contactar al paciente: 11 5555-0001"');
    expect(html).toContain("#25D366");
    // Cerrado: nada del menú (ni la lectura) en el HTML.
    expect(html).not.toContain('data-testid="contact-menu"');
    expect(html).not.toContain(SECRET[0]);
  });

  it("[CF3-SHU-18] admin (Secretaria): botón en el hero; sin teléfono, «—» y sin botón", () => {
    expect(wrap(<PatientAdminHero patient={adminPatient} canBook />)).toContain('data-testid="patient-phone-action"');
    const none = wrap(<PatientAdminHero patient={{ ...adminPatient, phone: null }} canBook />);
    expect(none).not.toContain('data-testid="patient-phone-action"');
  });

  it("[CF3-SHU-19] basic: ni teléfono ni botón", () => {
    const html = wrap(
      <PatientBasicView patient={{ id: "pat_b", firstName: "Ana", lastName: "Ruiz", documentId: "1", nextBookingAt: null }} />
    );
    expect(html).not.toContain('data-testid="patient-phone-action"');
    expect(html).not.toContain("5555");
  });
});

describe("[CF3-SHU] panel del menú", () => {
  const pa = phoneActionsFor("11 5555-0001");
  const bundle: PatientShareBundleVisible = {
    contact: { status: "ok", e164: pa.e164!, phone: pa },
    firstName: "Juan",
    clinicName: "Consultorio Pérez",
    turneroUrl: "https://app.example.com/turnos/consultorio-perez",
    upcoming: [
      {
        bookingId: "bk_1",
        startsAt: "2026-11-10T13:00:00.000Z",
        serviceName: "Kinesiología",
        practitionerName: "Ana López",
        durationMin: 45,
        locationName: null,
        telemedicineUrl: null,
        canPaymentLink: true,
        // Como si el server mandara de más por error: no se pinta ni viaja.
        ...({ title: SECRET[0], notes: SECRET[1] } as object),
      },
    ],
    canPaymentLink: true,
    canPortalInvite: true,
  };
  const view = (state: Parameters<typeof ContactMenuView>[0]["state"]) =>
    wrap(<ContactMenuView id="m1" state={state} onItem={() => {}} onCopy={() => {}} onClose={() => {}} />);

  it("[CF3-SHU-20] listo: menú accesible con las acciones y «Copiar» al lado de cada mensaje, sin PHI", () => {
    const model = contactMenuModel(bundle, { displayedPhone: "11 5555-0001", paymentLinkAvailable: true, portalInviteAvailable: true });
    const html = view({ status: "ready", model });
    expect(html).toContain('role="menu"');
    expect(html).toContain(`aria-label="${C.menuLabel}"`);
    for (const l of [C.chat, C.call, C.copyPhone, C.reminder, C.turnero, C.paymentLink, C.portalInvite]) expect(html).toContain(l);
    // Recordatorio y turnero llevan su «Copiar».
    expect(count(html, 'data-item="reminder-copy"')).toBe(1);
    expect(count(html, 'data-item="turnero-copy"')).toBe(1);
    expect(html.match(/role="menuitem"/g)?.length).toBe(9);
    for (const s of SECRET) expect(html).not.toContain(s);
  });

  it("[CF3-SHU-21] cargando y hidden: lo dice", () => {
    expect(view({ status: "loading" })).toContain('aria-busy="true"');
    const hidden = contactMenuModel({ contact: { status: "hidden" } }, { displayedPhone: null, paymentLinkAvailable: true, portalInviteAvailable: true });
    const html = view({ status: "ready", model: hidden });
    expect(html).toContain(C.hiddenTitle);
    expect(html).not.toContain('role="menuitem"');
  });
});

describe("[CF3-SHU] Turnos: compartir por fila", () => {
  const FUTURE = new Date(Date.now() + 5 * 86_400_000);
  const PAST = new Date(Date.now() - 5 * 86_400_000);
  const bk = (over: Partial<PatientBookingFull>) =>
    ({
      id: "bk_x",
      tenantId: "t1",
      patientId: "pat_admin",
      practitionerId: "pr_1",
      practitionerName: "Ana López",
      serviceId: "sv_1",
      serviceName: "Kinesiología",
      scheduledFor: FUTURE,
      durationMin: 45,
      copagoCents: 0,
      osAmountCents: 0,
      obraSocial: "Particular",
      status: "CONFIRMED",
      paymentStatus: "UNPAID",
      insurerPaidAt: null,
      title: SECRET[0],
      notes: SECRET[1],
      description: SECRET[2],
      updatedAt: new Date("2026-09-01T12:00:00Z"),
      createdAt: new Date("2026-09-01T12:00:00Z"),
      ...over,
    }) as unknown as PatientBookingFull;
  const common = { patientId: "pat_admin", loading: false, patchBooking: () => {}, dropBooking: () => {} };

  it("[CF3-SHU-22] admin: la fila futura tiene «Opciones» (menú); pasada y cancelada siguen con «Ver en agenda»", () => {
    const html = wrap(
      <TurnosView
        {...common}
        admin
        bookings={[bk({ id: "f1" }), bk({ id: "p1", scheduledFor: PAST, status: "COMPLETED" }), bk({ id: "c1", status: "CANCELLED" })]}
      />
    );
    expect(count(html, `aria-label="${C.rowMenuLabel}"`)).toBe(1);
    expect(count(html, ">Ver en agenda<")).toBe(2);
    expect(html).not.toContain("Acciones del turno");
    for (const s of SECRET) expect(html).not.toContain(s);
  });

  it("[CF3-SHU-23] full: el menú ⋯ sigue siendo el de siempre (el compartir va adentro)", () => {
    const html = wrap(<TurnosView {...common} bookings={[bk({ id: "f1" })]} />);
    expect(html).toContain('aria-label="Acciones del turno"');
    expect(html).toContain('aria-haspopup="menu"');
  });
});
