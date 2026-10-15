/**
 * BO2-C · directorio global de usuarios y acciones de cuenta de /plataforma (plan §19.5 fila «C»; §19.1 «cuentas
 * muertas»). Símbolos REALES (`lib/platform-users-read.ts`, `lib/platform-users.ts`) contra Postgres en los dos
 * roles (`test:integration` y `:owner`). Se reemplazan solo la sesión de Supabase (integration-setup), el puerto de
 * Auth (fake de GoTrue) y el despacho del mail (`__setEmailTransportForTests`: el sink a EmailLog sigue corriendo).
 *
 * Se fija:
 *  - barrera: quien no es superadmin rebota en cada export sin escribir ni auditar;
 *  - directorio: equipo / portal / huérfano; DTO con lista cerrada de campos; para la parte de PORTAL solo un
 *    conteo, nunca el nombre del consultorio ni datos de la ficha (fixture de PHI); búsqueda sin comodines; el
 *    usuario «solo Auth» aparece al buscar su email exacto;
 *  - link de acceso: el superadmin no ve el link si el mail salió; si no salió, se lo devolvemos; el registro no
 *    lleva ni link ni email;
 *  - deshabilitar/habilitar: base + ban en Auth; nadie se deshabilita a sí mismo; Auth caído = `authSynced:false`;
 *  - dar/quitar superadmin con confirmación tipeada; registro `platform.superadmin.grant|revoke`;
 *  - reparaciones: `Practitioner` + agenda, borrar huérfano de Auth solo si es seguro, sincronizar email.
 *
 * «No el último superadmin»: depende de cuántos superadmins activos hay en TODA la base (compartida con otras
 * sesiones y con el superadmin real del Docker); se cubre en unit (`platform-health-logic.test.ts`) y acá solo el
 * caso «hay otro activo → se puede».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { searchPlatformUsers, getPlatformUser } from "@/lib/platform-users-read";
import {
  sendPlatformAccessLink,
  setPlatformUserDisabled,
  setPlatformSuperadmin,
  repairCreatePractitioner,
  repairDeleteAuthOrphan,
  repairSyncProfileEmail,
} from "@/lib/platform-users";
import { ForbiddenError } from "@/lib/session";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const PHI_MARK = "Zqxphibo2c";

const ROW_KEYS = [
  "createdAt",
  "disabled",
  "email",
  "fullName",
  "id",
  "isPlatformAdmin",
  "kind",
  "membershipCount",
  "portalLinkCount",
];
const DETAIL_KEYS = [
  "auth",
  "createdAt",
  "disabled",
  "disabledAt",
  "disabledReason",
  "email",
  "fullName",
  "id",
  "isPlatformAdmin",
  "kind",
  "memberships",
  "portalLinkCount",
];
const MEMBERSHIP_KEYS = [
  "accepted",
  "acceptedAt",
  "clinical", // PL-1
  "hasPractitioner",
  "membershipId",
  "role",
  "suspended",
  "tenantId",
  "tenantName",
  "tenantSlug",
  "tenantStatus",
  "tenantVertical",
];

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  result: null as SendEmailResult | null,
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return mail.result ?? { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

describe.skipIf(!RUN)("[BO2-C] directorio de usuarios y cuentas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // consultorio con el miembro de equipo y la ficha de portal
  let gotrue: GotrueFake;
  let S: string; // superadmin sin consultorio
  let S2: string; // otro superadmin activo (para que S no sea «el último»)
  const MARK = `Bo2cdir${uniqueSuffix().replace(/[^a-z0-9]/gi, "")}`;
  const users: string[] = [];

  async function profile(o: { name?: string; admin?: boolean; email?: string } = {}): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id, email: o.email ?? `${id}@test.local`, fullName: o.name ?? `${MARK} ${id}`, isPlatformAdmin: o.admin ?? false },
    });
    users.push(id);
    return id;
  }

  function seedAuth(id: string, o: { email?: string; confirmed?: boolean; signedIn?: boolean } = {}) {
    const now = new Date().toISOString();
    gotrue.users.set(id, {
      id,
      email: o.email ?? `${id}@test.local`,
      emailConfirmedAt: o.confirmed === false ? null : now,
      lastSignInAt: o.signedIn === false ? null : now,
      createdAt: now,
      bannedUntil: null,
      password: null,
      fullName: null,
    });
  }

  const platformEvents = (targetUserId: string) =>
    db.platformAuditEvent.findMany({ where: { targetUserId }, orderBy: { createdAt: "asc" } });

  // Fixture: equipo (miembro de T), portal (ficha en T con PHI), huérfano.
  let teamUser: string;
  let portalUser: string;
  let orphanUser: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: T.tenantId }, data: { name: `Consultorio ${PHI_MARK}` } });
    S = await profile({ admin: true, name: "Super Admin BO2C" });
    S2 = await profile({ admin: true, name: "Otro Super BO2C" });

    teamUser = await profile();
    await db.membership.create({ data: { userId: teamUser, tenantId: T.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    await db.practitioner.create({ data: { tenantId: T.tenantId, userId: teamUser } });

    portalUser = await profile();
    await db.patient.create({
      data: {
        tenantId: T.tenantId,
        userId: portalUser,
        firstName: PHI_MARK,
        lastName: `Paciente ${PHI_MARK}`,
        documentId: `DNI-${uniqueSuffix()}`,
        notes: `Lumbalgia crónica ${PHI_MARK}`,
      },
    });

    orphanUser = await profile();
  });

  afterAll(async () => {
    if (!db) return;
    await T?.cleanup();
    if (users.length) {
      // Registro solo inserción: la limpieza de TEST lo saltea en modo réplica (como deleteTenantDeep).
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "targetUserId" = ANY(${users}::text[]) OR "actorId" = ANY(${users}::text[])`,
      ]);
      await db.patient.deleteMany({ where: { userId: { in: users } } });
      await db.membership.deleteMany({ where: { userId: { in: users } } });
      await db.practitioner.deleteMany({ where: { userId: { in: users } } });
      await db.userProfile.deleteMany({ where: { id: { in: users } } });
    }
    await db.$disconnect();
  });

  beforeEach(() => {
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    mail.sent.length = 0;
    mail.result = null;
    __setEmailTransportForTests(mail.transport);
    __rateLimitInternals.reset();
    asUser(S);
  });

  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  it("quien no es superadmin rebota en cada export, sin escribir ni auditar", async () => {
    asUser(T.userId); // OWNER de un consultorio, no superadmin
    const calls: Array<() => Promise<unknown>> = [
      () => searchPlatformUsers({ q: MARK }),
      () => getPlatformUser(teamUser),
      () => sendPlatformAccessLink({ userId: teamUser }),
      () => setPlatformUserDisabled({ userId: teamUser, disabled: true }),
      () => setPlatformSuperadmin({ userId: teamUser, grant: true, confirmEmail: `${teamUser}@test.local` }),
      () => repairCreatePractitioner({ tenantId: T.tenantId, userId: teamUser }),
      () => repairDeleteAuthOrphan({ authUserId: teamUser }),
      () => repairSyncProfileEmail({ userId: teamUser }),
    ];
    for (const c of calls) await expect(c()).rejects.toBeInstanceOf(ForbiddenError);
    const u = await db.userProfile.findUniqueOrThrow({ where: { id: teamUser } });
    expect(u.disabledAt).toBeNull();
    expect(u.isPlatformAdmin).toBe(false);
    expect(await platformEvents(teamUser)).toHaveLength(0);
    expect(gotrue.calls).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("directorio: clasifica equipo / portal / huérfano con lista cerrada de campos y sin PHI ni consultorios del portal", async () => {
    const page = await searchPlatformUsers({ q: MARK });
    const byId = new Map(page.rows.map((r) => [r.id, r]));
    expect(byId.get(teamUser)?.kind).toBe("team");
    expect(byId.get(portalUser)?.kind).toBe("portal");
    expect(byId.get(portalUser)?.portalLinkCount).toBe(1);
    expect(byId.get(orphanUser)?.kind).toBe("orphan");
    expect(byId.get(S)).toBeUndefined(); // el nombre de S no lleva MARK
    for (const r of page.rows) expect(Object.keys(r).sort()).toEqual(ROW_KEYS);
    expect(JSON.stringify(page)).not.toContain(PHI_MARK);

    const portalOnly = await searchPlatformUsers({ q: MARK, kind: "portal" });
    expect(portalOnly.rows.map((r) => r.id)).toEqual([portalUser]);
    const orphans = await searchPlatformUsers({ q: MARK, kind: "orphan" });
    expect(orphans.rows.map((r) => r.id)).toEqual([orphanUser]);
    const team = await searchPlatformUsers({ q: MARK, kind: "team" });
    expect(team.rows.map((r) => r.id)).toEqual([teamUser]);
  });

  it("la búsqueda no interpreta comodines de LIKE", async () => {
    expect((await searchPlatformUsers({ q: `${MARK}%` })).total).toBe(0);
    expect((await searchPlatformUsers({ q: `${MARK.slice(0, -1)}_` })).total).toBe(0);
  });

  it("detalle del paciente de portal: solo el conteo de fichas, nunca de qué consultorio", async () => {
    const d = await getPlatformUser(portalUser);
    expect(d).not.toBeNull();
    expect(Object.keys(d!).sort()).toEqual(DETAIL_KEYS);
    expect(d!.kind).toBe("portal");
    expect(d!.memberships).toEqual([]);
    expect(d!.portalLinkCount).toBe(1);
    expect(d!.auth).toEqual({ status: "missing" });
    const json = JSON.stringify(d);
    expect(json).not.toContain(PHI_MARK);
    expect(json).not.toContain(T.tenantId);
    expect(json).not.toContain(T.slug);
  });

  it("detalle del equipo: membresías con consultorio, rol, profesional y estado de Auth", async () => {
    seedAuth(teamUser);
    const d = await getPlatformUser(teamUser);
    expect(d!.kind).toBe("team");
    expect(d!.memberships).toHaveLength(1);
    expect(Object.keys(d!.memberships[0]).sort()).toEqual(MEMBERSHIP_KEYS);
    expect(d!.memberships[0]).toMatchObject({ tenantId: T.tenantId, role: "PRACTITIONER", accepted: true, suspended: false, hasPractitioner: true });
    // BO3 (integrador): la vertical viaja para el rótulo del rol (la factory crea KINESIOLOGY por default).
    expect(d!.memberships[0].tenantVertical).toBe("KINESIOLOGY");
    expect(d!.auth).toMatchObject({ status: "ok", emailConfirmed: true, banned: false, emailMismatch: false });
    expect(await getPlatformUser("no-existe")).toBeNull();
  });

  it("usuario solo de Auth: aparece al buscar su email exacto, borrable si nunca se usó", async () => {
    const email = `huerfano-${uniqueSuffix()}@test.local`;
    const created = await gotrue.createUser({ email, emailConfirm: false });
    expect(created.ok).toBe(true);
    const page = await searchPlatformUsers({ q: email.toUpperCase() });
    expect(page.rows).toHaveLength(0);
    expect(page.authOnly).toMatchObject({ email, emailConfirmed: false, canDelete: true });
    // Un email con perfil no consulta Auth como «solo Auth».
    expect((await searchPlatformUsers({ q: `${teamUser}@test.local` })).authOnly).toBeNull();
  });

  it("link de acceso: con el mail enviado el superadmin no ve el link; el registro no lleva ni link ni email", async () => {
    seedAuth(teamUser);
    const r = await sendPlatformAccessLink({ userId: teamUser });
    expect(r).toEqual({ ok: true, data: { purpose: "recovery", emailSent: true, emailStatus: "sent", copyUrl: null } });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: `${teamUser}@test.local`, kind: "platform_access_link", entity: "UserProfile", entityId: teamUser });
    expect(mail.sent[0].html).toContain("token_hash=");
    expect(gotrue.links.at(-1)).toMatchObject({ type: "recovery", userId: teamUser });

    const ev = (await platformEvents(teamUser)).filter((e) => e.action === "platform.user.access_link");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorId: S, tenantId: null, entity: "UserProfile", entityId: teamUser });
    const payload = JSON.stringify(ev[0].payload);
    expect(payload).not.toContain("token_hash");
    expect(payload).not.toContain("@");
    expect(ev[0].payload).toMatchObject({ purpose: "recovery", emailStatus: "sent", linkShown: false });
  });

  it("link de acceso: si el mail no sale, se devuelve el link para copiar; invitado sin entrar = activación", async () => {
    seedAuth(orphanUser, { confirmed: false, signedIn: false });
    mail.result = { ok: false, transport: "log", skipped: true, reason: "log_only" };
    const r = await sendPlatformAccessLink({ userId: orphanUser });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ purpose: "activation", emailSent: false, emailStatus: "skipped" });
    expect(r.data.copyUrl).toMatch(/\/auth\/confirm\?token_hash=.+&type=recovery/);
    const ev = (await platformEvents(orphanUser)).find((e) => e.action === "platform.user.access_link");
    expect(ev?.payload).toMatchObject({ purpose: "activation", linkShown: true });
    expect(JSON.stringify(ev?.payload)).not.toContain("token_hash");
  });

  it("[BO-Z] B2: link de acceso a una cuenta YA activa con el mail caído → sin link para copiar y mensaje claro", async () => {
    seedAuth(teamUser);
    mail.result = { ok: false, transport: "resend", skipped: false, reason: "bounce" };
    const r = await sendPlatformAccessLink({ userId: teamUser });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("como la cuenta ya está activa, no mostramos el link") });
    expect(JSON.stringify(r)).not.toContain("token_hash");
    const ev = (await platformEvents(teamUser)).filter((e) => e.action === "platform.user.access_link").at(-1);
    expect(ev?.payload).toMatchObject({ purpose: "recovery", emailStatus: "failed", linkShown: false });
  });

  it("link de acceso: sin cuenta en Auth o con el email desincronizado, no se emite nada", async () => {
    const lonely = await profile();
    expect(await sendPlatformAccessLink({ userId: lonely })).toMatchObject({ ok: false });
    seedAuth(lonely, { email: `otro-${lonely}@test.local` });
    const r = await sendPlatformAccessLink({ userId: lonely });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Sincronizalo/) });
    expect(gotrue.links).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("deshabilitar / habilitar: base + ban de Auth, auditado; nadie se deshabilita a sí mismo", async () => {
    expect(await setPlatformUserDisabled({ userId: S, disabled: true })).toMatchObject({ ok: false, error: "No podés deshabilitarte a vos mismo." });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: S } })).disabledAt).toBeNull();

    seedAuth(teamUser);
    const off = await setPlatformUserDisabled({ userId: teamUser, disabled: true, reason: `Pedido del titular ${PHI_MARK}` });
    expect(off).toEqual({ ok: true, data: { changed: true, authSynced: true } });
    const u = await db.userProfile.findUniqueOrThrow({ where: { id: teamUser } });
    expect(u.disabledAt).not.toBeNull();
    expect(u.disabledReason).toContain("Pedido del titular");
    expect(Date.parse(gotrue.users.get(teamUser)!.bannedUntil!)).toBeGreaterThan(Date.now() + 365 * 86_400_000);
    // Idempotente: repetir no vuelve a auditar.
    expect(await setPlatformUserDisabled({ userId: teamUser, disabled: true })).toEqual({ ok: true, data: { changed: false, authSynced: true } });

    const on = await setPlatformUserDisabled({ userId: teamUser, disabled: false });
    expect(on).toEqual({ ok: true, data: { changed: true, authSynced: true } });
    const u2 = await db.userProfile.findUniqueOrThrow({ where: { id: teamUser } });
    expect(u2.disabledAt).toBeNull();
    expect(u2.disabledReason).toBeNull();
    expect(gotrue.users.get(teamUser)!.bannedUntil).toBeNull();

    const ev = (await platformEvents(teamUser)).filter((e) => e.action.startsWith("platform.user.") && e.action !== "platform.user.access_link");
    expect(ev.map((e) => e.action)).toEqual(["platform.user.disable", "platform.user.enable"]);
    // El motivo (texto libre) no va al registro solo inserción.
    expect(JSON.stringify(ev[0].payload)).not.toContain(PHI_MARK);
    expect(ev[0].payload).toMatchObject({ reasonGiven: true });
  });

  it("deshabilitar con Auth caído: la base queda deshabilitada y el resultado lo dice", async () => {
    seedAuth(orphanUser);
    gotrue.failNext("error", "updateUserById");
    const r = await setPlatformUserDisabled({ userId: orphanUser, disabled: true });
    expect(r).toEqual({ ok: true, data: { changed: true, authSynced: false } });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: orphanUser } })).disabledAt).not.toBeNull();
    // Reintento: la base ya estaba, Auth ahora sí.
    expect(await setPlatformUserDisabled({ userId: orphanUser, disabled: true })).toEqual({ ok: true, data: { changed: false, authSynced: true } });
    await setPlatformUserDisabled({ userId: orphanUser, disabled: false });
  });

  it("se puede deshabilitar a otro superadmin mientras quede alguno activo", async () => {
    const extra = await profile({ admin: true });
    expect(await setPlatformUserDisabled({ userId: extra, disabled: true })).toMatchObject({ ok: true });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: extra } })).disabledAt).not.toBeNull();
  });

  it("dar / quitar superadmin: exige el email tipeado; auditado como grant / revoke", async () => {
    const target = await profile();
    const wrong = await setPlatformSuperadmin({ userId: target, grant: true, confirmEmail: "otro@test.local" });
    expect(wrong).toMatchObject({ ok: false, error: expect.stringMatching(/escribí exactamente el email/) });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: target } })).isPlatformAdmin).toBe(false);

    const g = await setPlatformSuperadmin({ userId: target, grant: true, confirmEmail: ` ${target.toUpperCase()}@TEST.LOCAL` });
    expect(g).toEqual({ ok: true, data: { changed: true } });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: target } })).isPlatformAdmin).toBe(true);

    const rv = await setPlatformSuperadmin({ userId: target, grant: false, confirmEmail: `${target}@test.local` });
    expect(rv).toEqual({ ok: true, data: { changed: true } });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: target } })).isPlatformAdmin).toBe(false);

    const ev = await platformEvents(target);
    expect(ev.map((e) => e.action)).toEqual(["platform.superadmin.grant", "platform.superadmin.revoke"]);
    expect(ev[0]).toMatchObject({ actorId: S, tenantId: null, entityId: target });

    // A un deshabilitado no se le da Plataforma.
    await db.userProfile.update({ where: { id: target }, data: { disabledAt: new Date() } });
    expect(await setPlatformSuperadmin({ userId: target, grant: true, confirmEmail: `${target}@test.local` })).toMatchObject({ ok: false });
    // Strict: una key de más rebota.
    expect(await setPlatformSuperadmin({ userId: target, grant: true, confirmEmail: `${target}@test.local`, mfa: "x" })).toMatchObject({
      ok: false,
      error: "Datos inválidos",
    });
  });

  it("reparación: miembro clínico sin Practitioner → profesional + agenda, doble audit; idempotente; no clínico no", async () => {
    const kine = await profile();
    await db.membership.create({ data: { userId: kine, tenantId: T.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    const r = await repairCreatePractitioner({ tenantId: T.tenantId, userId: kine });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.created).toBe(true);
    const prac = await db.practitioner.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: T.tenantId, userId: kine } } });
    expect(prac.id).toBe(r.data.practitionerId);
    expect(await db.practitionerSchedule.count({ where: { practitionerId: prac.id } })).toBeGreaterThan(0);

    const tenantEv = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, action: "platform.repair.practitioner" } });
    expect(tenantEv).toHaveLength(1);
    expect(tenantEv[0]).toMatchObject({ actorId: S, entityId: prac.id });
    const globalEv = await db.platformAuditEvent.findMany({ where: { tenantId: T.tenantId, action: "platform.repair.practitioner" } });
    expect(globalEv).toHaveLength(1);

    expect(await repairCreatePractitioner({ tenantId: T.tenantId, userId: kine })).toEqual({
      ok: true,
      data: { practitionerId: prac.id, created: false },
    });
    expect(await db.auditEvent.count({ where: { tenantId: T.tenantId, action: "platform.repair.practitioner" } })).toBe(1);

    const secre = await profile();
    await db.membership.create({ data: { userId: secre, tenantId: T.tenantId, role: "ASSISTANT", acceptedAt: new Date() } });
    expect(await repairCreatePractitioner({ tenantId: T.tenantId, userId: secre })).toMatchObject({ ok: false });
    expect(await db.practitioner.count({ where: { tenantId: T.tenantId, userId: secre } })).toBe(0);
    // No miembro del consultorio.
    expect(await repairCreatePractitioner({ tenantId: T.tenantId, userId: orphanUser })).toMatchObject({ ok: false });
  });

  it("reparación: borrar huérfano de Auth solo si es seguro; si GoTrue falla, no queda registro", async () => {
    const zombie = await gotrue.createUser({ email: `zombie-${uniqueSuffix()}@test.local`, emailConfirm: false });
    const used = await gotrue.createUser({ email: `usado-${uniqueSuffix()}@test.local`, emailConfirm: true });
    if (!zombie.ok || !used.ok) throw new Error("fake");
    users.push(zombie.data.id, used.data.id); // para limpiar el registro

    expect(await repairDeleteAuthOrphan({ authUserId: used.data.id })).toMatchObject({ ok: false });
    expect(gotrue.users.has(used.data.id)).toBe(true);
    // Uno con perfil (mismo id) tampoco, aunque nunca haya entrado.
    seedAuth(orphanUser, { confirmed: false, signedIn: false });
    expect(await repairDeleteAuthOrphan({ authUserId: orphanUser })).toMatchObject({ ok: false });
    expect(gotrue.users.has(orphanUser)).toBe(true);

    gotrue.failNext("error", "deleteUser");
    expect(await repairDeleteAuthOrphan({ authUserId: zombie.data.id })).toMatchObject({ ok: false });
    expect(gotrue.users.has(zombie.data.id)).toBe(true);
    expect(await platformEvents(zombie.data.id)).toHaveLength(0);

    expect(await repairDeleteAuthOrphan({ authUserId: zombie.data.id })).toEqual({ ok: true, data: { deleted: true } });
    expect(gotrue.users.has(zombie.data.id)).toBe(false);
    const ev = await platformEvents(zombie.data.id);
    expect(ev.map((e) => e.action)).toEqual(["platform.repair.auth_orphan_delete"]);
    expect(await platformEvents(used.data.id)).toHaveLength(0);
  });

  it("reparación: sincroniza el email del perfil con Auth; si otro perfil lo usa, no", async () => {
    const drift = await profile();
    const newEmail = `nuevo-${drift}@test.local`;
    seedAuth(drift, { email: newEmail });
    expect(await repairSyncProfileEmail({ userId: drift })).toEqual({ ok: true, data: { changed: true } });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: drift } })).email).toBe(newEmail);
    expect(await repairSyncProfileEmail({ userId: drift })).toEqual({ ok: true, data: { changed: false } });
    const ev = await platformEvents(drift);
    expect(ev.map((e) => e.action)).toEqual(["platform.repair.email_sync"]);
    expect(JSON.stringify(ev[0].payload)).not.toContain("@");

    const clash = await profile();
    seedAuth(clash, { email: newEmail.toUpperCase() });
    expect(await repairSyncProfileEmail({ userId: clash })).toMatchObject({ ok: false, error: expect.stringMatching(/Otro usuario ya usa/) });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: clash } })).email).toBe(`${clash}@test.local`);
  });

  it("S2 sigue activo (precondición de los casos de superadmin)", async () => {
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: S2 } })).disabledAt).toBeNull();
  });
});
