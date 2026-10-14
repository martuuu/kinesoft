/**
 * BO2-A · alta de consultorio + titular desde /plataforma (plan §19.5).
 *
 * Antes: un consultorio nuevo solo salía del stepper web (el kine se registra solo) o de
 * `scripts/create-tenant.ts` (Martin en una terminal, con la service key y una contraseña
 * inventada que había que pasarle al cliente). No quedaba en el registro de plataforma ni
 * había idempotencia: un doble Enter en un panel creaba dos consultorios.
 *
 * Acá se fija, con la action REAL (`createTenantWithOwner`) contra Postgres en los dos roles:
 *  - el consultorio nace completo en UNA tx: Tenant con vertical/plan/trial (el plan por el
 *    escritor único, source `platform`), Practitioner + OWNER aceptado + Particular + agenda +
 *    servicios iniciales de la vertical; doble audit `platform.tenant.create` (consultorio
 *    nuevo + registro global) y NADA en el consultorio «casa» del superadmin;
 *  - el titular nuevo se crea en Auth sin contraseña y sin confirmar (AUDIT §5.26) y recibe un
 *    link de recovery a /reset; uno existente se reutiliza sin `createUser`;
 *  - doble submit con el mismo `idempotencyKey` → un solo consultorio y el resultado del primero;
 *  - slug reservado / inválido / ocupado / alias; P2002 de slug derivado → reintento; slug pedido
 *    que otra alta toma en el medio → error y la cuenta de Auth creada en el intento se borra;
 *  - staff ≠ paciente (§5.22), usuario deshabilitado y perfil huérfano → rechazo sin efectos;
 *  - mail que no sale → ok con el link para copiar; no superadmin → Forbidden sin efectos.
 *
 * Se reemplazan solo el puerto de Auth (fake de GoTrue) y el despacho del mail
 * (`__setEmailTransportForTests`: validación, sink a EmailLog y log siguen corriendo).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createTenantWithOwner } from "@/lib/platform-provisioning";
import { initialSubscriptionFor, type CreateTenantWithOwnerInputType } from "@/lib/platform-provisioning-schemas";
import { starterServicesFor } from "@/lib/tenant-starter-services";
import { slugify } from "@/lib/onboarding-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  deleteTenantDeep,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  next: null as SendEmailResult | null,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    const r = mail.next ?? { ok: true as const, transport: "resend" as const, providerId: `re_${mail.sent.length}` };
    mail.next = null;
    return r;
  },
};

describe.skipIf(!RUN)("[BO2-A] alta de consultorio + titular desde Plataforma", () => {
  let db: PrismaClient;
  let home: EphemeralTenant; // consultorio «casa» del superadmin
  let other: EphemeralTenant; // consultorio ajeno (no superadmin; staff existente)
  let superId: string;
  let gotrue: GotrueFake;
  const createdTenants = new Set<string>();
  const extraProfiles = new Set<string>();

  beforeAll(async () => {
    db = ownerClient();
    home = await createEphemeralTenant(db);
    other = await createEphemeralTenant(db);
    superId = home.userId;
    await db.userProfile.update({ where: { id: superId }, data: { isPlatformAdmin: true } });
  });

  afterAll(async () => {
    for (const id of createdTenants) await deleteTenantDeep(db, id).catch(() => {});
    await home?.cleanup();
    await other?.cleanup();
    if (db) {
      // Los titulares que creó el fake tienen ids UUID (no `test-user-`): deleteTenantDeep no los borra.
      const ids = [...extraProfiles];
      if (ids.length) {
        await db.patient.updateMany({ where: { userId: { in: ids } }, data: { userId: null } });
        await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
        await db.userProfile.deleteMany({ where: { id: { in: ids }, practitioners: { none: {} }, memberships: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent.length = 0;
    mail.next = null;
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    __setEmailTransportForTests(mail.transport);
    asUser(superId);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  function input(o: Partial<CreateTenantWithOwnerInputType> = {}): CreateTenantWithOwnerInputType {
    const s = uniqueSuffix();
    return {
      clinicName: `Consultorio BO2A ${s}`,
      vertical: "KINESIOLOGY",
      plan: "PRO",
      ownerEmail: `bo2a-${s}@test.local`,
      ownerFirstName: "Ana",
      ownerLastName: "Titular",
      idempotencyKey: randomUUID(),
      ...o,
    };
  }

  async function track<T extends { ok: boolean }>(p: Promise<T>): Promise<T> {
    const r = await p;
    if (r.ok) {
      const d = (r as unknown as { data: { tenantId: string; ownerUserId: string } }).data;
      createdTenants.add(d.tenantId);
      extraProfiles.add(d.ownerUserId);
    }
    return r;
  }

  const homePlatformAudits = () =>
    db.auditEvent.count({ where: { tenantId: home.tenantId, action: { startsWith: "platform." } } });
  const tenantsNamed = (name: string) => db.tenant.count({ where: { name } });
  const createUserCalls = () => gotrue.calls.filter((c) => c.method === "createUser");

  /** Espera a que haya un INSERT en "Tenant" bloqueado por un lock (la fila del bloqueador sin commitear). */
  async function waitForBlockedTenantInsert(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%INSERT INTO "public"."Tenant"%'`;
      if ((rows[0]?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error("el alta nunca quedó bloqueada en el INSERT de Tenant (la carrera no se probó)");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Abre una tx (otra conexión) que inserta un Tenant con `slug` y lo deja SIN commitear hasta
   * que el alta quede bloqueada en su INSERT; ahí commitea → el alta recibe P2002 de verdad.
   */
  async function raceSlugAgainst<T>(slug: string, run: () => Promise<T>): Promise<{ result: T; blockerId: string }> {
    const blockerDb = ownerClient(); // conexión propia (la tx queda abierta) y BYPASSRLS: el Tenant no tiene GUC
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ready!: (id: string) => void;
    const readyP = new Promise<string>((r) => (ready = r));
    const blocker = blockerDb.$transaction(
      async (tx) => {
        const t = await tx.tenant.create({ data: { slug, name: `Bloqueador ${slug}` }, select: { id: true } });
        ready(t.id);
        await gate;
      },
      { timeout: 20_000 }
    );
    const blockerId = await readyP;
    createdTenants.add(blockerId);
    const action = run();
    try {
      await waitForBlockedTenantInsert();
    } finally {
      release();
      await blocker;
      await blockerDb.$disconnect();
    }
    return { result: await action, blockerId };
  }

  it("caso feliz: consultorio completo en una tx, plan/trial por el escritor único, doble audit y mail de activación", async () => {
    const before = await homePlatformAudits();
    const i = input();
    const r = await track(createTenantWithOwner(i));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ emailSent: true, replayed: false, slug: slugify(i.clinicName) });
    expect(r.data.activationUrl).toBeUndefined();
    const { tenantId, ownerUserId } = r.data;

    // Tenant: vertical/plan/trial (PRO → 14 días del catálogo), alta completa, turnero apagado.
    const t = await db.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const expected = initialSubscriptionFor("PRO", undefined, new Date());
    expect(t).toMatchObject({
      name: i.clinicName,
      vertical: "KINESIOLOGY",
      plan: "PRO",
      subscriptionStatus: "TRIALING",
      status: "ACTIVE",
      publicBookingEnabled: false,
    });
    expect(t.onboardingCompletedAt).not.toBeNull();
    expect(t.subscriptionStatusChangedAt).not.toBeNull();
    expect(toARDateKey(t.trialEndsAt!)).toBe(toARDateKey(expected.trialEndsAt!));
    expect(expected.trialDays).toBe(14);

    // Titular: Auth creado SIN contraseña y SIN confirmar (§5.26), perfil, OWNER aceptado, profesional.
    const created = createUserCalls();
    expect(created).toHaveLength(1);
    expect(created[0].args[0]).toMatchObject({ email: i.ownerEmail, emailConfirm: false });
    expect((created[0].args[0] as { password?: string }).password).toBeUndefined();
    const authUser = gotrue.users.get(ownerUserId)!;
    expect(authUser).toMatchObject({ email: i.ownerEmail, emailConfirmedAt: null, password: null });
    const profile = await db.userProfile.findUniqueOrThrow({ where: { id: ownerUserId } });
    expect(profile).toMatchObject({ email: i.ownerEmail, fullName: "Ana Titular", isPlatformAdmin: false });
    const m = await db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId: ownerUserId, tenantId } } });
    expect(m.role).toBe("OWNER");
    expect(m.acceptedAt).not.toBeNull();
    const pract = await db.practitioner.findFirstOrThrow({ where: { tenantId, userId: ownerUserId } });

    // Particular + agenda + servicios iniciales de la vertical, habilitados para el titular.
    expect(await db.insurer.count({ where: { tenantId, isParticular: true } })).toBe(1);
    expect(await db.location.count({ where: { tenantId } })).toBe(1);
    expect(await db.practitionerSchedule.count({ where: { tenantId, practitionerId: pract.id } })).toBe(6);
    const services = await db.service.findMany({ where: { tenantId }, select: { id: true, name: true, discipline: true } });
    expect(services.map((s) => s.name).sort()).toEqual(starterServicesFor("KINESIOLOGY").map((s) => s.name).sort());
    expect(await db.practitionerService.count({ where: { tenantId, practitionerId: pract.id } })).toBe(services.length);

    // Audit: platform.tenant.create en el consultorio NUEVO (una vez) + fila global con la clave; sin
    // `tenant.create` del bootstrap (no lo hizo el titular). El alta del plan, por el escritor único.
    const events = await db.auditEvent.findMany({ where: { tenantId }, select: { action: true, actorId: true } });
    expect(events.filter((e) => e.action === "platform.tenant.create")).toEqual([
      { action: "platform.tenant.create", actorId: superId },
    ]);
    expect(events.filter((e) => e.action === "platform.tenant.entitlements")).toHaveLength(1);
    expect(events.some((e) => e.action === "tenant.create")).toBe(false);
    const global = await db.platformAuditEvent.findMany({ where: { tenantId, action: "platform.tenant.create" } });
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ actorId: superId, idempotencyKey: i.idempotencyKey, entityId: tenantId });
    expect(global[0].payload).toMatchObject({ ownerUserId, plan: "PRO", vertical: "KINESIOLOGY", source: "platform" });
    // Sin el email del titular en el registro (solo inserción: lo que entra no sale).
    expect(JSON.stringify(global[0].payload)).not.toContain(i.ownerEmail);
    expect(await homePlatformAudits()).toBe(before);

    // Activación: recovery a /reset (no tiene contraseña) y un mail con el nombre del consultorio.
    const recov = gotrue.calls.filter((c) => c.method === "generateLink");
    expect(recov).toHaveLength(1);
    expect(recov[0].args[0]).toMatchObject({ type: "recovery", email: i.ownerEmail });
    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0];
    expect(sent).toMatchObject({ to: i.ownerEmail, kind: "tenant_activation", tenantId, entity: "Tenant", entityId: tenantId });
    expect(sent.text).toContain(i.clinicName);
    const url = /https?:\/\/\S+\/auth\/confirm\?\S+/.exec(sent.text)?.[0] ?? "";
    expect(new URL(url).searchParams.get("type")).toBe("recovery");
    expect(new URL(url).searchParams.get("next")).toBe("/reset");
    const log = await db.emailLog.findFirstOrThrow({ where: { tenantId, entity: "Tenant", entityId: tenantId } });
    expect(log).toMatchObject({ status: "sent", kind: "tenant_activation" });
  });

  it("General + FREE sin trial, sin servicios y con el alta abierta: ACTIVE, stepper pendiente, sin audit de entitlements no-op", async () => {
    const i = input({ vertical: "GENERAL", plan: "FREE", starterServices: false, onboardingCompleted: false });
    const r = await track(createTenantWithOwner(i));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } });
    expect(t).toMatchObject({ vertical: "GENERAL", plan: "FREE", subscriptionStatus: "ACTIVE", trialEndsAt: null });
    expect(t.onboardingCompletedAt).toBeNull();
    expect(await db.service.count({ where: { tenantId: r.data.tenantId } })).toBe(0);
    // FREE + ACTIVE son los defaults de la columna: el escritor no escribe ni audita un no-op.
    expect(await db.auditEvent.count({ where: { tenantId: r.data.tenantId, action: "platform.tenant.entitlements" } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId: r.data.tenantId, action: "platform.tenant.create" } })).toBe(1);
  });

  it("trialDays explícito gana al del catálogo", async () => {
    const r = await track(createTenantWithOwner(input({ plan: "STARTER", trialDays: 30 })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = await db.tenant.findUniqueOrThrow({ where: { id: r.data.tenantId } });
    expect(t.subscriptionStatus).toBe("TRIALING");
    expect(toARDateKey(t.trialEndsAt!)).toBe(toARDateKey(initialSubscriptionFor("STARTER", 30, new Date()).trialEndsAt!));
  });

  it("doble submit con el mismo idempotencyKey (secuencial): un solo consultorio, el resultado del primero, un solo mail", async () => {
    const i = input();
    const r1 = await track(createTenantWithOwner(i));
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    __rateLimitInternals.reset();
    const r2 = await createTenantWithOwner(i);
    expect(r2).toEqual({
      ok: true,
      data: { tenantId: r1.data.tenantId, slug: r1.data.slug, ownerUserId: r1.data.ownerUserId, emailSent: true, replayed: true },
    });
    expect(await tenantsNamed(i.clinicName)).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(createUserCalls()).toHaveLength(1);
    expect(await db.platformAuditEvent.count({ where: { idempotencyKey: i.idempotencyKey } })).toBe(1);
  });

  it("doble submit simultáneo: el lock por clave serializa y el segundo devuelve el consultorio del primero", async () => {
    const i = input();
    const [a, b] = await Promise.all([track(createTenantWithOwner(i)), track(createTenantWithOwner(i))]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.data.tenantId).toBe(b.data.tenantId);
    expect([a.data.replayed, b.data.replayed].sort()).toEqual([false, true]);
    expect(await tenantsNamed(i.clinicName)).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { tenantId: a.data.tenantId, action: "platform.tenant.create" } })).toBe(1);
  });

  it("la misma clave usada para otra acción de plataforma → error, sin crear nada", async () => {
    const key = randomUUID();
    await db.platformAuditEvent.create({
      data: { actorId: superId, action: "platform.test.other", entity: "Test", tenantId: home.tenantId, idempotencyKey: key },
    });
    const i = input({ idempotencyKey: key });
    const r = await createTenantWithOwner(i);
    expect(r.ok).toBe(false);
    expect(await tenantsNamed(i.clinicName)).toBe(0);
    expect(gotrue.calls).toHaveLength(0);
  });

  it("slug reservado, inválido, ocupado o alias de otro consultorio → fieldError sin tocar Auth ni la base", async () => {
    const alias = `alias-bo2a-${uniqueSuffix()}`.slice(0, 40);
    await db.tenantSlugAlias.create({ data: { slug: alias, tenantId: other.tenantId } });
    const homeSlug = (await db.tenant.findUniqueOrThrow({ where: { id: home.tenantId }, select: { slug: true } })).slug;
    for (const [slug, msg] of [
      ["agenda", /reservado/],
      ["-mal-", /inválido/],
      ["a", /inválido/],
      [homeSlug, /en uso/],
      [alias, /en uso/],
    ] as const) {
      const i = input({ slug });
      const r = await createTenantWithOwner(i);
      expect(r.ok, slug).toBe(false);
      if (r.ok) continue;
      expect(r.fieldErrors?.slug?.[0], slug).toMatch(msg);
      expect(await tenantsNamed(i.clinicName)).toBe(0);
    }
    expect(createUserCalls()).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("slug pedido libre se respeta", async () => {
    const slug = `bo2a-pedido-${uniqueSuffix()}`.slice(0, 40).replace(/-+$/, "");
    const r = await track(createTenantWithOwner(input({ slug })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.slug).toBe(slug);
  });

  it("P2002 del slug derivado (otra alta lo toma en paralelo) → reintenta con el siguiente libre", async () => {
    const i = input();
    const base = slugify(i.clinicName);
    const { result } = await raceSlugAgainst(base, () => track(createTenantWithOwner(i)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.slug).toBe(`${base}-2`);
    expect(await tenantsNamed(i.clinicName)).toBe(1);
  });

  it("slug pedido tomado entre el pre-chequeo y el INSERT → error y se borra la cuenta de Auth creada en este intento", async () => {
    const slug = `bo2a-carrera-${uniqueSuffix()}`.slice(0, 40).replace(/-+$/, "");
    const i = input({ slug });
    const { result } = await raceSlugAgainst(slug, () => createTenantWithOwner(i));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.slug?.[0]).toMatch(/en uso/);
    expect(createUserCalls()).toHaveLength(1);
    const del = gotrue.calls.filter((c) => c.method === "deleteUser");
    expect(del).toHaveLength(1);
    expect([...gotrue.users.values()].some((u) => u.email === i.ownerEmail)).toBe(false);
    expect(await tenantsNamed(i.clinicName)).toBe(0);
    expect(await db.userProfile.count({ where: { email: i.ownerEmail } })).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("email que ya existe en Auth (staff de otro consultorio) → se reutiliza sin createUser; queda titular de los dos", async () => {
    const ownerEmail = `${other.userId}@test.local`;
    // Cuenta confirmada y con contraseña: la sembramos con el MISMO id que su perfil de KineSoft.
    gotrue.users.set(other.userId, {
      id: other.userId,
      email: ownerEmail,
      emailConfirmedAt: new Date().toISOString(),
      lastSignInAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      bannedUntil: null,
      password: "clave-de-siempre",
      fullName: "Otro",
    });
    const r = await track(createTenantWithOwner(input({ ownerEmail })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.ownerUserId).toBe(other.userId);
    expect(createUserCalls()).toHaveLength(0);
    expect(gotrue.users.get(other.userId)?.password).toBe("clave-de-siempre");
    expect(await db.membership.count({ where: { userId: other.userId, role: "OWNER" } })).toBe(2);
    // Ya tiene contraseña: el link lo lleva directo al panel, no a /reset.
    const url = /https?:\/\/\S+\/auth\/confirm\?\S+/.exec(mail.sent[0]?.text ?? "")?.[0] ?? "";
    expect(new URL(url).searchParams.get("next")).toBe("/dashboard");
    createdTenants.add(r.data.tenantId);
    extraProfiles.delete(other.userId); // lo borra la limpieza de `other`
  });

  it("email de un paciente con portal (§5.22) → rechazo sin crear cuenta ni consultorio", async () => {
    const portalUser = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: portalUser, email: `${portalUser}@test.local` } });
    extraProfiles.add(portalUser);
    const ownerEmail = `portal-${uniqueSuffix()}@test.local`;
    const pid = await addPatient(db, other, { email: ownerEmail });
    await db.patient.update({ where: { id: pid }, data: { userId: portalUser } });
    const i = input({ ownerEmail });
    const r = await createTenantWithOwner(i);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.ownerEmail?.[0]).toMatch(/portal de pacientes/);
    expect(createUserCalls()).toHaveLength(0);
    expect(await tenantsNamed(i.clinicName)).toBe(0);
  });

  it("usuario deshabilitado en la plataforma → rechazo sin efectos", async () => {
    const u = `test-user-${uniqueSuffix()}`;
    const ownerEmail = `${u}@test.local`;
    await db.userProfile.create({ data: { id: u, email: ownerEmail, disabledAt: new Date() } });
    extraProfiles.add(u);
    gotrue.users.set(u, {
      id: u,
      email: ownerEmail,
      emailConfirmedAt: new Date().toISOString(),
      lastSignInAt: null,
      createdAt: new Date().toISOString(),
      bannedUntil: null,
      password: "x".repeat(10),
      fullName: null,
    });
    const i = input({ ownerEmail });
    const r = await createTenantWithOwner(i);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.ownerEmail?.[0]).toMatch(/deshabilitada/);
    expect(await tenantsNamed(i.clinicName)).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("perfil huérfano con ese email (sin cuenta de Auth) → rechazo claro en vez de un P2002 opaco", async () => {
    const u = `test-user-${uniqueSuffix()}`;
    const ownerEmail = `${u}@test.local`;
    await db.userProfile.create({ data: { id: u, email: ownerEmail } });
    extraProfiles.add(u);
    const i = input({ ownerEmail });
    const r = await createTenantWithOwner(i);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fieldErrors?.ownerEmail?.[0]).toMatch(/perfil viejo/);
    expect(createUserCalls()).toHaveLength(0);
  });

  it("el mail no sale → ok igual, con el link de activación para copiar (y EmailLog lo registra)", async () => {
    mail.next = { ok: false, transport: "log", skipped: true, reason: "no_api_key" };
    const r = await track(createTenantWithOwner(input()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.emailSent).toBe(false);
    expect(r.data.activationUrl).toMatch(/\/auth\/confirm\?/);
    expect(new URL(r.data.activationUrl!).searchParams.get("type")).toBe("recovery");
    const log = await db.emailLog.findFirstOrThrow({ where: { tenantId: r.data.tenantId, entity: "Tenant" } });
    expect(log).toMatchObject({ status: "skipped", reason: "no_api_key" });
  });

  it("no superadmin → ForbiddenError; sin sesión → UnauthenticatedError; en ningún caso hay efectos", async () => {
    const i = input();
    asUser(other.userId);
    await expect(createTenantWithOwner(i)).rejects.toBeInstanceOf(ForbiddenError);
    asAnonymous();
    await expect(createTenantWithOwner(i)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(gotrue.calls).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(await tenantsNamed(i.clinicName)).toBe(0);
    expect(await db.platformAuditEvent.count({ where: { idempotencyKey: i.idempotencyKey } })).toBe(0);
  });

  it("superadmin deshabilitado → ForbiddenError", async () => {
    await db.userProfile.update({ where: { id: superId }, data: { disabledAt: new Date() } });
    try {
      await expect(createTenantWithOwner(input())).rejects.toBeInstanceOf(ForbiddenError);
      expect(gotrue.calls).toHaveLength(0);
    } finally {
      await db.userProfile.update({ where: { id: superId }, data: { disabledAt: null } });
    }
  });

  it("input con keys de más (.strict) → error de validación sin efectos", async () => {
    const r = await createTenantWithOwner({ ...input(), status: "SUSPENDED" } as unknown as CreateTenantWithOwnerInputType);
    expect(r.ok).toBe(false);
    expect(gotrue.calls).toHaveLength(0);
  });
});
