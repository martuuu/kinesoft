/**
 * Non-server-action types + small helpers for the public booking flow.
 * Lives outside `lib/public-booking.ts` because that file is `"use server"`
 * and Next forbids non-async exports there.
 */
import { z } from "zod";
import type { TenantVertical } from "@prisma/client";

/**
 * Lo que ve el wizard público (`getPublicClinic`). Desde B3.2 (motor de
 * disponibilidad) solo trae lo que se ofrece ONLINE: profesionales con
 * membresía aceptada que tengan al menos un servicio habilitado y PUBLIC
 * (`PractitionerService`; sin fila = default de Configuración), y servicios
 * que algún profesional ofrezca así. Los campos marcados "B3.2" son nuevos y
 * OPCIONALES: el wizard actual no los usa; los consume B5.6 (filtros de
 * cobertura y sede, "cualquier profesional").
 */
export type PublicClinic = {
  slug: string;
  name: string;
  legalName: string | null;
  palette: string;
  /** EV1-C2: tipo de consultorio, solo para el copy del wizard (Clínica general
   *  no dice «Kinesiología» ni «sesión»). Opcional para los fixtures viejos:
   *  sin ella, el copy de Kinesiología de siempre. */
  vertical?: TenantVertical;
  /** VX2-d1: horario resumido de las franjas reales («Lun a vie 8 a 19 · Sáb 9 a 13», `summarizeOpeningHours`).
   *  null/ausente = sin franjas vigentes: el turnero no muestra horario (antes decía «lun-sáb 8 a 19hs» fijo). */
  openingSummary?: string | null;
  practitioners: {
    id: string;
    name: string;
    specialty: string | null;
    licenseNumber: string | null;
    yearsExp: number | null;
    // DIR-D18: sin `rating`. Viajaba al cliente sin que el wizard lo usara y es un dato de seed (nadie escribe
    // `Practitioner.rating`); el directorio tampoco lo publica.
    /** B3.2: sedes donde atiende (sus franjas en sedes activas; sin franjas =
     *  la principal). Orden de `PublicClinic.locations`. */
    locationIds?: string[];
    /** B3.2: coberturas que acepta (ids de `PublicClinic.insurers`).
     *  Sin fila `PractitionerPayer` = aceptada; Particular siempre. */
    acceptedInsurerIds?: string[];
  }[];
  services: {
    id: string;
    name: string;
    description: string | null;
    /** Duración a mostrar: la del servicio, o el override del único
     *  profesional que lo ofrece. Por profesional: `durationByPractitioner`. */
    durationMin: number;
    priceCents: number;
    /**
     * Filtro del wizard actual (`s.practitionerId === elegido || null`).
     * B3.2: si UN solo profesional lo ofrece online, es ese (aunque el
     * servicio sea del consultorio); si lo ofrecen varios, null. Con 3+
     * profesionales y un servicio ofrecido por 2, el wizard viejo lo muestra
     * también al tercero: la lista de horarios sale vacía y el submit lo
     * rechaza (seguro, no ideal) → B5.6 debe filtrar con `practitionerIds`.
     */
    practitionerId: string | null;
    /** B3.2: quiénes lo ofrecen online (habilitado + PUBLIC), en el orden de
     *  `practitioners`. Fuente de verdad para filtrar. */
    practitionerIds?: string[];
    /** B3.2: duración efectiva por profesional (override de PractitionerService). */
    durationByPractitioner?: Record<string, number>;
  }[];
  /** B3.2: sedes activas, la principal primero. */
  locations?: PublicLocation[];
  /** B3.2: coberturas activas del consultorio (sin montos). */
  insurers?: { id: string; name: string; isParticular: boolean }[];
};

export type PublicLocation = {
  id: string;
  name: string;
  address: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  isPrimary: boolean;
};

/**
 * Un horario de la grilla pública. `locationId` (B3.2, opcional): la sede de
 * la franja donde cae; null/ausente = sin sede configurada. El submit asigna
 * esa sede al turno: el cliente NO la manda.
 */
export type PublicSlot = { iso: string; time: string; available: boolean; locationId?: string | null };

/** "Cualquier profesional" (B3.2, `findFirstPublicSlot`): el primer horario
 *  libre de la grilla pública entre quienes ofrecen el servicio online. */
export type PublicFirstSlot = {
  practitionerId: string;
  iso: string;
  /** "HH:MM" de pared AR. */
  time: string;
  /** "YYYY-MM-DD" AR (para posicionar el calendario del wizard). */
  date: string;
  durationMin: number;
  locationId: string | null;
};

/** Input de `listPublicSlots` (validado en el server: viene de un anónimo). */
export const ListPublicSlotsSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** B3.2: solo franjas de esa sede. */
  locationId: z.string().min(1).max(40).optional(),
});
export type ListPublicSlotsInput = z.infer<typeof ListPublicSlotsSchema>;

/** Input de `findFirstPublicSlot` ("cualquier profesional", B3.2). */
export const FirstPublicSlotSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  serviceId: z.string().min(1).max(40),
  /** Cobertura del paciente (`PublicClinic.insurers[].id`): solo profesionales que la aceptan. */
  insurerId: z.string().min(1).max(40).optional(),
  locationId: z.string().min(1).max(40).optional(),
  /** Desde qué día AR buscar (default: hoy). */
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type FirstPublicSlotInput = z.infer<typeof FirstPublicSlotSchema>;

export type PublicBookingStatus = {
  bookingId: string;
  status: string;
  paymentStatus: string;
  tenantSlug: string;
  tenantName: string;
  serviceName: string;
  practitionerName: string;
  scheduledFor: string;
  durationMin: number;
  /** Initials only — never the full name, since this endpoint is unauth. */
  patientInitials: string | null;
  amountCents: number | null;
};

export type PrefillPatient = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  documentId: string;
  dateOfBirth: string;
  coverageInsurer: string;
  coveragePlan: string;
  emergencyName: string;
  emergencyPhone: string;
  notes: string;
};

const MIN_DOB = new Date("1900-01-01");

export const PatientHCSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // trim + minúsculas antes de validar, como `patientEmail` (A2a-S08).
  email: z.string().trim().toLowerCase().email().max(120),
  phone: z.string().trim().min(6).max(30),
  documentId: z.string().trim().min(4).max(20),
  dateOfBirth: z
    .string()
    .min(1)
    .refine((s) => {
      const t = new Date(s).getTime();
      if (Number.isNaN(t)) return false;
      const d = new Date(t);
      return d >= MIN_DOB && d <= new Date();
    }, "Fecha de nacimiento inválida"),
  coverageInsurer: z.string().trim().max(80).optional().or(z.literal("")),
  coveragePlan: z.string().trim().max(80).optional().or(z.literal("")),
  emergencyName: z.string().trim().max(80).optional().or(z.literal("")),
  emergencyPhone: z.string().trim().max(30).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  title: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
});

export const SubmitSchema = z.object({
  tenantSlug: z.string().min(1).max(80),
  // Key de idempotencia POR INSTANCIA del wizard (A2b-S-pub), como en la
  // agenda. Antes era determinística (`tenant:prof:slot:paciente`): re-reservar
  // el mismo horario después de cancelar devolvía el turno CANCELLED viejo
  // (el upsert con `update: {}` no lo revivía) y el paciente pagaba un turno
  // cancelado. El wizard la rota cuando cambia el horario elegido.
  idempotencyKey: z.string().uuid(),
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  scheduledFor: z.string().min(1),
  patient: PatientHCSchema,
});

export type SubmitPublicBookingInput = z.infer<typeof SubmitSchema>;

/**
 * DNI normalizado para matchear fichas (H4): sin puntos, espacios ni guiones,
 * en mayúsculas. "30.123.456", "30 123 456" y "30123456" son la misma persona.
 * El match se hace contra la columna normalizada igual (SQL `regexp_replace`),
 * así que una ficha cargada a mano con puntos también matchea.
 */
export function normalizeDocumentId(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z]/g, "").toUpperCase();
}

/** Teléfono comparable: solo dígitos. Para decidir si el contacto "difiere". */
export function normalizePhoneForCompare(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}
