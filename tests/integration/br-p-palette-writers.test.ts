/**
 * [BR-P] Escritores de `Tenant.palette` (colores de la sede y del turnero) y la paleta de marca en Apariencia.
 *
 * Corren las actions REALES (`lib/clinic-site-settings.ts`, `lib/platform-tenants.ts#setPlatformTenantSite`,
 * `lib/preferences.ts`) con el `getActor()` real contra Postgres; solo se mockean la sesión de Supabase, `next/headers`
 * y `next/cache` (integration-setup.ts). Con los dos roles (`kinesoft_app` con RLS y el owner BYPASSRLS de prod).
 *
 * Contrato (pedido de Martin del 05-nov): Plataforma asigna cualquier paleta (incluida la de marca «tmp») con doble
 * audit y CAS; el consultorio, desde «Sitio web» (`tenant.sensitive`), elige entre las 4 generales + la de marca que
 * tenga asignada; la Secretaria no; un valor fuera de la lista se rechaza. Apariencia: la de marca solo la guarda un
 * miembro del consultorio que la tiene.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  addStaff,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const SITES = "global:sites";
const DIRECTORY = "global:directory";

describe.skipIf(!RUN)("[BR-P] paleta del consultorio: escritores y Apariencia", () => {
  let db: PrismaClient;
  /** El consultorio al que Plataforma le asigna «tmp». */
  let A: EphemeralTenant;
  /** Otro consultorio (sin la marca). */
  let B: EphemeralTenant;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  let secretaria: { userId: string };

  const settings = () => import("@/lib/clinic-site-settings");
  const platform = () => import("@/lib/platform-tenants");
  const preferences = () => import("@/lib/preferences");

  const tenantRow = (id: string) =>
    db.tenant.findUniqueOrThrow({ where: { id }, select: { palette: true, phone: true, siteEnabled: true, updatedAt: true } });
  const version = async (id: string) => (await tenantRow(id)).updatedAt.toISOString();
  const form = { siteEnabled: false, siteTagline: null, publicDescription: null, phone: null, whatsapp: null, publicEmail: null };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    secretaria = await addStaff(db, A, "ASSISTANT", { grantSettings: true });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
  });

  it("[BR-P-9] «Sitio web»: la Secretaria con «Configuración» no lee ni escribe la paleta", async () => {
    const { getSiteSettings, updateSiteSettings } = await settings();
    asUser(secretaria.userId);
    const before = await tenantRow(A.tenantId);
    expect(await getSiteSettings()).toMatchObject({ ok: false });
    expect(await updateSiteSettings({ ...form, palette: "mint" }, before.updatedAt.toISOString())).toMatchObject({ ok: false });
    expect(await tenantRow(A.tenantId)).toEqual(before);
  });

  it("[BR-P-10] «Sitio web»: el Titular ve las 4 generales y elige una; audit con la clave, revalida sede, directorio y turnero", async () => {
    const { getSiteSettings, updateSiteSettings } = await settings();
    asUser(A.userId);
    const read = await getSiteSettings();
    expect(read).toMatchObject({ ok: true, data: { palette: "sky", paletteOptions: ["sky", "mint", "coral", "violet"] } });
    const r = await updateSiteSettings({ ...form, palette: "mint" }, await version(A.tenantId));
    expect(r).toMatchObject({ ok: true, data: { changed: ["palette"] } });
    expect((await tenantRow(A.tenantId)).palette).toBe("mint");
    const audits = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "tenant.site.update" } });
    expect(audits).toHaveLength(1);
    expect((audits[0].payload as { changed: string[] }).changed).toEqual(["palette"]);
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([`/${A.slug}`, `/c/${A.slug}/booking`, "/configuracion"])
    );

    // Sin `palette` en el input (form de SD-C): no se toca.
    revalidateTagSpy.mockClear();
    expect(await updateSiteSettings(form, await version(A.tenantId))).toMatchObject({ ok: true, data: { changed: [] } });
    expect((await tenantRow(A.tenantId)).palette).toBe("mint");
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[BR-P-11] «Sitio web»: la de marca sin tenerla asignada se rechaza y la tx se revierte entera (ni el contacto)", async () => {
    const { updateSiteSettings } = await settings();
    asUser(A.userId);
    const before = await tenantRow(A.tenantId);
    const r = await updateSiteSettings({ ...form, phone: "0341 455-1234", palette: "tmp" }, before.updatedAt.toISOString());
    expect(r).toMatchObject({ ok: false, error: "Esos colores son los de la marca de otro consultorio." });
    expect((r as { fieldErrors?: Record<string, string[]> }).fieldErrors?.palette?.length).toBe(1);
    expect(await tenantRow(A.tenantId)).toEqual(before);
    expect(revalidateTagSpy).not.toHaveBeenCalled();

    // Valor fuera de la lista: rechazo del zod con el campo marcado.
    const bad = await updateSiteSettings({ ...form, palette: "neon" as never }, before.updatedAt.toISOString());
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { fieldErrors?: Record<string, string[]> }).fieldErrors?.palette?.length).toBeGreaterThan(0);
    expect(await tenantRow(A.tenantId)).toEqual(before);
  });

  it("[BR-P-12] Plataforma: un OWNER sin superadmin rebota; el superadmin asigna «tmp» con doble audit y CAS", async () => {
    const { setPlatformTenantSite } = await platform();
    asUser(A.userId);
    await expect(
      setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(A.tenantId), palette: "tmp" })
    ).rejects.toThrow();
    expect((await tenantRow(A.tenantId)).palette).toBe("mint");

    asUser(S.userId);
    const stale = new Date((await tenantRow(A.tenantId)).updatedAt.getTime() - 1000).toISOString();
    expect(await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: stale, palette: "tmp" })).toMatchObject({ ok: false });
    expect(
      await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(A.tenantId), palette: "neon" as never })
    ).toMatchObject({ ok: false });
    expect((await tenantRow(A.tenantId)).palette).toBe("mint");

    const before = await tenantRow(A.tenantId);
    const r = await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: before.updatedAt.toISOString(), palette: "tmp" });
    expect(r).toMatchObject({ ok: true });
    const t = await tenantRow(A.tenantId);
    expect(t.palette).toBe("tmp");
    // Solo la paleta: el switch de la sede no se toca.
    expect(t.siteEnabled).toBe(before.siteEnabled);
    expect(t.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const local = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } });
    const global = await db.platformAuditEvent.findMany({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } });
    expect(local).toHaveLength(1);
    expect(global).toHaveLength(1);
    expect(global[0].payload).toMatchObject({ changed: ["palette"], before: { palette: "mint" }, after: { palette: "tmp" } });
    expect(global[0].payload).not.toHaveProperty("before.siteEnabled");
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([`/${A.slug}`, `/c/${A.slug}/booking`]));

    // Mismo valor = no-op sin audit.
    revalidateTagSpy.mockClear();
    expect(
      await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(A.tenantId), palette: "tmp" })
    ).toMatchObject({ ok: true });
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } })).toBe(1);
    expect(revalidateTagSpy).not.toHaveBeenCalled();

    // La lectura de Plataforma la trae cruda.
    const { getPlatformTenantDetail } = await import("@/lib/platform-tenants-read");
    expect((await getPlatformTenantDetail(A.tenantId))?.palette).toBe("tmp");
  });

  it("[BR-P-13] con la marca asignada, el Titular la ve entre las opciones; si elige otra, deja de ofrecérsele", async () => {
    const { getSiteSettings, updateSiteSettings } = await settings();
    asUser(A.userId);
    expect(await getSiteSettings()).toMatchObject({
      ok: true,
      data: { palette: "tmp", paletteOptions: ["sky", "mint", "coral", "violet", "tmp"] },
    });
    // Guardar el form sin cambiar la paleta (re-mandar «tmp») está permitido: es la suya.
    expect(await updateSiteSettings({ ...form, palette: "tmp" }, await version(A.tenantId))).toMatchObject({ ok: true });
    expect(await updateSiteSettings({ ...form, palette: "violet" }, await version(A.tenantId))).toMatchObject({ ok: true });
    expect(await getSiteSettings()).toMatchObject({ ok: true, data: { palette: "violet", paletteOptions: ["sky", "mint", "coral", "violet"] } });
    expect(await updateSiteSettings({ ...form, palette: "tmp" }, await version(A.tenantId))).toMatchObject({ ok: false });
    expect((await tenantRow(A.tenantId)).palette).toBe("violet");

    // Plataforma se la vuelve a asignar (para el resto de los tests).
    asUser(S.userId);
    const { setPlatformTenantSite } = await platform();
    expect(
      await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(A.tenantId), palette: "tmp" })
    ).toMatchObject({ ok: true });
  });

  it("[BR-P-14] Apariencia: «tmp» la guarda un miembro de TMP; en otro consultorio se rechaza; basura también", async () => {
    const { updateUserPreferences, getUserPreferences } = await preferences();
    asUser(B.userId);
    expect(await updateUserPreferences({ palette: "tmp" })).toEqual({ ok: false, error: "Esa paleta es la de otro consultorio." });
    expect(await updateUserPreferences({ palette: "neon" as never })).toEqual({ ok: false, error: "Paleta inválida." });
    expect((await getUserPreferences()).palette).toBe("sky");
    expect(await updateUserPreferences({ palette: "coral" })).toMatchObject({ ok: true });

    asUser(A.userId);
    expect(await updateUserPreferences({ palette: "tmp" })).toMatchObject({ ok: true, data: { palette: "tmp" } });
    expect((await getUserPreferences()).palette).toBe("tmp");
    // La Secretaria también es miembro: Apariencia es de cada uno.
    asUser(secretaria.userId);
    expect(await updateUserPreferences({ palette: "tmp" })).toMatchObject({ ok: true });
  });

  it("[BR-P-15] lectura: un valor guardado desconocido cae al default (antes se casteaba a ciegas)", async () => {
    const { getUserPreferences } = await preferences();
    await db.userPreferences.update({ where: { userId: B.userId }, data: { palette: "neon" } });
    asUser(B.userId);
    expect((await getUserPreferences()).palette).toBe("sky");
  });

  it("[BR-P-16] el turnero recibe la paleta del consultorio (`getPublicClinic`)", async () => {
    await db.tenant.update({ where: { id: A.tenantId }, data: { publicBookingEnabled: true } });
    const { getPublicClinic } = await import("@/lib/public-booking");
    const clinic = await getPublicClinic(A.slug);
    expect(clinic?.palette).toBe("tmp");
  });
});
