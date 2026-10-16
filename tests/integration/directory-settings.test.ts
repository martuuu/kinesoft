/**
 * [DIR-2b] Escritores del directorio desde Configuración (C-DIR8): opt-in del consultorio, descripción pública y
 * especialidades por profesional.
 *
 * Se fija:
 *  - opt-in: `tenant.admin` escribe (fila + `directoryListedAt` + audit en la tx + `revalidateTag("global:directory")`);
 *    mismo valor = sin write ni audit; un profesional sin «Configuración» → copy, sin write;
 *  - **soporte no publica** (DIR-D9): con sesión de soporte las dos actions devuelven «Soporte no puede cambiar la
 *    publicación en el directorio.» y no escriben;
 *  - descripción ≤ 800 (code points), vacía = null;
 *  - especialidades: ≤ 5; archivada o inexistente rechazada; profesional de otro consultorio = «no encontrado»; el
 *    propio profesional puede, otro profesional no.
 *
 * Símbolos REALES contra Postgres en los dos roles. Se mockea solo lo externo (sesión de Supabase y `next/cache` en
 * integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { setDirectoryListed, setPublicDescription, setPractitionerSpecialties } from "@/lib/directory-settings";
import { DIRECTORY_SUPPORT_DENIED } from "@/lib/directory-constants";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// Como en readonly-config: entrar como soporte (`startSupport`, acción `high`) pide el step-up de la 2FA por usuario;
// acá se da por hecho (el corte real lo prueba tests/integration/two-factor.test.ts). Se reemplaza la dependencia,
// no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const DIR_TAG = "global:directory";

describe.skipIf(!RUN)("[DIR-2b] directory-settings", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  const specialtyIds: string[] = [];
  let archivedId: string;

  const tenantRow = () =>
    db.tenant.findUniqueOrThrow({
      where: { id: A.tenantId },
      select: { directoryListed: true, directoryListedAt: true, publicDescription: true },
    });
  const audits = (action: string) => db.auditEvent.count({ where: { tenantId: A.tenantId, action } });
  const specialtiesOf = async (practitionerId: string) =>
    (await db.practitionerSpecialty.findMany({ where: { practitionerId }, select: { specialtyId: true } }))
      .map((r) => r.specialtyId)
      .sort();

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    kine = await addPractitioner(db, A, "PRACTITIONER");
    const src = { aliases: [], source: "CURATED" as const, sourceDate: new Date("2026-09-01") };
    for (let i = 0; i < 6; i++) {
      const s = uniqueSuffix();
      specialtyIds.push((await db.specialty.create({ data: { slug: `dir2b-${s}`, name: `Esp ${s}`, matchKey: `dir2b ${s}`, ...src } })).id);
    }
    const s = uniqueSuffix();
    archivedId = (
      await db.specialty.create({
        data: { slug: `dir2b-arch-${s}`, name: `Archivada ${s}`, matchKey: `dir2b arch ${s}`, archivedAt: new Date(), ...src },
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    asAnonymous();
    await A?.cleanup();
    await B?.cleanup();
    if (db) {
      await db.practitionerSpecialty.deleteMany({ where: { specialtyId: { in: [...specialtyIds, archivedId].filter(Boolean) } } });
      await db.specialty.deleteMany({ where: { id: { in: [...specialtyIds, archivedId].filter(Boolean) } } });
      await db.$disconnect();
    }
  });

  beforeEach(() => revalidateTagSpy.mockClear());

  describe("opt-in del consultorio", () => {
    it("el Titular lo prende: fila + listedAt + audit en la tx + tag del directorio; mismo valor no escribe", async () => {
      asUser(A.userId);
      expect(await setDirectoryListed(true)).toEqual({ ok: true, data: { listed: true } });
      const row = await tenantRow();
      expect(row.directoryListed).toBe(true);
      expect(row.directoryListedAt).toBeInstanceOf(Date);
      expect(await audits("tenant.directoryListed")).toBe(1);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "tenant.directoryListed" } });
      expect(ev.payload).toEqual({ directoryListed: true });
      expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);

      revalidateTagSpy.mockClear();
      expect(await setDirectoryListed(true)).toEqual({ ok: true, data: { listed: true } });
      expect(await audits("tenant.directoryListed")).toBe(1);
      expect(revalidateTagSpy).not.toHaveBeenCalled();

      expect(await setDirectoryListed(false)).toEqual({ ok: true, data: { listed: false } });
      expect(await tenantRow()).toMatchObject({ directoryListed: false, directoryListedAt: null });
      expect(await audits("tenant.directoryListed")).toBe(2);
    });

    it("un profesional sin «Configuración» no puede (copy, sin write)", async () => {
      asUser(kine.userId);
      const r = await setDirectoryListed(true);
      expect(r.ok).toBe(false);
      expect(await tenantRow()).toMatchObject({ directoryListed: false });
      const d = await setPublicDescription("Hola");
      expect(d.ok).toBe(false);
      expect((await tenantRow()).publicDescription).toBeNull();
    });

    it("descripción: ≤ 800 code points, vacía = null, con audit sin el texto", async () => {
      asUser(A.userId);
      const tooLong = await setPublicDescription("a".repeat(801));
      expect(tooLong).toMatchObject({ ok: false, error: "La descripción puede tener hasta 800 caracteres." });
      expect((await tenantRow()).publicDescription).toBeNull();

      const text = `  Kinesiología deportiva en Palermo ${"😀".repeat(10)}  `;
      expect(await setPublicDescription(text)).toEqual({ ok: true, data: { description: text.trim() } });
      expect((await tenantRow()).publicDescription).toBe(text.trim());
      expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);
      const ev = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: "tenant.publicDescription" } });
      expect(JSON.stringify(ev.payload)).not.toContain("Palermo");

      // 800 emojis = 1600 unidades UTF-16 pero 800 caracteres para el CHECK de la base: entra.
      expect((await setPublicDescription("😀".repeat(800))).ok).toBe(true);
      expect(await setPublicDescription("   ")).toEqual({ ok: true, data: { description: null } });
      expect((await tenantRow()).publicDescription).toBeNull();
    });
  });

  describe("con soporte (DIR-D9)", () => {
    let H: EphemeralTenant;
    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    });
    afterAll(async () => {
      if (db && H) await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
      await H?.cleanup();
    });
    beforeEach(async () => {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.updateMany({
        where: { superadminId: H.userId, endedAt: null },
        data: { endedAt: new Date(), endedReason: "test" },
      });
      asUser(H.userId);
      const r = await startSupport(A.tenantId, "El titular pidió ayuda con el directorio");
      if (!r.ok) throw new Error(r.error);
    });
    afterEach(() => cookies().delete(SUPPORT_COOKIE));

    it("soporte no publica ni edita la descripción: copy propio y nada escrito", async () => {
      const before = await tenantRow();
      const auditsBefore = await db.auditEvent.count({ where: { tenantId: A.tenantId } });
      expect(await setDirectoryListed(!before.directoryListed)).toEqual({ ok: false, error: DIRECTORY_SUPPORT_DENIED });
      expect(await setPublicDescription("Desde soporte")).toEqual({ ok: false, error: DIRECTORY_SUPPORT_DENIED });
      expect(await tenantRow()).toEqual(before);
      expect(await db.auditEvent.count({ where: { tenantId: A.tenantId } })).toBe(auditsBefore);
      expect(revalidateTagSpy).not.toHaveBeenCalledWith(DIR_TAG);
    });
  });

  describe("especialidades por profesional", () => {
    it("el Titular le carga especialidades a otro profesional; reemplaza por diferencia; tag del directorio", async () => {
      asUser(A.userId);
      const r1 = await setPractitionerSpecialties(kine.practitionerId, [specialtyIds[0], specialtyIds[1], specialtyIds[0]]);
      expect(r1).toEqual({ ok: true, data: { specialtyIds: [specialtyIds[0], specialtyIds[1]] } });
      expect(await specialtiesOf(kine.practitionerId)).toEqual([specialtyIds[0], specialtyIds[1]].sort());
      expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);
      const rows = await db.practitionerSpecialty.findMany({ where: { practitionerId: kine.practitionerId } });
      expect(rows.every((r) => r.tenantId === A.tenantId)).toBe(true);

      expect((await setPractitionerSpecialties(kine.practitionerId, [specialtyIds[1], specialtyIds[2]])).ok).toBe(true);
      expect(await specialtiesOf(kine.practitionerId)).toEqual([specialtyIds[1], specialtyIds[2]].sort());

      revalidateTagSpy.mockClear();
      expect((await setPractitionerSpecialties(kine.practitionerId, [specialtyIds[2], specialtyIds[1]])).ok).toBe(true);
      expect(revalidateTagSpy).not.toHaveBeenCalled();
    });

    it("más de 5 → rechazo sin write", async () => {
      asUser(A.userId);
      const before = await specialtiesOf(kine.practitionerId);
      const r = await setPractitionerSpecialties(kine.practitionerId, specialtyIds.slice(0, 6));
      expect(r).toEqual({ ok: false, error: "Podés elegir hasta 5 especialidades." });
      expect(await specialtiesOf(kine.practitionerId)).toEqual(before);
    });

    it("especialidad archivada o inexistente → rechazo sin write", async () => {
      asUser(A.userId);
      const before = await specialtiesOf(kine.practitionerId);
      expect((await setPractitionerSpecialties(kine.practitionerId, [specialtyIds[0], archivedId])).ok).toBe(false);
      expect((await setPractitionerSpecialties(kine.practitionerId, ["no-existe-xyz"])).ok).toBe(false);
      expect(await specialtiesOf(kine.practitionerId)).toEqual(before);
    });

    it("profesional de otro consultorio = no encontrado (sin write en ninguno)", async () => {
      asUser(A.userId);
      const r = await setPractitionerSpecialties(B.practitionerId, [specialtyIds[0]]);
      expect(r).toEqual({ ok: false, error: "Profesional no encontrado." });
      expect(await specialtiesOf(B.practitionerId)).toEqual([]);
    });

    it("el propio profesional puede; sobre otro profesional, no", async () => {
      asUser(kine.userId);
      expect((await setPractitionerSpecialties(kine.practitionerId, [specialtyIds[3]])).ok).toBe(true);
      expect(await specialtiesOf(kine.practitionerId)).toEqual([specialtyIds[3]]);
      const other = await setPractitionerSpecialties(A.practitionerId, [specialtyIds[3]]);
      expect(other.ok).toBe(false);
      expect(await specialtiesOf(A.practitionerId)).toEqual([]);
    });
  });
});
