/**
 * DIR-Z (revisor A, M2) · un usuario deshabilitado por Plataforma sale del directorio en el próximo request.
 *
 * Por qué existe: `setPlatformUserDisabled` escribía `UserProfile.disabledAt` y solo revalidaba `/plataforma`, y el
 * snapshot no miraba ese campo. La persona seguía publicada sin plazo y, como `/cuenta/perfil-publico` la manda a
 * `/cuenta-desactivada`, no tenía cómo retirar el consentimiento. El fix tiene dos patas y este test fija las dos con
 * los símbolos REALES: el filtro `user.disabledAt = null` de `buildDirectorySnapshot` y el
 * `revalidateTag(tags.directory())` de la action (con el `unstable_cache` real del setup: si la action no purgara el
 * tag, el segundo snapshot saldría del caché con la persona adentro).
 *
 * Se reemplazan solo la sesión (integration-setup), el puerto de Auth (fake de GoTrue) y el step-up de la 2FA (como
 * en platform-users.test.ts). Corre en los dos roles.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import { setPlatformUserDisabled } from "@/lib/platform-users";
import { DIRECTORY_CONSENT_VERSION } from "@/lib/directory-constants";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[DIR-Z M2] usuario deshabilitado por Plataforma → fuera del directorio", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let profileId = "";
  const S = `test-user-${uniqueSuffix()}`; // superadmin sin consultorio
  const s = uniqueSuffix();

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { directoryListed: true, directoryListedAt: new Date(), publicDescription: "Rehabilitación." },
    });
    await db.userProfile.create({ data: { id: S, email: `${S}@test.local`, fullName: "Super Admin DIRZ", isPlatformAdmin: true } });
    profileId = (
      await db.professionalPublicProfile.create({
        data: {
          userId: T.userId,
          publicName: `Deshabilitable ${s}`,
          listed: true,
          consentAt: new Date(),
          consentVersion: DIRECTORY_CONSENT_VERSION,
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    // El registro de Plataforma es solo inserción: se borra en modo réplica (como platform-users.test.ts).
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "targetUserId" = ${T.userId} OR "actorId" = ${S}`,
    ]);
    await db.professionalPublicProfile.deleteMany({ where: { id: profileId } });
    await T?.cleanup();
    await db.userProfile.deleteMany({ where: { id: S } });
    await db.$disconnect();
  });

  beforeEach(() => {
    const gotrue = new GotrueFake();
    const now = new Date().toISOString();
    gotrue.users.set(T.userId, {
      id: T.userId, email: `${T.userId}@test.local`, emailConfirmedAt: now, lastSignInAt: now, createdAt: now,
      bannedUntil: null, password: null, fullName: null,
    });
    __setAuthAdminForTests(gotrue);
    __rateLimitInternals.reset();
    asUser(S);
  });

  afterEach(() => {
    __setAuthAdminForTests(null);
    usePassthroughUnstableCache();
  });

  const listed = async () => (await getDirectorySnapshot()).professionals.some((p) => p.profileId === profileId);

  it("deshabilitar saca a la persona del snapshot cacheado; habilitarla la devuelve", async () => {
    useRealUnstableCache();
    expect(await listed()).toBe(true); // queda en el caché real

    expect(await setPlatformUserDisabled({ userId: T.userId, disabled: true })).toMatchObject({ ok: true, data: { changed: true } });
    expect((await db.userProfile.findUniqueOrThrow({ where: { id: T.userId } })).disabledAt).not.toBeNull();
    // Sin revalidar a mano: si la action no purgara `global:directory`, esto saldría del caché con la persona.
    expect(await listed()).toBe(false);
    // El perfil no se toca (al rehabilitarla vuelve sola, con el consentimiento que dio).
    expect(await db.professionalPublicProfile.findUniqueOrThrow({ where: { id: profileId } })).toMatchObject({ listed: true, hiddenAt: null });

    expect(await setPlatformUserDisabled({ userId: T.userId, disabled: false })).toMatchObject({ ok: true, data: { changed: true } });
    expect(await listed()).toBe(true);
  });
});
