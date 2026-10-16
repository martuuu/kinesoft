/**
 * [DIR-2b] Perfil público por persona (C-DIR8; DIR-D11/D12): `lib/public-profile.ts` por el canal service
 * (`ProfessionalPublicProfile` es SERVICE_ONLY) con el `userId` SIEMPRE de la sesión.
 *
 * Se fija:
 *  - guardar crea/edita sin publicar; un `userId` ajeno en el input se ignora (la fila es la de la sesión);
 *  - publicar exige la casilla === true y la versión vigente del texto; publica con `consentAt/Version` en la misma
 *    escritura; un email como nombre se rechaza (decisión 19);
 *  - quien no atiende en ningún consultorio usable no tiene perfil; con la 2FA pendiente, nada;
 *  - **retirar el consentimiento saca al profesional del snapshot en el próximo request**: snapshot con caché real
 *    (`useRealUnstableCache`), retiro → `listed=false` + `consentWithdrawnAt` en la fila, tag invalidado, y el
 *    próximo `getDirectorySnapshot()` ya no lo trae (sin el `revalidateTag` el caché lo seguiría mostrando).
 *
 * Símbolos REALES contra Postgres en los dos roles. Se mockea solo lo externo (sesión de Supabase y `next/cache`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  getMyPublicProfile,
  publishPublicProfile,
  savePublicProfile,
  withdrawPublicProfile,
} from "@/lib/public-profile";
import { DIRECTORY_CONSENT_VERSION } from "@/lib/directory-constants";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  revalidateTagSpy,
  useRealUnstableCache,
  usePassthroughUnstableCache,
} from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DIR_TAG = "global:directory";

const fields = (name: string) => ({
  publicName: name,
  honorific: "LIC",
  licenseKind: "MP",
  licenseNumber: "12345",
  licenseJurisdiction: "B",
  bio: "Rehabilitación de rodilla y hombro.",
});
const consent = { consentAccepted: true, consentVersion: DIRECTORY_CONSENT_VERSION };

describe.skipIf(!RUN)("[DIR-2b] public-profile", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let other: { userId: string; practitionerId: string };
  let staffUserId: string;

  const row = (userId: string) => db.professionalPublicProfile.findUnique({ where: { userId } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    other = await addPractitioner(db, A, "PRACTITIONER");
    // Secretaria SIN `Practitioner`: miembro usable que no atiende.
    staffUserId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: staffUserId, email: `${staffUserId}@test.local`, fullName: "Secre Test" } });
    await db.membership.create({ data: { userId: staffUserId, tenantId: A.tenantId, role: "ASSISTANT", acceptedAt: new Date() } });
  }, 60_000);

  afterAll(async () => {
    asAnonymous();
    usePassthroughUnstableCache();
    await A?.cleanup(); // borra los UserProfile de test → el perfil público cae por CASCADE
    await db?.$disconnect();
  });

  beforeEach(() => revalidateTagSpy.mockClear());

  it("guardar crea el perfil sin publicar; un userId ajeno en el input se ignora", async () => {
    asUser(A.userId);
    const r = await savePublicProfile({ ...fields("Ana Titular"), userId: other.userId } as Parameters<typeof savePublicProfile>[0]);
    expect(r).toEqual({ ok: true, data: { status: "draft" } });
    const mine = await row(A.userId);
    expect(mine).toMatchObject({ publicName: "Ana Titular", licenseKind: "MP", licenseJurisdiction: "B", listed: false, consentAt: null });
    expect(await row(other.userId)).toBeNull();
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);
  });

  it("publicar sin la casilla, con la casilla «truthy» o con otra versión del texto → no publica", async () => {
    asUser(A.userId);
    expect((await publishPublicProfile({ ...fields("Ana Titular") })).ok).toBe(false);
    expect((await publishPublicProfile({ ...fields("Ana Titular"), consentAccepted: "on", consentVersion: DIRECTORY_CONSENT_VERSION })).ok).toBe(false);
    expect((await publishPublicProfile({ ...fields("Ana Titular"), consentAccepted: true, consentVersion: "2025-01-v0" })).ok).toBe(false);
    expect(await row(A.userId)).toMatchObject({ listed: false, consentAt: null, consentVersion: null });
  });

  it("un email como nombre público se rechaza (decisión 19)", async () => {
    asUser(A.userId);
    const r = await publishPublicProfile({ ...fields("ana@consultorio.com"), ...consent });
    expect(r.ok).toBe(false);
    expect(await row(A.userId)).toMatchObject({ publicName: "Ana Titular", listed: false });
  });

  it("publicar con consentimiento: listed + consentAt + versión en la misma escritura", async () => {
    asUser(A.userId);
    expect(await publishPublicProfile({ ...fields("Ana Titular"), ...consent })).toEqual({ ok: true, data: { status: "published" } });
    const r = await row(A.userId);
    expect(r).toMatchObject({ listed: true, consentVersion: DIRECTORY_CONSENT_VERSION, consentWithdrawnAt: null });
    expect(r!.consentAt).toBeInstanceOf(Date);
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);
    const mine = await getMyPublicProfile();
    expect(mine.ok && mine.data).toMatchObject({ status: "published", profile: { publicName: "Ana Titular", licenseVerified: false } });
    // La lectura propia no trae userId ni email.
    expect(JSON.stringify(mine)).not.toContain(A.userId);
    expect(JSON.stringify(mine)).not.toContain("@");
  });

  it("quien no atiende en ningún consultorio no tiene perfil público", async () => {
    asUser(staffUserId);
    const r = await savePublicProfile(fields("Secre Test"));
    expect(r).toEqual({ ok: false, error: "El perfil público es para quienes atienden en al menos un consultorio." });
    expect(await row(staffUserId)).toBeNull();
  });

  it("con la 2FA pendiente no se guarda ni se publica", async () => {
    await db.userProfile.update({ where: { id: other.userId }, data: { twoFactorEmail: true } });
    try {
      asUser(other.userId);
      expect(await savePublicProfile(fields("Otro Kine"))).toEqual({ ok: false, error: "Primero terminá de verificar tu acceso." });
      expect(await publishPublicProfile({ ...fields("Otro Kine"), ...consent })).toMatchObject({ ok: false });
      expect(await row(other.userId)).toBeNull();
    } finally {
      await db.userProfile.update({ where: { id: other.userId }, data: { twoFactorEmail: false } });
    }
  });

  describe("snapshot con caché real", () => {
    beforeAll(async () => {
      await db.tenant.update({ where: { id: A.tenantId }, data: { directoryListed: true, directoryListedAt: new Date() } });
    });
    afterEach(() => usePassthroughUnstableCache());

    it("[DIR-2b] retirar el consentimiento saca al profesional del snapshot en el próximo request", async () => {
      useRealUnstableCache();
      const profileId = (await row(A.userId))!.id;
      const before = await getDirectorySnapshot();
      expect(before.professionals.map((p) => p.profileId)).toContain(profileId);
      // Línea de base del caché: sin una invalidación, la segunda lectura devuelve lo mismo (si no, el test no prueba
      // que el retiro invalida).
      await db.professionalPublicProfile.update({ where: { userId: A.userId }, data: { bio: "Cambio directo sin tag" } });
      const cached = await getDirectorySnapshot();
      expect(cached.professionals.find((p) => p.profileId === profileId)?.bio).toBe("Rehabilitación de rodilla y hombro.");

      asUser(A.userId);
      expect(await withdrawPublicProfile()).toEqual({ ok: true, data: { status: "withdrawn" } });
      const r = await row(A.userId);
      expect(r).toMatchObject({ listed: false });
      expect(r!.consentWithdrawnAt).toBeInstanceOf(Date);
      expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);

      const after = await getDirectorySnapshot();
      expect(after.professionals.map((p) => p.profileId)).not.toContain(profileId);
      expect(JSON.stringify(after)).not.toContain(profileId);
    });

    it("retirar otra vez es idempotente; volver a publicar estampa un consentimiento nuevo", async () => {
      asUser(A.userId);
      const first = (await row(A.userId))!;
      revalidateTagSpy.mockClear();
      expect(await withdrawPublicProfile()).toEqual({ ok: true, data: { status: "withdrawn" } });
      expect(revalidateTagSpy).not.toHaveBeenCalled();
      expect((await publishPublicProfile({ ...fields("Ana Titular"), ...consent })).ok).toBe(true);
      const again = (await row(A.userId))!;
      expect(again).toMatchObject({ listed: true, consentWithdrawnAt: null });
      expect(again.consentAt!.getTime()).toBeGreaterThanOrEqual(first.consentAt!.getTime());
    });
  });

  it("sin perfil, retirar devuelve error y no crea nada", async () => {
    asUser(other.userId);
    expect(await withdrawPublicProfile()).toEqual({ ok: false, error: "Primero guardá tu perfil público." });
    expect(await row(other.userId)).toBeNull();
  });
});
