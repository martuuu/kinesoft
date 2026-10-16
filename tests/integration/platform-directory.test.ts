/**
 * DIR-2c · moderación del directorio desde /plataforma (plan §20.10, C-DIR8), contra Postgres real y con los dos roles
 * (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod). Las actions corren por el canal service (y
 * `ProfessionalPublicProfile` es SERVICE_ONLY), así que lo que se prueba en los dos es que la barrera
 * (`requirePlatformAdmin("directory.moderate")`) y el audit valen igual.
 *
 * Se fija:
 *   - un OWNER que no es superadmin rebota (Forbidden) en las 6 actions y en la lectura, sin cambios ni audit;
 *   - ocultar sin motivo (o con < 3 caracteres) se rechaza, sin cambios;
 *   - audit doble con el payload: consultorio = AuditEvent del consultorio + PlatformAuditEvent; perfil = UNA fila
 *     global (targetUserId = la persona) + un AuditEvent en CADA consultorio donde atiende, enlazados por
 *     `platformEventId`. El texto del motivo nunca entra al registro;
 *   - ocultar no toca el opt-in del Titular ni el consentimiento de la persona; mostrar limpia las tres columnas;
 *   - verificar sin matrícula se rechaza; verificar/quitar; el trigger de M11 borra la verificación si cambia la
 *     matrícula;
 *   - el tag del directorio se revalida solo si algo cambió; el cambio de slug también lo revalida;
 *   - la lectura: DTO de lista cerrada, sin email, filtros por estado;
 *   - ocultar → fuera del snapshot (`getDirectorySnapshot`, DIR-2a), mostrar → vuelve.
 *
 * Símbolos reales; solo se mockea la sesión de Supabase, `next/headers` y `next/cache` (integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  hideDirectoryTenant,
  showDirectoryTenant,
  hideDirectoryProfile,
  showDirectoryProfile,
  verifyDirectoryLicense,
  unverifyDirectoryLicense,
} from "@/lib/platform-directory";
import { getPlatformDirectory } from "@/lib/platform-directory-read";
import { changePlatformTenantSlug } from "@/lib/platform-tenant-lifecycle";
import { buildDirectorySnapshot } from "@/lib/directory-internal";
import { ForbiddenError } from "@/lib/session";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

// El cambio de slug es `high`: sin PLATFORM_MFA_ENFORCEMENT=enforce pide el step-up de la 2FA por usuario. Se da por
// hecho (el corte real se prueba en tests/integration/two-factor.test.ts). Se reemplaza la dependencia, no la action.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const DIRECTORY_TAG = "global:directory";
const REASON_MARK = "Motivoprivadodelsuperadmin";

describe.skipIf(!RUN)("DIR-2c · moderación del directorio", () => {
  let db: PrismaClient;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  /** OWNER sin superadmin. */
  let A: EphemeralTenant;
  /** Consultorio publicado; su OWNER tiene perfil público y atiende también en C. */
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  let profileId: string;
  /** Perfil sin matrícula (de A). */
  let bareProfileId: string;

  const tenantRow = (id: string) =>
    db.tenant.findUniqueOrThrow({
      where: { id },
      select: {
        directoryListed: true,
        directoryListedAt: true,
        directoryHiddenAt: true,
        directoryHiddenReason: true,
        directoryHiddenById: true,
      },
    });
  const profileRow = (id: string) => db.professionalPublicProfile.findUniqueOrThrow({ where: { id } });
  const localAudits = (tenantId: string) =>
    db.auditEvent.findMany({
      where: { tenantId, action: { startsWith: "platform.directory." } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const globalAudits = (where: { tenantId?: string; entityId?: string }) =>
    db.platformAuditEvent.findMany({
      where: { ...where, action: { startsWith: "platform.directory." } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const wipeAudits = async () => {
    // Los registros son solo inserción (trigger): se borran en modo réplica, como la limpieza de la factory.
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "AuditEvent" WHERE "tenantId" = ANY(${[S.tenantId, A.tenantId, B.tenantId, C.tenantId]}) AND "action" LIKE 'platform.directory.%'`,
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "action" LIKE 'platform.directory.%' AND ("tenantId" = ANY(${[B.tenantId, C.tenantId]}) OR "entityId" = ANY(${[profileId, bareProfileId]}))`,
    ]);
  };

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    C = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: B.tenantId }, data: { directoryListed: true, directoryListedAt: new Date() } });
    // La persona de B atiende también en C (IAM-1: un Practitioner por consultorio).
    await db.practitioner.create({ data: { tenantId: C.tenantId, userId: B.userId, specialty: "Test", publicBookingEnabled: true } });
    await db.membership.create({ data: { tenantId: C.tenantId, userId: B.userId, role: "PRACTITIONER", acceptedAt: new Date() } });
    const now = new Date();
    profileId = (
      await db.professionalPublicProfile.create({
        data: {
          userId: B.userId,
          publicName: `Lic. Moderada ${uniqueSuffix()}`,
          honorific: "LIC",
          licenseKind: "MP",
          licenseNumber: "12345",
          licenseJurisdiction: "B",
          listed: true,
          consentAt: now,
          consentVersion: "2026-10-v1",
        },
      })
    ).id;
    bareProfileId = (await db.professionalPublicProfile.create({ data: { userId: A.userId, publicName: `Sin Matrícula ${uniqueSuffix()}` } })).id;
  });
  afterAll(async () => {
    // C primero: la persona de B tiene Practitioner en C (RESTRICT con UserProfile).
    await C?.cleanup();
    await B?.cleanup();
    await A?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    __rateLimitInternals.reset();
    revalidateTagSpy.mockClear();
  });

  it("OWNER no superadmin: Forbidden en las 6 actions y en la lectura, sin cambios ni audit", async () => {
    const beforeT = await tenantRow(B.tenantId);
    const beforeP = await profileRow(profileId);
    asUser(A.userId);
    const calls: [string, () => Promise<unknown>][] = [
      ["hideTenant", () => hideDirectoryTenant({ tenantId: B.tenantId, reason: "Spam en la descripción" })],
      ["showTenant", () => showDirectoryTenant({ tenantId: B.tenantId })],
      ["hideProfile", () => hideDirectoryProfile({ profileId, reason: "Matrícula falsa" })],
      ["showProfile", () => showDirectoryProfile({ profileId })],
      ["verify", () => verifyDirectoryLicense({ profileId })],
      ["unverify", () => unverifyDirectoryLicense({ profileId })],
      ["read", () => getPlatformDirectory()],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e) => e
      );
      expect(err, name).toBeInstanceOf(ForbiddenError);
    }
    expect(await tenantRow(B.tenantId)).toEqual(beforeT);
    expect(await profileRow(profileId)).toEqual(beforeP);
    expect(await localAudits(B.tenantId)).toHaveLength(0);
    expect(await globalAudits({ entityId: profileId })).toHaveLength(0);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("ocultar sin motivo (o con menos de 3 caracteres) se rechaza, sin cambios", async () => {
    asUser(S.userId);
    for (const bad of [{}, { reason: "" }, { reason: "  ab  " }, { reason: "x".repeat(501) }]) {
      const t = await hideDirectoryTenant({ tenantId: B.tenantId, ...bad });
      expect(t.ok, `tenant ${JSON.stringify(bad)}`).toBe(false);
      const p = await hideDirectoryProfile({ profileId, ...bad });
      expect(p.ok, `profile ${JSON.stringify(bad)}`).toBe(false);
    }
    // Campos de más (strict): no se cuela un `directoryHiddenById` ajeno.
    expect((await hideDirectoryTenant({ tenantId: B.tenantId, reason: "Motivo válido", directoryHiddenById: "x" })).ok).toBe(false);
    expect((await tenantRow(B.tenantId)).directoryHiddenAt).toBeNull();
    expect((await profileRow(profileId)).hiddenAt).toBeNull();
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("consultorio inexistente / perfil inexistente → error claro, sin audit", async () => {
    asUser(S.userId);
    const t = await hideDirectoryTenant({ tenantId: "no-existe", reason: "Motivo válido" });
    expect(t).toEqual({ ok: false, error: "No encontramos ese consultorio. Volvé a la lista." });
    const p = await verifyDirectoryLicense({ profileId: "no-existe" });
    expect(p).toEqual({ ok: false, error: "No encontramos ese perfil. Volvé a la lista." });
  });

  it("ocultar/mostrar consultorio: columnas, opt-in intacto, audit doble con el payload (sin el motivo), tag", async () => {
    asUser(S.userId);
    await wipeAudits();
    const res = await hideDirectoryTenant({ tenantId: B.tenantId, reason: `  ${REASON_MARK} spam  ` });
    expect(res).toEqual({ ok: true, data: { changed: true } });
    const hidden = await tenantRow(B.tenantId);
    expect(hidden.directoryHiddenAt).not.toBeNull();
    expect(hidden.directoryHiddenReason).toBe(`${REASON_MARK} spam`);
    expect(hidden.directoryHiddenById).toBe(S.userId);
    // El switch del Titular no se toca.
    expect(hidden.directoryListed).toBe(true);
    expect(hidden.directoryListedAt).not.toBeNull();
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);

    const local = await localAudits(B.tenantId);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ actorId: S.userId, action: "platform.directory.tenant_hide", entity: "Tenant", entityId: B.tenantId });
    const lp = local[0].payload as { changed: string[]; before: unknown; after: unknown; platform: { platformEventId: string } };
    expect([...lp.changed].sort()).toEqual(["directoryHiddenAt", "directoryHiddenById", "directoryHiddenReason"]);
    expect(lp.before).toEqual({ hidden: false });
    expect(lp.after).toEqual({ hidden: true });
    const global = await globalAudits({ tenantId: B.tenantId });
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({ action: "platform.directory.tenant_hide", actorId: S.userId, entityId: B.tenantId });
    expect(lp.platform.platformEventId).toBe(global[0].id);
    expect(JSON.stringify({ local, global })).not.toContain(REASON_MARK);
    // Nada en el home del superadmin.
    expect(await localAudits(S.tenantId)).toHaveLength(0);

    // Mismo motivo otra vez = no-op (sin audit, sin tag). Motivo nuevo = se actualiza y conserva la fecha.
    revalidateTagSpy.mockClear();
    expect(await hideDirectoryTenant({ tenantId: B.tenantId, reason: `${REASON_MARK} spam` })).toEqual({ ok: true, data: { changed: false } });
    expect(revalidateTagSpy).not.toHaveBeenCalled();
    expect(await hideDirectoryTenant({ tenantId: B.tenantId, reason: "Otro motivo" })).toEqual({ ok: true, data: { changed: true } });
    const again = await tenantRow(B.tenantId);
    expect(again.directoryHiddenAt).toEqual(hidden.directoryHiddenAt);
    expect(again.directoryHiddenReason).toBe("Otro motivo");
    const local2 = await localAudits(B.tenantId);
    expect(local2).toHaveLength(2);
    expect((local2[1].payload as { changed: string[] }).changed).toEqual(["directoryHiddenReason"]);

    // Mostrar: limpia las tres; opt-in sigue; audit doble.
    revalidateTagSpy.mockClear();
    expect(await showDirectoryTenant({ tenantId: B.tenantId })).toEqual({ ok: true, data: { changed: true } });
    const shown = await tenantRow(B.tenantId);
    expect(shown).toMatchObject({ directoryHiddenAt: null, directoryHiddenReason: null, directoryHiddenById: null, directoryListed: true });
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);
    const local3 = await localAudits(B.tenantId);
    expect(local3).toHaveLength(3);
    expect(local3[2]).toMatchObject({ action: "platform.directory.tenant_show" });
    expect(local3[2].payload).toMatchObject({ before: { hidden: true }, after: { hidden: false } });
    expect(await globalAudits({ tenantId: B.tenantId })).toHaveLength(3);
    // Ya visible = no-op.
    revalidateTagSpy.mockClear();
    expect(await showDirectoryTenant({ tenantId: B.tenantId })).toEqual({ ok: true, data: { changed: false } });
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("ocultar/mostrar perfil: consentimiento intacto; UNA fila global + un AuditEvent por consultorio donde atiende", async () => {
    asUser(S.userId);
    await wipeAudits();
    const before = await profileRow(profileId);
    expect(await hideDirectoryProfile({ profileId, reason: `${REASON_MARK} denuncia` })).toEqual({ ok: true, data: { changed: true } });
    const hidden = await profileRow(profileId);
    expect(hidden.hiddenAt).not.toBeNull();
    expect(hidden.hiddenReason).toBe(`${REASON_MARK} denuncia`);
    expect(hidden.hiddenById).toBe(S.userId);
    // Lo de la persona no se toca.
    expect({ listed: hidden.listed, consentAt: hidden.consentAt, consentVersion: hidden.consentVersion, consentWithdrawnAt: hidden.consentWithdrawnAt }).toEqual({
      listed: before.listed,
      consentAt: before.consentAt,
      consentVersion: before.consentVersion,
      consentWithdrawnAt: before.consentWithdrawnAt,
    });
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);

    const global = await globalAudits({ entityId: profileId });
    expect(global).toHaveLength(1);
    expect(global[0]).toMatchObject({
      action: "platform.directory.profile_hide",
      actorId: S.userId,
      targetUserId: B.userId,
      entity: "ProfessionalPublicProfile",
      tenantId: null,
    });
    expect([...(global[0].payload as { tenantIds: string[] }).tenantIds].sort()).toEqual([B.tenantId, C.tenantId].sort());
    for (const t of [B, C]) {
      const local = await localAudits(t.tenantId);
      expect(local, t.slug).toHaveLength(1);
      expect(local[0]).toMatchObject({ actorId: S.userId, action: "platform.directory.profile_hide", entityId: profileId });
      const lp = local[0].payload as { changed: string[]; before: unknown; after: unknown; platform: { platformEventId: string } };
      expect([...lp.changed].sort()).toEqual(["hiddenAt", "hiddenById", "hiddenReason"]);
      expect(lp.after).toEqual({ hidden: true });
      expect(lp.platform.platformEventId).toBe(global[0].id);
    }
    expect(await localAudits(A.tenantId)).toHaveLength(0);
    expect(JSON.stringify(global)).not.toContain(REASON_MARK);
    expect(JSON.stringify(await localAudits(B.tenantId))).not.toContain(REASON_MARK);

    expect(await showDirectoryProfile({ profileId })).toEqual({ ok: true, data: { changed: true } });
    expect(await profileRow(profileId)).toMatchObject({ hiddenAt: null, hiddenReason: null, hiddenById: null, listed: true });
    expect(await globalAudits({ entityId: profileId })).toHaveLength(2);
    expect(await localAudits(C.tenantId)).toHaveLength(2);
    expect(await showDirectoryProfile({ profileId })).toEqual({ ok: true, data: { changed: false } });
  });

  it("verificar matrícula: sin matrícula se rechaza; verificar/quitar con audit; el trigger la borra si cambia", async () => {
    asUser(S.userId);
    await wipeAudits();
    const bad = await verifyDirectoryLicense({ profileId: bareProfileId });
    expect(bad).toEqual({ ok: false, error: "Ese perfil no tiene matrícula cargada: no hay nada que verificar." });
    expect((await profileRow(bareProfileId)).licenseVerifiedAt).toBeNull();
    expect(await globalAudits({ entityId: bareProfileId })).toHaveLength(0);

    expect(await verifyDirectoryLicense({ profileId })).toEqual({ ok: true, data: { changed: true } });
    const v = await profileRow(profileId);
    expect(v.licenseVerifiedAt).not.toBeNull();
    expect(v.licenseVerifiedById).toBe(S.userId);
    const g = await globalAudits({ entityId: profileId });
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ action: "platform.directory.license_verify", targetUserId: B.userId });
    expect(g[0].payload).toMatchObject({ before: { verified: false }, after: { verified: true } });
    expect(await localAudits(B.tenantId)).toHaveLength(1);
    // Ya verificada = no-op.
    expect(await verifyDirectoryLicense({ profileId })).toEqual({ ok: true, data: { changed: false } });

    // La persona cambia la matrícula → el trigger de M11 borra la verificación (DIR-D10).
    await db.professionalPublicProfile.update({ where: { id: profileId }, data: { licenseNumber: "99999" } });
    expect(await profileRow(profileId)).toMatchObject({ licenseVerifiedAt: null, licenseVerifiedById: null });

    expect(await verifyDirectoryLicense({ profileId })).toEqual({ ok: true, data: { changed: true } });
    expect(await unverifyDirectoryLicense({ profileId })).toEqual({ ok: true, data: { changed: true } });
    expect(await profileRow(profileId)).toMatchObject({ licenseVerifiedAt: null, licenseVerifiedById: null });
    expect(await unverifyDirectoryLicense({ profileId })).toEqual({ ok: true, data: { changed: false } });
    expect((await globalAudits({ entityId: profileId })).map((e) => e.action)).toEqual([
      "platform.directory.license_verify",
      "platform.directory.license_verify",
      "platform.directory.license_unverify",
    ]);
  });

  it("lectura: DTO de lista cerrada, sin email; filtros por estado", async () => {
    asUser(S.userId);
    await hideDirectoryProfile({ profileId, reason: "Motivo de prueba" });
    const all = await getPlatformDirectory({ q: "Moderada" });
    expect(all.filters).toEqual({ q: "Moderada", estado: "todos" });
    const p = all.profiles.find((x) => x.profileId === profileId);
    expect(p).toBeDefined();
    expect(Object.keys(p!).sort()).toEqual(
      [
        "profileId",
        "userId",
        "publicName",
        "honorific",
        "license",
        "listed",
        "consentAt",
        "consentVersion",
        "consentWithdrawnAt",
        "hidden",
        "clinics",
        "updatedAt",
      ].sort()
    );
    expect(p!.hidden?.reason).toBe("Motivo de prueba");
    expect(p!.clinics.map((c) => c.tenantId).sort()).toEqual([B.tenantId, C.tenantId].sort());
    expect(JSON.stringify(all)).not.toContain("@test.local");

    const byName = await getPlatformDirectory({ q: (await db.tenant.findUniqueOrThrow({ where: { id: B.tenantId } })).name });
    const c = byName.clinics.find((x) => x.tenantId === B.tenantId);
    expect(c).toBeDefined();
    expect(Object.keys(c!).sort()).toEqual(
      ["tenantId", "name", "slug", "directoryListed", "directoryListedAt", "publicBookingEnabled", "tenantStatus", "hasDescription", "hidden"].sort()
    );
    // C no publicó ni fue ocultado: no es asunto del directorio.
    expect((await getPlatformDirectory({ q: C.slug })).clinics).toHaveLength(0);

    expect((await getPlatformDirectory({ estado: "ocultos", q: "Moderada" })).profiles.map((x) => x.profileId)).toEqual([profileId]);
    expect((await getPlatformDirectory({ estado: "publicados", q: "Moderada" })).profiles).toHaveLength(0);
    await showDirectoryProfile({ profileId });
    expect((await getPlatformDirectory({ estado: "publicados", q: "Moderada" })).profiles.map((x) => x.profileId)).toEqual([profileId]);
    // Cola de verificación: publicado, con matrícula y sin verificar (el de arriba quedó sin verificar).
    expect((await getPlatformDirectory({ estado: "sin_verificar", q: "Moderada" })).profiles.map((x) => x.profileId)).toEqual([profileId]);
    expect((await getPlatformDirectory({ estado: "sin_verificar" })).clinics).toHaveLength(0);
    // Valor raro → default; `%` no es comodín.
    expect((await getPlatformDirectory({ estado: "cualquiera" })).filters.estado).toBe("todos");
    expect((await getPlatformDirectory({ q: "%" })).profiles).toHaveLength(0);
  });

  it("ocultar → fuera del snapshot; mostrar → vuelve (consultorio y perfil)", async () => {
    asUser(S.userId);
    // `buildDirectorySnapshot` = el builder real sin el caché (el tag ya se afirma arriba).
    const snap = async () => {
      const s = await buildDirectorySnapshot();
      return {
        clinic: s.clinics.some((c) => c.slug === B.slug),
        profile: s.professionals.some((p) => p.profileId === profileId),
      };
    };
    expect(await snap()).toEqual({ clinic: true, profile: true });

    expect((await hideDirectoryProfile({ profileId, reason: "Denuncia en revisión" })).ok).toBe(true);
    expect(await snap()).toEqual({ clinic: true, profile: false });
    expect((await showDirectoryProfile({ profileId })).ok).toBe(true);
    expect(await snap()).toEqual({ clinic: true, profile: true });

    // Ocultar el consultorio saca también al perfil: B es el único consultorio publicado donde atiende.
    expect((await hideDirectoryTenant({ tenantId: B.tenantId, reason: "Spam en la descripción" })).ok).toBe(true);
    expect(await snap()).toEqual({ clinic: false, profile: false });
    expect((await showDirectoryTenant({ tenantId: B.tenantId })).ok).toBe(true);
    expect(await snap()).toEqual({ clinic: true, profile: true });
  });

  it("cambio de slug desde Plataforma revalida el tag del directorio (DIR-2c, handoff §4)", async () => {
    asUser(S.userId);
    const t = await db.tenant.findUniqueOrThrow({ where: { id: C.tenantId }, select: { updatedAt: true } });
    const res = await changePlatformTenantSlug({
      tenantId: C.tenantId,
      expectedUpdatedAt: t.updatedAt.toISOString(),
      slug: `dir-${uniqueSuffix()}`,
    });
    expect(res.ok).toBe(true);
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIRECTORY_TAG);
  });
});
