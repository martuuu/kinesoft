/**
 * Multi-user visibility helpers.
 *
 * The OWNER toggles `Tenant.sharedPatientView` from /configuracion:
 *
 *   - **shared (true)**  — every member of the tenant sees every Patient
 *     and Booking in the tenant. Useful for small consultorios where
 *     the kine is the only one writing into the HC.
 *   - **per-kine (false, default)** — each PRACTITIONER only sees the
 *     Patients they were assigned to (`Patient.assignedPractitionerId`)
 *     and their own Bookings. OWNER and ADMIN roles bypass this filter
 *     and always see everything (otherwise they couldn't audit).
 *
 * Patients with `assignedPractitionerId == null` are "del consultorio
 * común" — visible to everyone regardless of mode. This is also the
 * legacy bucket for patients created before this field existed.
 */
import "server-only";
import { prisma } from "@/lib/db";
import type { Actor } from "@/lib/session";
import type { Prisma } from "@prisma/client";

export type Visibility = {
  /** Whether the actor's role allows seeing every row in the tenant. */
  seesAll: boolean;
  /** Tenant has shared view enabled. */
  sharedView: boolean;
  /** Prisma `where` fragment to scope patient queries by visibility. */
  patientWhere: Prisma.PatientWhereInput;
  /** Prisma `where` fragment to scope booking queries by visibility. */
  bookingWhere: Prisma.BookingWhereInput;
};

/**
 * Compute the visibility shape for an actor. The Membership lookup is
 * cheap; consider memoising via `cache()` if it becomes a hotspot.
 */
export async function visibilityForActor(actor: Actor): Promise<Visibility> {
  const [tenant, membership] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { sharedPatientView: true },
    }),
    prisma.membership.findUnique({
      where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
      select: { role: true },
    }),
  ]);

  const sharedView = tenant?.sharedPatientView ?? false;
  const role = membership?.role ?? "PRACTITIONER";
  const seesAll = role === "OWNER" || role === "ADMIN" || sharedView;

  // Per-kine mode: practitioner sees patients assigned to them OR
  // patients with no assignment ("consultorio común"). The booking
  // filter is stricter — practitioners only see their own bookings.
  const patientWhere: Prisma.PatientWhereInput = seesAll
    ? {}
    : {
        OR: [
          { assignedPractitionerId: actor.practitionerId },
          { assignedPractitionerId: null },
        ],
      };
  const bookingWhere: Prisma.BookingWhereInput = seesAll
    ? {}
    : { practitionerId: actor.practitionerId };

  return { seesAll, sharedView, patientWhere, bookingWhere };
}
