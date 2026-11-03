/**
 * CF2 (§29) · P-PL · lógica pura del directorio de pacientes: hechos de turnos por paciente × profesional,
 * profesionales de la fila (decisión 2 de Martin), estado del paciente (D-CF2-14) y «última visita» (D-CF2-15).
 * Corre igual en TZ=UTC y en TZ=America/Argentina/Buenos_Aires: todo es aritmética de instantes.
 */
import { describe, it, expect } from "vitest";
import {
  PATIENT_ACTIVE_WINDOW_DAYS,
  PATIENT_LAST_VISIT_EXCLUDED_STATUSES,
  PATIENT_RECENT_PRACTITIONER_DAYS,
  directoryTotalsAll,
  foldPatientBookingFacts,
  lastVisitBookingWhere,
  normalizeDirectoryFilter,
  patientActivity,
  patientPractitionerIds,
  type PatientBookingFactRow,
} from "@/lib/patients-list-logic";

const DAY = 86_400_000;
// 12:00 AR del 2-nov (15:00 UTC): lejos de la medianoche para que un corrimiento de TZ no cambie nada.
const now = new Date("2026-11-02T15:00:00.000Z");
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const ahead = (d: number) => new Date(now.getTime() + d * DAY);

const fact = (p: Partial<PatientBookingFactRow> & Pick<PatientBookingFactRow, "patientId" | "practitionerId">) => ({
  nextAt: null,
  lastCompletedAt: null,
  lastSeenAt: null,
  ...p,
});

describe("[CF2-PL1] patientActivity (D-CF2-14: activo = próximo turno o visita en 90 días)", () => {
  it("visita hace 89 días → activo; hace 91 → inactivo (sin próximo)", () => {
    expect(PATIENT_ACTIVE_WINDOW_DAYS).toBe(90);
    expect(patientActivity({ archivedView: false, nextAt: null, lastVisitAt: ago(89) }, now)).toBe("active");
    expect(patientActivity({ archivedView: false, nextAt: null, lastVisitAt: ago(91) }, now)).toBe("inactive");
  });

  it("borde: exactamente 90 días es activo; un ms más, inactivo", () => {
    expect(patientActivity({ archivedView: false, nextAt: null, lastVisitAt: ago(90) }, now)).toBe("active");
    const justOut = new Date(ago(90).getTime() - 1);
    expect(patientActivity({ archivedView: false, nextAt: null, lastVisitAt: justOut }, now)).toBe("inactive");
  });

  it("un próximo turno lo hace activo aunque la última visita sea vieja o no exista", () => {
    expect(patientActivity({ archivedView: false, nextAt: ahead(40), lastVisitAt: ago(400) }, now)).toBe("active");
    expect(patientActivity({ archivedView: false, nextAt: ahead(1), lastVisitAt: null }, now)).toBe("active");
  });

  it("sin turnos → inactivo; en la vista de archivados → archivado aunque tenga turnos", () => {
    expect(patientActivity({ archivedView: false, nextAt: null, lastVisitAt: null }, now)).toBe("inactive");
    expect(patientActivity({ archivedView: true, nextAt: ahead(1), lastVisitAt: ago(1) }, now)).toBe("archived");
  });
});

describe("[CF2-PL2] foldPatientBookingFacts", () => {
  it("lastVisitAt = max(lastSeenAt) entre profesionales (no el COMPLETED: D-CF2-15)", () => {
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "a", lastSeenAt: ago(10), lastCompletedAt: ago(50) }),
        fact({ patientId: "p1", practitionerId: "b", lastSeenAt: ago(3), lastCompletedAt: null }),
      ],
      now,
    );
    expect(m.get("p1")?.lastVisitAt).toEqual(ago(3));
  });

  it("cancelados/ausentes no cuentan: un profesional con solo lastCompletedAt (sin lastSeenAt) no aporta visita", () => {
    // El SQL deja lastSeenAt en null cuando todos los turnos pasados con ese profesional fueron CANCELLED/NO_SHOW;
    // la fold no debe caer a lastCompletedAt (que el SQL no puede tener sin lastSeenAt, pero se blinda igual).
    const m = foldPatientBookingFacts(
      [fact({ patientId: "p1", practitionerId: "a", lastSeenAt: null, lastCompletedAt: null, nextAt: null })],
      now,
    );
    expect(m.get("p1")).toEqual({ nextAt: null, lastVisitAt: null, recentPractitionerIds: [], upcomingPractitionerIds: [] });
  });

  it("nextAt = el más cercano entre profesionales", () => {
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "a", nextAt: ahead(9) }),
        fact({ patientId: "p1", practitionerId: "b", nextAt: ahead(2) }),
      ],
      now,
    );
    expect(m.get("p1")?.nextAt).toEqual(ahead(2));
  });

  it("reciente = con próximo o visto en 30 días; orden: próximos por cercanía, después visto más reciente", () => {
    expect(PATIENT_RECENT_PRACTITIONER_DAYS).toBe(30);
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "old", lastSeenAt: ago(31) }),
        fact({ patientId: "p1", practitionerId: "seen5", lastSeenAt: ago(5) }),
        fact({ patientId: "p1", practitionerId: "next9", nextAt: ahead(9), lastSeenAt: ago(200) }),
        fact({ patientId: "p1", practitionerId: "seen29", lastSeenAt: ago(29) }),
        fact({ patientId: "p1", practitionerId: "next2", nextAt: ahead(2) }),
      ],
      now,
    );
    expect(m.get("p1")?.recentPractitionerIds).toEqual(["next2", "next9", "seen5", "seen29"]);
  });

  it("[CF2-ZF3-6] upcomingPractitionerIds (filas basic): solo los que tienen un turno próximo, por cercanía; nunca el visto hace poco", () => {
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "seen5", lastSeenAt: ago(5) }),
        fact({ patientId: "p1", practitionerId: "next9", nextAt: ahead(9), lastSeenAt: ago(2) }),
        fact({ patientId: "p1", practitionerId: "next2", nextAt: ahead(2) }),
      ],
      now,
    );
    expect(m.get("p1")?.upcomingPractitionerIds).toEqual(["next2", "next9"]);
    // La fila admin/full sigue con los recientes (decisión 2).
    expect(m.get("p1")?.recentPractitionerIds).toEqual(["next2", "next9", "seen5"]);
  });

  it("dedupe: filas repetidas del mismo (paciente, profesional) se funden en una", () => {
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "a", lastSeenAt: ago(40) }),
        fact({ patientId: "p1", practitionerId: "a", lastSeenAt: ago(2) }),
        fact({ patientId: "p1", practitionerId: "a", nextAt: ahead(3) }),
      ],
      now,
    );
    expect(m.get("p1")).toEqual({ nextAt: ahead(3), lastVisitAt: ago(2), recentPractitionerIds: ["a"], upcomingPractitionerIds: ["a"] });
  });

  it("separa pacientes y no inventa entradas para pacientes sin filas", () => {
    const m = foldPatientBookingFacts(
      [
        fact({ patientId: "p1", practitionerId: "a", lastSeenAt: ago(1) }),
        fact({ patientId: "p2", practitionerId: "b", nextAt: ahead(1) }),
      ],
      now,
    );
    expect([...m.keys()].sort()).toEqual(["p1", "p2"]);
    expect(m.get("p1")?.recentPractitionerIds).toEqual(["a"]);
    expect(m.get("p2")?.recentPractitionerIds).toEqual(["b"]);
    expect(m.has("p3")).toBe(false);
  });
});

describe("[CF2-PL3] patientPractitionerIds (decisión 2: el a cargo + los recientes)", () => {
  it("a cargo primero, sin duplicados", () => {
    expect(patientPractitionerIds("b", ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    expect(patientPractitionerIds("z", ["a", "a"])).toEqual(["z", "a"]);
  });

  it("sin a cargo («Consultorio común») → solo los recientes", () => {
    expect(patientPractitionerIds(null, ["a", "c"])).toEqual(["a", "c"]);
    expect(patientPractitionerIds(undefined, [])).toEqual([]);
  });

  it("a cargo sin turnos recientes igual aparece", () => {
    expect(patientPractitionerIds("b", [])).toEqual(["b"]);
  });
});

describe("[CF2-INTP3] última visita: un PENDING pasado (reserva online impaga) no es visita (D-CF2-15)", () => {
  it("PENDING va con CANCELLED y NO_SHOW en la lista y en el where del filtro", () => {
    expect([...PATIENT_LAST_VISIT_EXCLUDED_STATUSES]).toEqual(["CANCELLED", "NO_SHOW", "PENDING"]);
    expect(lastVisitBookingWhere(now, undefined, undefined).status).toEqual({ notIn: ["CANCELLED", "NO_SHOW", "PENDING"] });
  });
});

describe("[CF2-PL4] última visita: mismo criterio en el filtro (D-CF2-15)", () => {
  it("excluye cancelados, ausentes y reservas impagas, solo turnos pasados, con las puntas del rango", () => {
    const from = new Date("2026-10-01T03:00:00.000Z");
    const to = new Date("2026-10-31T02:59:59.999Z");
    expect(lastVisitBookingWhere(now, from, to)).toEqual({
      status: { notIn: ["CANCELLED", "NO_SHOW", "PENDING"] },
      scheduledFor: { lt: now, gte: from, lte: to },
    });
    expect(lastVisitBookingWhere(now, undefined, undefined)).toEqual({
      status: { notIn: ["CANCELLED", "NO_SHOW", "PENDING"] },
      scheduledFor: { lt: now },
    });
  });
});

describe("[CF2-PL5] filtro y totales sin planes (decisión 3)", () => {
  it("?filter= distinto de archivados se lee como all", () => {
    expect(normalizeDirectoryFilter("archived")).toBe("archived");
    expect(normalizeDirectoryFilter("active")).toBe("all");
    expect(normalizeDirectoryFilter("no-program")).toBe("all");
    expect(normalizeDirectoryFilter(undefined)).toBe("all");
    expect(normalizeDirectoryFilter("basura")).toBe("all");
  });

  it("directoryTotalsAll = { all } sin con/sin plan", () => {
    expect(directoryTotalsAll([{}, {}, {}])).toEqual({ all: 3 });
    expect(directoryTotalsAll([])).toEqual({ all: 0 });
  });
});
