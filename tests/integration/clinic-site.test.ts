/**
 * CF3 (SD-K) · loader de la sede digital `/<slug>` contra Postgres real (D-CF3-3, D-CF3-9, D-CF3-10).
 *
 * Corre las funciones REALES (`buildClinicSiteSnapshot`, `getClinicSite`, `listEnabledSiteSlugs`: canal service +
 * `getPublicClinic`); solo `next/cache` está mockeado (setup de integración). Fixtures por el owner. Se corre con los
 * dos roles (`test:integration` y `test:integration:owner`): el loader usa `prismaService`, así que el resultado tiene
 * que ser el mismo con RLS aplicado o con BYPASSRLS (prod).
 *
 * Los asserts miran SOLO las sedes de esta suite (por slug): otras suites pueden tener sedes prendidas a la vez.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { revalidateTag } from "next/cache";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";
import {
  addInsurer,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import {
  CLINIC_SITES_TAG,
  buildClinicSiteSnapshot,
  getClinicSite,
  listEnabledSiteSlugs,
} from "@/lib/clinic-site-internal";
import { expandClinicSite } from "@/lib/clinic-site-logic";
import { clinicSiteSchema, type ClinicSite } from "@/lib/clinic-site-types";

const RUN = process.env.INTEGRATION === "1";
const E164 = "+5493415559999";

describe.skipIf(!RUN)("[CF3-SDK] loader de la sede digital", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const s = uniqueSuffix();
  let payerId = "";
  const aliasSlug = `sdk-viejo-${s}`;
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;
  const logoAt = new Date("2026-11-01T12:00:00.000Z");
  let OK: EphemeralTenant;
  let OFF: EphemeralTenant;
  let SUSP: EphemeralTenant;
  let CLOSED: EphemeralTenant;
  let hiddenPrice = "";
  let switchOff = "";
  const privateUserIds: string[] = [];

  async function tenant(data: Parameters<PrismaClient["tenant"]["update"]>[0]["data"], opts: Parameters<typeof createEphemeralTenant>[1] = {}) {
    const t = await createEphemeralTenant(db, opts);
    tenants.push(t);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: {
        siteEnabled: true,
        siteEnabledAt: new Date(),
        siteTagline: "Rehabilitación en Rosario",
        publicDescription: "Kinesiología y osteopatía.",
        phone: "3415550000",
        whatsapp: "5493415550000",
        publicEmail: `contacto-${s}@consultorio.test`,
        ...data,
      },
    });
    privateUserIds.push(t.userId);
    return t;
  }

  beforeAll(async () => {
    if (!RUN) return;
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default (banner): suspendido cierra lo público
    db = ownerClient();
    payerId = (
      await db.payer.create({
        data: { slug: `sdk-osde-${s}`, name: `OSDE ${s}`, kind: "PREPAGA", matchKey: `sdk-osde-${s}`, source: "RNEMP", sourceDate: new Date() },
      })
    ).id;

    // ── Sede OK ──
    OK = await tenant({ logoStorageKey: "tenants/x/logo.png", logoUpdatedAt: logoAt });
    await db.tenant.update({ where: { id: OK.tenantId }, data: { name: `TMP ${s}` } });
    await db.userProfile.update({ where: { id: OK.userId }, data: { fullName: `Ana Pérez ${s}` } });
    await db.practitioner.update({
      where: { id: OK.practitionerId },
      data: {
        licenseNumber: "MN 1234",
        // Contacto privado del profesional con TODOS los opt-ins prendidos: igual no sale en la sede (D-CF3-9).
        contactWhatsapp: E164,
        contactConsentAt: new Date(),
        contactConsentVersion: "v1",
        showContactInLeadWindow: true,
        showContactForInsured: true,
      },
    });
    await db.location.create({
      data: { tenantId: OK.tenantId, name: "Centro", address: "Córdoba 1234", city: "Rosario", province: "Santa Fe", isPrimary: true },
    });
    await db.insurer.update({ where: { id: OK.particularInsurerId }, data: { copagoCents: 800_000 } });
    const linked = await addInsurer(db, OK, { name: `OSDE local ${s}`, copagoCents: 1500 });
    await db.insurer.update({ where: { id: linked }, data: { payerId } });
    // Precio propio de Ana para el servicio de la factory (Service.priceCents = 5000).
    await db.practitionerService.create({
      data: { tenantId: OK.tenantId, practitionerId: OK.practitionerId, serviceId: OK.serviceId, priceCents: 1_500_000 },
    });
    // Profesional con precio propio pero `showPublicPrice=false`.
    const hp = await addPractitioner(db, OK);
    hiddenPrice = hp.practitionerId;
    privateUserIds.push(hp.userId);
    const hpSvc = await db.service.create({
      data: { tenantId: OK.tenantId, practitionerId: hp.practitionerId, name: "Osteopatía", durationMin: 60, priceCents: 9000 },
    });
    await db.practitioner.update({ where: { id: hp.practitionerId }, data: { showPublicPrice: false } });
    await db.practitionerService.create({
      data: { tenantId: OK.tenantId, practitionerId: hp.practitionerId, serviceId: hpSvc.id, priceCents: 2_222_200 },
    });
    // Profesional fuera del turnero (switch propio apagado): no aparece.
    const so = await addPractitioner(db, OK);
    switchOff = so.practitionerId;
    privateUserIds.push(so.userId);
    await db.service.create({
      data: { tenantId: OK.tenantId, practitionerId: so.practitionerId, name: "Fuera", durationMin: 30, priceCents: 7777 },
    });
    await db.practitioner.update({ where: { id: so.practitionerId }, data: { publicBookingEnabled: false } });
    // Alias viejo del slug.
    await db.tenantSlugAlias.create({ data: { slug: aliasSlug, tenantId: OK.tenantId } });

    // ── Sede apagada, consultorio suspendido, turnero cerrado ──
    OFF = await tenant({ siteEnabled: false, siteEnabledAt: null });
    SUSP = await tenant({ status: "SUSPENDED", statusChangedAt: new Date() });
    CLOSED = await tenant({}, { publicBookingEnabled: false });
  });

  afterAll(async () => {
    if (!RUN) return;
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    await db.tenantSlugAlias.deleteMany({ where: { slug: aliasSlug } });
    for (const t of tenants) await t.cleanup();
    await db.payer.deleteMany({ where: { id: payerId } });
    await db.$disconnect();
  });

  afterEach(() => usePassthroughUnstableCache());

  const siteOf = async (slug: string): Promise<ClinicSite | null> => {
    const snap = await buildClinicSiteSnapshot();
    const c = snap.sites.find((x) => x.slug === slug);
    return c ? expandClinicSite(c) : null;
  };

  it("[CF3-SDK-I1] sede OK: DTO cerrado, contenido y precios por profesional", async () => {
    const site = (await siteOf(OK.slug))!;
    expect(() => clinicSiteSchema.parse(site)).not.toThrow();
    expect(site).toMatchObject({
      slug: OK.slug,
      name: `TMP ${s}`,
      tagline: "Rehabilitación en Rosario",
      description: "Kinesiología y osteopatía.",
      logoUrl: `/${OK.slug}/logo?v=${logoAt.getTime()}`,
      contact: { phone: "3415550000", whatsapp: "5493415550000" },
      coverages: [`OSDE ${s}`],
      bookingUrl: `/c/${OK.slug}/booking`,
      online: { bookingOpen: true },
    });
    expect(site.locations).toEqual([
      expect.objectContaining({ name: "Centro", address: "Córdoba 1234", city: "Rosario", province: "Santa Fe" }),
    ]);
    expect(site.practitioners.map((p) => p.id).sort()).toEqual([OK.practitionerId, hiddenPrice].sort());
    const ana = site.practitioners.find((p) => p.id === OK.practitionerId)!;
    expect(ana).toMatchObject({ name: `Ana Pérez ${s}`, license: "MN 1234", bookingUrl: `/c/${OK.slug}/booking?pro=${OK.practitionerId}` });
    expect(ana.services).toEqual([{ id: OK.serviceId, name: "Consulta", durationMin: 45, priceCents: 1_500_000 }]);
    // showPublicPrice=false: el precio ni viaja.
    const hp = site.practitioners.find((p) => p.id === hiddenPrice)!;
    expect(hp.services.map((x) => x.priceCents)).toEqual([null]);
    expect(site.practitioners.some((p) => p.id === switchOff)).toBe(false);
  });

  it("[CF3-SDK-I2] PII: el snapshot no tiene emails, WhatsApp ni userIds de profesionales ni el email público", async () => {
    const full = JSON.stringify(await buildClinicSiteSnapshot());
    expect(full).not.toContain(E164);
    expect(full).not.toContain(`contacto-${s}@consultorio.test`);
    for (const u of privateUserIds) expect(full).not.toContain(u);
    expect(full).not.toContain("2222200");
    const mine = JSON.stringify((await buildClinicSiteSnapshot()).sites.filter((x) => tenants.some((t) => t.slug === x.slug)));
    expect(mine).not.toContain("@");
  });

  it("[CF3-SDK-I3] apagada / suspendida → null; turnero cerrado → sede sin profesionales; inexistente → null", async () => {
    expect(await getClinicSite(OFF.slug)).toBeNull();
    expect(await getClinicSite(SUSP.slug)).toBeNull();
    expect(await getClinicSite(`no-existe-${s}`)).toBeNull();
    expect(await getClinicSite("../../etc/passwd")).toBeNull();
    const closed = (await getClinicSite(CLOSED.slug)) as ClinicSite;
    expect(closed).not.toBeNull();
    expect(closed.practitioners).toEqual([]);
    expect(closed.online).toEqual({ bookingOpen: false });
  });

  it("[CF3-SDK-I4] alias → redirect a la vigente; mayúsculas → redirect", async () => {
    expect(await getClinicSite(aliasSlug)).toEqual({ redirectTo: OK.slug });
    expect(await getClinicSite(OK.slug.toUpperCase())).toEqual({ redirectTo: OK.slug });
  });

  it("[CF3-SDK-I5] sitemap: solo las prendidas y abiertas", async () => {
    const slugs = await listEnabledSiteSlugs();
    expect(slugs).toEqual(expect.arrayContaining([OK.slug, CLOSED.slug]));
    expect(slugs).not.toContain(OFF.slug);
    expect(slugs).not.toContain(SUSP.slug);
  });

  it("[CF3-SDK-I6] caché: clave global, tag `global:sites`; revalidar refleja el apagado", async () => {
    const { keyParts } = useRealUnstableCache();
    expect(await getClinicSite(OK.slug)).not.toBeNull();
    // CF3b PH-S: v3 (la forma compacta suma `photoUrl` por profesional).
    expect(keyParts.at(-1)).toEqual(["clinic-site:snapshot:v3"]);
    // Un slug basura no arma otra entrada: misma clave global.
    await getClinicSite(`basura-${s}`);
    expect(new Set(keyParts.map((k) => k.join("|")))).toEqual(new Set(["clinic-site:snapshot:v3"]));

    await db.tenant.update({ where: { id: OK.tenantId }, data: { siteEnabled: false } });
    try {
      expect(await getClinicSite(OK.slug)).not.toBeNull(); // sin revalidar, el cache sigue
      revalidateTag(CLINIC_SITES_TAG);
      expect(await getClinicSite(OK.slug)).toBeNull();
      expect(await getClinicSite(aliasSlug)).toBeNull(); // el alias de una sede apagada tampoco redirige
    } finally {
      await db.tenant.update({ where: { id: OK.tenantId }, data: { siteEnabled: true } });
    }
  });
});
