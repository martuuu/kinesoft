/**
 * [CT-L-4] Matrícula de la PERSONA (CF3b, M23) sobre la base real, en los DOS roles (`test:integration` = kinesoft_app
 * con RLS; `test:integration:owner` = owner BYPASSRLS, como prod).
 *
 * Se fija:
 *  - `setOwnLicense` escribe SOLO la fila de la sesión: un `userId` ajeno en el input se ignora (UserProfile no tiene
 *    RLS: la sesión es la única barrera); la fecha la pone el trigger; el evento de «Seguridad de la cuenta» queda sin el
 *    número completo; sin cambio no escribe ni deja evento; borrar (los tres null) también estampa;
 *  - el contrato todo o nada llega con su copy por campo (MP sin provincia → `jurisdiction`), sin tocar la fila;
 *  - quien no atiende no carga una matrícula pero sí puede borrar la suya; 2FA pendiente o sin sesión → nada;
 *  - la matrícula AJENA (Usuarios) la fija ct-u-team-co-owner.test.ts (`listTeamMembersInTx`: solo el principal y solo
 *    de miembros aceptados). CF3 ZF5 borró `licensesForTenantMembersInTx` (sin llamadores) y su caso [CT-L-4f];
 *  - el loader de /configuracion trae la propia en `miAgenda.license` (y la de nadie más).
 *
 * Símbolos REALES contra Postgres. Se mockea solo lo externo (sesión de Supabase y `next/cache`, en el setup).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getOwnLicense, setOwnLicense } from "@/lib/user-license";
import { USER_LICENSE_COPY } from "@/lib/user-license-logic";
import type { SetOwnLicenseInput } from "@/lib/user-license-schemas";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy } from "@/tests/helpers/integration-setup";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CT-L-4] matrícula de la persona (lib/user-license)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let U: EphemeralTenant;
  let pro: { userId: string; practitionerId: string };
  let invited: { userId: string; practitionerId: string };
  let staffUserId: string;

  const lic = (userId: string) =>
    db.userProfile.findUniqueOrThrow({
      where: { id: userId },
      select: { licenseKind: true, licenseNumber: true, licenseJurisdiction: true, licenseUpdatedAt: true },
    });
  const events = (userId: string) =>
    db.userSecurityEvent.findMany({ where: { userId, kind: { startsWith: "license." } }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    U = await createEphemeralTenant(db);
    pro = await addPractitioner(db, A, "PRACTITIONER");
    // Invitación pendiente: la persona existe (y ya cargó su matrícula en otro lado), pero todavía no aceptó.
    invited = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.updateMany({ where: { userId: invited.userId, tenantId: A.tenantId }, data: { acceptedAt: null } });
    await db.userProfile.update({ where: { id: invited.userId }, data: { licenseKind: "MN", licenseNumber: "INV-1" } });
    // Del otro consultorio, con matrícula.
    await db.userProfile.update({
      where: { id: U.userId },
      data: { licenseKind: "MP", licenseNumber: "OTRO-77", licenseJurisdiction: "S" },
    });
    staffUserId = (await addStaff(db, A, "ASSISTANT")).userId;
  }, 60_000);

  afterAll(async () => {
    asAnonymous();
    for (const t of [A, U]) await t?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => revalidatePathSpy.mockClear());

  it("[CT-L-4a] carga la propia (MP), un userId ajeno en el input se ignora; fecha del trigger y evento sin el número", async () => {
    asUser(pro.userId);
    const before = await lic(U.userId);
    const r = await setOwnLicense({
      kind: "MP",
      number: "  MP 12.345/B ",
      jurisdiction: "x",
      userId: U.userId,
    } as SetOwnLicenseInput);
    expect(r.ok).toBe(true);
    const row = await lic(pro.userId);
    expect(row).toMatchObject({ licenseKind: "MP", licenseNumber: "MP 12.345/B", licenseJurisdiction: "X" });
    expect(row.licenseUpdatedAt).toBeInstanceOf(Date);
    expect(r.ok && r.data).toEqual({
      license: { kind: "MP", number: "MP 12.345/B", jurisdiction: "X" },
      updatedAt: row.licenseUpdatedAt!.toISOString(),
    });
    // La fila ajena, intacta.
    expect(await lic(U.userId)).toEqual(before);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/configuracion");

    const ev = await events(pro.userId);
    expect(ev.map((e) => e.kind)).toEqual(["license.updated"]);
    expect(ev[0].payload).toEqual({ kind: "MP", jurisdiction: "X", number: "•••/B" });
    expect(JSON.stringify(ev[0].payload)).not.toContain("12.345");
    expect(ev[0].tenantId).toBeNull();

    expect(await getOwnLicense()).toEqual(r);
  });

  it("[CT-L-4b] lo mismo otra vez: ok sin escribir (la fecha queda) ni dejar evento", async () => {
    asUser(pro.userId);
    const before = await lic(pro.userId);
    const r = await setOwnLicense({ kind: "MP", number: "MP 12.345/B", jurisdiction: "X" });
    expect(r.ok).toBe(true);
    expect(await lic(pro.userId)).toEqual(before);
    expect((await events(pro.userId)).length).toBe(1);
    expect(revalidatePathSpy).not.toHaveBeenCalled();
  });

  it("[CT-L-4c] MP sin provincia y número con signos al final: error por campo, la fila no cambia", async () => {
    asUser(pro.userId);
    const before = await lic(pro.userId);
    const noProvince = await setOwnLicense({ kind: "MP", number: "999", jurisdiction: null });
    expect(noProvince).toEqual({
      ok: false,
      error: USER_LICENSE_COPY.errJurisdiction,
      fieldErrors: { jurisdiction: [USER_LICENSE_COPY.errJurisdiction] },
    });
    const badNumber = await setOwnLicense({ kind: "MN", number: "123-", jurisdiction: null });
    expect(badNumber.ok === false && Object.keys(badNumber.fieldErrors ?? {})).toEqual(["number"]);
    // Forma inválida (no string): zod la frena antes del parser.
    const weird = await setOwnLicense({ kind: "MN", number: 12345 as unknown as string, jurisdiction: null });
    expect(weird).toEqual({ ok: false, error: USER_LICENSE_COPY.invalid });
    expect(await lic(pro.userId)).toEqual(before);
  });

  it("[CT-L-4d] pasar a MN descarta la provincia; borrar (los tres null) estampa y deja «license.cleared»", async () => {
    asUser(pro.userId);
    const mn = await setOwnLicense({ kind: "MN", number: "777", jurisdiction: "X" });
    expect(mn.ok && mn.data.license).toEqual({ kind: "MN", number: "777", jurisdiction: null });
    const set = await lic(pro.userId);
    const cleared = await setOwnLicense({ kind: null, number: null, jurisdiction: null });
    expect(cleared.ok && cleared.data.license).toBeNull();
    const row = await lic(pro.userId);
    expect(row).toMatchObject({ licenseKind: null, licenseNumber: null, licenseJurisdiction: null });
    expect(row.licenseUpdatedAt!.getTime()).toBeGreaterThanOrEqual(set.licenseUpdatedAt!.getTime());
    const ev = await events(pro.userId);
    expect(ev.map((e) => e.kind)).toEqual(["license.updated", "license.updated", "license.cleared"]);
    expect(ev[1].payload).toEqual({ kind: "MN", jurisdiction: null, number: "•••" });
  });

  it("[CT-L-4e] quien no atiende no carga matrícula (pero puede borrar la suya); 2FA pendiente o sin sesión → nada", async () => {
    asUser(staffUserId);
    expect(await setOwnLicense({ kind: "MN", number: "1", jurisdiction: null })).toEqual({
      ok: false,
      error: USER_LICENSE_COPY.notPractitioner,
    });
    expect(await lic(staffUserId)).toMatchObject({ licenseKind: null, licenseNumber: null });
    // Una que quedó de cuando atendía (fixture directo) se puede sacar.
    await db.userProfile.update({ where: { id: staffUserId }, data: { licenseKind: "MN", licenseNumber: "VIEJA-1" } });
    const cleared = await setOwnLicense({ kind: null, number: null, jurisdiction: null });
    expect(cleared.ok).toBe(true);
    expect(await lic(staffUserId)).toMatchObject({ licenseKind: null, licenseNumber: null });

    await db.userProfile.update({ where: { id: pro.userId }, data: { twoFactorEmail: true } });
    try {
      asUser(pro.userId);
      expect(await setOwnLicense({ kind: "MN", number: "2", jurisdiction: null })).toEqual({
        ok: false,
        error: USER_LICENSE_COPY.pending2fa,
      });
      expect(await getOwnLicense()).toEqual({ ok: false, error: USER_LICENSE_COPY.pending2fa });
      expect(await lic(pro.userId)).toMatchObject({ licenseNumber: null });
    } finally {
      await db.userProfile.update({ where: { id: pro.userId }, data: { twoFactorEmail: false } });
    }
    asAnonymous();
    expect(await setOwnLicense({ kind: "MN", number: "3", jurisdiction: null })).toEqual({
      ok: false,
      error: USER_LICENSE_COPY.noSession,
    });
  });

  it("[CT-L-4g] el loader trae la propia en miAgenda.license (y nada de la de otros)", async () => {
    asUser(pro.userId);
    // CF3 ZF5: la cargaba [CT-L-4f] (borrado junto con `licensesForTenantMembersInTx`); ahora la carga este caso.
    expect((await setOwnLicense({ kind: "MP", number: "4567", jurisdiction: "B" })).ok).toBe(true);
    const actor = await getActor();
    const r = await loadConfiguracionPage(actor, await capabilitiesForActor(actor));
    const row = await lic(pro.userId);
    expect(r.miAgenda?.license).toEqual({
      license: { kind: "MP", number: "4567", jurisdiction: "B" },
      updatedAt: row.licenseUpdatedAt!.toISOString(),
    });
    expect(JSON.stringify(r.miAgenda)).not.toMatch(/OTRO-77|INV-1/);

    // El Titular (sin matrícula) recibe la suya vacía.
    asUser(A.userId);
    const owner = await getActor();
    const o = await loadConfiguracionPage(owner, await capabilitiesForActor(owner));
    expect(o.miAgenda?.license).toEqual({ license: null, updatedAt: null });
  });
});
