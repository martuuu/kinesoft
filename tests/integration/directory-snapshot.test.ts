/**
 * DIR-2a · snapshot del directorio contra Postgres real (C-DIR4).
 *
 * Corre la función REAL (`buildDirectorySnapshot` / `getDirectorySnapshot`, canal service + `getPublicClinic`); solo
 * `next/cache` está mockeado (setup de integración). Fixtures por el owner.
 *
 * Matriz de exclusión: cada caso tiene un perfil PUBLICADO de alguien que no debe aparecer (si apareciera, es una
 * fuga). Consultorio: sin opt-in / oculto por Plataforma / turnero apagado / suspendido. Profesional: switch del
 * turnero apagado / membresía suspendida / sin servicio PUBLIC / perfil sin publicar / oculto / consentimiento retirado.
 *
 * PII: el snapshot serializado no contiene emails, userIds, `rating`, `priceCents` ni el email público del consultorio.
 *
 * Los asserts miran SOLO las filas de esta suite (por slug / profileId): otras suites de la misma base pueden tener
 * consultorios listados en el mismo momento.
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
import { buildDirectorySnapshot, getDirectorySnapshot } from "@/lib/directory-internal";
import { tags } from "@/lib/cache-tags";
import type { DirectorySnapshot } from "@/lib/directory-types";

const RUN = process.env.INTEGRATION === "1";
const CONSENT = "2026-10-v1";

describe.skipIf(!RUN)("[DIR-2a] snapshot del directorio (C-DIR4)", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const s = uniqueSuffix();
  let specialtyId = "";
  let archivedSpecialtyId = "";
  let payerId = "";
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  /** Perfil publicado (o con lo que se pise) para un usuario. Devuelve el id del perfil. */
  async function publish(userId: string, publicName: string, over: Record<string, unknown> = {}): Promise<string> {
    const p = await db.professionalPublicProfile.create({
      data: {
        userId,
        publicName,
        honorific: "LIC",
        licenseKind: "MN",
        licenseNumber: "12345",
        bio: "Kinesióloga deportiva.",
        listed: true,
        consentAt: new Date(),
        consentVersion: CONSENT,
        ...over,
      },
      select: { id: true },
    });
    return p.id;
  }

  /** Practicante extra con servicio PROPIO (para que quede reservable salvo por lo que el caso apaga). */
  async function addBookable(t: EphemeralTenant) {
    const p = await addPractitioner(db, t);
    await db.service.create({
      data: { tenantId: t.tenantId, practitionerId: p.practitionerId, name: `Sesión ${uniqueSuffix()}`, durationMin: 30, priceCents: 7777 },
    });
    return p;
  }

  async function listedTenant(over: Parameters<PrismaClient["tenant"]["update"]>[0]["data"] = {}) {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    await db.tenant.update({
      where: { id: t.tenantId },
      data: {
        directoryListed: true,
        directoryListedAt: new Date(),
        publicDescription: "Rehabilitación y deporte.",
        phone: "3415550000",
        whatsapp: "5493415550000",
        publicEmail: `contacto-${s}@consultorio.test`,
        ...over,
      },
    });
    return t;
  }

  // Fixture principal y casos.
  let OK: EphemeralTenant;
  const ids = {} as Record<
    | "ok" | "okSecond" | "switchOff" | "suspendedMember" | "noService" | "unpublished" | "hidden" | "withdrawn"
    | "tNotListed" | "tHidden" | "tTurneroOff" | "tSuspended",
    string
  >;
  const userIds: string[] = [];
  let SECOND: EphemeralTenant;
  let NOPROF: EphemeralTenant; // consultorio listado sin perfiles publicados (DIR-D25)
  const excludedSlugs: string[] = [];

  beforeAll(async () => {
    if (!RUN) return;
    delete process.env.TENANT_ACCESS_ENFORCEMENT; // default (banner): suspendido cierra el turnero
    db = ownerClient();
    specialtyId = (
      await db.specialty.create({
        data: { slug: `dir2a-dep-${s}`, name: `Deportiva ${s}`, matchKey: `dir2a-dep-${s}`, source: "REFEPS", sourceDate: new Date() },
      })
    ).id;
    archivedSpecialtyId = (
      await db.specialty.create({
        data: {
          slug: `dir2a-arch-${s}`, name: `Archivada ${s}`, matchKey: `dir2a-arch-${s}`, source: "REFEPS",
          sourceDate: new Date(), archivedAt: new Date(),
        },
      })
    ).id;
    payerId = (
      await db.payer.create({
        data: { slug: `dir2a-osde-${s}`, name: `OSDE ${s}`, kind: "PREPAGA", matchKey: `dir2a-osde-${s}`, source: "RNEMP", sourceDate: new Date() },
      })
    ).id;

    // ── Consultorio OK ──
    OK = await listedTenant();
    await db.practitioner.update({ where: { id: OK.practitionerId }, data: { rating: 4.9 } });
    await db.location.create({
      data: { tenantId: OK.tenantId, name: "Centro", address: "Córdoba 1234", city: "Rosario", province: "Santa Fe", provinceCode: "S", isPrimary: true },
    });
    const linked = await addInsurer(db, OK, { name: `OSDE local ${s}`, copagoCents: 1500 });
    await db.insurer.update({ where: { id: linked }, data: { payerId } });
    await addInsurer(db, OK, { name: `Mutual sin vincular ${s}` });
    await db.practitionerSpecialty.createMany({
      data: [
        { tenantId: OK.tenantId, practitionerId: OK.practitionerId, specialtyId },
        { tenantId: OK.tenantId, practitionerId: OK.practitionerId, specialtyId: archivedSpecialtyId },
      ],
    });
    userIds.push(OK.userId);
    ids.ok = await publish(OK.userId, `Ana Pérez ${s}`, { licenseKind: "MP", licenseJurisdiction: "S" });

    // Profesional del mismo consultorio: switch del turnero apagado.
    const off = await addBookable(OK);
    await db.practitioner.update({ where: { id: off.practitionerId }, data: { publicBookingEnabled: false } });
    userIds.push(off.userId);
    ids.switchOff = await publish(off.userId, `Apagado ${s}`);

    // Membresía suspendida.
    const susp = await addBookable(OK);
    await db.membership.update({
      where: { userId_tenantId: { userId: susp.userId, tenantId: OK.tenantId } },
      data: { disabledAt: new Date(), disabledReason: "MANUAL" },
    });
    userIds.push(susp.userId);
    ids.suspendedMember = await publish(susp.userId, `Suspendido ${s}`);

    // Sin servicio PUBLIC (no ofrece nada online).
    const nosvc = await addPractitioner(db, OK);
    userIds.push(nosvc.userId);
    ids.noService = await publish(nosvc.userId, `Sin servicio ${s}`);

    // Reservables pero con el perfil sin publicar / oculto / consentimiento retirado.
    const unp = await addBookable(OK);
    userIds.push(unp.userId);
    ids.unpublished = await publish(unp.userId, `Borrador ${s}`, { listed: false, consentAt: null, consentVersion: null });
    const hid = await addBookable(OK);
    userIds.push(hid.userId);
    ids.hidden = await publish(hid.userId, `Oculto ${s}`, { hiddenAt: new Date(), hiddenReason: "Matrícula dudosa", hiddenById: "platform-x" });
    const wd = await addBookable(OK);
    userIds.push(wd.userId);
    ids.withdrawn = await publish(wd.userId, `Retirado ${s}`, { listed: false, consentWithdrawnAt: new Date() });

    // ── Segundo consultorio donde Ana TAMBIÉN atiende (una persona = un profesional) ──
    SECOND = await listedTenant({ name: `Segundo ${s}` });
    userIds.push(SECOND.userId);
    ids.okSecond = await publish(SECOND.userId, `Beto Ruiz ${s}`);
    const anaThere = await db.practitioner.create({
      data: { tenantId: SECOND.tenantId, userId: OK.userId, publicBookingEnabled: true },
    });
    await db.membership.create({ data: { userId: OK.userId, tenantId: SECOND.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    await db.service.create({
      data: { tenantId: SECOND.tenantId, practitionerId: anaThere.id, name: "Consulta Ana", durationMin: 30, priceCents: 9999 },
    });

    // ── Consultorio listado sin perfiles publicados ──
    NOPROF = await listedTenant();
    userIds.push(NOPROF.userId);

    // ── Consultorios excluidos, cada uno con un perfil publicado de su titular ──
    const cases: [keyof typeof ids, Parameters<typeof listedTenant>[0]][] = [
      ["tNotListed", { directoryListed: false, directoryListedAt: null }],
      ["tHidden", { directoryHiddenAt: new Date(), directoryHiddenReason: "Denuncia", directoryHiddenById: "platform-x" }],
      ["tTurneroOff", { publicBookingEnabled: false }],
      ["tSuspended", { status: "SUSPENDED", statusChangedAt: new Date() }],
    ];
    for (const [key, data] of cases) {
      const t = await listedTenant(data);
      excludedSlugs.push(t.slug);
      userIds.push(t.userId);
      ids[key] = await publish(t.userId, `Excluido ${key} ${s}`);
    }
  });

  afterAll(async () => {
    if (!RUN) return;
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    // SECOND primero: el Practitioner de Ana ahí es RESTRICT hacia su UserProfile.
    for (const t of [SECOND, ...tenants.filter((x) => x !== SECOND)]) await t?.cleanup();
    await db.specialty.deleteMany({ where: { id: { in: [specialtyId, archivedSpecialtyId] } } });
    await db.payer.deleteMany({ where: { id: payerId } });
    await db.$disconnect();
  });

  afterEach(() => usePassthroughUnstableCache());

  const mine = (snap: DirectorySnapshot) => {
    const slugs = new Set(tenants.map((t) => t.slug));
    const profileIds = new Set(Object.values(ids));
    return {
      professionals: snap.professionals.filter((p) => profileIds.has(p.profileId)),
      clinics: snap.clinics.filter((c) => slugs.has(c.slug)),
    };
  };

  it("aparecen solo el consultorio y los profesionales que cumplen C-DIR4", async () => {
    const snap = mine(await buildDirectorySnapshot());
    expect(snap.professionals.map((p) => p.profileId).sort()).toEqual([ids.ok, ids.okSecond].sort());
    expect(snap.clinics.map((c) => c.slug).sort()).toEqual([OK.slug, SECOND.slug, NOPROF.slug].sort());
    for (const slug of excludedSlugs) expect(snap.clinics.some((c) => c.slug === slug)).toBe(false);
  });

  it("Ana: una entrada con sus dos consultorios, deep link, zona, especialidad vigente, coberturas y matrícula", async () => {
    const snap = mine(await buildDirectorySnapshot());
    const ana = snap.professionals.find((p) => p.profileId === ids.ok)!;
    expect(ana.publicName).toBe(`Ana Pérez ${s}`);
    expect(ana.honorificLabel).toBe("Lic.");
    expect(ana.license).toEqual({ kind: "MP", number: "12345", jurisdiction: "S", verified: false });
    expect(ana.specialties).toEqual([{ slug: `dir2a-dep-${s}`, name: `Deportiva ${s}` }]); // la archivada no
    expect(ana.coverages).toEqual(
      expect.arrayContaining([
        { name: `OSDE ${s}`, payerSlug: `dir2a-osde-${s}` }, // vinculada: nombre del catálogo
        { name: `Mutual sin vincular ${s}`, payerSlug: null },
      ])
    );
    expect(ana.acceptsParticular).toBe(true);
    const inOk = ana.clinics.find((c) => c.slug === OK.slug)!;
    expect(inOk).toEqual({
      slug: OK.slug,
      name: expect.any(String),
      path: `/consultorios/${OK.slug}`,
      city: "Rosario",
      provinceCode: "S",
      bookingHref: `/c/${OK.slug}/booking?pro=${OK.practitionerId}`,
    });
    expect(ana.clinics.map((c) => c.slug).sort()).toEqual([OK.slug, SECOND.slug].sort());

    const clinic = snap.clinics.find((c) => c.slug === OK.slug)!;
    expect(clinic.description).toBe("Rehabilitación y deporte.");
    expect(clinic.phone).toBe("3415550000");
    expect(clinic.locations).toEqual([{ name: "Centro", address: "Córdoba 1234", city: "Rosario", provinceCode: "S" }]);
    expect(clinic.professionals.map((p) => p.profileId)).toEqual([ids.ok]);
    expect(snap.clinics.find((c) => c.slug === NOPROF.slug)!.professionals).toEqual([]);
  });

  it("PII: sin emails, userIds, rating, precios ni el email público del consultorio", async () => {
    const full = JSON.stringify(await buildDirectorySnapshot());
    for (const u of userIds) {
      expect(full).not.toContain(u);
      expect(full).not.toContain(`${u}@test.local`);
    }
    expect(full).not.toContain(`contacto-${s}@consultorio.test`);
    expect(full).not.toMatch(/"rating"|"priceCents"|"email"|"userId"|"publicEmail"/);
    expect(JSON.stringify(mine(JSON.parse(full)))).not.toContain("@");
  });

  it("caché: clave `directory:snapshot:v1`, tag global; revalidar el tag refleja el retiro en el próximo request", async () => {
    const { keyParts } = useRealUnstableCache();
    const first = mine(await getDirectorySnapshot());
    expect(first.professionals.some((p) => p.profileId === ids.okSecond)).toBe(true);
    expect(keyParts.at(-1)).toEqual(["directory:snapshot:v1"]);

    // Retiro (como lo escribe DIR-2b): sin revalidar, el caché sigue sirviendo el viejo.
    await db.professionalPublicProfile.update({
      where: { id: ids.okSecond },
      data: { listed: false, consentWithdrawnAt: new Date() },
    });
    expect(mine(await getDirectorySnapshot()).professionals.some((p) => p.profileId === ids.okSecond)).toBe(true);
    revalidateTag(tags.directory());
    const after = mine(await getDirectorySnapshot());
    expect(after.professionals.some((p) => p.profileId === ids.okSecond)).toBe(false);
    // El consultorio sigue (tiene profesionales reservables), ahora sin publicados propios.
    expect(after.clinics.find((c) => c.slug === SECOND.slug)!.professionals.map((p) => p.profileId)).toEqual([ids.ok]);
  });
});
