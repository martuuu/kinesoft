/**
 * [EV2-3c] Toast «Cargar evolución» al marcar «Atendido» en Recepción (agenda) y en /sala (Tablero y escritorio).
 *
 * Render estático (sin jsdom): el hook real (`useAttendedNoteToast`) se monta en un harness que llama al callback
 * con la fila confirmada por el server, con el `useToast` y el router mockeados (solo la red/framework: el hook y
 * la regla pura son los reales). Un caso por rol: profesional, OWNER que atiende (propio y ajeno), Secretaria,
 * ADMIN y BILLING; y los bordes (invitado, otra acción, el server no lo dejó COMPLETED, módulo apagado).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const success = vi.fn();
const push = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success, error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }) }));

import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { useAttendedNoteToast } from "@/components/agenda/reception/use-attended-note-toast";
import {
  ATTENDED_NOTE_TOAST,
  attendedNoteHref,
  offersAttendedNoteToast,
} from "@/components/agenda/reception/attended-note-toast";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { ReceptionAction } from "@/lib/reception-state";
import type { TenantModule } from "@/lib/tenant-modules";

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
function dto(over: Partial<BookingDTO> = {}): BookingDTO {
  return { id: "bk1", scheduledFor: iso("09:00"), durationMin: 45, status: "COMPLETED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat1", patientName: "Ana Pérez", patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: iso("09:50"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: iso("08:55"), attendingAt: iso("09:02"), calledAt: null, ...over };
}

type Viewer = { practitionerId: string | null; canReadClinical: boolean } | null;
function Harness({ viewer, action, saved }: { viewer: Viewer; action: ReceptionAction; saved: BookingDTO }) {
  const offer = useAttendedNoteToast(viewer);
  offer(action, saved);
  return null;
}
function run(viewer: Viewer, opts: { action?: ReceptionAction; saved?: BookingDTO; modules?: TenantModule[] } = {}) {
  const el = <Harness viewer={viewer} action={opts.action ?? "atendido"} saved={opts.saved ?? dto()} />;
  renderToStaticMarkup(opts.modules ? <TenantModulesProvider modules={opts.modules}>{el}</TenantModulesProvider> : el);
}

const PROFESIONAL = { practitionerId: "p1", canReadClinical: true };
const OWNER_QUE_ATIENDE = { practitionerId: "p1", canReadClinical: true };
// Secretaria/BILLING: sin `clinical.read` y, desde IAM-4a, `practitionerId` null.
const SECRETARIA = { practitionerId: null, canReadClinical: false };
// ADMIN: nunca clínico (`isClinicalMember`), aunque tenga agenda propia.
const ADMIN_CON_AGENDA = { practitionerId: "p9", canReadClinical: false };
// Titular que no atiende: sin `clinical.read` y sin practitionerId.
const TITULAR_SIN_AGENDA = { practitionerId: null, canReadClinical: false };

beforeEach(() => {
  success.mockClear();
  push.mockClear();
});

describe("[EV2-3c] toast «Cargar evolución» por rol", () => {
  it("profesional en su turno: toast con «Cargar evolución» → perfil con ?turno=", () => {
    run(PROFESIONAL);
    expect(success).toHaveBeenCalledTimes(1);
    const [title, opts] = success.mock.calls[0];
    expect(title).toBe(ATTENDED_NOTE_TOAST.title);
    expect(opts.description).toBe("Ana Pérez");
    expect(opts.id).toBe("attended-note:bk1");
    expect(opts.action.label).toBe("Cargar evolución");
    opts.action.onClick();
    expect(push).toHaveBeenCalledWith("/pacientes/pat1?tab=evoluciones&turno=bk1");
  });

  it("OWNER que atiende: en su turno sí; en el de otro profesional no", () => {
    run(OWNER_QUE_ATIENDE);
    expect(success).toHaveBeenCalledTimes(1);
    success.mockClear();
    run(OWNER_QUE_ATIENDE, { saved: dto({ practitionerId: "p2" }) });
    expect(success).not.toHaveBeenCalled();
  });

  it("Secretaria, ADMIN y Titular sin agenda: nunca", () => {
    for (const v of [SECRETARIA, ADMIN_CON_AGENDA, TITULAR_SIN_AGENDA]) {
      run(v, { saved: dto({ practitionerId: v.practitionerId ?? "p1" }) });
    }
    expect(success).not.toHaveBeenCalled();
  });

  it("sin viewer (la superficie no lo recibió): nunca", () => {
    run(null);
    expect(success).not.toHaveBeenCalled();
  });

  it("módulo `evoluciones` apagado: nunca", () => {
    run(PROFESIONAL, { modules: ["agenda", "pacientes", "facturacion", "obrasSociales"] });
    expect(success).not.toHaveBeenCalled();
    run(PROFESIONAL, { modules: ["agenda", "pacientes", "evoluciones"] });
    expect(success).toHaveBeenCalledTimes(1);
  });

  it("bordes: invitado, otras acciones y una fila que el server no dejó COMPLETED", () => {
    run(PROFESIONAL, { saved: dto({ patientId: null, patientName: "Juan Invitado" }) });
    for (const a of ["llego", "llamar", "en-atencion", "ausente", "deshacer"] as const) {
      run(PROFESIONAL, { action: a, saved: dto({ status: a === "ausente" ? "NO_SHOW" : "CONFIRMED" }) });
    }
    run(PROFESIONAL, { saved: dto({ status: "CONFIRMED" }) });
    expect(success).not.toHaveBeenCalled();
  });
});

describe("[EV2-3c] regla pura", () => {
  const on = { ...PROFESIONAL, evolucionesOn: true };
  it("offersAttendedNoteToast", () => {
    expect(offersAttendedNoteToast(on)).toBe(true);
    expect(offersAttendedNoteToast({ ...on, practitionerId: "" })).toBe(false);
    expect(offersAttendedNoteToast({ ...on, canReadClinical: false })).toBe(false);
    expect(offersAttendedNoteToast({ ...on, evolucionesOn: false })).toBe(false);
    expect(offersAttendedNoteToast(null)).toBe(false);
  });
  it("attendedNoteHref encodea el turno", () => {
    expect(attendedNoteHref(on, "atendido", { id: "a b", status: "COMPLETED", patientId: "pat1", practitionerId: "p1" })).toBe(
      "/pacientes/pat1?tab=evoluciones&turno=a%20b"
    );
  });
});
