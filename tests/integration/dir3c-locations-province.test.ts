/**
 * [DIR-3c] Sedes → provincia normalizada (C-DIR9, DIR-D16, M11 `Location.provinceCode`).
 *
 * Se fija, sobre las actions REALES de `lib/locations.ts` contra Postgres (los dos roles):
 *  - elegir la provincia guarda el código (`provinceCode`) y también el nombre en `province`: lo que hoy lee
 *    `province` (turnero, agenda, export) sigue mostrando algo legible;
 *  - un código que no es una de las 24 jurisdicciones se rechaza con error de campo y no escribe;
 *  - sacar la provincia (null / "") borra el código pero NO pisa el `province` viejo («Bs As» cargado a mano): solo se
 *    reemplaza cuando hay un código elegido;
 *  - toda escritura de sedes invalida el snapshot del directorio (`global:directory`): la ciudad y la provincia de la
 *    sede se ven en `/consultorios/<slug>`.
 * Se mockea solo lo externo (sesión y `next/cache` en integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createLocation, updateLocation } from "@/lib/locations";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DIR_TAG = "global:directory";

describe.skipIf(!RUN)("[DIR-3c] Sedes: provincia normalizada", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  const loc = (id: string) =>
    db.location.findUniqueOrThrow({ where: { id }, select: { province: true, provinceCode: true, city: true } });

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  }, 60_000);

  afterAll(async () => {
    asAnonymous();
    await T?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => revalidateTagSpy.mockClear());

  it("[DIR-3c] crear con provincia guarda el código y el nombre, e invalida el directorio", async () => {
    asUser(T.userId);
    const r = await createLocation({ name: "Sede Córdoba", city: "Córdoba", provinceCode: "X" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await loc(r.data.id)).toEqual({ province: "Córdoba", provinceCode: "X", city: "Córdoba" });
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);
  });

  it("[DIR-3c] código inválido: error de campo y no escribe", async () => {
    asUser(T.userId);
    const created = await db.location.create({ data: { tenantId: T.tenantId, name: "Sede vieja", province: "Bs As" } });
    const r = await updateLocation(created.id, { provinceCode: "ZZ" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors?.provinceCode?.length).toBeGreaterThan(0);
    expect(await loc(created.id)).toMatchObject({ province: "Bs As", provinceCode: null });
    const nope = await createLocation({ name: "Sede X", provinceCode: "AR-B" });
    expect(nope.ok).toBe(false);
  });

  it("[DIR-3c] elegir provincia pisa el texto viejo; sacarla borra el código y deja el texto", async () => {
    asUser(T.userId);
    const created = await db.location.create({ data: { tenantId: T.tenantId, name: "Sede legado", province: "Bs As" } });
    expect((await updateLocation(created.id, { provinceCode: "B" })).ok).toBe(true);
    expect(await loc(created.id)).toMatchObject({ province: "Buenos Aires", provinceCode: "B" });
    expect(revalidateTagSpy).toHaveBeenCalledWith(DIR_TAG);

    expect((await updateLocation(created.id, { provinceCode: "" })).ok).toBe(true);
    expect(await loc(created.id)).toMatchObject({ province: "Buenos Aires", provinceCode: null });

    // Editar otro campo sin mandar provinceCode no la toca.
    expect((await updateLocation(created.id, { provinceCode: "C" })).ok).toBe(true);
    expect((await updateLocation(created.id, { city: "CABA" })).ok).toBe(true);
    expect(await loc(created.id)).toEqual({ province: "Ciudad Autónoma de Buenos Aires", provinceCode: "C", city: "CABA" });
  });
});
