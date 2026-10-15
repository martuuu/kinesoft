/**
 * [EV2-3a] Perfil del paciente: pestaña «Evoluciones», línea de tiempo y «Última evolución» de Resumen.
 *
 * Render estático (`renderToStaticMarkup`) de los componentes reales: `PatientProfile` (pestañas por acceso),
 * `EvolucionesView` (con `initialPage`, porque el efecto de carga no corre en render estático) y `ResumenView`. Se
 * mockean solo las server actions (red). Permisos de cada nota armados con el `permissionsFor` real. Fechas afirmadas
 * en hora AR: corre igual en TZ=UTC y TZ=AR.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/plans-read", () => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
  voidClinicalNote: async () => ({ ok: false, error: "x" }),
}));
const read = vi.hoisted(() => ({
  getPatientTimeline: vi.fn(async () => null),
  getBookingClinicalNote: vi.fn(async () => null),
  getClinicalNoteHistory: vi.fn(async () => null),
  getPatientClinicalSummary: vi.fn(async () => null),
}));
vi.mock("@/lib/clinical-notes-read", () => read);

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { PatientProfile } from "@/components/patients/patient-profile";
import {
  EvolucionesView,
  addAmendmentToItems,
  insertNoteInItems,
  replaceNoteInItems,
  sessionDetailLine,
} from "@/components/patients/profile/views/evoluciones-view";
import { ResumenView, latestNoteExcerpt } from "@/components/patients/profile/views/resumen-view";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import { modulesFor } from "@/lib/tenant-modules";
import type { ClinicalNoteDTO, TimelineItem, TimelineSessionDTO } from "@/lib/clinical-notes-types";
import type { PatientCore } from "@/lib/patients-types";
import type { PatientWithRelations } from "@/components/patients/profile/types";
import type { Capability } from "@/lib/capabilities";

const GENERAL = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false });
const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });

const render = (el: ReactElement, modules = KINE) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={modules}>
      <ToastProvider>
        <ConfirmProvider>{el}</ConfirmProvider>
      </ToastProvider>
    </TenantModulesProvider>
  );
const noop = () => {};

const ME = "user-me";
const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR
const PID = "pat_000000abcdef";

function note(over: Partial<ClinicalNoteDTO> = {}, ctx: { actor?: string; canWrite?: boolean } = {}): ClinicalNoteDTO {
  const n: ClinicalNoteDTO = {
    id: "note-1",
    patientId: PID,
    bookingId: "bk-1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control de hombro",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-14T12:30:00.000Z",
    author: { userId: ME, practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-14T13:00:00.000Z",
    updatedAt: "2026-10-14T13:00:00.000Z",
    voided: null,
    booking: { id: "bk-1", scheduledFor: "2026-10-14T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    ...over,
  };
  n.permissions = permissionsFor(
    {
      authorUserId: n.author.userId,
      createdAt: new Date(n.createdAt),
      voidedAt: n.voided ? new Date(n.voided.at) : null,
      amendsNoteId: n.amendsNoteId,
    },
    { actorUserId: ctx.actor ?? ME, isClinicalOwner: false, canWrite: ctx.canWrite ?? true, now: NOW }
  );
  return n;
}

function session(over: Partial<TimelineSessionDTO> = {}): TimelineSessionDTO {
  return {
    id: "ses-1",
    programId: "prog-1",
    programTitle: "Rehabilitación de hombro",
    completedAt: "2026-10-14T13:15:00.000Z",
    bookingId: "bk-1",
    notes: "Tolera bien la carga.",
    rpe: 6,
    paInPre: 7,
    paInPost: 4,
    exercisesDone: 8,
    exercisesTotal: 10,
    ...over,
  };
}

const noteItem = (n: ClinicalNoteDTO, amendments: ClinicalNoteDTO[] = [], s: TimelineSessionDTO | null = null): TimelineItem => ({
  type: "note",
  key: `n:${n.id}`,
  at: n.occurredAt,
  note: n,
  amendments,
  session: s,
});
const sessionItem = (s: TimelineSessionDTO): TimelineItem => ({ type: "session", key: `s:${s.id}`, at: s.completedAt, session: s });

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}
function tabLabels(html: string) {
  return [...html.matchAll(/<button type="button" data-profile-tab="[^"]+"[^>]*>([^<]+)/g)].map((m) => m[1].trim());
}

// ─── Pestañas por acceso ─────────────────────────────────────────────────────────────────────────────────────────

const core = {
  id: PID,
  tenantId: "t1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: null,
  dateOfBirth: null,
  phone: null,
  email: null,
  notes: "Alérgica al ibuprofeno.",
  diagnosisTitle: null,
  assignedPractitionerId: null,
  coverages: [],
  emergency: [],
  archivedAt: null,
  portalUserId: null,
  userId: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-09-01T12:00:00Z"),
} as unknown as PatientCore;

function profile(capabilities: Capability[], over: Partial<Parameters<typeof PatientProfile>[0]> = {}, modules = KINE) {
  return render(
    <PatientProfile
      patientCore={core}
      recentBookings={[]}
      billableCount={0}
      evaScores={[]}
      capabilities={capabilities}
      role="OWNER"
      {...over}
    />,
    modules
  );
}

describe("[EV2-3a] pestañas del perfil por acceso", () => {
  it("profesional con clinical.read: «Evoluciones» segunda, con el contador de vivas; la curva se llama «EVA»", () => {
    const html = profile(["clinical.read"], { clinicalSummary: { latest: note(), liveCount: 3 } });
    expect(tabLabels(html)).toEqual([
      "Resumen", "Evoluciones", "Turnos", "Sesiones", "Planes", "Archivos", "Antecedentes", "EVA", "Facturación", "Actividad",
    ]);
    expect(html).toMatch(/data-profile-tab="evoluciones"[^>]*>Evoluciones<span[^>]*>3</);
  });

  it("Titular sin agenda (acceso full, sin clinical.read): no hay Evoluciones aunque llegue un resumen ni ?tab=evoluciones", () => {
    const html = profile(["account.owner", "tenant.admin"] as Capability[], {
      clinicalSummary: { latest: note(), liveCount: 3 },
      initialTab: "evoluciones",
    });
    expect(tabLabels(html)).not.toContain("Evoluciones");
    expect(html).toMatch(/data-profile-tab="resumen" aria-current="true"/);
    // Tampoco la card de Resumen (sería HC).
    expect(html).not.toContain("Última evolución");
    expect(html).not.toContain("Control de hombro");
  });

  it("consultorio General con clinical.read: Evoluciones es del núcleo (sí), EVA no", () => {
    const html = profile(["clinical.read"], {}, GENERAL);
    expect(tabLabels(html)).toEqual(["Resumen", "Evoluciones", "Turnos", "Archivos", "Antecedentes", "Facturación", "Actividad"]);
  });

  it("Resumen del perfil: «Última evolución» + «Notas generales» (ya no «Notas clínicas»)", () => {
    const html = profile(["clinical.read"], { clinicalSummary: { latest: note(), liveCount: 3 } });
    expect(html).toContain("Última evolución");
    expect(html).toContain("Control de hombro");
    expect(html).toContain("Ver las 3 evoluciones");
    expect(html).toContain("Notas generales");
    expect(html).toContain("Alérgica al ibuprofeno.");
    expect(html).not.toContain("Notas clínicas");
  });
});

// ─── Resumen ──────────────────────────────────────────────────────────────────────────────────────────────────────

const patient = { ...core, bookings: [], evaScores: [] } as unknown as PatientWithRelations;
const planPerms = { manage: false, schedule: false } as unknown as Parameters<typeof ResumenView>[0]["permissions"];

describe("[EV2-3a] ResumenView: Última evolución", () => {
  const resumen = (props: Partial<Parameters<typeof ResumenView>[0]>) =>
    render(
      <ResumenView patient={patient} plan={null} diagnosisName={null} permissions={planPerms} onOpenEditor={noop} {...props} />,
      GENERAL
    );

  it("sin resumen (sin módulo o sin acceso) no hay card", () => {
    expect(resumen({ clinicalSummary: null })).not.toContain("Última evolución");
  });

  it("sin evoluciones: lo dice, y lleva a la pestaña", () => {
    const html = resumen({ clinicalSummary: { latest: null, liveCount: 0 }, onOpenEvoluciones: noop });
    expect(html).toContain("Todavía no hay evoluciones.");
    expect(buttons(html)).toContain("Ir a Evoluciones");
  });

  it("con evolución: tipo, fecha AR, título, extracto y autor", () => {
    const html = resumen({
      clinicalSummary: { latest: note({ kind: "FIRST_VISIT", body: "palabra ".repeat(80) }), liveCount: 1 },
      onOpenEvoluciones: noop,
    });
    expect(html).toContain("Primera consulta");
    expect(html).toContain("09:30"); // 12:30 UTC = 09:30 AR
    expect(html).toContain("Control de hombro");
    expect(html).toContain("Lic. Pérez");
    expect(html).toContain("…");
    expect(buttons(html)).toContain("Ir a Evoluciones");
  });

  it("latestNoteExcerpt corta en una palabra y no toca textos cortos", () => {
    expect(latestNoteExcerpt("  corto  ")).toBe("corto");
    const out = latestNoteExcerpt("abc ".repeat(100), 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
    expect(out).not.toMatch(/ …$/);
  });
});

// ─── Línea de tiempo ─────────────────────────────────────────────────────────────────────────────────────────────

describe("[EV2-3a] EvolucionesView: línea de tiempo", () => {
  const view = (props: Partial<Parameters<typeof EvolucionesView>[0]> = {}) =>
    render(<EvolucionesView patientId={PID} canWrite now={NOW} {...props} />);

  it("notas con enmiendas, anuladas colapsadas con motivo, sesión del turno adentro y sesión suelta", () => {
    const root = note();
    const amendment = note({
      id: "note-2",
      amendsNoteId: "note-1",
      title: null,
      body: "Agrego: dolor nocturno.",
      createdAt: "2026-10-15T10:00:00.000Z",
      occurredAt: "2026-10-15T10:00:00.000Z",
    });
    const voided = note({
      id: "note-3",
      bookingId: null,
      booking: null,
      title: "Cargada por error",
      occurredAt: "2026-10-10T12:00:00.000Z",
      voided: { at: "2026-10-10T13:00:00.000Z", byUserId: ME, reason: "Paciente equivocado" },
    });
    const loose = session({ id: "ses-2", bookingId: "bk-9", completedAt: "2026-10-12T15:00:00.000Z", notes: null, rpe: null, paInPre: null, paInPost: null });
    const html = view({
      initialPage: {
        items: [noteItem(root, [amendment], session()), sessionItem(loose), noteItem(voided)],
        nextCursor: "cursor-2",
      },
    });
    // Orden del server, intacto.
    expect([...html.matchAll(/data-timeline-item="(\w+)"/g)].map((m) => m[1])).toEqual(["note", "session", "note"]);
    // Raíz + enmienda debajo.
    expect(html).toContain('data-note-id="note-1"');
    expect(html).toContain('data-note-id="note-2"');
    expect(html).toContain("Agrego: dolor nocturno.");
    expect(html).toContain("Enmienda");
    // Anulada: colapsada con motivo.
    expect(html).toMatch(/data-note-id="note-3" data-voided=""/);
    expect(html).toContain("Anulada");
    expect(html).toContain("Paciente equivocado");
    // Sesión del turno dentro de la nota, con su detalle; la suelta como tarjeta propia.
    expect(html).toContain("Sesión registrada · Rehabilitación de hombro");
    expect(html).toContain("8/10 ejercicios · RPE 6 · EVA 7 → 4");
    expect(html).toContain("Tolera bien la carga.");
    expect(html).toMatch(/data-session-id="ses-2"[\s\S]*Sesión del plan · Rehabilitación de hombro/);
    // Paginado y acciones de la pestaña.
    const b = buttons(html);
    expect(b).toContain("Cargar más");
    expect(b).toContain("Nueva evolución");
    expect(html).toMatch(/href="\/pacientes\/pat_000000abcdef\/imprimir"[^>]*target="_blank"[^>]*>Imprimir historia clínica</);
    expect(html).toContain('aria-label="Buscar en las evoluciones"');
  });

  it("sin escritura (no es profesional): sin «Nueva evolución» ni acciones en las tarjetas; imprimir sí", () => {
    const n = note({}, { canWrite: false });
    const html = view({ canWrite: false, initialPage: { items: [noteItem(n)], nextCursor: null } });
    const b = buttons(html);
    expect(b).not.toContain("Nueva evolución");
    expect(b).not.toContain("Agregar enmienda");
    expect(b).not.toContain("Anular");
    expect(b).not.toContain("Cargar más");
    expect(html).toContain("Imprimir historia clínica");
  });

  it("vacía: lo dice y sugiere cómo cargar la primera (solo a quien escribe)", () => {
    expect(view({ initialPage: { items: [], nextCursor: null } })).toContain("Cargá la primera con «Nueva evolución»");
    const ro = view({ canWrite: false, initialPage: { items: [], nextCursor: null } });
    expect(ro).toContain("Todavía no hay evoluciones de este paciente.");
    expect(ro).not.toContain("Cargá la primera");
  });

  it("antes de la primera respuesta muestra «Cargando» (sin lista vacía engañosa)", () => {
    const html = view();
    expect(html).toContain("Cargando evoluciones…");
    expect(html).not.toContain("Todavía no hay evoluciones");
  });
});

describe("[EV2-3a] helpers de la línea de tiempo", () => {
  it("insertNoteInItems: absorbe la sesión suelta de su turno y respeta el orden", () => {
    const s = session({ id: "ses-5", bookingId: "bk-5", completedAt: "2026-10-13T12:00:00.000Z" });
    const old = note({ id: "note-old", bookingId: null, booking: null, occurredAt: "2026-10-01T12:00:00.000Z" });
    const items = [sessionItem(s), noteItem(old)];
    const created = note({ id: "note-new", bookingId: "bk-5", occurredAt: "2026-10-13T11:00:00.000Z" });
    const out = insertNoteInItems(items, created, false);
    expect(out.map((i) => i.key)).toEqual(["n:note-new", "n:note-old"]);
    expect(out[0].type === "note" && out[0].session?.id).toBe("ses-5");
  });

  it("insertNoteInItems: si cae más atrás de lo cargado y hay más páginas, no la inserta (viene con «Cargar más»)", () => {
    const items = [noteItem(note({ id: "a", occurredAt: "2026-10-10T12:00:00.000Z" }))];
    const older = note({ id: "b", bookingId: null, booking: null, occurredAt: "2026-09-01T12:00:00.000Z" });
    expect(insertNoteInItems(items, older, true)).toBe(items);
    expect(insertNoteInItems(items, older, false).map((i) => i.key)).toEqual(["n:a", "n:b"]);
  });

  it("replaceNoteInItems: reemplaza raíz o enmienda por id y reubica si cambió la fecha", () => {
    const a = note({ id: "a", occurredAt: "2026-10-10T12:00:00.000Z" });
    const b = note({ id: "b", occurredAt: "2026-10-05T12:00:00.000Z" });
    const am = note({ id: "am", amendsNoteId: "b", body: "viejo" });
    const items = [noteItem(a), noteItem(b, [am])];
    const moved = replaceNoteInItems(items, { ...b, occurredAt: "2026-10-12T12:00:00.000Z" });
    expect(moved.map((i) => i.key)).toEqual(["n:b", "n:a"]);
    const amended = replaceNoteInItems(items, { ...am, body: "nuevo" });
    expect(amended[1].type === "note" && amended[1].amendments[0].body).toBe("nuevo");
  });

  it("addAmendmentToItems: al final de su raíz, sin duplicar", () => {
    const r = note({ id: "r" });
    const am = note({ id: "am1", amendsNoteId: "r" });
    const once = addAmendmentToItems([noteItem(r)], am);
    const twice = addAmendmentToItems(once, am);
    expect(twice[0].type === "note" && twice[0].amendments.map((x) => x.id)).toEqual(["am1"]);
  });

  it("sessionDetailLine: omite lo que no se cargó", () => {
    expect(sessionDetailLine(session())).toBe("8/10 ejercicios · RPE 6 · EVA 7 → 4");
    expect(sessionDetailLine(session({ exercisesTotal: 0, rpe: null, paInPre: null, paInPost: 3 }))).toBe("EVA — → 3");
    expect(sessionDetailLine(session({ exercisesTotal: 0, rpe: null, paInPre: null, paInPost: null }))).toBe("");
  });
});

// La página es un Server Component (no se renderiza acá): se fija en el fuente que el resumen de HC se pide UNA vez y
// solo en la rama `full`, después de los cortes `admin` (Secretaria/Facturación) y básico.
describe("[EV2-3a] page.tsx: getPatientClinicalSummary solo en el perfil full", () => {
  it("una sola llamada, después de los returns de admin y básico", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/pacientes/[id]/page.tsx", "utf8");
    const calls = [...src.matchAll(/getPatientClinicalSummary\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(src.indexOf('if (core.access === "admin")'));
    expect(calls[0]).toBeGreaterThan(src.indexOf('if (core.access !== "full")'));
  });
});
