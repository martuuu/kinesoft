/**
 * Planes S07i (P0.1) — las dos piezas de P0-Ck que los writes de Planes usan
 * para quedar atómicos, contra Postgres real y con los dos roles
 * (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS = prod):
 *
 *   - `runWithRls(t, fn, { timeout })`: al vencer, Prisma aborta la tx con
 *     P2028 y lo escrito adentro NO queda (el commit de un plan corre con
 *     `{ timeout: 15000, maxWait: 5000 }`; si se pasa, no puede quedar medio
 *     plan escrito).
 *   - `auditInTx`: el evento existe si y solo si el write existe. Si la tx se
 *     revierte (throw del caller, o timeout), el audit se va con ella; a
 *     diferencia de `audit()`, que escribe por otra conexión y quedaría.
 *
 * Se afirma el efecto observable: la fila de AuditEvent está o no está,
 * leída por una conexión owner aparte.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("runWithRls opts + auditInTx (S07i)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let bypass: boolean;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    bypass = await appRoleBypassesRls();
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  const countAction = (tenantId: string, action: string) =>
    db.auditEvent.count({ where: { tenantId, action } });

  it("runWithRls {timeout} corta con P2028 y revierte lo escrito (audit incluido)", async () => {
    const action = `test.s07i.timeout.${uniqueSuffix()}`;
    let caught: unknown;
    try {
      await runWithRls(
        A.tenantId,
        async (tx) => {
          await auditInTx(tx, { tenantId: A.tenantId, actorId: A.userId, action, entity: "Test" });
          // Más que el timeout: la tx vence mientras duerme.
          await tx.$executeRaw`SELECT pg_sleep(1.5)`;
          return "no-deberia-llegar";
        },
        { timeout: 300 }
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2028");
    // Dar tiempo a que el pg_sleep termine del lado del server antes de mirar:
    // si la tx hubiera commiteado igual, la fila aparecería acá.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await countAction(A.tenantId, action)).toBe(0);
  });

  it("runWithRls con timeout holgado commitea normal (las opts no cambian el camino feliz)", async () => {
    const action = `test.s07i.ok.${uniqueSuffix()}`;
    const r = await runWithRls(
      A.tenantId,
      async (tx) => {
        await auditInTx(tx, { tenantId: A.tenantId, actorId: A.userId, action, entity: "Test", entityId: "x1" });
        return "ok" as const;
      },
      { timeout: 15_000, maxWait: 5_000 }
    );
    expect(r).toBe("ok");
    const rows = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: A.userId, entity: "Test", entityId: "x1" });
  });

  it("auditInTx se revierte con la tx (throw del caller → sin evento)", async () => {
    const action = `test.s07i.rollback.${uniqueSuffix()}`;
    await expect(
      runWithRls(A.tenantId, async (tx) => {
        await auditInTx(tx, { tenantId: A.tenantId, actorId: A.userId, action, entity: "Test" });
        // Visible DENTRO de la tx (misma conexión)…
        expect(await tx.auditEvent.count({ where: { tenantId: A.tenantId, action } })).toBe(1);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // …y no queda después del rollback.
    expect(await countAction(A.tenantId, action)).toBe(0);
  });

  it("auditInTx NO traga errores: un audit inválido aborta la tx entera", async () => {
    const action = `test.s07i.fk.${uniqueSuffix()}`;
    await expect(
      runWithRls(A.tenantId, async (tx) => {
        await auditInTx(tx, { tenantId: A.tenantId, action, entity: "Test", entityId: "antes" });
        // tenantId inexistente: FK (owner) o policy (kinesoft_app) → falla.
        await auditInTx(tx, { tenantId: `no-existe-${uniqueSuffix()}`, action, entity: "Test" });
      })
    ).rejects.toBeTruthy();
    expect(await countAction(A.tenantId, action)).toBe(0);
  });

  it("auditInTx con el tenantId de OTRO tenant: RLS lo frena con kinesoft_app; con owner pasa (la barrera es el código)", async () => {
    const action = `test.s07i.cross.${uniqueSuffix()}`;
    const attempt = runWithRls(A.tenantId, async (tx) => {
      await auditInTx(tx, { tenantId: B.tenantId, action, entity: "Test" });
    });
    if (bypass) {
      // Prod hoy (BYPASSRLS): la policy no corre. Por eso cada write de Planes
      // arma los params del audit con el tenantId del actor, nunca del input.
      await attempt;
      expect(await countAction(B.tenantId, action)).toBe(1);
    } else {
      await expect(attempt).rejects.toBeTruthy();
      expect(await countAction(B.tenantId, action)).toBe(0);
    }
  });
});
