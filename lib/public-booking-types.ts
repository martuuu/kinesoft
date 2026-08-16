/**
 * Non-server-action types + small helpers for the public booking flow.
 * Lives outside `lib/public-booking.ts` because that file is `"use server"`
 * and Next forbids non-async exports there.
 */
import { z } from "zod";

export type PublicClinic = {
  slug: string;
  name: string;
  legalName: string | null;
  palette: string;
  practitioners: {
    id: string;
    name: string;
    specialty: string | null;
    licenseNumber: string | null;
    yearsExp: number | null;
    rating: number | null;
  }[];
  services: {
    id: string;
    name: string;
    description: string | null;
    durationMin: number;
    priceCents: number;
    practitionerId: string | null;
  }[];
};

export type PublicSlot = { iso: string; time: string; available: boolean };

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
  email: z.string().email().max(120),
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
  practitionerId: z.string().min(1).max(40),
  serviceId: z.string().min(1).max(40),
  scheduledFor: z.string().min(1),
  patient: PatientHCSchema,
});

export type SubmitPublicBookingInput = z.infer<typeof SubmitSchema>;
