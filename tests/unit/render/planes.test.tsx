/**
 * [P3-S21] `/planes` + nav (PD-11, PD-13, C4, C10).
 *
 * Render estático (`renderToStaticMarkup`, sin jsdom): se mockean solo las
 * server actions (red), `next/navigation`, `next/dynamic` (los modales lazy no
 * se abren en un render estático) y el toast; `PlanesClient` y el modelo son
 * los reales. Fechas en UTC con el offset AR explícito: da lo mismo con TZ=UTC
 * y TZ=AR.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock("@/lib/plans-adopt", () => ({
  previewGeneratePlanBookings: async () => ({ ok: false, error: "x" }),
  generatePlanBookings: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/plans-read", () => ({
  listSchedulablePlanSessions: async () => ({ ok: true, data: [] }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { PlanesClient, type PlanesClientProps } from "@/components/planes/planes-client";
import {
  PLANES_COPY,
  PLAN_STATUS_LABEL as PLANES_STATUS_LABEL,
  availableDisciplines,
  canScheduleRow,
  disciplineFromSlug,
  nextSessionLabel,
  parsePlanesFilter,
  pickSessionToSchedule,
  planesHref,
  planesScreenPermissions,
  resolveDisciplineTab,
  rowTitle,
  visiblePlanRows,
} from "@/components/planes/planes-model";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { navFor, shortcutsFor } from "@/lib/nav";
import type { PlanListRow } from "@/lib/plans-read-types";
import { PLAN_STATUS_LABEL as GROUPS_STATUS_LABEL } from "@/components/planes/plan-booking-groups";

const row = (over: Partial<PlanListRow> & { id: string }): PlanListRow => ({
  patientId: `pat-${over.id}`,
  patientName: "Ana Pérez",
  level: "full",
  discipline: "KINESIOLOGY",
  status: "ACTIVE",
  archivedAt: null,
  linked: true,
  title: "Rehabilitación de rodilla",
  practitionerId: "pr1",
  practitionerName: "Lic. Gómez",
  serviceId: "s1",
  serviceName: "Kine",
  locationId: null,
  totalLive: 10,
  done: 3,
  sinTurno: 0,
  nextSession: null,
  updatedAt: new Date("2026-10-01T12:00:00.000Z"),
  createdAt: new Date("2026-09-01T12:00:00.000Z"),
  ...over,
});

const OWNER = capabilitiesFor("OWNER");
const PRACT = capabilitiesFor("PRACTITIONER");
const SECRE = capabilitiesFor("ASSISTANT");
const BILLING = capabilitiesFor("BILLING");

describe("[P3-S21] rutas y pestañas por disciplina (PD-11)", () => {
  it("slug ↔ disciplina = DISCIPLINE_TAG_SLUGS; desconocido → null", () => {
    expect(disciplineFromSlug("kinesiologia")).toBe("KINESIOLOGY");
    expect(disciplineFromSlug("osteopatia")).toBe("OSTEOPATHY");
    expect(disciplineFromSlug("KINESIOLOGY")).toBeNull();
    expect(disciplineFromSlug("")).toBeNull();
    expect(planesHref("OSTEOPATHY")).toBe("/planes/osteopatia");
    expect(planesHref("KINESIOLOGY", "sin-turno")).toBe("/planes/kinesiologia?filtro=sin-turno");
  });

  it("pestañas = disciplinas con algún servicio, en orden canónico y sin repetir", () => {
    expect(availableDisciplines([{ discipline: "OSTEOPATHY" }, { discipline: null }, { discipline: "OSTEOPATHY" }])).toEqual([
      "OSTEOPATHY",
    ]);
    expect(availableDisciplines([{ discipline: "OSTEOPATHY" }, { discipline: "KINESIOLOGY" }])).toEqual([
      "KINESIOLOGY",
      "OSTEOPATHY",
    ]);
    expect(availableDisciplines([{ discipline: null }])).toEqual([]);
  });

  it("otra disciplina (sin servicio) o slug desconocido → null (la página da notFound)", () => {
    expect(resolveDisciplineTab("osteopatia", ["KINESIOLOGY"])).toBeNull();
    expect(resolveDisciplineTab("pilates", ["KINESIOLOGY"])).toBeNull();
    expect(resolveDisciplineTab("kinesiologia", ["KINESIOLOGY"])).toBe("KINESIOLOGY");
  });

  it("filtro de la URL", () => {
    expect(parsePlanesFilter("sin-turno")).toBe("sin-turno");
    expect(parsePlanesFilter(["sin-turno"])).toBe("sin-turno");
    expect(parsePlanesFilter("otro")).toBe("all");
    expect(parsePlanesFilter(undefined)).toBe("all");
  });
});

describe("[P3-S21] permisos (sin reimplementar el server)", () => {
  it("Nuevo plan: plans.manage + clinical.read; la Secretaria y Facturación no", () => {
    expect(planesScreenPermissions(OWNER, true).create).toBe(true);
    expect(planesScreenPermissions(PRACT, true).create).toBe(true);
    expect(planesScreenPermissions(SECRE, true).create).toBe(false);
    expect(planesScreenPermissions(BILLING, true).create).toBe(false);
  });

  it("filtro Sesiones sin turno: plans.schedule (la Secretaria sí, Facturación no); sin módulo nada", () => {
    expect(planesScreenPermissions(SECRE, true).sinTurnoFilter).toBe(true);
    expect(planesScreenPermissions(BILLING, true).sinTurnoFilter).toBe(false);
    expect(planesScreenPermissions(OWNER, false)).toEqual({ create: false, sinTurnoFilter: false });
  });

  it("Agendar: plans.schedule sobre el paciente, plan ACTIVO vinculado con sin turno", () => {
    const r = row({ id: "p1", sinTurno: 2 });
    expect(canScheduleRow(r, PRACT, true)).toBe(true);
    // Secretaria: nivel admin + agenda.operateAll.
    expect(canScheduleRow({ ...r, level: "admin", title: null }, SECRE, true)).toBe(true);
    // Profesional sin full sobre ese paciente (admin) y sin operateAll → no.
    expect(canScheduleRow({ ...r, level: "admin" }, PRACT, true)).toBe(false);
    expect(canScheduleRow({ ...r, level: "admin" }, BILLING, true)).toBe(false);
    expect(canScheduleRow({ ...r, status: "PAUSED" }, PRACT, true)).toBe(false);
    expect(canScheduleRow({ ...r, linked: false }, PRACT, true)).toBe(false);
    expect(canScheduleRow({ ...r, sinTurno: 0 }, PRACT, true)).toBe(false);
    expect(canScheduleRow(r, PRACT, false)).toBe(false);
  });
});

describe("[P3-S21] filas", () => {
  const rows = [
    row({ id: "a", patientName: "Zoe Álvarez", sinTurno: 1 }),
    row({ id: "b", patientName: "Ángela Ruiz", status: "PAUSED", sinTurno: 2 }),
    row({ id: "c", patientName: "Bruno Díaz", linked: false }),
    row({ id: "d", patientName: "Carla Sosa" }),
  ];

  it("Sesiones sin turno: solo ACTIVOS vinculados con sinTurno > 0", () => {
    expect(visiblePlanRows(rows, "sin-turno").map((r) => r.id)).toEqual(["a"]);
  });

  it("todos, ordenados por paciente; búsqueda sin tildes ni mayúsculas", () => {
    expect(visiblePlanRows(rows, "all").map((r) => r.id)).toEqual(["b", "c", "d", "a"]);
    expect(visiblePlanRows(rows, "all", "angela").map((r) => r.id)).toEqual(["b"]);
  });

  it("título: nunca en Sesiones sin turno (PD-13); null del server se respeta", () => {
    expect(rowTitle(rows[0], "sin-turno")).toBeNull();
    expect(rowTitle(rows[0], "all")).toBe("Rehabilitación de rodilla");
    expect(rowTitle({ ...rows[0], title: null }, "all")).toBeNull();
  });

  it("próxima sesión en hora AR", () => {
    const label = nextSessionLabel({ nextSession: { sessionId: "s", ordinal: 4, at: new Date("2026-10-14T12:30:00.000Z") } });
    expect(label).toContain("14/10");
    expect(label).toContain("09:30");
    expect(nextSessionLabel({ nextSession: null })).toBeNull();
  });

  it("Agendar elige la sin turno de menor ordinal de ESE plan (por programId, S21 H3)", () => {
    const schedulable = [
      { sessionId: "x5", programId: "p1", ordinal: 5, totalLive: 10, sinTurno: true },
      { sessionId: "x4", programId: "p1", ordinal: 4, totalLive: 10, sinTurno: true },
      { sessionId: "x3", programId: "p1", ordinal: 3, totalLive: 10, sinTurno: false },
      // Otro plan del mismo paciente con un ordinal menor: no se elige.
      { sessionId: "other", programId: "p2", ordinal: 1, totalLive: 6, sinTurno: true },
    ];
    expect(pickSessionToSchedule("p1", schedulable)).toEqual({
      sessionId: "x4",
      label: "Sesión 4 de 10",
    });
    expect(pickSessionToSchedule("p3", schedulable)).toBeNull();
  });
});

describe("[P3-S21] nav: una entrada Planes + atajo (solo lib/nav.ts)", () => {
  const kine = modulesFor({ vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: false });
  const general = modulesFor({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });

  it("Kine: Planes después de Pacientes, una sola vez; General: no", () => {
    const h = navFor(kine, OWNER).map((i) => i.href);
    expect(h.filter((x) => x.startsWith("/planes"))).toEqual(["/planes"]);
    expect(h.indexOf("/planes")).toBe(h.indexOf("/pacientes") + 1);
    expect(navFor(kine, SECRE).map((i) => i.href)).toContain("/planes");
    expect(navFor(general, OWNER).map((i) => i.href)).not.toContain("/planes");
  });

  it("atajo ⌘K Planes solo con el módulo", () => {
    expect(shortcutsFor(kine)).toContainEqual({ id: "nav:planes", category: "shortcut", label: "Planes", href: "/planes" });
    expect(shortcutsFor(general).map((s) => s.href)).not.toContain("/planes");
  });
});

describe("[P3-S21] PlanesClient (render)", () => {
  const base: PlanesClientProps = {
    discipline: "KINESIOLOGY",
    disciplines: ["KINESIOLOGY", "OSTEOPATHY"],
    rows: [row({ id: "p1", sinTurno: 2 }), row({ id: "p2", patientName: "Bruno Díaz", sinTurno: 0 })],
    truncated: false,
    error: null,
    filter: "all",
    capabilities: [...PRACT],
    canEditServices: false,
  };
  const html = (p: Partial<PlanesClientProps> = {}) => renderToStaticMarkup(<PlanesClient {...base} {...p} />);

  it("profesional: Nuevo plan, títulos, pestañas con la actual marcada, Agendar en la que tiene sin turno", () => {
    const out = html();
    expect(out).toContain("Nuevo plan");
    expect(out).toContain("Rehabilitación de rodilla");
    expect(out).toMatch(/<a aria-current="page"[^>]*href="\/planes\/kinesiologia"/);
    expect(out).toContain('href="/planes/osteopatia"');
    expect(out).toContain("2 sesiones sin turno");
    expect((out.match(/>Agendar</g) ?? []).length).toBe(1);
    // Link a la card del plan con C10.
    expect(out).toContain("/pacientes/pat-p1?tab=planes&amp;programa=p1");
    // Sección de plantillas (S21t) montada para quien arma planes.
    expect(out).toContain('aria-label="Plantillas"');
  });

  it("[P3-Z F2] anti-false-green: con un título secreto en filas de nivel admin, no se pinta (ni en Todos)", () => {
    const rows = base.rows.map((r) => ({ ...r, level: "admin" as const, title: "SECRETO-titulo" }));
    expect(html({ capabilities: [...SECRE], filter: "all", rows })).not.toContain("SECRETO");
    expect(html({ capabilities: [...SECRE], filter: "sin-turno", rows })).not.toContain("SECRETO");
  });

  it("[P3-Z F2] legacy: el copy C13 del plan anterior a la agenda", () => {
    expect(PLANES_COPY.unlinked).toBe("Plan anterior a la agenda · Completá los datos para agendar");
    expect(html({ rows: [row({ id: "lg", linked: false })] })).toContain("Plan anterior a la agenda · Completá los datos para agendar");
  });

  it("[P3-Z F2] estados: el mismo copy en /planes y en el perfil (COMPLETED = 'Finalizado')", () => {
    expect(PLANES_STATUS_LABEL).toEqual(GROUPS_STATUS_LABEL);
    expect(GROUPS_STATUS_LABEL.COMPLETED).toBe("Finalizado");
  });

  it("Secretaria en Sesiones sin turno: sin título, sin Nuevo plan, con Agendar; solo la fila con sin turno", () => {
    const rows = base.rows.map((r) => ({ ...r, level: "admin" as const, title: "SECRETO-titulo" }));
    const out = html({ capabilities: [...SECRE], filter: "sin-turno", rows });
    expect(out).not.toContain("Nuevo plan");
    expect(out).not.toContain('aria-label="Plantillas"');
    expect(out).not.toContain("Rehabilitación");
    expect(out).not.toContain("SECRETO");
    expect(out).not.toContain('data-testid="plan-row-title"');
    expect(out).toContain("Ana Pérez");
    expect(out).not.toContain("Bruno Díaz");
    expect(out).toContain(">Agendar<");
    expect(out).toMatch(/<a aria-current="true"[^>]*href="\/planes\/kinesiologia\?filtro=sin-turno"/);
  });

  it("aunque el server mandara título, la vista sin turno no lo pinta", () => {
    const out = html({ filter: "sin-turno" });
    expect(out).not.toContain("Rehabilitación de rodilla");
  });

  it("Facturación: sin filtro sin turno (aunque venga en la URL) ni Agendar ni Nuevo plan", () => {
    const rows = base.rows.map((r) => ({ ...r, level: "admin" as const, title: null }));
    const out = html({ capabilities: [...BILLING], filter: "sin-turno", rows });
    expect(out).not.toContain("Sesiones sin turno");
    expect(out).not.toContain(">Agendar<");
    expect(out).not.toContain("Nuevo plan");
    expect(out).toContain("Bruno Díaz");
  });

  it("sin disciplinas: estado vacío (con Servicios solo para admin), sin Nuevo plan", () => {
    const out = html({ discipline: null, disciplines: [], rows: [] });
    expect(out).toContain("Todavía no hay servicios con disciplina");
    expect(out).not.toContain("Nuevo plan");
    expect(out).not.toContain("/configuracion");
    expect(html({ discipline: null, disciplines: [], rows: [], canEditServices: true })).toContain('href="/configuracion"');
  });

  it("error de lectura se muestra; vacío con copy por disciplina", () => {
    expect(html({ error: "No tenés permiso para ver los planes de este paciente." })).toContain("No tenés permiso");
    expect(html({ rows: [] })).toContain("No hay planes activos de kinesiología.");
  });
});
