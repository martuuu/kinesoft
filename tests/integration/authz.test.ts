/**
 * `lib/authz.ts` contra la DB real (B1.7 AUTHZ): el rol sale de Membership
 * (el Actor no lo lleva) y `requireTenantAdmin` reemplaza el chequeo
 * OWNER/ADMIN copiado. Se llama a los símbolos reales con el getActor real
 * (tests/helpers/actor.ts); se afirma el efecto observable: la action de
 * tenant-settings que lo adopta escribe o no escribe la fila.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getCapabilities, getMembershipRole, requireCapability, requireTenantAdmin } from "@/lib/authz";
import { updateTenantBasics } from "@/lib/tenant-settings";
import { getActor, ForbiddenError, UnauthenticatedError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("authz · rol desde Membership", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let pracUser: string;
  let assistantUser: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    pracUser = (await addPractitioner(db, A, "PRACTITIONER")).userId;
    assistantUser = (await addPractitioner(db, A, "ASSISTANT")).userId;
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("OWNER: rol OWNER, todas las capabilities, requireTenantAdmin devuelve el actor", async () => {
    asUser(A.userId);
    expect(await getMembershipRole(await getActor())).toBe("OWNER");
    const caps = await getCapabilities();
    expect(caps.has("tenant.admin")).toBe(true);
    expect(caps.has("clinical.read")).toBe(true);
    const actor = await requireTenantAdmin();
    expect(actor.tenantId).toBe(A.tenantId);
    expect(actor.userId).toBe(A.userId);
  });

  it("PRACTITIONER: sin tenant.admin; requireTenantAdmin tira ForbiddenError con el mensaje de siempre", async () => {
    asUser(pracUser);
    expect(await getMembershipRole(await getActor())).toBe("PRACTITIONER");
    const caps = await getCapabilities();
    // Planes E1 (P0-Ck): PRACTITIONER suma plans.manage/schedule/authorize; NO agenda.operateAll.
    expect([...caps].sort()).toEqual([
      "agenda.manageOwnBlocks",
      "agenda.reception",
      "agenda.viewAll",
      "clinical.read",
      "plans.authorize",
      "plans.manage",
      "plans.schedule",
    ]);
    const err = await requireTenantAdmin().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Solo OWNER/ADMIN pueden cambiar la configuración del consultorio.");
  });

  it("ASSISTANT: sin clinical.read; requireCapability('clinical.read') rechaza", async () => {
    asUser(assistantUser);
    const caps = await getCapabilities();
    expect(caps.has("clinical.read")).toBe(false);
    expect(caps.has("agenda.manageBlocks")).toBe(true);
    // Planes E1: la Secretaria opera todos los turnos y agenda/autoriza en planes, sin plans.manage.
    expect(caps.has("agenda.operateAll")).toBe(true);
    expect(caps.has("plans.schedule")).toBe(true);
    expect(caps.has("plans.authorize")).toBe(true);
    expect(caps.has("plans.manage")).toBe(false);
    await expect(requireCapability("clinical.read")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("tenant-settings adoptó requireTenantAdmin: PRACTITIONER no escribe, OWNER sí", async () => {
    asUser(pracUser);
    await expect(updateTenantBasics({ name: "Hackeado" })).rejects.toThrow(
      "Solo OWNER/ADMIN pueden cambiar la configuración del consultorio."
    );
    expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).name).not.toBe("Hackeado");

    asUser(A.userId);
    const r = await updateTenantBasics({ name: "Consultorio Renombrado" });
    expect(r.ok).toBe(true);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).name).toBe("Consultorio Renombrado");
  });

  it("membresía borrada → el PRÓXIMO request no arma Actor (falla cerrado)", async () => {
    // PL-1e/1b (H1b-T1): el Actor trae su `membership` de la foto del request (sin query extra), así que un Actor
    // ya armado conserva su acceso hasta que termina ese request. La barrera es el request siguiente: sin fila
    // no hay Actor (y sin Actor no hay capacidades).
    asUser(pracUser);
    await getActor();
    await db.membership.delete({ where: { userId_tenantId: { userId: pracUser, tenantId: A.tenantId } } });
    try {
      asUser(pracUser);
      const err = await getActor().catch((e) => e);
      expect(err).toBeInstanceOf(UnauthenticatedError);
      // `getActor` expone `no_session` para todo lo que no es 2FA (el `no_membership` fino vive en la foto).
      expect((err as UnauthenticatedError).reason).toBe("no_session");
    } finally {
      // Se restaura para que el cleanup (que recorre memberships) borre su UserProfile.
      await db.membership.create({ data: { userId: pracUser, tenantId: A.tenantId, role: "PRACTITIONER", acceptedAt: new Date() } });
    }
  });
});
