/**
 * Multi-user visibility + per-patient sharing helpers (Sprint 16).
 *
 * Access model:
 *
 *   1. **OWNER / ADMIN** of a tenant always have FULL access to every
 *      patient (audit / oversight requirement).
 *   2. **`Tenant.sharedPatientView = true`** is the legacy "everyone
 *      sees everything" override — when on, every member of the
 *      tenant gets FULL access regardless of ownership / shares.
 *      Surfaced in /configuracion with a warning since it short-circuits
 *      per-patient PatientShare grants.
 *   3. **Owner** (`Patient.assignedPractitionerId == actor.practitionerId`)
 *      → FULL access. Sprint 16 dropped the "null = consultorio común"
 *      semantic; every patient now has exactly one owner.
 *   4. **Explicit share** (`PatientShare` row with
 *      `(patientId, practitionerId = actor.practitionerId)`) → FULL access.
 *   5. **Otherwise** → BASIC access: the patient row appears in the
 *      directory and on the agenda, but only first/last name + DNI
 *      + next appointment time are exposed. Everything else (HC, plans,
 *      sessions, contact info) is hidden until shared.
 *
 * Public surface:
 *   - `visibilityForActor(actor)` → coarse Prisma where-fragment used for
 *     LISTING patients/bookings. Lists return EVERY patient of the
 *     tenant; per-row access is decided downstream via `bulkPatientAccess`.
 *   - `patientAccessFor(actor, patientId)` → fine-grained `"full" |
 *     "basic" | "none"` decision for a SINGLE patient. Detail pages and
 *     mutations gate on this.
 *   - `bulkPatientAccess(actor, ids[])` → batched version that returns
 *     a `Map<patientId, AccessLevel>` in one round trip. Used by list /
 *     agenda renderers to decide row-by-row.
 *
 * RLS (Ola B2): these read Patient / Tenant / Membership / PatientShare —
 * all RLS-governed. Each public function self-primes a tenant-scoped
 * transaction via `withTenantDb`, so a caller can either invoke it
 * standalone (a fresh `runWithRls` is opened) or, when already inside a
 * `runWithRls`, pass its `tx` as the trailing `db` argument to avoid
 * nesting. A silent empty read here would mis-authorize, so this is the
 * highest-stakes module to get right.
 */
import "server-only";
import { cache } from "react";
import { withTenantDb, type DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Prisma } from "@prisma/client";

export type AccessLevel = "full" | "basic" | "none";

export type Visibility = {
  /** Actor's role grants full access to every row in the tenant. */
  seesAll: boolean;
  /** Tenant has shared-view mode enabled (overrides per-patient shares). */
  sharedView: boolean;
  /**
   * Prisma `where` fragment for **LISTING** patients. Sprint 16 broadens
   * this from the per-kine restriction: every member can SEE every
   * patient in the tenant (even basic-only ones). Access tier is decided
   * downstream by `bulkPatientAccess`.
   */
  patientWhere: Prisma.PatientWhereInput;
  /**
   * Prisma `where` fragment for **LISTING** bookings. Same idea: agenda
   * shows every booking of the tenant; basic-only ones get a stripped
   * card via UI logic.
   */
  bookingWhere: Prisma.BookingWhereInput;
};

// Internal reads take the primed client explicitly. No `react.cache` here:
// memoisation lives on the public entry points, and these must run on the
// same tenant-scoped transaction the caller opened.
function readTenantSettings(db: DbClient, tenantId: string) {
  return db.tenant.findUnique({
    where: { id: tenantId },
    select: { sharedPatientView: true },
  });
}

function readMembershipRole(db: DbClient, userId: string, tenantId: string) {
  return db.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId } },
    select: { role: true },
  });
}

export async function visibilityForActor(
  actor: Actor,
  db?: DbClient
): Promise<Visibility> {
  return withTenantDb(actor.tenantId, db, async (c) => {
    const [tenant, membership] = await Promise.all([
      readTenantSettings(c, actor.tenantId),
      readMembershipRole(c, actor.userId, actor.tenantId),
    ]);

    const sharedView = tenant?.sharedPatientView ?? false;
    const role = membership?.role ?? "PRACTITIONER";
    const seesAll = role === "OWNER" || role === "ADMIN" || sharedView;

    // Sprint 16: lists are NO LONGER filtered by ownership at the SQL
    // layer. Every member sees every patient + booking; per-row access
    // tier (full vs basic) is resolved by the renderer. The patientWhere /
    // bookingWhere fragments are kept as `{}` so existing callsites that
    // spread them don't break, but they no longer scope by practitioner.
    return {
      seesAll,
      sharedView,
      patientWhere: {},
      bookingWhere: {},
    };
  });
}

/**
 * Resolve a SINGLE patient's access level for the given actor.
 *
 * Resolves to "none" if the patient doesn't exist or is from another
 * tenant. Used by `getPatientCore` and friends to decide whether to
 * return the full payload or the basic projection.
 *
 * Cache: `react.cache` memoises per (actor, patientId) within the same
 * request. Callers already inside a `runWithRls` should pass their `tx`
 * as the third arg (that key variant is memoised separately).
 */
export const patientAccessFor = cache(
  async (actor: Actor, patientId: string, db?: DbClient): Promise<AccessLevel> =>
    withTenantDb(actor.tenantId, db, async (c) => {
      const [patient, tenant, membership] = await Promise.all([
        c.patient.findUnique({
          where: { id: patientId },
          select: { tenantId: true, assignedPractitionerId: true },
        }),
        readTenantSettings(c, actor.tenantId),
        readMembershipRole(c, actor.userId, actor.tenantId),
      ]);

      if (!patient || patient.tenantId !== actor.tenantId) return "none";

      const role = membership?.role ?? "PRACTITIONER";
      if (role === "OWNER" || role === "ADMIN") return "full";
      if (tenant?.sharedPatientView) return "full";
      if (patient.assignedPractitionerId === actor.practitionerId) return "full";

      const share = await c.patientShare.findUnique({
        where: {
          patientId_practitionerId: {
            patientId,
            practitionerId: actor.practitionerId,
          },
        },
        select: { id: true },
      });
      return share ? "full" : "basic";
    })
);

/**
 * Batched access resolver. Issues ONE share-lookup query for the whole
 * id list instead of N individual ones. Use this in directory listing
 * + agenda renderers where many patients are rendered side-by-side.
 *
 * Returns a `Map` keyed by patientId. Missing keys = "none" (patient
 * isn't in the actor's tenant); look those up with caller-side defaults.
 */
export async function bulkPatientAccess(
  actor: Actor,
  patientIds: readonly string[],
  db?: DbClient
): Promise<Map<string, AccessLevel>> {
  const result = new Map<string, AccessLevel>();
  if (patientIds.length === 0) return result;

  return withTenantDb(actor.tenantId, db, async (c) => {
    const [patients, tenant, membership] = await Promise.all([
      c.patient.findMany({
        where: { id: { in: patientIds as string[] }, tenantId: actor.tenantId },
        select: { id: true, assignedPractitionerId: true },
      }),
      readTenantSettings(c, actor.tenantId),
      readMembershipRole(c, actor.userId, actor.tenantId),
    ]);

    const role = membership?.role ?? "PRACTITIONER";
    const seesAll = role === "OWNER" || role === "ADMIN" || !!tenant?.sharedPatientView;

    if (seesAll) {
      for (const p of patients) result.set(p.id, "full");
      return result;
    }

    // Practitioner: full for owned + explicitly shared, basic otherwise.
    const ownedIds = new Set(
      patients
        .filter((p) => p.assignedPractitionerId === actor.practitionerId)
        .map((p) => p.id)
    );
    const otherIds = patients.filter((p) => !ownedIds.has(p.id)).map((p) => p.id);

    const shareRows =
      otherIds.length > 0
        ? await c.patientShare.findMany({
            where: {
              patientId: { in: otherIds },
              practitionerId: actor.practitionerId,
            },
            select: { patientId: true },
          })
        : [];
    const sharedIds = new Set(shareRows.map((r) => r.patientId));

    for (const p of patients) {
      if (ownedIds.has(p.id)) result.set(p.id, "full");
      else if (sharedIds.has(p.id)) result.set(p.id, "full");
      else result.set(p.id, "basic");
    }
    return result;
  });
}

/**
 * List the practitioners who currently have an explicit share on the
 * patient. Used by the SharePatientButton popover to render the
 * checkbox state. `tenantId` is required to prime the RLS transaction.
 */
export async function listPatientShares(
  patientId: string,
  tenantId: string,
  db?: DbClient
): Promise<string[]> {
  const rows = await withTenantDb(tenantId, db, (c) =>
    c.patientShare.findMany({
      where: { patientId },
      select: { practitionerId: true },
    })
  );
  return rows.map((r) => r.practitionerId);
}
