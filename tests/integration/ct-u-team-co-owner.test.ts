/**
 * [CT-U] CF3b (M23): la lista del equipo de Configuración → Usuarios (`listTeamMembersInTx`, lib/invitations-read.ts)
 * trae «Co-titular» (`Membership.grantCoOwner`) y la matrícula de la PERSONA (`UserProfile.license*`).
 *
 *   [CT-U-L1] El Titular principal ve `grantCoOwner` y la matrícula de los Profesionales que aceptaron (MN, MP con
 *             provincia, null si no la cargaron). No viaja en la fila del Titular, del Administrador/a ni de un
 *             Profesional con la membresía sin aceptar (es la única lectura de la matrícula ajena).
 *   [CT-U-L2] El co-titular (y cualquiera que no sea el principal) recibe `grantCoOwner` pero NUNCA `license`.
 *   [CT-U-L3] 0 sentencias más: la matrícula va en el mismo select (presupuesto de /configuracion,
 *             `pf2-config-budget`). Mismo número de sentencias para el principal y para el co-titular.
 *
 * Símbolo real, contra el Docker local con los dos roles (`test:integration` = kinesoft_app con RLS, `:owner` = BYPASSRLS
 * como prod): `runWithRls` + `listTeamMembersInTx`. Los datos se cargan con el cliente owner (fixture), no por la app.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { listTeamMembersInTx } from "@/lib/invitations-read";
import { measure } from "@/tests/helpers/query-counter";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CT-U] equipo de Usuarios con «Co-titular» y matrícula", () => {
  let db: PrismaClient;
  let t: EphemeralTenant;
  let co: { userId: string };
  let mn: { userId: string };
  let none: { userId: string };
  let pendingPro: { userId: string };
  let admin: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    t = await createEphemeralTenant(db);
    co = await addPractitioner(db, t);
    mn = await addPractitioner(db, t);
    none = await addPractitioner(db, t);
    pendingPro = await addPractitioner(db, t);
    admin = await addStaff(db, t, "ADMIN", { grantSettings: true });
    await db.membership.update({ where: { userId_tenantId: { userId: co.userId, tenantId: t.tenantId } }, data: { grantCoOwner: true } });
    await db.membership.update({ where: { userId_tenantId: { userId: pendingPro.userId, tenantId: t.tenantId } }, data: { acceptedAt: null } });
    // Matrícula de la persona (M23). `licenseUpdatedAt` la pone el trigger de la base.
    const lic = (userId: string, kind: string, number: string, jur: string | null) =>
      db.$executeRaw`UPDATE "UserProfile" SET "licenseKind" = ${kind}, "licenseNumber" = ${number}, "licenseJurisdiction" = ${jur} WHERE id = ${userId}`;
    await lic(co.userId, "MP", "4567", "X");
    await lic(mn.userId, "MN", "12345", null);
    await lic(pendingPro.userId, "MN", "999", null);
    await lic(t.userId, "MN", "1", null);
    await lic(admin.userId, "MN", "2", null);
  });

  afterAll(async () => {
    await t?.cleanup();
    await db?.$disconnect();
  });

  const list = (viewerUserId: string) => runWithRls(t.tenantId, (tx) => listTeamMembersInTx(tx, t.tenantId, viewerUserId));
  const byUser = <R extends { userId: string }>(rows: R[], userId: string): R => {
    const r = rows.find((x) => x.userId === userId);
    if (!r) throw new Error(`sin fila para ${userId}`);
    return r;
  };

  it("[CT-U-L1] el Titular principal ve «Co-titular» y la matrícula de los profesionales que aceptaron", async () => {
    const rows = await list(t.userId);
    expect(byUser(rows, co.userId)).toMatchObject({ grantCoOwner: true, license: { kind: "MP", number: "4567", jurisdiction: "X" } });
    expect(byUser(rows, mn.userId)).toMatchObject({ grantCoOwner: false, license: { kind: "MN", number: "12345", jurisdiction: null } });
    expect(byUser(rows, none.userId)).toMatchObject({ grantCoOwner: false, license: null });
    // Sin aceptar, el Titular y el Administrador/a: la clave no viaja.
    for (const id of [pendingPro.userId, t.userId, admin.userId]) expect(byUser(rows, id)).not.toHaveProperty("license");
    expect(byUser(rows, t.userId).grantCoOwner).toBe(false);
  });

  it("[CT-U-L2] el co-titular y el Administrador/a reciben «Co-titular» pero nunca la matrícula", async () => {
    for (const viewer of [co.userId, admin.userId]) {
      const rows = await list(viewer);
      expect(byUser(rows, co.userId).grantCoOwner).toBe(true);
      for (const r of rows) expect(r).not.toHaveProperty("license");
    }
  });

  it("[CT-U-L3] la matrícula no suma sentencias (mismo select) y cuesta lo mismo para cualquiera que mire", async () => {
    const principal = await measure(() => list(t.userId));
    const coOwner = await measure(() => list(co.userId));
    console.info(`[CT-U] listTeamMembersInTx: ${principal.m.statements} sentencias (principal) · ${coOwner.m.statements} (co-titular)`);
    expect(principal.m.statements).toBe(coOwner.m.statements);
    // Las mismas 4 de antes de CT-U (medido el 05-nov con el Docker local): las membresías, su usuario y su profesional
    // (los `include` de Prisma), el último link de contraseña. Las columnas de M23 viajan en el select del usuario.
    expect(principal.m.statements).toBe(4);
  });
});
