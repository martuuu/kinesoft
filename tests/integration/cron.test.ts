/**
 * [BO5-A] Rutas de Vercel Cron (`app/api/cron/*`) contra Postgres real, en los dos roles (`test:integration` y
 * `:owner`). Se corren los handlers REALES; se reemplazan solo el despacho del mail (`__setEmailTransportForTests`:
 * el sink a EmailLog sigue corriendo) y el puerto de Auth (fake de GoTrue, para los detectores de huérfanos).
 *
 * Se fija:
 *  - auth: sin header / con otro secreto → 401; sin CRON_SECRET en Production → 503; nada corre ni escribe;
 *  - invitations-expire: cuenta y NO escribe (el estado «vencida» es derivado);
 *  - trial-reminders: el OWNER de un consultorio en prueba recibe su etapa (d3 / vencida), el suspendido y el que
 *    tiene la prueba lejos no; la segunda corrida del día no reenvía; queda la fila del registro y el EmailLog;
 *  - health-digest: fila `platform.cron.health_digest` con conteos, mail al superadmin si hay hallazgos, y la
 *    segunda corrida del día no escribe ni manda.
 *
 * La base es compartida con otras sesiones: los conteos globales se afirman con `>=` y los efectos sobre los
 * consultorios PROPIOS del test con igualdad.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { GET as invitationsExpire } from "@/app/api/cron/invitations-expire/route";
import { GET as trialReminders } from "@/app/api/cron/trial-reminders/route";
import { GET as healthDigest } from "@/app/api/cron/health-digest/route";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { healthDigestKey, trialReminderKey } from "@/lib/cron-jobs-logic";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const SECRET = `cron-test-${randomBytes(12).toString("hex")}`;
const DAY = 86_400_000;

/** Registro a mano (no `vi.fn`: vitest 2.1.9 rompe con un fn que tira a través de un mock). */
const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
  to(addr: string, kind?: string) {
    return mail.sent.filter((m) => m.to === addr && (!kind || m.kind === kind));
  },
};

function req(path: string, authorization?: string | null): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request(`http://localhost:3000${path}`, { headers });
}
const authed = (path: string) => req(path, `Bearer ${SECRET}`);

describe.skipIf(!RUN)("[BO5-A] cron", () => {
  let db: PrismaClient;
  let A: EphemeralTenant; // prueba que vence en 3 días (d3)
  let G: EphemeralTenant; // prueba vencida hace 2 días (gracia → expired)
  let S: EphemeralTenant; // suspendido, con la prueba por vencer
  let F: EphemeralTenant; // prueba con 20 días por delante
  const emailOf: Record<string, string> = {};
  let superadminId: string;
  let superadminEmail: string;
  let invitationId: string;

  async function trialing(t: EphemeralTenant, endsAt: Date) {
    await db.tenant.update({ where: { id: t.tenantId }, data: { subscriptionStatus: "TRIALING", trialEndsAt: endsAt, plan: "PRO" } });
    emailOf[t.tenantId] = (await db.userProfile.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true } })).email;
  }

  beforeAll(async () => {
    db = ownerClient();
    const now = Date.now();
    A = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db, { status: "SUSPENDED" });
    F = await createEphemeralTenant(db);
    await trialing(A, new Date(now + 2 * DAY));
    await trialing(G, new Date(now - 2 * DAY));
    await trialing(S, new Date(now + 2 * DAY));
    await trialing(F, new Date(now + 20 * DAY));

    // Invitación pendiente y vencida (la cuenta invitations-expire y el detector del resumen).
    const inv = await db.invitation.create({
      data: {
        tenantId: A.tenantId,
        email: `inv-${randomBytes(4).toString("hex")}@example.com`,
        firstName: "Ana",
        lastName: "Pérez",
        role: "ASSISTANT",
        invitedById: A.userId,
        expiresAt: new Date(now - DAY),
        token: randomBytes(16).toString("hex"),
      },
    });
    invitationId = inv.id;

    superadminId = `test-user-${uniqueSuffix()}`;
    superadminEmail = `${superadminId}@test.local`;
    await db.userProfile.create({ data: { id: superadminId, email: superadminEmail, fullName: "Superadmin cron", isPlatformAdmin: true } });
  });

  afterAll(async () => {
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
    for (const t of [A, G, S, F]) await t?.cleanup();
    if (superadminId) await db.userProfile.deleteMany({ where: { id: superadminId } });
    await db.$disconnect();
  });

  beforeEach(() => {
    mail.sent.length = 0;
    __setEmailTransportForTests(mail.transport);
    __setAuthAdminForTests(new GotrueFake());
    vi.stubEnv("CRON_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  // ── Auth ────────────────────────────────────────────────────────────────────────────────────────────────────

  it.each([
    ["/api/cron/invitations-expire", invitationsExpire],
    ["/api/cron/trial-reminders", trialReminders],
    ["/api/cron/health-digest", healthDigest],
  ] as const)("%s: sin header u otro secreto → 401 sin correr nada", async (path, GET) => {
    const before = await db.platformAuditEvent.count({ where: { action: { startsWith: "platform.cron." } } });
    for (const h of [null, "Bearer otro", SECRET, `Basic ${SECRET}`]) {
      const res = await GET(req(path, h));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false });
    }
    expect(mail.sent).toHaveLength(0);
    expect(await db.platformAuditEvent.count({ where: { action: { startsWith: "platform.cron." } } })).toBe(before);
  });

  it("sin CRON_SECRET en Production → 503; fuera de Production → 401", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await trialReminders(req("/api/cron/trial-reminders", "Bearer "))).status).toBe(503);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await trialReminders(req("/api/cron/trial-reminders", "Bearer "))).status).toBe(401);
    expect(mail.sent).toHaveLength(0);
  });

  it("MAINTENANCE_MODE=on: autoriza pero no corre (200 skipped), sin mails ni filas", async () => {
    vi.stubEnv("MAINTENANCE_MODE", "on");
    const before = await db.platformAuditEvent.count({ where: { action: { startsWith: "platform.cron." } } });
    const res = await trialReminders(authed("/api/cron/trial-reminders"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, job: "trial-reminders", skipped: "maintenance" });
    expect(mail.sent).toHaveLength(0);
    expect(await db.platformAuditEvent.count({ where: { action: { startsWith: "platform.cron." } } })).toBe(before);
    // Sin secreto válido sigue siendo 401 (el mantenimiento no abre nada).
    expect((await trialReminders(req("/api/cron/trial-reminders", "Bearer otro"))).status).toBe(401);
  });

  // ── invitations-expire ──────────────────────────────────────────────────────────────────────────────────────

  it("invitations-expire: cuenta las vencidas pendientes y no escribe nada", async () => {
    const before = await db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    const res = await invitationsExpire(authed("/api/cron/invitations-expire"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, job: "invitations-expire", written: 0 });
    expect(body.expiredPending).toBeGreaterThanOrEqual(1);
    expect(body.expiredLast24h).toBeGreaterThanOrEqual(0);
    const after = await db.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(after).toEqual(before);
  });

  // ── trial-reminders ─────────────────────────────────────────────────────────────────────────────────────────

  it("trial-reminders: d3 al OWNER de A, «terminó» al de G, nada a S (suspendido) ni a F; la segunda corrida no reenvía", async () => {
    const res = await trialReminders(authed("/api/cron/trial-reminders"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, job: "trial-reminders", errors: 0 });
    expect(body.claimed).toBeGreaterThanOrEqual(2);

    const a = mail.to(emailOf[A.tenantId], "trial_reminder");
    expect(a).toHaveLength(1);
    expect(a[0].subject).toBe("Tu prueba de KineSoft vence en 3 días");
    expect(a[0].tenantId).toBe(A.tenantId);
    expect(a[0].text).toContain("/configuracion?tab=plan");

    const g = mail.to(emailOf[G.tenantId], "trial_reminder");
    expect(g).toHaveLength(1);
    expect(g[0].subject).toBe("Tu prueba de KineSoft terminó");

    expect(mail.to(emailOf[S.tenantId])).toHaveLength(0);
    expect(mail.to(emailOf[F.tenantId])).toHaveLength(0);

    // Registro global: una fila por (consultorio, etapa, fin de prueba), sin actor (es el cron).
    const tA = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { trialEndsAt: true } });
    const rowA = await db.platformAuditEvent.findUniqueOrThrow({
      where: { idempotencyKey: trialReminderKey(A.tenantId, "d3", tA.trialEndsAt!) },
    });
    expect(rowA).toMatchObject({ action: "platform.cron.trial_reminder", tenantId: A.tenantId, actorId: null, actorEmail: null });
    expect(rowA.payload).toMatchObject({ stage: "d3", daysLeft: 3, recipients: 1 });
    expect(await db.platformAuditEvent.count({ where: { tenantId: { in: [S.tenantId, F.tenantId] } } })).toBe(0);

    // EmailLog del intento (lo escribe el sink real), en el consultorio.
    const logs = await db.emailLog.findMany({ where: { tenantId: A.tenantId, kind: "trial_reminder" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "sent", entity: "Tenant", entityId: A.tenantId });

    // Segunda corrida el mismo día: nada nuevo.
    mail.sent.length = 0;
    const again = await (await trialReminders(authed("/api/cron/trial-reminders"))).json();
    expect(again.alreadySent).toBeGreaterThanOrEqual(2);
    expect(mail.to(emailOf[A.tenantId])).toHaveLength(0);
    expect(mail.to(emailOf[G.tenantId])).toHaveLength(0);
    expect(await db.emailLog.count({ where: { tenantId: A.tenantId, kind: "trial_reminder" } })).toBe(1);
  });

  it("trial-reminders: OWNER deshabilitado → no se reserva ni se manda (sale cuando haya un titular activo)", async () => {
    const t = await createEphemeralTenant(db, { disabled: true });
    try {
      await trialing(t, new Date(Date.now() + 2 * DAY));
      await trialReminders(authed("/api/cron/trial-reminders"));
      expect(mail.to(emailOf[t.tenantId])).toHaveLength(0);
      expect(await db.platformAuditEvent.count({ where: { tenantId: t.tenantId } })).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  // ── health-digest ───────────────────────────────────────────────────────────────────────────────────────────

  it("health-digest: fila con conteos + mail al superadmin activo; la segunda corrida del día no escribe ni manda", async () => {
    // La clave es por día AR y el registro es solo inserción: se borra la de HOY (solo base local de test, en modo
    // réplica, como `deleteTenantDeep`) para que el test no dependa de si ya corrió hoy.
    const key = healthDigestKey(new Date());
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "idempotencyKey" = ${key}`,
    ]);

    const res = await healthDigest(authed("/api/cron/health-digest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, job: "health-digest", alreadyRan: false });
    expect(body.counts.expiredInvitations).toBeGreaterThanOrEqual(1);
    expect(body.counts.authOrphans).toBe(0); // fake de GoTrue vacío: disponible y en cero
    expect(body.findings).toBeGreaterThanOrEqual(1);

    const toAdmin = mail.to(superadminEmail, "platform_health_digest");
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0].tenantId).toBeNull();
    expect(toAdmin[0].text).toMatch(/Invitaciones vencidas sin anular: \d+/);
    expect(toAdmin[0].text).toContain("/plataforma/salud");
    // Solo conteos: ni el email de la invitación ni el del OWNER.
    expect(toAdmin[0].text).not.toContain("@example.com");
    expect(toAdmin[0].text).not.toContain(emailOf[A.tenantId]);

    const row = await db.platformAuditEvent.findUniqueOrThrow({ where: { idempotencyKey: key } });
    expect(row).toMatchObject({ action: "platform.cron.health_digest", tenantId: null, actorId: null, entity: "PlatformHealth" });
    expect((row.payload as { counts: { expiredInvitations: number } }).counts.expiredInvitations).toBeGreaterThanOrEqual(1);
    expect(row.payload).toMatchObject({ notify: true });

    mail.sent.length = 0;
    const again = await (await healthDigest(authed("/api/cron/health-digest"))).json();
    expect(again).toMatchObject({ ok: true, alreadyRan: true, mailsSent: 0 });
    expect(mail.to(superadminEmail)).toHaveLength(0);
    expect(await db.platformAuditEvent.count({ where: { idempotencyKey: key } })).toBe(1);

    await db.emailLog.deleteMany({ where: { kind: "platform_health_digest", entityId: row.id } });
  });

  it("health-digest: un superadmin deshabilitado no recibe el resumen", async () => {
    const key = healthDigestKey(new Date());
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "idempotencyKey" = ${key}`,
    ]);
    await db.userProfile.update({ where: { id: superadminId }, data: { disabledAt: new Date() } });
    try {
      const body = await (await healthDigest(authed("/api/cron/health-digest"))).json();
      expect(body.alreadyRan).toBe(false);
      expect(mail.to(superadminEmail)).toHaveLength(0);
      await db.emailLog.deleteMany({ where: { kind: "platform_health_digest", entity: "PlatformAuditEvent", createdAt: { gte: new Date(Date.now() - 60_000) } } });
    } finally {
      await db.userProfile.update({ where: { id: superadminId }, data: { disabledAt: null } });
    }
  });
});
