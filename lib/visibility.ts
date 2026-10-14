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
 *      semantic; every patient now has exactly one owner. IAM-4a: un actor
 *      sin profesional (`practitionerId` null: rol no clínico) nunca es
 *      dueño: la comparación va por `isActorPractitioner`, que no matchea
 *      `null === null` contra un paciente sin asignar.
 *   4. **Explicit share** (`PatientShare` row with
 *      `(patientId, practitionerId = actor.practitionerId)`) → FULL access.
 *   5. **Otherwise** → BASIC access: the patient row appears in the
 *      directory and on the agenda, but only first/last name + DNI
 *      + next appointment time are exposed. Everything else (HC, plans,
 *      sessions, contact info) is hidden until shared.
 *
 *   0. **Nivel `admin` (Planes E1, PD-13, S02p) — se evalúa ANTES que 2-5.**
 *      Un rol SIN `clinical.read` (ASSISTANT = Secretaria, BILLING =
 *      Facturación) tiene SIEMPRE exactamente `admin` sobre todos los
 *      pacientes del tenant:
 *        - nunca `full`: ni por `sharedPatientView`, ni por `PatientShare`,
 *          ni por `assignedPractitionerId` (en prod hay pacientes asignados
 *          a la Secretaria: precheck 15). Antes de S02p la Secretaria con
 *          "Consultorio común" caía en (2) y leía la HC completa;
 *        - nunca menos: ve los datos administrativos de todos los pacientes
 *          sin depender de "Consultorio común" (opera la agenda de todos).
 *      `admin` = nombre, DNI, contacto, obra social y cobertura, contacto de
 *      emergencia, turnos y estado de cobro. **Nunca** HC (diagnóstico,
 *      notas, EVA, título de planes, archivos, actividad, Seguimiento) ni
 *      escritura clínica ni las acciones que piden full (borrar turnos,
 *      cobros): operar turnos va por `agenda.operateAll`.
 *      **Regla de compatibilidad:** todo chequeo que habilita HC o escritura
 *      se escribe `=== "full"` (forma positiva), nunca `!== "basic"`: con
 *      `admin` la forma negativa lo dejaría pasar. Los recortes de PHI que
 *      hoy preguntan `=== "basic"` tratan a `admin` como full hasta que su
 *      dueño escriba la proyección admin.
 *
 * Public surface:
 *   - `visibilityForActor(actor)` → coarse Prisma where-fragment used for
 *     LISTING patients/bookings. Lists return EVERY patient of the
 *     tenant; per-row access is decided downstream via `bulkPatientAccess`.
 *   - `patientAccessFor(actor, patientId)` → fine-grained `"full" |
 *     "admin" | "basic" | "none"` decision for a SINGLE patient. Detail pages and
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
import type { Prisma, Role } from "@prisma/client";
import { capabilitiesFor, type PatientAccessLevel } from "@/lib/capabilities";
import { isActorPractitioner } from "@/lib/practitioner-scope";

/**
 * = `PatientAccessLevel` de `lib/capabilities.ts` (el puro que importa la UI):
 * un solo tipo para que los predicados `canOperateBooking`/`canWriteClinical`
 * y `bookingFieldAccess` reciban exactamente lo que devuelve este módulo.
 */
export type AccessLevel = PatientAccessLevel;

export type Visibility = {
  /**
   * Actor's role grants full access to every row in the tenant. PD-13: un
   * rol sin `clinical.read` nunca lo tiene (ni con `sharedPatientView`):
   * los consumidores (`getDashboardData`, `listOpenSessions`) lo usan para
   * abrir datos clínicos de todo el tenant.
   */
  seesAll: boolean;
  /**
   * PD-13 (S02p): el rol no lee clínica → nivel `admin` sobre TODOS los
   * pacientes del tenant (datos administrativos, nunca HC). Excluyente con
   * `seesAll`.
   */
  adminView: boolean;
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

/**
 * PD-13: ¿el rol queda en el nivel `admin`? = no tiene `clinical.read` en la
 * matriz de `lib/capabilities.ts` (hoy ASSISTANT y BILLING). Se deriva de la
 * matriz y no de una lista de roles para que un rol nuevo sin clínica caiga
 * solo en `admin` y nunca herede `full` por "Consultorio común".
 *
 * Membresía ausente: se conserva el default histórico de este módulo
 * (`PRACTITIONER`), que tiene `clinical.read` y por lo tanto sigue el camino
 * asignado/share/básico. No se cambia acá porque `getActor()` ya exige
 * membresía (sin ella no hay Actor) y pasarla a `admin` le abriría contacto y
 * cobertura de todo el tenant a una identidad sin rol.
 *
 * BO2-E (PHI): el superadmin que entra «como soporte» NO tiene membresía en el
 * consultorio, así que caía en ese default `PRACTITIONER` y, con «Consultorio
 * común», veía la HC completa. Decisión 3 de Martin: soporte ve lo que ve la
 * Secretaria → se fuerza `ASSISTANT` (nivel `admin`) cuando `actor.support`,
 * aunque el superadmin además sea miembro del consultorio.
 */
function isAdminOnlyRole(role: Role): boolean {
  return !capabilitiesFor(role).has("clinical.read");
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
    const role: Role = actor.support ? "ASSISTANT" : (membership?.role ?? "PRACTITIONER");
    const adminView = isAdminOnlyRole(role);
    // PD-13: sin clinical.read, "Consultorio común" ya no abre todo.
    const seesAll = !adminView && (role === "OWNER" || role === "ADMIN" || sharedView);

    // Sprint 16: lists are NO LONGER filtered by ownership at the SQL
    // layer. Every member sees every patient + booking; per-row access
    // tier (full vs basic) is resolved by the renderer. The patientWhere /
    // bookingWhere fragments are kept as `{}` so existing callsites that
    // spread them don't break, but they no longer scope by practitioner.
    return {
      seesAll,
      adminView,
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

      const role: Role = actor.support ? "ASSISTANT" : (membership?.role ?? "PRACTITIONER");
      if (role === "OWNER" || role === "ADMIN") return "full";
      // PD-13: antes que sharedPatientView / asignación / share, que darían full.
      if (isAdminOnlyRole(role)) return "admin";
      if (tenant?.sharedPatientView) return "full";
      // IAM-4a: sin profesional (no debería pasar con un rol clínico: `buildActor` lo exige) no hay «propio» ni
      // share posible. Nunca `null === null` contra un paciente sin asignar.
      const pid = actor.practitionerId;
      if (!pid) return "basic";
      if (isActorPractitioner(actor, patient.assignedPractitionerId)) return "full";

      const share = await c.patientShare.findUnique({
        where: {
          patientId_practitionerId: {
            patientId,
            practitionerId: pid,
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

    const role: Role = actor.support ? "ASSISTANT" : (membership?.role ?? "PRACTITIONER");

    // PD-13: sin clinical.read, `admin` para todos los pacientes del tenant
    // (los ausentes del mapa siguen siendo "none": no son del tenant). Mismo
    // orden que `patientAccessFor`: antes del corto circuito de sharedView.
    if (isAdminOnlyRole(role)) {
      for (const p of patients) result.set(p.id, "admin");
      return result;
    }

    const seesAll = role === "OWNER" || role === "ADMIN" || !!tenant?.sharedPatientView;

    if (seesAll) {
      for (const p of patients) result.set(p.id, "full");
      return result;
    }

    // Practitioner: full for owned + explicitly shared, basic otherwise.
    // IAM-4a: sin profesional, todo básico (ni «propios» por `null === null` ni query de shares).
    const pid = actor.practitionerId;
    const ownedIds = new Set(
      patients
        .filter((p) => isActorPractitioner(actor, p.assignedPractitionerId))
        .map((p) => p.id)
    );
    const otherIds = patients.filter((p) => !ownedIds.has(p.id)).map((p) => p.id);

    const shareRows =
      pid && otherIds.length > 0
        ? await c.patientShare.findMany({
            where: {
              patientId: { in: otherIds },
              practitionerId: pid,
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
