/**
 * HD-7: `ensureAccessToken` (vía `withAccountToken`) refresca, gana el CAS y llama a `restoreActiveAfterRefresh` (TP-ZF1
 * B5). Eso es best effort (los tokens ya quedaron guardados), pero un `.catch(() => {})` mudo dejaba la cuenta en
 * REAUTH_REQUIRED sin que nada lo contara. Ahora se loguea `mp_connect.refresh.restore_active_failed` con el id y el
 * NOMBRE del error (nunca el mensaje: puede traer datos de la query), y el cobro sigue con el token nuevo.
 *
 * Se mockea lo externo (DB service, MP y el módulo de cuentas); el cliente y el secret-box son los reales.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { findFirst, updateMany, refreshTokens, restoreActiveAfterRefresh } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  updateMany: vi.fn(),
  refreshTokens: vi.fn(),
  restoreActiveAfterRefresh: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prismaService: { mpCredential: { findFirst, updateMany } } }));
vi.mock("@/lib/mp-connect/oauth-client", () => ({ refreshTokens }));
vi.mock("@/lib/mp-connect/accounts-internal", () => ({
  restoreActiveAfterRefresh,
  markAccountReauthRequired: vi.fn(),
}));

import { withAccountToken, type MpAccountRef } from "@/lib/mp-connect/account-client";
import { mpCredentialAad, sealSecret } from "@/lib/secret-box";
import { logger } from "@/lib/logger";

const ACCOUNT: MpAccountRef = {
  id: "acc-hd7",
  tenantId: "tenant-hd7",
  kind: "PRACTITIONER",
  status: "ACTIVE",
  mpUserId: "mp-user-1",
  webhookRef: "ref-hd7",
};

function arrangeExpiringCredential() {
  findFirst.mockResolvedValue({
    id: "cred-1",
    accessTokenBox: sealSecret("old-access", mpCredentialAad(ACCOUNT.id, "accessToken")),
    refreshTokenBox: sealSecret("old-refresh", mpCredentialAad(ACCOUNT.id, "refreshToken")),
    // Vence en 1 minuto: menos que el margen de 5 → refresca.
    accessExpiresAt: new Date(Date.now() + 60_000),
    version: 3,
  });
  refreshTokens.mockResolvedValue({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 3600, userId: "mp-user-1" });
  updateMany.mockResolvedValue({ count: 1 });
}

afterEach(() => {
  vi.restoreAllMocks();
  findFirst.mockReset();
  updateMany.mockReset();
  refreshTokens.mockReset();
  restoreActiveAfterRefresh.mockReset();
});

describe("[HD-7] account-client · restore tras ganar el CAS", () => {
  it("[HD-7] si restoreActiveAfterRefresh falla, se loguea restore_active_failed con accountId y el nombre del error, y el token nuevo se usa igual", async () => {
    arrangeExpiringCredential();
    class PrismaClientKnownRequestError extends Error {
      name = "PrismaClientKnownRequestError";
    }
    restoreActiveAfterRefresh.mockRejectedValue(new PrismaClientKnownRequestError("detalle con datos que no salen"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const out = await withAccountToken(ACCOUNT, async (t) => t);

    expect(out).toBe("new-access");
    expect(restoreActiveAfterRefresh).toHaveBeenCalledWith({ tenantId: ACCOUNT.tenantId, accountId: ACCOUNT.id, credentialVersion: 4 });
    expect(warn).toHaveBeenCalledWith("mp_connect.refresh.restore_active_failed", {
      accountId: ACCOUNT.id,
      error: "PrismaClientKnownRequestError",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/detalle con datos|new-access|new-refresh/);
  });

  it("[HD-7] si el restore anda, no hay aviso", async () => {
    arrangeExpiringCredential();
    restoreActiveAfterRefresh.mockResolvedValue({ restored: true });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    expect(await withAccountToken(ACCOUNT, async (t) => t)).toBe("new-access");
    expect(warn).not.toHaveBeenCalledWith("mp_connect.refresh.restore_active_failed", expect.anything());
  });
});
