/**
 * Zod schemas shared by client forms and server actions.
 * Keeping them in one place avoids drift between the two layers.
 */
import { z } from "zod";

export const PatientCreate = z.object({
  firstName: z.string().trim().min(1, "Nombre requerido").max(80),
  lastName: z.string().trim().min(1, "Apellido requerido").max(80),
  email: z.string().email("Email inválido").optional().or(z.literal("").transform(() => undefined)),
  phone: z.string().trim().min(6).max(30).optional().or(z.literal("").transform(() => undefined)),
  documentId: z.string().trim().min(4).max(20).optional().or(z.literal("").transform(() => undefined)),
  dateOfBirth: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  notes: z.string().max(2000).optional().or(z.literal("").transform(() => undefined)),
});
export type PatientCreateInput = z.input<typeof PatientCreate>;

export const PatientUpdate = PatientCreate.partial().extend({
  id: z.string().min(1),
});
export type PatientUpdateInput = z.input<typeof PatientUpdate>;

export const BookingCreate = z.object({
  patientId: z.string().min(1).optional(),
  serviceId: z.string().min(1),
  practitionerId: z.string().min(1),
  scheduledFor: z
    .string()
    .min(1, "Fecha y hora requeridas")
    .transform((v) => new Date(v)),
  durationMin: z.coerce.number().int().min(15).max(240).default(45),
  notes: z.string().max(1000).optional().or(z.literal("").transform(() => undefined)),
  guestName: z.string().max(120).optional().or(z.literal("").transform(() => undefined)),
  guestEmail: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  guestPhone: z.string().max(30).optional().or(z.literal("").transform(() => undefined)),
});
export type BookingCreateInput = z.input<typeof BookingCreate>;

export const BookingUpdate = z.object({
  id: z.string().min(1),
  // Sprint 18: `patientId` is mutable so the BookingDrawer edit flow
  // can swap the patient of an existing booking. The empty string
  // becomes `null` (server clears the link and turns the booking
  // back into a guest slot). The server enforces tenant scope on the
  // target patient before saving.
  patientId: z
    .string()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  scheduledFor: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(v) : undefined)),
  durationMin: z.coerce.number().int().min(15).max(240).optional(),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "NO_SHOW", "COMPLETED"]).optional(),
  notes: z.string().max(1000).optional(),
});
export type BookingUpdateInput = z.input<typeof BookingUpdate>;

export const SessionNoteCreate = z.object({
  programId: z.string().min(1),
  index: z.coerce.number().int().min(1).max(64),
  scheduledFor: z
    .string()
    .min(1)
    .transform((v) => new Date(v)),
  notes: z.string().max(4000).optional().or(z.literal("").transform(() => undefined)),
  paInPre: z.coerce.number().int().min(0).max(10).optional(),
  paInPost: z.coerce.number().int().min(0).max(10).optional(),
  rpe: z.coerce.number().int().min(0).max(10).optional(),
});

export const EvaScoreCreate = z.object({
  patientId: z.string().min(1),
  value: z.coerce.number().int().min(0).max(10),
  source: z.string().max(40).optional(),
});

export const ProgramCreate = z.object({
  patientId: z.string().min(1),
  title: z.string().min(1).max(120),
  totalSessions: z.coerce.number().int().min(1).max(64).default(8),
  frequency: z.coerce.number().int().min(1).max(7).default(2),
  startDate: z
    .string()
    .min(1)
    .transform((v) => new Date(v)),
});
export type ProgramCreateInput = z.input<typeof ProgramCreate>;

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };
