/**
 * Server-internal helpers for the public booking flow. Not "use server" —
 * these must NEVER be exposed as RPC endpoints, only invoked from server
 * components / server actions that have already validated the caller.
 *
 * Importantly, `findPatientByEmailForPrefill` returns PII and must only
 * be called from a context where the email has already been validated
 * against a verified Supabase session (`user.email_confirmed_at`).
 */
import "server-only";
// Cross-tenant prefill lookup, no single-tenant Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import type { PrefillPatient } from "@/lib/public-booking-types";

/**
 * Look up a Patient row across tenants by email and return the prefill
 * shape used by the booking wizard. The caller is responsible for proving
 * the email belongs to the requester (typically: a verified Supabase
 * session whose `email` matches).
 */
export async function findPatientByEmailForPrefill(
  email: string,
  opts: { tenantId?: string } = {}
): Promise<PrefillPatient | null> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  const row = await prisma.patient.findFirst({
    where: {
      email: { equals: trimmed, mode: "insensitive" },
      ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
    },
    include: { coverages: { orderBy: { id: "desc" } }, emergency: true },
  });
  if (!row) return null;
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email ?? trimmed,
    phone: row.phone ?? "",
    documentId: row.documentId ?? "",
    dateOfBirth: row.dateOfBirth ? row.dateOfBirth.toISOString().slice(0, 10) : "",
    coverageInsurer: row.coverages[0]?.insurer ?? "",
    coveragePlan: row.coverages[0]?.planName ?? "",
    emergencyName: row.emergency[0]?.name ?? "",
    emergencyPhone: row.emergency[0]?.phone ?? "",
    notes: "",
  };
}
