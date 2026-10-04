// P0-S02u-perfil · Perfil coherente con varios planes.
//
// Bugs vivos (AUDIT `hero-plan-activo-falso`, y la parte de perfil de
// `varios-planes-activos-take1`): `activeProgram` caía a `programs[0]` aunque
// estuviera COMPLETED/CANCELLED, así que el hero decía "Plan activo" y Resumen
// mostraba un plan terminado como el vigente; con dos ACTIVE se veía uno solo
// sin aviso; y el badge de Sesiones contaba las sesiones de TODOS los planes
// mientras la vista listaba solo las del primero.
//
// Se renderiza el `PatientProfile` real (y `SesionesView` con lo que el perfil
// le pasa). Se mockean solo la red (server actions) y el router.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
// Al importar el perfil se cargan los módulos de server actions (`lib/session`,
// `lib/authz`…), que envuelven resolvers con `React.cache`: solo existe en el
// runtime de RSC. Se polyfillea como identidad; las actions no se invocan en
// un render estático, así que nada de servidor corre en el test.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import { PatientProfile, pickProfilePrograms } from "@/components/patients/patient-profile";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { SesionesView } from "@/components/patients/profile/views/sesiones-view";
import type { PatientCore, PatientProgramLite } from "@/lib/patients-types";
import type { PatientWithRelations } from "@/components/patients/profile/types";

const core = {
  id: "pat_000000abcdef",
  tenantId: "t1",
  firstName: "Lucía",
  lastName: "Gómez",
  documentId: null,
  dateOfBirth: null,
  phone: null,
  email: null,
  notes: null,
  assignedPractitionerId: null,
  coverages: [],
  emergency: null,
  archivedAt: null,
  portalUserId: null,
  userId: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-09-01T12:00:00Z"),
} as unknown as PatientCore;

let seq = 0;
function program(
  status: PatientProgramLite["status"],
  createdAt: string,
  title: string,
  sessions = 2,
  done = 0,
): PatientProgramLite {
  const id = `prog_${++seq}`;
  return {
    id,
    title,
    status,
    totalSessions: sessions,
    frequency: 2,
    startDate: new Date(createdAt),
    createdAt: new Date(createdAt),
    sessions: Array.from({ length: sessions }, (_, i) => ({
      id: `${id}_s${i + 1}`,
      index: i + 1,
      scheduledFor: new Date(createdAt),
      completedAt: i < done ? new Date(createdAt) : null,
      notes: null,
      _count: { exercises: 0 },
    })),
    case: null,
  };
}

function render(programsLite: PatientProgramLite[]) {
  return renderToStaticMarkup(
    <ConfirmProvider>
    <PatientProfile
      patientCore={core}
      programsLite={programsLite}
      recentBookings={[]}
      billableCount={0}
      evaScores={[]}
    />
    </ConfirmProvider>,
  );
}

/** El badge de un tab: `<button …>Sesiones<span …>N</span>` → N. */
function badge(html: string, label: string): number | null {
  const m = html.match(new RegExp(`>${label}</span>\\s*<span[^>]*>(\\d+)<`)) ??
    html.match(new RegExp(`${label}<span[^>]*>(\\d+)<`));
  return m ? Number(m[1]) : null;
}

describe("[P0-S02u-perfil] perfil con varios planes", () => {
  it("[P0-S02u-perfil] con solo planes terminados el hero no dice 'Plan activo'", () => {
    const html = render([
      program("COMPLETED", "2026-09-01T12:00:00Z", "Lumbalgia"),
      program("CANCELLED", "2026-08-01T12:00:00Z", "Cervical"),
    ]);
    expect(html).not.toContain("Plan activo");
    expect(html).toContain("Sin plan activo");
    // Resumen muestra el último plan con su estado, no como vigente, y ofrece crear uno.
    expect(html).toContain("Completado");
    expect(html).toContain("Crear plan");
  });

  it("[P0-S02u-perfil] activeProgram = el ACTIVE más reciente, aunque haya terminados más nuevos", () => {
    const html = render([
      program("COMPLETED", "2026-09-20T12:00:00Z", "Terminado nuevo"),
      program("ACTIVE", "2026-09-10T12:00:00Z", "Activo reciente", 10, 3),
      program("ACTIVE", "2026-08-10T12:00:00Z", "Activo viejo"),
    ]);
    expect(html).toContain("Plan activo");
    expect(html).toContain("Activo reciente");
    expect(html).not.toContain("Terminado nuevo");
    expect(html).toContain("3 / 10");
    // "+N": hay otro ACTIVE, se avisa (hero con aria y Resumen).
    expect(html).toContain("+1");
    expect(html).toContain('aria-label="Y 1 plan activo más"');
    expect(html).toContain("1 plan activo más");
  });

  it("[P0-S02u-perfil] el más reciente se elige por createdAt, no por el orden de llegada", () => {
    const viejo = program("ACTIVE", "2026-01-01T12:00:00Z", "Viejo");
    const nuevo = program("ACTIVE", "2026-06-01T12:00:00Z", "Nuevo");
    const pick = pickProfilePrograms([viejo, nuevo]);
    expect(pick.activeProgram?.id).toBe(nuevo.id);
    expect(pick.otherActiveCount).toBe(1);
  });

  it("[P0-S02u-perfil] un plan pausado (sin activos) se muestra como pausado", () => {
    const html = render([program("PAUSED", "2026-09-01T12:00:00Z", "Rodilla")]);
    expect(html).not.toContain("Plan activo");
    expect(html).toContain("Plan pausado");
  });

  it("[P0-S02u-perfil] sin planes: 'Sin plan'", () => {
    const html = render([]);
    expect(html).toContain("Sin plan");
    expect(html).not.toContain("Plan activo");
  });

  it("[P0-S02u-perfil] el badge de Sesiones cuenta lo mismo que lista la vista", () => {
    const programs = [
      program("ACTIVE", "2026-09-10T12:00:00Z", "Activo", 3),
      program("COMPLETED", "2026-05-10T12:00:00Z", "Viejo", 4),
    ];
    const html = render(programs);
    const { sessionGroups } = pickProfilePrograms(programs);
    const patient = { ...core, programs, bookings: [], evaScores: [] } as PatientWithRelations;
    const view = renderToStaticMarkup(<SesionesView patient={patient} groups={sessionGroups} />);
    const rows = view.match(/href="\/seguimiento\//g)?.length ?? 0;
    expect(rows).toBe(7);
    expect(badge(html, "Sesiones")).toBe(rows);
    // Con más de un plan, cada grupo dice de qué plan son (el índice reinicia por plan).
    expect(view).toContain("Activo");
    expect(view).toContain("Viejo");
    expect(view.indexOf("Activo")).toBeLessThan(view.indexOf("Viejo"));
  });
});
