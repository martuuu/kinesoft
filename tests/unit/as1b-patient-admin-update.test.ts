import { describe, it, expect } from "vitest";
import { PATIENT_CLINICAL_KEYS, PatientAdminUpdate, PatientUpdate } from "@/lib/validation";

/**
 * [AS-1b] Lista cerrada de la rama `admin` de `updatePatient` (T3c-1b, plan §23.5). El rechazo de las claves clínicas
 * con su copy lo prueba la integración (`as1b-patients-admin.test.ts`); acá, el schema puro.
 */
describe("[AS-1b] PatientAdminUpdate", () => {
  it("acepta contacto, DNI y nacimiento con las mismas reglas que la edición full", () => {
    const r = PatientAdminUpdate.safeParse({
      id: "p1",
      firstName: " Ana ",
      email: "ANA@X.COM",
      phone: "",
      documentId: "",
      dateOfBirth: "1990-04-02",
      expectedUpdatedAt: "2026-10-18T12:00:00.000Z",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ firstName: "Ana", email: "ana@x.com", phone: null });
    expect(r.data.documentId).toBeUndefined(); // `""` = no tocar el DNI, como en PatientUpdate
    expect(r.data.dateOfBirth?.toISOString().slice(0, 10)).toBe("1990-04-02");
  });

  it("es estricta: cualquier clave clínica u otra de más se rechaza", () => {
    for (const k of PATIENT_CLINICAL_KEYS) {
      expect(PatientAdminUpdate.safeParse({ id: "p1", [k]: "x" }).success).toBe(false);
    }
    expect(PatientAdminUpdate.safeParse({ id: "p1", assignedPractitionerId: "x" }).success).toBe(false);
  });

  it("las claves clínicas son exactamente las de PatientUpdate que la lista cerrada deja afuera", () => {
    const full = Object.keys(PatientUpdate.shape).sort();
    const admin = Object.keys(PatientAdminUpdate.shape);
    expect(full.filter((k) => !admin.includes(k)).sort()).toEqual([...PATIENT_CLINICAL_KEYS].sort());
  });
});
