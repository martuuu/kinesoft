import { expect, test } from "@playwright/test";
import { ownerClient } from "../helpers/tenant-factory";
import { E2E_BASE_URL } from "./support/e2e-constants.mjs";
import { readFixture } from "./support/fixture";

/**
 * [TP-E] El profesional conecta SU cuenta de Mercado Pago por OAuth contra el simulador local (`MP_CONNECT_MODE=fake`,
 * start-server.mjs): «Mi Mercado Pago» → «Conectar Mercado Pago» → autorización del fake (PKCE + state firmado + cookie
 * `kine_mp_oauth`) → callback real que canjea el código contra el fake y sella los tokens → «Conectada · Simulador
 * local» → delegación de links de pago a la Secretaría y los administradores.
 *
 * Corre primero de las specs de cobro (orden alfabético con `workers: 1`); `payment-link` y `turnero-cobro` reusan la
 * cuenta, y si se corren solas la conectan con `connectFakeMpViaUi` (support/mp.ts).
 */
test("[TP-E] Mi Mercado Pago: conectar la cuenta del simulador → «Conectada · Simulador local» → delegación", async ({ page }) => {
  const fx = readFixture();
  const db = ownerClient();
  try {
    // Precondición: la corrida arranca sin cuentas (tenant efímero).
    expect(await db.mpAccount.count({ where: { tenantId: fx.tenantId } })).toBe(0);

    await page.goto("/configuracion?tab=mercado-pago");
    const panel = page.locator("[data-my-mp-panel]");
    await expect(panel.getByRole("heading", { name: "Mi Mercado Pago" })).toBeVisible();
    await expect(panel.getByText("Sin conectar", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Conectar Mercado Pago" }).click();

    // Autorización del simulador: mismo origen que la app, nunca auth.mercadopago.com.
    await page.waitForURL(/\/api\/mp\/fake\/authorization\?/);
    expect(new URL(page.url()).origin).toBe(E2E_BASE_URL);
    await expect(page.getByText("Simulador de Mercado Pago (solo desarrollo)")).toBeVisible();
    await page.getByRole("button", { name: "Autorizar como Vendedor de prueba 1" }).click();

    // Vuelta del callback: aviso una sola vez y el estado de la cuenta.
    await page.waitForURL(/\/configuracion/);
    await expect(panel.getByRole("status").filter({ hasText: "Listo: tu Mercado Pago quedó conectado." })).toBeVisible();
    const status = panel.locator('[data-mp-status="ACTIVE"]');
    await expect(status.getByText("Conectada", { exact: true })).toBeVisible();
    await expect(status.getByText("· VENDEDOR_PRUEBA_1")).toBeVisible();
    await expect(status.getByText("Simulador local", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Desconectar" })).toBeVisible();
    // El aviso `?mp=ok` se saca de la URL (recargar no lo repite).
    await expect(page).not.toHaveURL(/[?&]mp=/);

    // Efecto observable: la fila de la cuenta y la credencial sellada (nunca el token en claro).
    const account = await db.mpAccount.findFirstOrThrow({
      where: { tenantId: fx.tenantId, practitionerId: fx.practitionerId },
      select: { id: true, kind: true, status: true, mpUserId: true, mpNickname: true, liveMode: true, linksDelegated: true },
    });
    expect(account).toMatchObject({
      kind: "PRACTITIONER",
      status: "ACTIVE",
      mpUserId: "900000001",
      mpNickname: "VENDEDOR_PRUEBA_1",
      liveMode: false,
      linksDelegated: false,
    });
    const cred = await db.mpCredential.findUniqueOrThrow({ where: { mpAccountId: account.id }, select: { accessTokenBox: true, keyId: true } });
    expect(cred.keyId).toBe("dev");
    expect(cred.accessTokenBox).not.toContain("FAKE-900000001");

    // Delegación: el switch prende y queda en la base.
    const delegation = panel.getByRole("switch", {
      name: "Permitir que la Secretaría y los administradores generen links de pago a mi cuenta",
    });
    await expect(delegation).toHaveAttribute("aria-checked", "false");
    await delegation.click();
    await expect(delegation).toHaveAttribute("aria-checked", "true");
    await expect(
      panel.getByText("La Secretaría y los administradores pueden mandarles a tus pacientes links de pago que se cobran en tu cuenta.")
    ).toBeVisible();
    await expect
      .poll(async () => (await db.mpAccount.findUniqueOrThrow({ where: { id: account.id }, select: { linksDelegated: true } })).linksDelegated)
      .toBe(true);

    // Recargar: el estado sale de la base, no del cliente.
    await page.reload();
    await expect(panel.locator('[data-mp-status="ACTIVE"]').getByText("Simulador local", { exact: true })).toBeVisible();
    await expect(delegation).toHaveAttribute("aria-checked", "true");
  } finally {
    await db.$disconnect();
  }
});
