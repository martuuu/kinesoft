/**
 * [AS-1s] Terminar un acceso de soporte desde el consultorio (#27, plan §23.5).
 *
 * Por qué: desde BO2-E un acceso de soporte no tiene vencimiento y terminaba solo cuando el superadmin salía o cerraba
 * sesión; el consultorio veía «En curso» en Configuración → Accesos de soporte y no podía hacer nada. Ahora quien tiene
 * `tenant.sensitive` lo termina (`endSupportAccessForTenant`): `endedReason = "tenant"`, audit doble (`platform.support.end`
 * en el log del consultorio y en `PlatformAuditEvent`) y el superadmin cae en su PRÓXIMO request (`resolveSupportTarget`
 * exige `endedAt: null`).
 *
 * Símbolos REALES contra Postgres en los dos roles (`kinesoft_app` y owner BYPASSRLS): la action, `getActor` /
 * `tryGetActor` (rama de soporte de buildActor) y `resolveSupportSession`. Se mockea solo la sesión de Supabase y la
 * cookie jar (integration-setup). La fila de soporte se siembra directo (la apertura con `startSupport` la prueba
 * support-session.test.ts) y la cookie se firma con el helper real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient, Role } from "@prisma/client";
import { ForbiddenError, getActor, tryGetActor } from "@/lib/session";
import { endSupportAccessForTenant } from "@/lib/support-session-tenant";
import { SUPPORT_COOKIE, makeSupportCookieValue, resolveSupportSession } from "@/lib/support-session-internal";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const REASON = "El OWNER pidió ayuda con los horarios";
const ALREADY_ENDED = "Ese acceso ya terminó.";

describe.skipIf(!RUN)("[AS-1s] terminar un acceso de soporte desde el consultorio", () => {
  let db: PrismaClient;
  /** Consultorio donde entra soporte (OWNER = T.userId). */
  let T: EphemeralTenant;
  /** Otro consultorio con su propio acceso abierto. */
  let T2: EphemeralTenant;
  /** Superadmin sin consultorio propio (como soporte entra solo a T o T2). */
  let S: string;
  /** Otro superadmin (abre en T2 a la vez que S en T: una abierta por superadmin, M7). */
  let S2: string;
  let secretaria: string;
  let kine: string;
  const users: string[] = [];

  async function staff(t: EphemeralTenant, role: Role, grants: { grantSettings?: boolean } = {}): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    users.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Staff ${role}` } });
    await db.membership.create({ data: { userId: id, tenantId: t.tenantId, role, clinical: false, acceptedAt: new Date(), ...grants } });
    return id;
  }

  async function openSession(superadminId: string, t: EphemeralTenant): Promise<string> {
    const row = await db.supportSession.create({ data: { tenantId: t.tenantId, superadminId, reason: REASON } });
    return row.id;
  }

  /** El superadmin vuelve a navegar con su cookie (= su próximo request). */
  function asSupport(superadminId: string, sessionId: string): void {
    asUser(superadminId);
    cookies().set(SUPPORT_COOKIE, makeSupportCookieValue(sessionId, superadminId));
  }

  const audits = (sessionId: string) =>
    Promise.all([
      db.auditEvent.findMany({ where: { action: "platform.support.end", entityId: sessionId } }),
      db.platformAuditEvent.findMany({ where: { action: "platform.support.end", entityId: sessionId } }),
    ]);

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    T2 = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    for (const label of ["S", "S2"]) {
      const id = `test-user-${uniqueSuffix()}`;
      users.push(id);
      await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `Soporte ${label}`, isPlatformAdmin: true } });
      if (label === "S") S = id;
      else S2 = id;
    }
    // Decisión 3 del 19-oct: la Secretaria con «Configuración» NO toca lo delicado (corte de staff).
    secretaria = await staff(T, "ASSISTANT", { grantSettings: true });
    kine = (await addPractitioner(db, T, "PRACTITIONER")).userId;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // FK RESTRICT de SupportSession a Tenant/UserProfile: primero las filas de soporte.
    await db.supportSession.deleteMany({ where: { superadminId: { in: [S, S2].filter(Boolean) } } });
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "tenantId" = ANY(${[T?.tenantId, T2?.tenantId].filter(Boolean)})`,
    ]);
    for (const t of [T, T2]) await t?.cleanup();
    await db.userProfile.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    cookies().delete(SUPPORT_COOKIE);
    cookies().delete("kine_tenant");
    await db.supportSession.updateMany({ where: { superadminId: { in: [S, S2] }, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
  });

  it("el titular lo termina: fila cerrada «tenant», audit doble y el superadmin cae en su próximo request", async () => {
    const sessionId = await openSession(S, T);
    // Anti-false-green: antes de terminar, la cookie SÍ abre el consultorio como soporte.
    asSupport(S, sessionId);
    expect((await getActor()).support?.sessionId).toBe(sessionId);

    asUser(T.userId);
    const r = await endSupportAccessForTenant({ id: sessionId });
    expect(r).toEqual({ ok: true, data: undefined });

    const row = await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.endedAt).not.toBeNull();
    expect(row.endedReason).toBe("tenant");

    const [ev, pe] = await audits(sessionId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ tenantId: T.tenantId, actorId: T.userId, entity: "SupportSession" });
    expect(ev[0].payload).toMatchObject({ endedReason: "tenant", superadminId: S });
    expect(pe).toHaveLength(1);
    expect(pe[0]).toMatchObject({
      tenantId: T.tenantId,
      actorId: T.userId,
      actorEmail: `${T.userId}@test.local`,
      entity: "SupportSession",
    });
    // El que terminó es miembro de T: su «casa» en el registro global es T (PlatformActorRef armado con el miembro).
    expect(pe[0].payload).toMatchObject({ endedReason: "tenant", platform: { actorHomeTenantId: T.tenantId } });
    // El enlace del log del consultorio a la fila global.
    expect((ev[0].payload as { platform?: { platformEventId?: string } }).platform?.platformEventId).toBe(pe[0].id);

    // Próximo request del superadmin: la cookie ya no abre nada (y se borra). S no tiene consultorio propio.
    asSupport(S, sessionId);
    expect(await resolveSupportSession(S)).toBeNull();
    asSupport(S, sessionId);
    expect(await tryGetActor()).toBeNull();
    expect(cookies().get(SUPPORT_COOKIE)).toBeUndefined();
  });

  it("doble clic: el segundo devuelve «Ese acceso ya terminó.» y no audita dos veces (también en paralelo)", async () => {
    const a = await openSession(S, T);
    asUser(T.userId);
    expect((await endSupportAccessForTenant({ id: a })).ok).toBe(true);
    expect(await endSupportAccessForTenant({ id: a })).toEqual({ ok: false, error: ALREADY_ENDED });
    const [ev, pe] = await audits(a);
    expect([ev.length, pe.length]).toEqual([1, 1]);

    // Dos pestañas a la vez: el UPDATE condicional (`endedAt: null`) deja ganar a uno solo.
    const b = await openSession(S, T);
    const both = await Promise.all([endSupportAccessForTenant({ id: b }), endSupportAccessForTenant({ id: b })]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    expect(both.filter((x) => !x.ok)).toEqual([{ ok: false, error: ALREADY_ENDED }]);
    const [ev2, pe2] = await audits(b);
    expect([ev2.length, pe2.length]).toEqual([1, 1]);
  });

  it("la Secretaria (aun con «Configuración») y un profesional sin «Configuración» no pueden: la fila sigue abierta", async () => {
    const sessionId = await openSession(S, T);
    for (const who of [secretaria, kine]) {
      asUser(who);
      await expect(endSupportAccessForTenant({ id: sessionId })).rejects.toBeInstanceOf(ForbiddenError);
    }
    const row = await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.endedAt).toBeNull();
    const [ev, pe] = await audits(sessionId);
    expect([ev.length, pe.length]).toEqual([0, 0]);
  });

  it("el acceso de OTRO consultorio no se toca (mismo copy: no confirma que exista)", async () => {
    const mine = await openSession(S, T);
    const other = await openSession(S2, T2);
    asUser(T.userId);
    expect(await endSupportAccessForTenant({ id: other })).toEqual({ ok: false, error: ALREADY_ENDED });
    expect((await db.supportSession.findUniqueOrThrow({ where: { id: other } })).endedAt).toBeNull();
    expect((await db.supportSession.findUniqueOrThrow({ where: { id: mine } })).endedAt).toBeNull();
    const [ev, pe] = await audits(other);
    expect([ev.length, pe.length]).toEqual([0, 0]);
    // Y el superadmin de T2 sigue adentro.
    asSupport(S2, other);
    expect(await resolveSupportSession(S2)).toEqual({ sessionId: other, tenantId: T2.tenantId });
  });

  it("el propio soporte no se lo termina desde el consultorio (tiene `tenant.sensitive` por SUPPORT_CAPS)", async () => {
    const sessionId = await openSession(S, T);
    asSupport(S, sessionId);
    await expect(endSupportAccessForTenant({ id: sessionId })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await db.supportSession.findUniqueOrThrow({ where: { id: sessionId } })).endedAt).toBeNull();
  });

  it("id inválido: rechazo sin escribir", async () => {
    asUser(T.userId);
    const r = await endSupportAccessForTenant({ id: "" });
    expect(r.ok).toBe(false);
  });
});
