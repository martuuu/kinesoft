/**
 * IAM-2b · activación de la cuenta desde `/invite/<token>` y aceptación con sesión (punto 4 del QA de
 * Martin, 14-oct: el invitado no podía crear su cuenta).
 *
 * Símbolos REALES: `activateInvitation` (lib/invite-activation-internal.ts) y `acceptInvite`
 * (app/invite/[token]/accept-action.ts) contra Postgres, en los dos roles (`test:integration` y `:owner`).
 * Se reemplaza solo lo externo: GoTrue por el fake (`__setAuthAdminForTests`, C-IAM3), el despacho del mail
 * (`__setEmailTransportForTests`: el sink de EmailLog sigue corriendo) y la cookie/sesión (integration-setup).
 *
 * Arrancó como `it.fails("[IAM-2b] el invitado crea su cuenta desde el link")` con el módulo inexistente; quedó
 * dado vuelta en el primer caso.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { activateInvitation } from "@/lib/invite-activation-internal";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { __setAuthAdminForTests, type AuthAdminPort } from "@/lib/identity/auth-admin";
import { __setEmailTransportForTests, type SendEmailInput } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant-cookie";
import { getActor } from "@/lib/session";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const IP = "203.0.113.7";
const PASSWORD = "clave-segura-1";

const rawToken = () => randomBytes(24).toString("base64url");
const uniqEmail = (tag: string) => `iam2b-${tag}-${randomBytes(4).toString("hex")}@example.com`;

describe.skipIf(!RUN)("IAM-2b activación desde /invite/<token>", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let fake: GotrueFake;
  let sent: SendEmailInput[];
  /** Ids de usuarios creados por el fake (UUID): sus perfiles no los borra `deleteTenantDeep`. */
  const createdUserIds = new Set<string>();
  const plantedProfiles: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    // PRO: estos casos suman varios profesionales al mismo consultorio; FREE (1 lugar) los frena al activar (BO2-B).
    A = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" });
    await db.service.create({
      data: { tenantId: B.tenantId, practitionerId: null, name: "Compartido", durationMin: 30, priceCents: 0 },
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      const ids = [...createdUserIds, ...plantedProfiles];
      if (ids.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
        await db.userProfile.deleteMany({ where: { id: { in: ids }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    fake = new GotrueFake();
    __setAuthAdminForTests(trackingPort(fake));
    sent = [];
    __setEmailTransportForTests(async (i) => {
      sent.push(i);
      return { ok: true, transport: "resend", providerId: `prov-${sent.length}` };
    });
    cookies().delete(ACTIVE_TENANT_COOKIE);
    asAnonymous();
  });

  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  /** Registra los ids que crea el fake (para limpiar perfiles) sin cambiar su comportamiento. */
  function trackingPort(inner: AuthAdminPort, before?: () => Promise<void>): AuthAdminPort {
    return {
      createUser: async (p) => {
        if (before) await before();
        const r = await inner.createUser(p);
        if (r.ok) createdUserIds.add(r.data.id);
        return r;
      },
      deleteUser: (id) => inner.deleteUser(id),
      updateUserById: (id, p) => inner.updateUserById(id, p),
      getUser: (id) => inner.getUser(id),
      findUserByEmail: (e) => inner.findUserByEmail(e),
      listUsers: (p) => inner.listUsers(p),
      generateLink: (p) => inner.generateLink(p),
    };
  }

  async function invite(
    t: EphemeralTenant,
    over: {
      email?: string;
      role?: Role;
      firstName?: string;
      lastName?: string;
      expiresAt?: Date;
      revokedAt?: Date | null;
      acceptedAt?: Date | null;
      prior?: string;
    } = {}
  ): Promise<{ id: string; raw: string; email: string; priorRaw: string | null }> {
    const raw = rawToken();
    const priorRaw = over.prior ?? null;
    const email = over.email ?? uniqEmail("inv");
    const row = await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email,
        firstName: over.firstName ?? "Ana",
        lastName: over.lastName ?? "Pérez",
        role: over.role ?? "PRACTITIONER",
        specialty: "Kinesiología",
        token: hashInviteToken(raw),
        priorTokens: priorRaw ? [hashInviteToken(priorRaw)] : [],
        invitedById: t.userId,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000),
        revokedAt: over.revokedAt ?? null,
        acceptedAt: over.acceptedAt ?? null,
      },
    });
    return { id: row.id, raw, email, priorRaw };
  }

  const input = (token: string, over: Partial<Record<"firstName" | "lastName" | "password" | "passwordConfirm", string>> = {}) => ({
    token,
    firstName: "Ana",
    lastName: "Pérez",
    password: PASSWORD,
    passwordConfirm: over.password ?? PASSWORD,
    ...over,
  });

  async function membershipsOf(email: string) {
    return db.membership.findMany({ where: { user: { email: email.toLowerCase() } } });
  }

  it("[IAM-2b] el invitado crea su cuenta desde el link (atómico: Auth confirmado, perfil, membresía, invitación aceptada; Secretaria sin profesional desde IAM-4a)", async () => {
    // El link usado es uno ANTERIOR reenviado (priorTokens): tiene que valer igual.
    const prior = rawToken();
    const inv = await invite(B, { email: uniqEmail("Act").replace("iam2b", "IAM2B"), role: "ASSISTANT", prior });
    const r = await activateInvitation(input(prior, { firstName: " Ana María ", lastName: "Pérez Gómez" }), { ip: IP });
    expect(r).toMatchObject({ ok: true, tenantId: B.tenantId, adopted: false });
    if (!r.ok) return;
    const email = inv.email.toLowerCase();
    expect(r.email).toBe(email);

    // GoTrue: confirmado (IAM-D1), con la clave y el nombre completo.
    const created = fake.calls.filter((c) => c.method === "createUser");
    expect(created).toHaveLength(1);
    expect(created[0].args[0]).toMatchObject({ email, emailConfirm: true, fullName: "Ana María Pérez Gómez" });
    const au = fake.users.get(r.userId)!;
    expect(au.emailConfirmedAt).not.toBeNull();
    expect(au.password).toBe(PASSWORD);
    expect(fake.calls.some((c) => c.method === "deleteUser")).toBe(false);

    // Filas.
    const profile = await db.userProfile.findUnique({ where: { id: r.userId } });
    expect(profile).toMatchObject({ email, fullName: "Ana María Pérez Gómez" });
    const m = await db.membership.findUnique({ where: { userId_tenantId: { userId: r.userId, tenantId: B.tenantId } } });
    expect(m?.role).toBe("ASSISTANT");
    expect(m?.acceptedAt).not.toBeNull();
    // IAM-4a: la Secretaria es staff sin agenda (§19.2 decisión 2): sin Practitioner ni franjas. El caso del kine
    // (con Practitioner y agenda) está en tests/integration/actor-sin-profesional.test.ts.
    expect(await db.practitioner.count({ where: { tenantId: B.tenantId, userId: r.userId } })).toBe(0);
    expect(await db.practitionerSchedule.count({ where: { tenantId: B.tenantId, practitioner: { userId: r.userId } } })).toBe(0);
    const row = await db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedByUserId).toBe(r.userId);

    // Audit en la tx, cookie del consultorio, bienvenida (y su EmailLog sin el email en claro).
    const ev = await db.auditEvent.findFirst({ where: { tenantId: B.tenantId, entityId: inv.id, action: "invitation.accept" } });
    expect(ev?.actorId).toBe(r.userId);
    expect(ev?.payload).toMatchObject({ via: "activation" });
    expect(cookies().get(ACTIVE_TENANT_COOKIE)?.value).toBe(B.tenantId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "welcome", to: email, tenantId: B.tenantId, entityId: inv.id });
    const logs = await db.emailLog.findMany({ where: { tenantId: B.tenantId, entityId: inv.id } });
    expect(logs.map((l) => [l.kind, l.status])).toEqual([["welcome", "sent"]]);
    expect(JSON.stringify(logs)).not.toContain(email);

    // El mismo link no sirve dos veces.
    const again = await activateInvitation(input(prior), { ip: IP });
    expect(again).toMatchObject({ ok: false, code: "accepted" });
  });

  it("email con una cuenta REAL en GoTrue (confirmada) → «ya tenés cuenta», no escribe nada ni borra a nadie", async () => {
    const inv = await invite(B);
    const pre = await fake.createUser({ email: inv.email, password: "otra-clave-9", emailConfirm: true });
    expect(pre.ok).toBe(true);
    fake.calls.length = 0;

    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "account_exists" });
    expect(fake.calls.map((c) => c.method)).toEqual(["createUser", "findUserByEmail"]);
    expect([...fake.users.values()].find((u) => u.email === inv.email)?.password).toBe("otra-clave-9");
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).toBeNull();
    expect(await membershipsOf(inv.email)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("usuario de Auth sin confirmar pero que YA entró (lastSignInAt) no es zombie → «ya tenés cuenta»", async () => {
    const inv = await invite(B);
    const pre = await fake.createUser({ email: inv.email, password: "otra-clave-9", emailConfirm: false });
    if (!pre.ok) throw new Error("seed");
    fake.users.get(pre.data.id)!.lastSignInAt = new Date().toISOString();
    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "account_exists" });
    expect(fake.calls.some((c) => c.method === "updateUserById")).toBe(false);
  });

  it("email con perfil de KineSoft → «ya tenés cuenta» sin llamar a GoTrue", async () => {
    const r0 = await invite(B, { email: `${A.userId}@test.local` });
    const r = await activateInvitation(input(r0.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "account_exists" });
    expect(fake.calls).toHaveLength(0);
  });

  it("adopta un zombie (sin confirmar, sin login, sin perfil, sin membresías ni fichas): updateUserById y sigue", async () => {
    const inv = await invite(B);
    const z = await fake.createUser({ email: inv.email, emailConfirm: false });
    if (!z.ok) throw new Error("seed");
    createdUserIds.add(z.data.id);
    fake.calls.length = 0;

    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: true, userId: z.data.id, adopted: true });
    const up = fake.calls.find((c) => c.method === "updateUserById");
    expect(up?.args).toEqual([z.data.id, { password: PASSWORD, emailConfirm: true, fullName: "Ana Pérez" }]);
    expect(fake.users.get(z.data.id)?.emailConfirmedAt).not.toBeNull();
    expect(fake.calls.some((c) => c.method === "deleteUser")).toBe(false);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedByUserId).toBe(z.data.id);
    const ev = await db.auditEvent.findFirst({ where: { entityId: inv.id, action: "invitation.accept" } });
    expect(ev?.payload).toMatchObject({ via: "activation", adopted: true });
  });

  it("falla de la base después de crear el usuario → deleteUser del creado en ESTE intento, nada escrito", async () => {
    const inv = await invite(B);
    // Un alta concurrente deja un perfil con el mismo email entre el chequeo y la tx: el upsert del
    // perfil choca con el único de `UserProfile.email` (falla real de Postgres, no simulada).
    const planted = `iam2b-planted-${uniqueSuffix()}`;
    plantedProfiles.push(planted);
    __setAuthAdminForTests(
      trackingPort(fake, async () => {
        await db.userProfile.create({ data: { id: planted, email: inv.email } });
      })
    );
    const before = new Set(createdUserIds);
    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "error" });
    const createdId = [...createdUserIds].find((id) => !before.has(id))!;
    expect(createdId).toBeTruthy();
    const del = fake.calls.find((c) => c.method === "deleteUser");
    expect(del?.args).toEqual([createdId]);
    expect(fake.users.has(createdId)).toBe(false);
    const row = await db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.acceptedAt).toBeNull();
    expect(await db.membership.count({ where: { userId: createdId } })).toBe(0);
    expect(await db.auditEvent.count({ where: { entityId: inv.id } })).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("pierde el CAS (otra aceptación ganó entre la lectura y la tx) → borra el usuario creado y dice «ya aceptada»", async () => {
    const inv = await invite(B);
    __setAuthAdminForTests(
      trackingPort(fake, async () => {
        await db.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedByUserId: "otro" } });
      })
    );
    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "accepted" });
    expect(fake.calls.filter((c) => c.method === "deleteUser")).toHaveLength(1);
    expect([...fake.users.values()].some((u) => u.email === inv.email)).toBe(false);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedByUserId).toBe("otro");
    expect(await membershipsOf(inv.email)).toHaveLength(0);
  });

  it("anulada en carrera → el CAS también la frena y lo dice", async () => {
    const inv = await invite(B);
    __setAuthAdminForTests(
      trackingPort(fake, async () => {
        await db.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
      })
    );
    expect(await activateInvitation(input(inv.raw), { ip: IP })).toMatchObject({ ok: false, code: "revoked" });
    expect(fake.calls.filter((c) => c.method === "deleteUser")).toHaveLength(1);
  });

  it("dos activaciones en carrera → gana una (una cuenta, una membresía)", async () => {
    const inv = await invite(B);
    const [r1, r2] = await Promise.all([
      activateInvitation(input(inv.raw), { ip: IP }),
      activateInvitation(input(inv.raw), { ip: "203.0.113.8" }),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    const loser = [r1, r2].find((r) => !r.ok)!;
    expect(["accepted", "account_exists"]).toContain(loser.ok ? "" : loser.code);
    expect([...fake.users.values()].filter((u) => u.email === inv.email)).toHaveLength(1);
    const ms = await membershipsOf(inv.email);
    expect(ms).toHaveLength(1);
    const winner = oks[0];
    if (!winner.ok) return;
    expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedByUserId).toBe(winner.userId);
  });

  it("dos adopciones del mismo zombie en carrera → el CAS deja una y el zombie no se borra", async () => {
    const inv = await invite(B);
    const z = await fake.createUser({ email: inv.email, emailConfirm: false });
    if (!z.ok) throw new Error("seed");
    createdUserIds.add(z.data.id);
    const rs = await Promise.all([
      activateInvitation(input(inv.raw), { ip: IP }),
      activateInvitation(input(inv.raw), { ip: "203.0.113.9" }),
    ]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(fake.users.has(z.data.id)).toBe(true);
    expect(fake.calls.some((c) => c.method === "deleteUser")).toBe(false);
    expect(await db.membership.count({ where: { userId: z.data.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { entityId: inv.id, action: "invitation.accept" } })).toBe(1);
  });

  it("anulada / vencida / aceptada / link desconocido → error claro, sin tocar GoTrue", async () => {
    const rev = await invite(B, { revokedAt: new Date() });
    const exp = await invite(B, { expiresAt: new Date(Date.now() - 1000) });
    const acc = await invite(B, { acceptedAt: new Date() });
    expect(await activateInvitation(input(rev.raw), { ip: IP })).toMatchObject({
      ok: false,
      code: "revoked",
      error: expect.stringContaining("anuló"),
    });
    expect(await activateInvitation(input(exp.raw), { ip: IP })).toMatchObject({
      ok: false,
      code: "expired",
      error: expect.stringContaining("venció"),
    });
    expect(await activateInvitation(input(acc.raw), { ip: IP })).toMatchObject({ ok: false, code: "accepted" });
    expect(await activateInvitation(input(rawToken()), { ip: IP })).toMatchObject({ ok: false, code: "not_found" });
    expect(fake.calls).toHaveLength(0);
  });

  it("email de un paciente con portal (en cualquier consultorio) → rechazo §5.22, sin crear la cuenta", async () => {
    const inv = await invite(B);
    const pid = await addPatient(db, A, { email: inv.email.toUpperCase() });
    const portalUser = `iam2b-portal-${uniqueSuffix()}`;
    plantedProfiles.push(portalUser);
    // Perfil con OTRO email: así el rechazo viene de la ficha con portal y no del «ya tenés cuenta».
    await db.userProfile.create({ data: { id: portalUser, email: `${portalUser}@portal.test` } });
    await db.patient.update({ where: { id: pid }, data: { userId: portalUser } });
    const r = await activateInvitation(input(inv.raw), { ip: IP });
    expect(r).toMatchObject({ ok: false, code: "patient_identity" });
    expect(fake.calls).toHaveLength(0);
    await db.patient.update({ where: { id: pid }, data: { userId: null } });
  });

  it("validación: contraseña corta, sin número o que no coincide → invalid_input por campo, sin llamadas", async () => {
    const inv = await invite(B);
    const short = await activateInvitation(input(inv.raw, { password: "a1" }), { ip: IP });
    expect(short).toMatchObject({ ok: false, code: "invalid_input" });
    if (!short.ok) expect(short.fieldErrors?.password?.[0]).toMatch(/8/);
    const mismatch = await activateInvitation(input(inv.raw, { passwordConfirm: "otra-cosa-2" }), { ip: IP });
    if (!mismatch.ok) expect(mismatch.fieldErrors?.passwordConfirm?.[0]).toMatch(/no coinciden/);
    const noName = await activateInvitation(input(inv.raw, { firstName: "  " }), { ip: IP });
    if (!noName.ok) expect(noName.fieldErrors?.firstName).toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });

  it("rate limit por token: el 6º intento con el mismo link en 10 min se frena", async () => {
    const rev = await invite(B, { revokedAt: new Date() });
    for (let i = 0; i < 5; i++) {
      expect(await activateInvitation(input(rev.raw), { ip: `198.51.100.${i}` })).toMatchObject({ code: "revoked" });
    }
    expect(await activateInvitation(input(rev.raw), { ip: "198.51.100.99" })).toMatchObject({ code: "rate_limited" });
  });

  describe("aceptación con sesión (acceptInvite)", () => {
    it("un kine de A que acepta B queda en B: profesional de B con agenda, cookie kine_tenant = B y getActor en B", async () => {
      const inv = await invite(B, { email: `${A.userId}@test.local` });
      asUser(A.userId);
      expect(await acceptInvite(inv.raw)).toEqual({ ok: true, data: undefined });
      expect(cookies().get(ACTIVE_TENANT_COOKIE)?.value).toBe(B.tenantId);
      const prac = await db.practitioner.findUnique({ where: { tenantId_userId: { tenantId: B.tenantId, userId: A.userId } } });
      expect(prac).not.toBeNull();
      expect(await db.practitionerSchedule.count({ where: { practitionerId: prac!.id } })).toBeGreaterThan(0);
      const row = await db.invitation.findUniqueOrThrow({ where: { id: inv.id } });
      expect(row.acceptedByUserId).toBe(A.userId);
      expect((await getActor()).tenantId).toBe(B.tenantId);
      const ev = await db.auditEvent.findFirst({ where: { entityId: inv.id, action: "invitation.accept" } });
      expect(ev?.payload).toMatchObject({ via: "session" });
      // Ya aceptada: el mismo link no vuelve a escribir.
      expect(await acceptInvite(inv.raw)).toMatchObject({ ok: false, error: expect.stringContaining("ya fue aceptada") });
    });

    it("un link anterior reenviado sirve para aceptar; una anulada no", async () => {
      const t = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "CLINICA" }); // cupo (BO2-B)
      try {
        const prior = rawToken();
        const inv = await invite(t, { email: `${A.userId}@test.local`, prior });
        asUser(A.userId);
        expect(await acceptInvite(prior)).toEqual({ ok: true, data: undefined });
        const rev = await invite(t, { email: `${A.userId}@test.local`, revokedAt: new Date() });
        expect(await acceptInvite(rev.raw)).toMatchObject({ ok: false, error: expect.stringContaining("anuló") });
        expect((await db.invitation.findUniqueOrThrow({ where: { id: inv.id } })).acceptedAt).not.toBeNull();
      } finally {
        await t.cleanup();
      }
    });

    it("staff ≠ paciente: una identidad vinculada a una ficha se rechaza", async () => {
      const s = uniqueSuffix();
      const uid = `test-user-portal-${s}`;
      await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
      const pid = await addPatient(db, A, {});
      await db.patient.update({ where: { id: pid }, data: { userId: uid } });
      const inv = await invite(B, { email: `${uid}@test.local` });
      asUser(uid);
      expect(await acceptInvite(inv.raw)).toMatchObject({ ok: false, error: expect.stringContaining("portal de pacientes") });
      expect(await db.membership.count({ where: { userId: uid } })).toBe(0);
      await db.patient.update({ where: { id: pid }, data: { userId: null } });
      plantedProfiles.push(uid);
    });
  });
});
