/**
 * [INF-S] Núcleo de `scripts/qa-tenants.ts` (§26.8, decisión 3 de Martin del 22-oct) contra el Docker local, con el fake
 * de GoTrue como puerto de Auth. El SCRIPT no se corre: lo corre Martin (local o prod demo).
 *
 * Los slugs llevan un prefijo propio de este archivo (`qa-zt<sufijo>-…`) y no los 8 canónicos `qa-<plan>-<vertical>`:
 * si Martin armó los consultorios QA en su Docker, el test no los toca (ni los borra en el cleanup).
 *
 * Qué se fija:
 *  - crea los 8 (4 planes × 2 verticales) con `bootstrapTenant` + el escritor único de entitlements (source
 *    `platform`, con su audit), turnero prendido, ACTIVE; usuarios por rol (Individual = Titular; Consultorio = 5;
 *    Clínica = 6 + 2 salas; Libre = Clínica + cupos a medida), cuentas de Auth confirmadas, contraseña de env;
 *  - re-correr no duplica nada (ni cuentas de Auth);
 *  - `--sample-data`: 10 pacientes «QA Paciente NN» y una semana de turnos, idempotente;
 *  - `--state` cambia el acceso calculado (`tenantAccessFor`) y solo acepta slugs `qa-`;
 *  - `--cleanup` borra solo `qa-`: consultorios, perfiles y cuentas de Auth; un consultorio ajeno queda intacto;
 *  - `--target`: local exige base y Auth locales (o un Auth que no sea el de prod); prod exige confirmación y el MISMO
 *    proyecto de Supabase para la base y para Auth.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { tenantAccessFor } from "@/lib/tenant-access";
import { grantsOnEnterRole } from "@/lib/team-internal";
import {
  QA_STATES,
  cleanupQaTenants,
  ensureQaTenants,
  formatAccessTable,
  qaSlugs,
  resolveQaTarget,
  setQaTenantState,
  type QaDeps,
} from "@/scripts/lib/qa-tenants-core";

const RUN = process.env.INTEGRATION === "1";
const PREFIX = `qa-zt${Date.now().toString(36).slice(-5)}-`;
const EMAIL_BASE = "inf-s-qa@example.com";
const PASSWORD = "qa-integration-pass-0123";

describe.skipIf(!RUN)("[INF-S] qa-tenants (núcleo) contra el Docker local", () => {
  let db: PrismaClient;
  let fake: GotrueFake;
  let deps: QaDeps;
  let foreign: EphemeralTenant;
  const slugs = () => qaSlugs(PREFIX).map((s) => s.slug);

  beforeAll(async () => {
    db = ownerClient();
    fake = new GotrueFake();
    deps = { db, auth: fake, slugPrefix: PREFIX, log: () => {} };
    foreign = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
  });
  afterAll(async () => {
    try {
      await cleanupQaTenants(deps, { emailBase: EMAIL_BASE });
    } finally {
      await foreign?.cleanup();
      await db?.$disconnect();
    }
  });

  it("[INF-S] crea los 8 consultorios qa-<plan>-<vertical> con plan, vertical, turnero, ACTIVE y usuarios por rol", async () => {
    const r = await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD });
    expect(slugs()).toHaveLength(8);
    expect(slugs().every((s) => s.startsWith("qa-"))).toBe(true);

    const tenants = await db.tenant.findMany({
      where: { slug: { in: slugs() } },
      select: {
        id: true, slug: true, saasPlan: true, plan: true, vertical: true, status: true, subscriptionStatus: true,
        publicBookingEnabled: true, onboardingCompletedAt: true, maxUsersOverride: true, maxProfessionalsOverride: true,
        maxStaffOverride: true,
      },
    });
    expect(tenants).toHaveLength(8);
    const expectRoles: Record<string, string[]> = {
      INDIVIDUAL: ["OWNER"],
      CONSULTORIO: ["ADMIN", "ASSISTANT", "OWNER", "PRACTITIONER", "PRACTITIONER"],
      CLINICA: ["ADMIN", "ASSISTANT", "BILLING", "OWNER", "PRACTITIONER", "PRACTITIONER"],
      LIBRE: ["ADMIN", "ASSISTANT", "BILLING", "OWNER", "PRACTITIONER", "PRACTITIONER"],
    };
    for (const spec of qaSlugs(PREFIX)) {
      const t = tenants.find((x) => x.slug === spec.slug)!;
      expect(t, spec.slug).toBeTruthy();
      expect(t.saasPlan, spec.slug).toBe(spec.plan);
      expect(t.vertical, spec.slug).toBe(spec.vertical);
      expect(t.status).toBe("ACTIVE");
      expect(t.subscriptionStatus).toBe("ACTIVE");
      expect(t.publicBookingEnabled).toBe(true);
      expect(t.onboardingCompletedAt).not.toBeNull();
      const ms = await db.membership.findMany({
        where: { tenantId: t.id },
        select: { role: true, clinical: true, grantSettings: true, grantBilling: true, acceptedAt: true, disabledAt: true, userId: true },
      });
      expect(ms.map((m) => m.role).sort(), spec.slug).toEqual(expectRoles[spec.plan]);
      for (const m of ms) {
        expect(m.acceptedAt).not.toBeNull();
        expect(m.disabledAt).toBeNull();
        if (m.role !== "OWNER") {
          // Mismos permisos con los que entra una invitación aceptada (`grantsOnEnterRole`, Titular que invita).
          expect({ grantSettings: m.grantSettings, grantBilling: m.grantBilling }, m.role).toEqual(
            grantsOnEnterRole(m.role, { grantSettings: false, grantBilling: false }, true)
          );
          expect(m.clinical, m.role).toBe(m.role === "PRACTITIONER");
        }
      }
      // Profesionales con agenda: Titular + los PRACTITIONER, todos en el turnero.
      const pracs = await db.practitioner.findMany({ where: { tenantId: t.id }, select: { id: true, publicBookingEnabled: true } });
      expect(pracs.length).toBe(1 + ms.filter((m) => m.role === "PRACTITIONER").length);
      expect(pracs.every((p) => p.publicBookingEnabled)).toBe(true);
      const schedules = await db.practitionerSchedule.count({ where: { tenantId: t.id } });
      expect(schedules).toBeGreaterThan(0);
      const rooms = await db.room.count({ where: { tenantId: t.id } });
      expect(rooms, spec.slug).toBe(spec.plan === "CLINICA" || spec.plan === "LIBRE" ? 2 : 0);
      if (spec.plan === "LIBRE") {
        expect(t.maxUsersOverride).toBe(12);
        expect(t.maxProfessionalsOverride).toBe(8);
        expect(t.maxStaffOverride).toBe(4);
      } else {
        expect(t.maxUsersOverride).toBeNull();
      }
      // Escritor único de entitlements, source platform: queda su audit en el consultorio.
      const audit = await db.auditEvent.count({ where: { tenantId: t.id, action: "platform.tenant.entitlements" } });
      expect(audit, spec.slug).toBeGreaterThanOrEqual(1);
    }

    // Auth: una cuenta confirmada por persona, con la contraseña de env y email plus-addressing.
    const totalUsers = 2 * (1 + 5 + 6 + 6);
    expect(r.rows).toHaveLength(totalUsers);
    expect(fake.users.size).toBe(totalUsers);
    for (const u of fake.users.values()) {
      expect(u.emailConfirmedAt).not.toBeNull();
      expect(u.password).toBe(PASSWORD);
      expect(u.email).toMatch(/^inf-s-qa\+qa-zt[a-z0-9]+-[a-z]+-[a-z]+-[a-z0-9]+@example\.com$/);
    }
    const creates = fake.calls.filter((c) => c.method === "createUser");
    expect(creates).toHaveLength(totalUsers);
    expect(creates.every((c) => (c.args[0] as { emailConfirm: boolean }).emailConfirm === true)).toBe(true);

    // La tabla de accesos no imprime la contraseña.
    const table = formatAccessTable(r.rows);
    expect(table).toContain(slugs()[0]);
    expect(table).not.toContain(PASSWORD);
    expect(table).toMatch(/QA_PASSWORD/);
  });

  it("[INF-S] idempotente: re-correr no duplica consultorios, cuentas, membresías ni salas", async () => {
    const before = {
      tenants: await db.tenant.count({ where: { slug: { startsWith: PREFIX } } }),
      members: await db.membership.count({ where: { tenant: { slug: { startsWith: PREFIX } } } }),
      rooms: await db.room.count({ where: { tenant: { slug: { startsWith: PREFIX } } } }),
      services: await db.service.count({ where: { tenant: { slug: { startsWith: PREFIX } } } }),
      users: fake.users.size,
      creates: fake.calls.filter((c) => c.method === "createUser").length,
    };
    const r = await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD });
    expect(r.tenantsCreated).toBe(0);
    expect(r.usersCreated).toBe(0);
    expect(await db.tenant.count({ where: { slug: { startsWith: PREFIX } } })).toBe(before.tenants);
    expect(await db.membership.count({ where: { tenant: { slug: { startsWith: PREFIX } } } })).toBe(before.members);
    expect(await db.room.count({ where: { tenant: { slug: { startsWith: PREFIX } } } })).toBe(before.rooms);
    expect(await db.service.count({ where: { tenant: { slug: { startsWith: PREFIX } } } })).toBe(before.services);
    expect(fake.users.size).toBe(before.users);
    expect(fake.calls.filter((c) => c.method === "createUser").length).toBe(before.creates);
  });

  // CF3 ZF5 (B): re-correr deja cada membresía como dice la spec, y eso incluye «Co-titular» (M23). Antes el `update`
  // no lo tocaba: un QA que había promovido a alguien a co-titular lo conservaba, y si esa persona era el
  // Administrador/a de la spec (y la habían pasado a Profesional para probar), volver a ADMIN chocaba con el CHECK
  // `Membership_coOwner_role_check` (23514) y el script entero se caía.
  it("[CF3-ZF5-2b] re-correr apaga «Co-titular» (no se hereda) y vuelve el rol de la spec sin chocar con el CHECK de M23", async () => {
    const slug = `${PREFIX}consultorio-general`;
    const t = await db.tenant.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    const byRole = (role: "ADMIN" | "PRACTITIONER") =>
      db.membership.findFirstOrThrow({ where: { tenantId: t.id, role }, orderBy: { invitedAt: "asc" }, select: { id: true, userId: true } });
    const admin = await byRole("ADMIN");
    const prof = await byRole("PRACTITIONER");
    await db.membership.update({ where: { id: prof.id }, data: { grantCoOwner: true } });
    await db.membership.update({ where: { id: admin.id }, data: { role: "PRACTITIONER", clinical: true, grantCoOwner: true } });
    await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD });
    expect(await db.membership.findUniqueOrThrow({ where: { id: prof.id } })).toMatchObject({ role: "PRACTITIONER", grantCoOwner: false });
    expect(await db.membership.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ role: "ADMIN", clinical: false, grantCoOwner: false });
  });

  it("[INF-S] --sample-data: 10 pacientes «QA Paciente NN» y una semana de turnos, idempotente", async () => {
    const slug = qaSlugs(PREFIX).find((s) => s.plan === "CONSULTORIO" && s.vertical === "KINESIOLOGY")!.slug;
    const t = await db.tenant.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD, sampleData: true });
    const patients = await db.patient.findMany({ where: { tenantId: t.id }, select: { firstName: true, lastName: true } });
    expect(patients).toHaveLength(10);
    expect(patients.map((p) => `${p.firstName} ${p.lastName}`).sort()[0]).toBe("QA Paciente 01");
    const bookings = await db.booking.findMany({
      where: { tenantId: t.id },
      select: { scheduledFor: true, practitionerId: true, status: true, idempotencyKey: true },
    });
    expect(bookings.length).toBeGreaterThanOrEqual(10);
    const days = new Set(bookings.map((b) => b.scheduledFor.toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(5);
    expect(new Set(bookings.map((b) => b.practitionerId)).size).toBe(3); // Titular + 2 profesionales
    const span = Math.max(...bookings.map((b) => +b.scheduledFor)) - Math.min(...bookings.map((b) => +b.scheduledFor));
    expect(span).toBeLessThanOrEqual(7 * 86_400_000);
    expect(bookings.every((b) => b.idempotencyKey.startsWith("qa-sample:"))).toBe(true);

    await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD, sampleData: true });
    expect(await db.patient.count({ where: { tenantId: t.id } })).toBe(10);
    expect(await db.booking.count({ where: { tenantId: t.id } })).toBe(bookings.length);
  });

  it("[INF-S] --state cambia el acceso calculado (trial, trial-expired, read-only, past-due, suspended, active)", async () => {
    const slug = qaSlugs(PREFIX).find((s) => s.plan === "INDIVIDUAL" && s.vertical === "KINESIOLOGY")!.slug;
    const expected: Record<(typeof QA_STATES)[number], string> = {
      trial: "full",
      "trial-expired": "grace",
      "read-only": "read_only",
      "past-due": "grace",
      suspended: "suspended",
      active: "full",
    };
    expect([...QA_STATES].sort()).toEqual(Object.keys(expected).sort());
    for (const state of QA_STATES) {
      const r = await setQaTenantState(deps, slug, state);
      const t = await db.tenant.findUniqueOrThrow({
        where: { slug },
        select: { status: true, subscriptionStatus: true, trialEndsAt: true, subscriptionStatusChangedAt: true, statusReason: true },
      });
      expect(tenantAccessFor(t, new Date()).mode, state).toBe(expected[state]);
      expect(r.access.mode, state).toBe(expected[state]);
      if (state === "suspended") expect(t.statusReason).toMatch(/^TEST/);
    }
    const t = await db.tenant.findUniqueOrThrow({ where: { slug }, select: { status: true, subscriptionStatus: true, trialEndsAt: true } });
    expect(t).toEqual({ status: "ACTIVE", subscriptionStatus: "ACTIVE", trialEndsAt: null });
    // Por el escritor único: cada cambio deja su audit de Plataforma.
    const audits = await db.auditEvent.count({ where: { tenant: { slug }, action: "platform.tenant.entitlements" } });
    expect(audits).toBeGreaterThanOrEqual(QA_STATES.length);
    // Re-correr la creación no pisa el estado elegido con --state.
    await setQaTenantState(deps, slug, "read-only");
    await ensureQaTenants(deps, { emailBase: EMAIL_BASE, password: PASSWORD });
    const after = await db.tenant.findUniqueOrThrow({
      where: { slug },
      select: { status: true, subscriptionStatus: true, trialEndsAt: true, subscriptionStatusChangedAt: true },
    });
    expect(tenantAccessFor(after, new Date()).mode).toBe("read_only");
    await setQaTenantState(deps, slug, "active");
  });

  it("[INF-S] --state solo acepta slugs qa- y estados conocidos", async () => {
    await expect(setQaTenantState(deps, foreign.slug, "suspended")).rejects.toThrow(/qa-/);
    await expect(setQaTenantState(deps, slugs()[0], "borrado" as never)).rejects.toThrow(/estado/i);
    // Un slug qa- que no es uno de los 8 (podría ser un consultorio real con ese nombre) tampoco.
    await expect(setQaTenantState(deps, `${PREFIX}otro-consultorio`, "active")).rejects.toThrow(/solo para los consultorios qa-/);
    const f = await db.tenant.findUniqueOrThrow({ where: { id: foreign.tenantId }, select: { status: true } });
    expect(f.status).toBe("ACTIVE");
  });

  it("[INF-S] --target: local exige base y Auth locales; prod exige confirmación y el mismo proyecto", () => {
    const log = () => {};
    const local = "postgresql://u:p@localhost:5433/kinesoft";
    const prodDb = "postgresql://postgres.abcdefghijklmnop:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";
    expect(() => resolveQaTarget({ target: undefined, dbUrl: local, supabaseUrl: "http://127.0.0.1:54321", log })).toThrow(/--target/);
    expect(resolveQaTarget({ target: "local", dbUrl: local, supabaseUrl: "http://127.0.0.1:54321", log }).db.isLocal).toBe(true);
    // Base local con el Auth de prod: no (crearía cuentas reales para un consultorio que no existe en prod).
    expect(() =>
      resolveQaTarget({ target: "local", dbUrl: local, supabaseUrl: "https://abcdefghijklmnop.supabase.co", prodRef: "abcdefghijklmnop", log })
    ).toThrow(/producción/i);
    expect(() => resolveQaTarget({ target: "local", dbUrl: local, supabaseUrl: "https://zzzzzzzzzzzzzzzz.supabase.co", log })).toThrow(
      /PROD_SUPABASE_REF/
    );
    expect(() => resolveQaTarget({ target: "local", dbUrl: prodDb, supabaseUrl: "http://127.0.0.1:54321", log })).toThrow(/LOCAL/);
    expect(() => resolveQaTarget({ target: "prod", dbUrl: local, supabaseUrl: "http://127.0.0.1:54321", log })).toThrow(/local/);
    expect(() =>
      resolveQaTarget({ target: "prod", dbUrl: prodDb, supabaseUrl: "https://abcdefghijklmnop.supabase.co", confirm: "otro", log })
    ).toThrow(/KINESOFT_CONFIRM_PROD/);
    expect(() =>
      resolveQaTarget({
        target: "prod",
        dbUrl: prodDb,
        supabaseUrl: "https://zzzzzzzzzzzzzzzz.supabase.co",
        confirm: "abcdefghijklmnop",
        log,
      })
    ).toThrow(/mismo proyecto/);
    const ok = resolveQaTarget({
      target: "prod",
      dbUrl: prodDb,
      supabaseUrl: "https://abcdefghijklmnop.supabase.co",
      confirm: "abcdefghijklmnop",
      log,
    });
    expect(ok.db.projectRef).toBe("abcdefghijklmnop");
  });

  it("[INF-S] --cleanup borra solo qa-: consultorios, perfiles y cuentas de Auth; el ajeno queda intacto", async () => {
    const userIds = (await db.membership.findMany({ where: { tenant: { slug: { startsWith: PREFIX } } }, select: { userId: true } })).map(
      (m) => m.userId
    );
    expect(userIds.length).toBe(36);
    const r = await cleanupQaTenants(deps, { emailBase: EMAIL_BASE });
    expect(r.tenants.sort()).toEqual(slugs().sort());
    expect(await db.tenant.count({ where: { slug: { startsWith: PREFIX } } })).toBe(0);
    expect(await db.userProfile.count({ where: { id: { in: userIds } } })).toBe(0);
    expect(fake.users.size).toBe(0);
    expect(r.authUsersDeleted).toBe(36);
    // El consultorio ajeno (slug test-…) y su Titular siguen.
    expect(await db.tenant.count({ where: { id: foreign.tenantId } })).toBe(1);
    expect(await db.userProfile.count({ where: { id: foreign.userId } })).toBe(1);
    // Segunda corrida: no hay nada que borrar.
    const again = await cleanupQaTenants(deps, { emailBase: EMAIL_BASE });
    expect(again.tenants).toEqual([]);
    expect(again.authUsersDeleted).toBe(0);
  });
});
