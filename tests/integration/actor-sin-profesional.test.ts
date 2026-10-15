/**
 * IAM-4a · Actor sin profesional para roles no clínicos (plan §19.2 decisión 2, §19.4 fila 4a; AUDIT
 * `secretaria-sin-practitioner`).
 *
 * Antes: `buildActor` exigía una fila `Practitioner` en el consultorio para TODO rol y `joinTenantInTx` se la
 * creaba (con agenda) también a la Secretaria (ASSISTANT) y a Facturación (BILLING). Ahora:
 *   - `Actor.practitionerId` es `null` para los roles no clínicos, aunque tengan una fila vieja (queda inofensiva:
 *     desde IAM-2e no es reservable);
 *   - los clínicos (OWNER, ADMIN, PRACTITIONER) siguen exigiendo su `Practitioner`;
 *   - al unirse un no clínico no se crea `Practitioner` ni franjas.
 *
 * El riesgo que `tsc` no ve: con `practitionerId = null`, un `where: { assignedPractitionerId: actor.practitionerId }`
 * compila a `IS NULL` y la Secretaria vería todo lo «sin asignar». Los casos de abajo siembran pacientes SIN
 * asignar a propósito para que ese atajo se note.
 *
 * Símbolos REALES contra Postgres en los dos roles (`test:integration` y `:owner`). Se mockea solo la sesión de
 * Supabase y la cookie (integration-setup), GoTrue (fake) y el despacho del mail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { getActor, getAccessSnapshot } from "@/lib/session";
import { getCapabilities } from "@/lib/authz";
import { activateInvitation } from "@/lib/invite-activation-internal";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __setEmailTransportForTests } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { createBooking, listAgendaBookings, markReceptionAction } from "@/lib/bookings";
import { listOpenSessions } from "@/lib/sessions";
import { searchPatientsForAssignment } from "@/lib/diagnosis";
import { bulkPatientAccess, patientAccessFor } from "@/lib/visibility";
import { getDashboardData, getRevenue } from "@/lib/dashboard";
import { changeMemberRole } from "@/lib/invitations";
import { OPEN_SESSIONS_BUCKET_LIMIT } from "@/lib/sessions-types";
import { localToARIso } from "@/lib/datetime-ar";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { createPlan } from "@/tests/helpers/plan-factory";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("[IAM-4a] Actor sin profesional para roles no clínicos", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Kine del consultorio (además del OWNER de la factory). */
  let kine: { userId: string; practitionerId: string };
  /** Secretaria SIN fila Practitioner (como queda una activada desde IAM-4a). */
  let secretaria: string;
  /** Facturación SIN fila Practitioner. */
  let billing: string;
  /** Secretaria «vieja»: con la fila Practitioner que le creaba `acceptInvite` antes de IAM-4a. */
  let secretariaVieja: { userId: string; practitionerId: string };
  /** Paciente SIN asignar (`assignedPractitionerId` null): el blanco del atajo `IS NULL`. */
  let sinAsignar: string;
  const createdUserIds = new Set<string>();

  beforeAll(async () => {
    db = ownerClient();
    // PRO: cupo para el kine + la Secretaria vieja (rol clínico de antes); FREE (1 lugar) frena la 2.ª activación (BO2-B).
    T = await createEphemeralTenant(db, { plan: "PRO" });
    kine = await addPractitioner(db, T, "PRACTITIONER");
    secretaria = await staffWithoutPractitioner("ASSISTANT");
    billing = await staffWithoutPractitioner("BILLING");
    secretariaVieja = await addPractitioner(db, T, "ASSISTANT");
    sinAsignar = await addPatient(db, T, { assignedPractitionerId: null, firstName: "Sin", lastName: "Asignar" });
  });

  afterAll(async () => {
    await T?.cleanup();
    if (db) {
      const ids = [...createdUserIds];
      if (ids.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
        await db.userProfile.deleteMany({ where: { id: { in: ids }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete(ACTIVE_TENANT_COOKIE);
  });

  async function staffWithoutPractitioner(role: Role): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({ data: { userId: id, tenantId: T.tenantId, role, acceptedAt: new Date() } });
    return id;
  }

  // ── Entrar ────────────────────────────────────────────────────────────────

  it("[IAM-4a] Secretaria sin Practitioner entra: getActor OK con practitionerId null y sus capabilities", async () => {
    asUser(secretaria);
    const actor = await getActor();
    expect(actor.tenantId).toBe(T.tenantId);
    expect(actor.practitionerId).toBeNull();
    expect(actor.practitionerName).toBe("Staff ASSISTANT");
    const caps = await getCapabilities();
    expect(caps.has("agenda.viewAll")).toBe(true);
    expect(caps.has("agenda.operateAll")).toBe(true);
    expect(caps.has("clinical.read")).toBe(false);
  });

  it("[IAM-4a] una Secretaria vieja con fila Practitioner tiene igual practitionerId null", async () => {
    asUser(secretariaVieja.userId);
    const actor = await getActor();
    expect(actor.tenantId).toBe(T.tenantId);
    expect(actor.practitionerId).toBeNull();
    // La fila vieja no se borra: queda inofensiva.
    expect(await db.practitioner.count({ where: { id: secretariaVieja.practitionerId } })).toBe(1);
  });

  it("[IAM-4a] OWNER y PRACTITIONER sin cambios: su practitionerId; un kine sin Practitioner sigue sin acceso", async () => {
    asUser(T.userId);
    expect((await getActor()).practitionerId).toBe(T.practitionerId);
    asUser(kine.userId);
    expect((await getActor()).practitionerId).toBe(kine.practitionerId);

    const roto = await staffWithoutPractitioner("PRACTITIONER");
    asUser(roto);
    await expect(getActor()).rejects.toMatchObject({ name: "UnauthenticatedError" });
    expect((await getAccessSnapshot())?.state).toEqual({ kind: "no_access", reason: "missing_practitioner" });
  });

  // ── Operar la agenda ─────────────────────────────────────────────────────

  it("[IAM-4a] Secretaria sin Practitioner ve la agenda de todos, crea un turno para el profesional elegido y opera Recepción", async () => {
    const delKine = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    const own = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: delKine,
        practitionerId: kine.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar("2031-05-05", "09:00")),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    asUser(secretaria);

    const created = await createBooking({
      patientId: sinAsignar,
      serviceId: T.serviceId,
      // El profesional elegido (el OWNER de la factory, que tiene el servicio habilitado): no el actor.
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-05-05", "11:00"),
      idempotencyKey: randomUUID(),
    });
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const row = await db.booking.findUniqueOrThrow({ where: { id: created.ok ? created.data.id : "" } });
    expect(row.practitionerId).toBe(T.practitionerId);

    const agenda = await listAgendaBookings({
      from: new Date(ar("2031-05-05", "00:00")),
      to: new Date(ar("2031-05-06", "00:00")),
    });
    expect(agenda.map((b) => b.id).sort()).toEqual([own.id, row.id].sort());

    // Recepción: solo turnos de HOY (AR). Uno del kine, que no es el actor.
    const hoy = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: delKine,
        practitionerId: kine.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    const arrived = await markReceptionAction(hoy.id, "llego", hoy.updatedAt.toISOString());
    expect(arrived, JSON.stringify(arrived)).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: hoy.id } })).arrivedAt).not.toBeNull();
  });

  // ── Sin atajo `IS NULL` hacia lo «sin asignar» ───────────────────────────

  it("[IAM-4a] Secretaria no ve sesiones abiertas de pacientes sin asignar (sessions.ts:303, ni el conteo)", async () => {
    // Más sesiones que el tope del bucket: con `assignedPractitionerId IS NULL` el SQL las trae, el filtro por
    // acceso las descarta, pero el `total` (count real − descartadas) delataba que existen.
    const plan = await createPlan(db, T, { patientId: sinAsignar, sessions: 0, totalSessions: 200 });
    const n = OPEN_SESSIONS_BUCKET_LIMIT + 1;
    await db.session.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        programId: plan.programId,
        practitionerId: T.practitionerId,
        index: i + 1,
        scheduledFor: new Date(Date.parse("2020-01-01T13:00:00Z") + i * 86_400_000),
      })),
    });

    asUser(secretaria);
    const b = await listOpenSessions();
    expect(b.overdue).toEqual({ rows: [], total: 0 });
    expect(b.today.total + b.upcoming.total + b.recent.total + (b.sinTurno?.total ?? 0)).toBe(0);
    expect(b.suggestDischarge).toEqual({ rows: [], total: 0 });

    // El OWNER sí las ve (no se rompió el camino «ver todo»).
    asUser(T.userId);
    expect((await listOpenSessions()).overdue.total).toBe(n);
  });

  it("[IAM-4a] Secretaria y Facturación no buscan pacientes para diagnóstico (diagnosis.ts:271)", async () => {
    // Ya cortaba `adminView` antes de la query (`[]`): el caso queda como red para que el atajo no vuelva.
    for (const u of [secretaria, billing]) {
      asUser(u);
      expect(await searchPatientsForAssignment("Asignar")).toEqual([]);
    }
  });

  it("[IAM-4a] el nivel de acceso de un no clínico sobre un paciente sin asignar es `admin`, nunca `full` (visibility.ts:202,263)", async () => {
    for (const u of [secretaria, billing, secretariaVieja.userId]) {
      asUser(u);
      const actor = await getActor();
      expect(await patientAccessFor(actor, sinAsignar)).toBe("admin");
      expect((await bulkPatientAccess(actor, [sinAsignar])).get(sinAsignar)).toBe("admin");
    }
  });

  // ── Facturación ──────────────────────────────────────────────────────────

  it("[IAM-4a] Facturación sin Practitioner entra y ve los ingresos de todo el consultorio (revenueScopeFor)", async () => {
    asUser(billing);
    const actor = await getActor();
    expect(actor.practitionerId).toBeNull();
    const d = await getDashboardData();
    expect(d.revenueScope).toBe("tenant");
    expect(d.monthRevenue).not.toBeNull();
    // Sin profesional: los KPIs «propios» no caen en lo sin asignar.
    expect(d.todayCount).toBe(0);
    expect(d.pinned.newPatientsMonth).toBe(0);
    // PL-Z (FX4): sin ficha no hay switch del propio turnero en el menú de perfil.
    expect(d.ownPublicBooking).toBeNull();
    const r = await getRevenue("month");
    expect(r.ok).toBe(true);
  });

  it("[PL-Z FX4] el dashboard trae la ficha propia y su `publicBookingEnabled` (fuera del cache, al día)", async () => {
    asUser(kine.userId);
    await db.practitioner.update({ where: { id: kine.practitionerId }, data: { publicBookingEnabled: false } });
    expect((await getDashboardData()).ownPublicBooking).toEqual({ practitionerId: kine.practitionerId, enabled: false });
    await db.practitioner.update({ where: { id: kine.practitionerId }, data: { publicBookingEnabled: true } });
    expect((await getDashboardData()).ownPublicBooking).toEqual({ practitionerId: kine.practitionerId, enabled: true });
  });

  it("[IAM-4a] Secretaria sin Practitioner abre el dashboard sin tirar y sin ingresos", async () => {
    asUser(secretaria);
    const d = await getDashboardData();
    expect(d.revenueScope).toBe("none");
    expect(d.monthRevenue).toBeNull();
    expect(d.pinned.newPatientsMonth).toBe(0);
    // PL-Z (FX4): sin ficha no hay switch del propio turnero en el menú de perfil.
    expect(d.ownPublicBooking).toBeNull();
    const r = await getRevenue("month");
    expect(r.ok).toBe(false);
  });

  // ── Cambio de rol (handoff a IAM-4c) ─────────────────────────────────────

  it("[IAM-4c] ascender a una Secretaria sin Practitioner a Kinesiólogo/a le crea el profesional (si no, queda sin acceso)", async () => {
    // Regresión que abre IAM-4a: hasta acá toda membresía tenía Practitioner, así que `changeMemberRole` solo
    // cambiaba `Membership.role`. Una Secretaria activada desde IAM-4a no tiene profesional: al pasarla a un rol
    // clínico su membresía deja de ser usable (`missing_practitioner`). IAM-4c (dueña de lib/invitations.ts) lo dio
    // vuelta creando `Practitioner` + agenda en la misma tx del cambio de rol (más casos en team-admin.test.ts).
    const ascendida = await staffWithoutPractitioner("ASSISTANT");
    const m = await db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId: ascendida, tenantId: T.tenantId } } });
    asUser(T.userId);
    expect(await changeMemberRole(m.id, "PRACTITIONER")).toEqual({ ok: true, data: undefined });
    asUser(ascendida);
    const actor = await getActor();
    expect(actor.practitionerId).not.toBeNull();
    expect(await db.practitionerSchedule.count({ where: { practitionerId: actor.practitionerId! } })).toBeGreaterThan(0);
  });

  // ── Activación ───────────────────────────────────────────────────────────

  describe("activación (joinTenantInTx)", () => {
    let fake: GotrueFake;

    beforeEach(() => {
      __rateLimitInternals.reset();
      fake = new GotrueFake();
      __setAuthAdminForTests({
        createUser: async (p) => {
          const r = await fake.createUser(p);
          if (r.ok) createdUserIds.add(r.data.id);
          return r;
        },
        deleteUser: (id) => fake.deleteUser(id),
        updateUserById: (id, p) => fake.updateUserById(id, p),
        getUser: (id) => fake.getUser(id),
        findUserByEmail: (e) => fake.findUserByEmail(e),
        listUsers: (p) => fake.listUsers(p),
        generateLink: (p) => fake.generateLink(p),
      });
      __setEmailTransportForTests(async () => ({ ok: true, transport: "resend", providerId: "prov" }));
      asAnonymous();
    });

    afterEach(() => {
      __setAuthAdminForTests(null);
      __setEmailTransportForTests(null);
    });

    async function activate(role: Role) {
      const raw = randomBytes(24).toString("base64url");
      const email = `iam4a-${role.toLowerCase()}-${randomBytes(4).toString("hex")}@example.com`;
      await db.invitation.create({
        data: {
          tenantId: T.tenantId,
          email,
          firstName: "Ana",
          lastName: "Pérez",
          role,
          specialty: "Kinesiología",
          token: hashInviteToken(raw),
          invitedById: T.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const r = await activateInvitation(
        { token: raw, firstName: "Ana", lastName: "Pérez", password: "clave-segura-1", passwordConfirm: "clave-segura-1" },
        { ip: "203.0.113.9" }
      );
      expect(r).toMatchObject({ ok: true, tenantId: T.tenantId });
      if (!r.ok) throw new Error("activación falló");
      return r.userId;
    }

    it("[IAM-4a] una Secretaria nueva no recibe Practitioner ni franjas, y entra con practitionerId null", async () => {
      const userId = await activate("ASSISTANT");
      expect(await db.practitioner.count({ where: { tenantId: T.tenantId, userId } })).toBe(0);
      expect(await db.practitionerSchedule.count({ where: { tenantId: T.tenantId, practitioner: { userId } } })).toBe(0);
      const m = await db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId: T.tenantId } } });
      expect(m.role).toBe("ASSISTANT");
      expect(m.acceptedAt).not.toBeNull();
      asUser(userId);
      expect((await getActor()).practitionerId).toBeNull();
    });

    it("[IAM-4a] un kine nuevo sigue recibiendo Practitioner con su agenda", async () => {
      const userId = await activate("PRACTITIONER");
      const prac = await db.practitioner.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: T.tenantId, userId } } });
      expect(await db.practitionerSchedule.count({ where: { practitionerId: prac.id } })).toBeGreaterThan(0);
      asUser(userId);
      expect((await getActor()).practitionerId).toBe(prac.id);
    });
  });
});
