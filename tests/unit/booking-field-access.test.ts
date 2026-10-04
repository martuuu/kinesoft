/**
 * `bookingFieldAccess` (Planes E1, C8): un campo se escribe si y solo si se
 * puede leer. Caso por caso contra la regla de lectura de
 * `listAgendaBookings` (`showClinical` / `showNotes`), más el nivel `admin`
 * de PD-13, que no habilita nada.
 */
import { describe, it, expect } from "vitest";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import type { PatientAccessLevel } from "@/lib/capabilities";

const ALL_RW = { title: "rw", description: "rw", notes: "rw" } as const;
const ALL_HIDDEN = { title: "hidden", description: "hidden", notes: "hidden" } as const;

describe("bookingFieldAccess · turno con paciente", () => {
  it("clinical.read + full → los tres rw", () => {
    expect(bookingFieldAccess({ clinical: true, access: "full", hasPatient: true })).toEqual(ALL_RW);
  });

  it.each(["admin", "basic", "none"] as PatientAccessLevel[])("clinical.read + %s → los tres ocultos", (access) => {
    expect(bookingFieldAccess({ clinical: true, access, hasPatient: true })).toEqual(ALL_HIDDEN);
  });

  it.each(["full", "admin", "basic", "none"] as PatientAccessLevel[])(
    "sin clinical.read + %s → los tres ocultos (Secretaria con sharedPatientView incluida)",
    (access) => {
      expect(bookingFieldAccess({ clinical: false, access, hasPatient: true })).toEqual(ALL_HIDDEN);
    }
  );
});

describe("bookingFieldAccess · turno guest (sin paciente)", () => {
  it.each(["full", "admin", "basic", "none"] as PatientAccessLevel[])(
    "clinical.read (acceso %s, se ignora) → los tres rw",
    (access) => {
      expect(bookingFieldAccess({ clinical: true, access, hasPatient: false })).toEqual(ALL_RW);
    }
  );

  it.each(["full", "admin", "basic", "none"] as PatientAccessLevel[])(
    "sin clinical.read (acceso %s) → title/description ocultos, notas rw (administrativas)",
    (access) => {
      expect(bookingFieldAccess({ clinical: false, access, hasPatient: false })).toEqual({
        title: "hidden",
        description: "hidden",
        notes: "rw",
      });
    }
  );
});

describe("bookingFieldAccess · paridad con la lectura de listAgendaBookings", () => {
  // Copia literal de la regla de `lib/bookings.ts` (listAgendaBookings) para
  // los niveles que existen hoy. Si alguien cambia una de las dos, este test
  // obliga a decidir. (`admin` no existe todavía en esa lectura: S02p.)
  const readRule = (clinical: boolean, access: "full" | "basic" | "none", hasPatient: boolean) => {
    const showClinical = clinical && access !== "basic";
    const showNotes = access !== "basic" && (clinical || !hasPatient);
    return { showClinical, showNotes };
  };
  for (const clinical of [true, false]) {
    for (const hasPatient of [true, false]) {
      // listAgendaBookings: con paciente el acceso es full|basic; sin paciente es "none".
      const levels: Array<"full" | "basic" | "none"> = hasPatient ? ["full", "basic"] : ["none"];
      for (const access of levels) {
        it(`clinical=${clinical} patient=${hasPatient} access=${access}`, () => {
          const r = readRule(clinical, access, hasPatient);
          const w = bookingFieldAccess({ clinical, access, hasPatient });
          expect(w.title === "rw").toBe(r.showClinical);
          expect(w.description === "rw").toBe(r.showClinical);
          expect(w.notes === "rw").toBe(r.showNotes);
        });
      }
    }
  }
});
