/**
 * CF3 (SD-U) · la sede digital `/<slug>` contra Postgres real: lo que SD-U le sumó al loader (paleta, horario semanal
 * por profesional para «Quién atiende cada día») y la página REAL renderizada con el DTO del loader real.
 *
 * Funciones REALES (`buildClinicSiteSnapshot`, `getClinicSite` → `getPublicClinic`, canal service; la página de
 * `app/(sede)/[slug]/page.tsx`); solo `next/cache` está mockeado (setup de integración, passthrough). Fixtures por el
 * owner. Corre con los dos roles: el loader usa `prismaService`, el resultado tiene que ser el mismo con RLS aplicado o
 * con BYPASSRLS (prod). Los asserts miran SOLO las sedes de esta suite.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { addPractitioner, createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { buildClinicSiteSnapshot, getClinicSite } from "@/lib/clinic-site-internal";
import { expandClinicSite } from "@/lib/clinic-site-logic";
import { clinicSiteSchema, type ClinicSite } from "@/lib/clinic-site-types";
import { toARDateKey } from "@/lib/datetime-ar";
import SedeDigitalPage from "@/app/(sede)/[slug]/page";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CF3-SDU] sede digital: horario por profesional, paleta y página", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const s = uniqueSuffix();
  let T: EphemeralTenant;
  let noSchedule = "";
  let roomId = "";
  const day = (offsetDays: number) => {
    const d = new Date(`${toARDateKey(new Date())}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d;
  };

  beforeAll(async () => {
    if (!RUN) return;
    db = ownerClient();
    T = await createEphemeralTenant(db);
    tenants.push(T);
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { siteEnabled: true, siteEnabledAt: new Date(), palette: "violet", name: `Sede ${s}`, businessHoursStart: 9, businessHoursEnd: 18 },
    });
    await db.userProfile.update({ where: { id: T.userId }, data: { fullName: `Tomás Paredes ${s}` } });
    const main = await db.location.create({
      data: { tenantId: T.tenantId, name: "Centro", address: "Córdoba 1234", city: "Rosario", province: "Santa Fe", isPrimary: true },
    });
    const closed = await db.location.create({ data: { tenantId: T.tenantId, name: "Cerrada", active: false } });
    roomId = (await db.room.create({ data: { tenantId: T.tenantId, locationId: main.id, name: `Box ${s}` } })).id;
    await db.practitionerSchedule.createMany({
      data: [
        // Lunes 8-12 y 11-14 (se unen), martes 14-20 con sala, miércoles vencida, jueves que empieza mañana,
        // viernes en una sede inactiva (no ofrece turnos).
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: main.id, dow: 1, startMin: 480, endMin: 720 },
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: main.id, dow: 1, startMin: 660, endMin: 840 },
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: main.id, dow: 2, startMin: 840, endMin: 1200, roomId },
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: main.id, dow: 3, startMin: 540, endMin: 600, validUntil: day(-1) },
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: main.id, dow: 4, startMin: 540, endMin: 600, validFrom: day(1) },
        { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: closed.id, dow: 5, startMin: 540, endMin: 600 },
      ],
    });
    // Segundo profesional sin ninguna franja: la red de seguridad del motor (lun a sáb, horario del consultorio).
    const p2 = await addPractitioner(db, T);
    noSchedule = p2.practitionerId;
    await db.userProfile.update({ where: { id: p2.userId }, data: { fullName: `Mariana Pérez ${s}` } });
    await db.service.create({
      data: { tenantId: T.tenantId, practitionerId: p2.practitionerId, name: "Osteopatía", durationMin: 50, priceCents: 9000 },
    });
  });

  afterAll(async () => {
    if (!RUN) return;
    for (const t of tenants) await t.cleanup();
    await db.$disconnect();
  });

  const siteOf = async (): Promise<ClinicSite> => {
    const c = (await buildClinicSiteSnapshot()).sites.find((x) => x.slug === T.slug);
    return expandClinicSite(c!);
  };

  it("[CF3-SDU-I1] horario por profesional: vigentes hoy (AR), unidas, sin sedes inactivas; red de seguridad sin franjas", async () => {
    const site = await siteOf();
    expect(() => clinicSiteSchema.parse(site)).not.toThrow();
    expect(site.palette).toBe("violet");
    const tomas = site.practitioners.find((p) => p.id === T.practitionerId)!;
    expect(tomas.hours).toEqual([
      { dow: 1, startMin: 480, endMin: 840 },
      { dow: 2, startMin: 840, endMin: 1200 },
    ]);
    const mariana = site.practitioners.find((p) => p.id === noSchedule)!;
    expect(mariana.hours.map((h) => h.dow)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mariana.hours.every((h) => h.startMin === 540 && h.endMin === 1080)).toBe(true);
  });

  it("[CF3-SDU-I2] el horario no arrastra sede, sala ni ids de franja al snapshot", async () => {
    const mine = JSON.stringify((await buildClinicSiteSnapshot()).sites.find((x) => x.slug === T.slug));
    expect(mine).not.toContain(roomId);
    expect(mine).not.toContain("Box ");
    expect(mine).not.toMatch(/locationId|roomId|validFrom|validUntil/);
  });

  it("[CF3-SDU-I3] la página real con el loader real: grilla, paleta, ?pro= y 404 con la sede apagada", async () => {
    const html = renderToStaticMarkup(await SedeDigitalPage({ params: { slug: T.slug } }));
    expect(html).toContain('data-palette="violet"');
    expect(html).toContain("Quién atiende cada día");
    expect(html).toContain("8 a 14 h");
    expect(html).toContain(`href="/c/${T.slug}/booking?pro=${T.practitionerId}"`);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]/i); // ningún email (el `@context` del JSON-LD no cuenta)

    await db.tenant.update({ where: { id: T.tenantId }, data: { siteEnabled: false } });
    try {
      expect(await getClinicSite(T.slug)).toBeNull();
      const digest = await SedeDigitalPage({ params: { slug: T.slug } }).then(
        () => "no tiró",
        (e: { digest?: string }) => e.digest ?? String(e)
      );
      expect(digest).toBe("NEXT_NOT_FOUND");
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { siteEnabled: true } });
    }
  });
});
