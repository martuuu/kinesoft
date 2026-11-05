/**
 * CF3 (SD-S) · Configuración → «Sitio web» y el switch de Plataforma (D-CF3-9, D-CF3-10).
 *
 * Corren las actions REALES (`lib/clinic-site-settings.ts`, `lib/platform-tenants.ts#setPlatformTenantSite`) con el
 * `getActor()` real contra Postgres; solo se mockean la sesión de Supabase, `next/headers` y `next/cache`
 * (integration-setup.ts) y el step-up de 2FA del cambio de slug (la dependencia, no la action). Se corre con los dos
 * roles (`kinesoft_app` con RLS y el owner BYPASSRLS de prod): el resultado tiene que ser el mismo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const SITES = "global:sites";
const DIRECTORY = "global:directory";

describe.skipIf(!RUN)("[CF3-SDS] «Sitio web» del consultorio", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  let secretaria: { userId: string };
  let proSinConfig: { userId: string };
  let proConConfig: { userId: string };
  const s = uniqueSuffix();
  const settings = () => import("@/lib/clinic-site-settings");

  const row = () =>
    db.tenant.findUniqueOrThrow({
      where: { id: A.tenantId },
      select: {
        siteEnabled: true,
        siteEnabledAt: true,
        siteTagline: true,
        publicDescription: true,
        phone: true,
        whatsapp: true,
        publicEmail: true,
        updatedAt: true,
      },
    });
  const version = async () => (await row()).updatedAt.toISOString();
  const siteAudits = () => db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "tenant.site.update" } });
  const full = {
    siteEnabled: true,
    siteTagline: "Kinesiología y osteopatía en Rosario",
    publicDescription: "Atendemos con turno.\nObras sociales y particulares.",
    phone: "0341 455-1234",
    whatsapp: "341 15 555-1234",
    publicEmail: `Contacto-${s}@Consultorio.test`,
  };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    secretaria = await addStaff(db, A, "ASSISTANT", { grantSettings: true });
    proSinConfig = await addPractitioner(db, A, "PRACTITIONER");
    proConConfig = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.updateMany({ where: { tenantId: A.tenantId, userId: proConConfig.userId }, data: { grantSettings: true } });
  });

  afterAll(async () => {
    await A?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
  });

  it("[CF3-SDS10] la Secretaria con «Configuración» y un profesional sin ella: rechazo al leer y al guardar, sin cambios", async () => {
    const { getSiteSettings, updateSiteSettings } = await settings();
    const before = await row();
    for (const u of [secretaria.userId, proSinConfig.userId]) {
      asUser(u);
      expect(await getSiteSettings()).toMatchObject({ ok: false });
      expect(await updateSiteSettings(full, before.updatedAt.toISOString())).toMatchObject({ ok: false });
    }
    expect(await row()).toEqual(before);
    expect(await siteAudits()).toHaveLength(0);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  // CF3 ZF2 (B3): el copy decía «el administrador» a secas, pero un Administrador sin «Configuración» tampoco pasa el
  // gate (`tenant.sensitive` le llega solo por la delegación) y la Secretaría/Facturación nunca, aunque la tengan.
  it("[CF3-ZF2-2] el rechazo dice lo mismo que el gate tenant.sensitive, al leer y al guardar", async () => {
    const { getSiteSettings, updateSiteSettings } = await settings();
    const before = await row();
    const msg =
      "El sitio web lo maneja el titular, o un administrador o profesional con permiso de «Configuración». Secretaría y Facturación no tienen acceso.";
    for (const u of [secretaria.userId, proSinConfig.userId]) {
      asUser(u);
      expect(await getSiteSettings()).toEqual({ ok: false, error: msg });
      expect(await updateSiteSettings(full, before.updatedAt.toISOString())).toEqual({ ok: false, error: msg });
    }
  });

  it("[CF3-SDS11] el Titular prende y edita: normaliza, fecha el encendido, audita las claves y revalida después", async () => {
    asUser(A.userId);
    const { getSiteSettings, updateSiteSettings } = await settings();
    const read = await getSiteSettings();
    expect(read).toMatchObject({
      ok: true,
      data: { slug: A.slug, sitePath: `/${A.slug}`, siteEnabled: false, siteEnabledAt: null, hasLogo: false, slugReserved: false },
    });
    const r = await updateSiteSettings(full, (read as { data: { updatedAt: string } }).data.updatedAt);
    expect(r).toMatchObject({ ok: true });
    const t = await row();
    expect(t).toMatchObject({
      siteEnabled: true,
      siteTagline: full.siteTagline,
      publicDescription: full.publicDescription,
      phone: "0341 455-1234",
      whatsapp: "+5493415551234",
      publicEmail: `contacto-${s}@consultorio.test`,
    });
    expect(t.siteEnabledAt).toBeInstanceOf(Date);
    expect((r as { data: { updatedAt: string } }).data.updatedAt).toBe(t.updatedAt.toISOString());
    const audits = await siteAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({ siteEnabled: true });
    expect(new Set((audits[0].payload as { changed: string[] }).changed)).toEqual(
      new Set(["siteEnabled", "siteTagline", "publicDescription", "phone", "whatsapp", "publicEmail"])
    );
    // Sin valores en el log: solo las claves.
    expect(JSON.stringify(audits[0].payload)).not.toContain("Rosario");
    const tagsCalled = revalidateTagSpy.mock.calls.map((c) => c[0]);
    expect(tagsCalled).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining([`/${A.slug}`, "/configuracion", `/c/${A.slug}/booking`])
    );
  });

  it("[CF3-SDS12] mismo contenido → no-op: sin write, sin audit, sin revalidar y con la misma versión", async () => {
    asUser(A.userId);
    const { updateSiteSettings } = await settings();
    const v = await version();
    const r = await updateSiteSettings({ ...full, whatsapp: "+5493415551234" }, v);
    expect(r).toEqual({ ok: true, data: { updatedAt: v, changed: [] } });
    expect(await version()).toBe(v);
    expect(await siteAudits()).toHaveLength(1);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[CF3-SDS13] CAS: un expectedUpdatedAt viejo rebota sin cambios (otro guardó antes)", async () => {
    asUser(A.userId);
    const { updateSiteSettings } = await settings();
    const old = new Date((await row()).updatedAt.getTime() - 60_000).toISOString();
    const before = await row();
    expect(await updateSiteSettings({ ...full, siteTagline: "Otra frase" }, old)).toEqual({
      ok: false,
      error: "Otro cambio se guardó antes. Recargá y revisá.",
    });
    expect(await row()).toEqual(before);
    // Versión con forma inválida: mismo rechazo, nunca «sin CAS».
    expect(await updateSiteSettings({ ...full, siteTagline: "Otra frase" }, "ayer")).toMatchObject({ ok: false });
    expect(await row()).toEqual(before);
  });

  it.each([
    ["frase > 120", { siteTagline: "x".repeat(121) }, "siteTagline"],
    ["frase con salto de línea", { siteTagline: "Hola\nchau" }, "siteTagline"],
    ["descripción > 800", { publicDescription: "x".repeat(801) }, "publicDescription"],
    ["WhatsApp fijo", { whatsapp: "0341 455-1234" }, "whatsapp"],
    ["WhatsApp sin área", { whatsapp: "4555-1234" }, "whatsapp"],
    ["teléfono sin área", { phone: "455-1234" }, "phone"],
    ["teléfono con letras", { phone: "341 CALL-ME" }, "phone"],
    ["email inválido", { publicEmail: "no-es-email" }, "publicEmail"],
  ])("[CF3-SDS14] %s → rechazo con el campo marcado", async (_n, patch, field) => {
    asUser(A.userId);
    const { updateSiteSettings } = await settings();
    const before = await row();
    const r = await updateSiteSettings({ ...full, ...patch }, before.updatedAt.toISOString());
    expect(r).toMatchObject({ ok: false });
    expect((r as { fieldErrors?: Record<string, string[]> }).fieldErrors?.[field]?.length).toBeGreaterThan(0);
    expect(await row()).toEqual(before);
  });

  it("[CF3-SDS15] un campo de más (p. ej. el slug) se rechaza: el formulario no escribe otras columnas", async () => {
    asUser(A.userId);
    const { updateSiteSettings } = await settings();
    const r = await updateSiteSettings({ ...full, slug: "otro" } as never, await version());
    expect(r).toMatchObject({ ok: false });
  });

  it("[CF3-SDS16] apagar conserva siteEnabledAt; vaciar textos y contacto los deja en null", async () => {
    asUser(proConConfig.userId); // profesional con «Configuración» = tenant.sensitive
    const { updateSiteSettings } = await settings();
    const prev = await row();
    const r = await updateSiteSettings(
      { siteEnabled: false, siteTagline: "  ", publicDescription: "", phone: "", whatsapp: null, publicEmail: "" },
      prev.updatedAt.toISOString()
    );
    expect(r).toMatchObject({ ok: true });
    const t = await row();
    expect(t).toMatchObject({ siteEnabled: false, siteTagline: null, publicDescription: null, phone: null, whatsapp: null, publicEmail: null });
    expect(t.siteEnabledAt?.getTime()).toBe(prev.siteEnabledAt?.getTime());
  });

  it("[CF3-SDS17] Plataforma: un OWNER sin superadmin rebota; el superadmin prende con doble audit y CAS", async () => {
    const { setPlatformTenantSite } = await import("@/lib/platform-tenants");
    asUser(A.userId);
    await expect(setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(), siteEnabled: true })).rejects.toThrow();
    expect((await row()).siteEnabled).toBe(false);

    asUser(S.userId);
    const stale = new Date((await row()).updatedAt.getTime() - 1000).toISOString();
    expect(await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: stale, siteEnabled: true })).toMatchObject({ ok: false });
    const before = await row();
    const r = await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: before.updatedAt.toISOString(), siteEnabled: true });
    expect(r).toMatchObject({ ok: true });
    const t = await row();
    expect(t.siteEnabled).toBe(true);
    expect(t.siteEnabledAt!.getTime()).toBeGreaterThan(before.siteEnabledAt!.getTime());
    expect(t.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const local = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } });
    const global = await db.platformAuditEvent.findMany({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } });
    expect(local).toHaveLength(1);
    expect(global).toHaveLength(1);
    expect(global[0].payload).toMatchObject({ before: { siteEnabled: false }, after: { siteEnabled: true } });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toContain(`/${A.slug}`);

    // Mismo valor = no-op sin audit.
    revalidateTagSpy.mockClear();
    expect(await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(), siteEnabled: true })).toMatchObject({ ok: true });
    expect(await db.platformAuditEvent.count({ where: { tenantId: A.tenantId, action: "platform.tenant.site" } })).toBe(1);
    expect(revalidateTagSpy).not.toHaveBeenCalled();

    // Un campo de más se rechaza (strict).
    expect(
      await setPlatformTenantSite({ tenantId: A.tenantId, expectedUpdatedAt: await version(), siteEnabled: false, siteTagline: "x" })
    ).toMatchObject({ ok: false });
  });

  it("[CF3-SDS18] la lectura de Plataforma trae el switch de la sede", async () => {
    asUser(S.userId);
    const { getPlatformTenantDetail } = await import("@/lib/platform-tenants-read");
    expect((await getPlatformTenantDetail(A.tenantId))?.siteEnabled).toBe(true);
  });

  it("[CF3-SDS19] invalidaciones que faltaban: nombre (Configuración y Plataforma) y slug → sede y directorio", async () => {
    asUser(A.userId);
    const { updateTenantBasics } = await import("@/lib/tenant-settings");
    expect(await updateTenantBasics({ name: `Consultorio ${s}` })).toMatchObject({ ok: true });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toContain(`/${A.slug}`);

    asUser(S.userId);
    const lifecycle = await import("@/lib/platform-tenant-lifecycle");
    revalidateTagSpy.mockClear();
    expect(
      await lifecycle.updatePlatformTenantProfile({ tenantId: A.tenantId, expectedUpdatedAt: await version(), phone: "0341 400-0000" })
    ).toMatchObject({ ok: true });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));

    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
    const oldSlug = A.slug;
    const newSlug = `sds-${s}`.slice(0, 40);
    expect(
      await lifecycle.changePlatformTenantSlug({ tenantId: A.tenantId, expectedUpdatedAt: await version(), slug: newSlug })
    ).toMatchObject({ ok: true });
    expect(revalidateTagSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([SITES, DIRECTORY]));
    expect(revalidatePathSpy.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([`/${oldSlug}`, `/${newSlug}`]));
  });
});
