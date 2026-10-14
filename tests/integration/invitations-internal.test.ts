/**
 * C-IAM5 · `findInvitationByRawToken` (IAM-2): token vigente, token anterior reenviado, anulada, vencida y token
 * con forma inválida. Corre en los dos roles; la función va por el canal service (sin GUC).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { prismaService } from "@/lib/db";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { findInvitationByRawToken } from "@/lib/invitations-internal";
import { createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const raw = () => randomBytes(24).toString("base64url");

describe.skipIf(!RUN)("C-IAM5 findInvitationByRawToken", () => {
  let T: EphemeralTenant;
  beforeAll(async () => {
    T = await createEphemeralTenant(ownerClient());
  });
  afterAll(async () => {
    await T?.cleanup();
  });

  async function invite(over: { token: string; priorTokens?: string[]; expiresAt?: Date; revokedAt?: Date | null; acceptedAt?: Date | null }) {
    return prismaService.invitation.create({
      data: {
        tenantId: T.tenantId,
        email: `inv-${randomBytes(4).toString("hex")}@example.com`,
        firstName: "Ana",
        lastName: "Pérez",
        role: "ASSISTANT",
        invitedById: T.userId,
        expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000),
        token: over.token,
        priorTokens: over.priorTokens ?? [],
        revokedAt: over.revokedAt ?? null,
        acceptedAt: over.acceptedAt ?? null,
      },
    });
  }

  it("encuentra por el token vigente y no devuelve el hash", async () => {
    const t = raw();
    const inv = await invite({ token: hashInviteToken(t) });
    const r = await findInvitationByRawToken(t);
    expect(r?.id).toBe(inv.id);
    expect(r?.status).toBe("pending");
    expect(r?.matchedPrior).toBe(false);
    expect(r?.tenant.id).toBe(T.tenantId);
    expect(JSON.stringify(r)).not.toContain(hashInviteToken(t));
  });

  it("un link anterior reenviado sigue valiendo (priorTokens)", async () => {
    const viejo = raw();
    const nuevo = raw();
    const inv = await invite({ token: hashInviteToken(nuevo), priorTokens: [hashInviteToken(viejo)] });
    const r = await findInvitationByRawToken(viejo);
    expect(r?.id).toBe(inv.id);
    expect(r?.matchedPrior).toBe(true);
  });

  it("estados: anulada, aceptada y vencida", async () => {
    const a = raw();
    const b = raw();
    const c = raw();
    await invite({ token: hashInviteToken(a), revokedAt: new Date() });
    await invite({ token: hashInviteToken(b), acceptedAt: new Date() });
    await invite({ token: hashInviteToken(c), expiresAt: new Date(Date.now() - 1000) });
    expect((await findInvitationByRawToken(a))?.status).toBe("revoked");
    expect((await findInvitationByRawToken(b))?.status).toBe("accepted");
    expect((await findInvitationByRawToken(c))?.status).toBe("expired");
  });

  it("token desconocido o con forma inválida → null", async () => {
    expect(await findInvitationByRawToken(raw())).toBeNull();
    expect(await findInvitationByRawToken("x")).toBeNull();
    expect(await findInvitationByRawToken("../../etc/passwd")).toBeNull();
  });
});
