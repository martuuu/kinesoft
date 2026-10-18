/**
 * T3d-1u (plan §23.5): payloads de los formularios de paciente («Nuevo paciente» y «Editar datos»), fuera de los
 * componentes para poder fijarlos con un unit test (AGENTS §3: lógica pura en un módulo testeable).
 *
 * Modo `admin` (Secretaria, Admin, Facturación: nivel `admin` de la ficha, sin `clinical.read`): el payload **no lleva**
 * `notes`, `diagnosisTitle` ni `diagnosisNote`, ni siquiera vacías. `updatePatient` rechaza el pedido ENTERO si llega
 * cualquier clave clínica con valor («Las notas y el diagnóstico los edita el profesional a cargo.», T3c-1b), así que
 * mandar `notes: ""` como hacía el formulario completo dejaba a la recepción sin poder guardar ni el teléfono.
 * `createPatient` las ignora sin `clinical.read`, pero se omiten igual: el alta de la recepción no las pide.
 */

/** Lo único que se lee del form: `FormData` en el navegador, un objeto simple en el test. */
export type FormLike = { get(name: string): FormDataEntryValue | null };

export type PatientFormMode = "full" | "admin";

/** Claves clínicas del paciente: nunca salen en modo `admin` (mismo set que `PATIENT_CLINICAL_KEYS` del server). */
export const CLINICAL_FORM_KEYS = ["notes", "diagnosisTitle", "diagnosisNote"] as const;

const str = (fd: FormLike, k: string) => String(fd.get(k) ?? "");

function contactFields(fd: FormLike) {
  return {
    firstName: str(fd, "firstName"),
    lastName: str(fd, "lastName"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    documentId: str(fd, "documentId"),
    dateOfBirth: str(fd, "dateOfBirth"),
  };
}

function clinicalFields(fd: FormLike) {
  return {
    notes: str(fd, "notes"),
    diagnosisTitle: str(fd, "diagnosisTitle"),
    diagnosisNote: str(fd, "diagnosisNote"),
  };
}

/**
 * Payload de `updatePatient`. `expectedUpdatedAt` sale solo si se conoce (el optimistic lock es opcional en el server):
 * desde T3e-2p la proyección `admin` también trae `updatedAt`.
 */
export function patientUpdatePayload(
  mode: PatientFormMode,
  id: string,
  expectedUpdatedAt: string | null,
  fd: FormLike
) {
  return {
    id,
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
    ...contactFields(fd),
    ...(mode === "full" ? clinicalFields(fd) : {}),
  };
}

/** Cobertura elegida en el alta: "particular" | "ins:<id>" | "other" (+ el nombre libre). */
export function coverageCreateFields(coverage: string, otherInsurer: string) {
  return {
    insurerId: coverage.startsWith("ins:") ? coverage.slice(4) : undefined,
    insurerName: coverage === "other" ? otherInsurer.trim() || undefined : undefined,
  };
}

/** Payload de `createPatient` (primer argumento). En modo `admin` el profesional a cargo va en las opciones. */
export function patientCreatePayload(mode: PatientFormMode, fd: FormLike, coverage: string, otherInsurer: string) {
  return {
    ...contactFields(fd),
    ...(mode === "full" ? clinicalFields(fd) : {}),
    ...coverageCreateFields(coverage, otherInsurer),
  };
}

/**
 * Qué alta ofrece /pacientes (mismo criterio que `createPatient`, que lee las capabilities del miembro):
 *  - `full`: con `clinical.read` (profesional), el formulario de siempre; la ficha queda a su cargo.
 *  - `admin`: sin `clinical.read` y con `agenda.operateAll` (Secretaria, Admin que no atiende): «Profesional a cargo»
 *    obligatorio (el server exige `assignTo`) y sin notas ni diagnóstico. Antes de T3d el botón se escondía y la
 *    recepción solo podía dar de alta desde el modal del turno.
 *  - `null`: Facturación (ni una ni otra) y el soporte de Plataforma (solo lectura).
 */
export function newPatientMode(caps: ReadonlySet<string>, opts: { support: boolean }): PatientFormMode | null {
  if (opts.support) return null;
  if (caps.has("clinical.read")) return "full";
  if (caps.has("agenda.operateAll")) return "admin";
  return null;
}

/**
 * Campo «Copago propio» de «Editar datos» (modo `admin`). Vacío = no se toca (no hay forma de borrarlo desde acá:
 * `setPatientDefaultCopago` solo fija un monto; volver al copago de la obra social es cambiar la cobertura). Un monto
 * igual al que ya tenía tampoco escribe (evita un audit `patient.copago.update` de más).
 */
export type CopagoFieldResult = { kind: "none" } | { kind: "set"; cents: number } | { kind: "invalid" };

export function parseCopagoField(raw: string, initialCents: number | null, parse: (s: string) => number | null): CopagoFieldResult {
  const t = raw.trim();
  if (!t) return { kind: "none" };
  const cents = parse(t);
  // Mismo tope que el server (`setPatientDefaultCopago`: 0..100.000,00 en centavos).
  if (cents == null || cents < 0 || cents > 100_000_00) return { kind: "invalid" };
  if (initialCents != null && cents === initialCents) return { kind: "none" };
  return { kind: "set", cents };
}
