import { createHmac } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { SaasPlan, SubscriptionStatus, TenantPlan } from "@prisma/client";
import { ownerClient } from "../../helpers/tenant-factory";
import { readFixture } from "./fixture";

/**
 * MPS-E (T6, X8) · helpers de `subscription.spec.ts`: la suscripción SaaS del consultorio del fixture contra el MP FALSO
 * de la PLATAFORMA (`SAAS_BILLING_MODE=mp`, `MP_CONNECT_MODE=fake`, `MP_WEBHOOK_SECRET` literal: lo fija
 * `start-server.mjs`). Nada sale del server local.
 *
 * ── Step-up (PL-D11) ──
 * «Cómo pagás», activar el débito, la baja y el cambio de plan piden `requireStepUp`, y el Titular del fixture NO tiene
 * 2FA: sin ningún método la action tira `TwoFactorSetupRequiredError` («Activá la verificación en dos pasos…») y el
 * flujo no se puede probar. No hay forma de leer un código por email en el E2E (`EMAIL_TRANSPORT=log`) ni un TOTP (el
 * GoTrue falso no hace MFA), así que se le prende lo MÍNIMO por la base local:
 *   - `UserProfile.twoFactorEmail = true` (un método prendido: deja de ser «setup»);
 *   - 5 códigos de recuperación con un valor conocido, hasheados como `lib/two-factor-internal.ts` (`recoveryHash`):
 *     HMAC-SHA256 con la clave derivada de `SUPABASE_SERVICE_ROLE_KEY` + «kinesoft:two-factor-codes:v1». En el E2E esa
 *     clave es el literal `e2e-service-key` de `start-server.mjs` (duplicado acá A PROPÓSITO: si cambia uno solo, el
 *     código «no es válido» y la spec cae en el primer paso, no en silencio).
 * Con eso la app pide la 2FA al entrar (`/verificar-acceso`) y la spec la pasa por la UI REAL con «Usar un código de
 * recuperación»: `useRecoveryCode` pone la cookie de sesión (12 h) Y la de step-up (10 min), así que las actions
 * siguientes pasan `requireStepUp` sin modal. 5 códigos (no 1): con ≤ 3 restantes la pantalla frena en «Te quedan N
 * códigos…» en vez de seguir. `restoreTwoFactor` lo deja como estaba en el `afterAll` (las specs que siguen usan el
 * mismo Titular sin 2FA).
 */
const E2E_SERVICE_ROLE_KEY = "e2e-service-key";
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Códigos de recuperación de la corrida (10 caracteres del alfabeto de `two-factor-internal`). */
export const RECOVERY_CODES = ["e2esubsaaa", "e2esubsbbb", "e2esubsccc", "e2esubsddd", "e2esubseee"] as const;

function recoveryHash(userId: string, code: string): string {
  for (const ch of code) if (!RECOVERY_ALPHABET.includes(ch)) throw new Error(`código de recuperación inválido: ${code}`);
  const key = createHmac("sha256", E2E_SERVICE_ROLE_KEY).update("kinesoft:two-factor-codes:v1").digest();
  return createHmac("sha256", key).update(`recovery.${userId}.${code}`).digest("hex");
}

export async function enableRecoveryOnlyTwoFactor(): Promise<{ twoFactorEmail: boolean; twoFactorTotp: boolean }> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    const prev = await db.userProfile.findUniqueOrThrow({ where: { id: fx.owner.id }, select: { twoFactorEmail: true, twoFactorTotp: true } });
    await db.twoFactorRecoveryCode.deleteMany({ where: { userId: fx.owner.id } });
    await db.twoFactorRecoveryCode.createMany({ data: RECOVERY_CODES.map((c) => ({ userId: fx.owner.id, codeHash: recoveryHash(fx.owner.id, c) })) });
    await db.userProfile.update({ where: { id: fx.owner.id }, data: { twoFactorEmail: true, twoFactorUpdatedAt: new Date() } });
    return prev;
  } finally {
    await db.$disconnect();
  }
}

export async function restoreTwoFactor(prev: { twoFactorEmail: boolean; twoFactorTotp: boolean }): Promise<void> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    await db.userProfile.update({ where: { id: fx.owner.id }, data: prev });
    await db.twoFactorRecoveryCode.deleteMany({ where: { userId: fx.owner.id } });
    await db.twoFactorChallenge.deleteMany({ where: { userId: fx.owner.id } });
  } finally {
    await db.$disconnect();
  }
}

/** `/verificar-acceso` (la manda el layout de la app con `?next=`): «Usar un código de recuperación» → «Entrar». */
export async function passTwoFactorWithRecovery(page: Page, code: string): Promise<void> {
  await page.waitForURL(/\/verificar-acceso/);
  await page.getByRole("button", { name: "Usar un código de recuperación" }).click();
  await page.getByLabel("Código de recuperación").fill(code);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/verificar-acceso"));
}

// ── Suscripción y cargos de la corrida (canal owner del Docker local) ──────────────────────────────────────────────

type TenantSnapshot = { saasPlan: SaasPlan; plan: TenantPlan; subscriptionStatus: SubscriptionStatus; trialEndsAt: Date | null };

export async function snapshotTenant(): Promise<TenantSnapshot> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    return await db.tenant.findUniqueOrThrow({
      where: { id: fx.tenantId },
      select: { saasPlan: true, plan: true, subscriptionStatus: true, trialEndsAt: true },
    });
  } finally {
    await db.$disconnect();
  }
}

/**
 * Borra la plata de la corrida (ajustes → pagos → cargos → suscripción, el orden de FK de `deleteTenantDeep`) y deja
 * el tenant con el plan y el estado de antes. `SaasAdjustment` es solo inserción (trigger `saas_adjustment_guard`,
 * también para el owner): se borra en modo réplica, como la factory.
 */
export async function wipeSubscription(restore?: TenantSnapshot): Promise<void> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRaw`DELETE FROM "SaasAdjustment" WHERE "tenantId" = ${fx.tenantId}`,
    ]);
    await db.saasPayment.deleteMany({ where: { tenantId: fx.tenantId } });
    await db.saasCharge.deleteMany({ where: { tenantId: fx.tenantId } });
    await db.saasSubscription.deleteMany({ where: { tenantId: fx.tenantId } });
    if (restore) await db.tenant.update({ where: { id: fx.tenantId }, data: restore });
  } finally {
    await db.$disconnect();
  }
}

/** Ya en la pantalla: el cargo `chargeId` de la lista «Cargos» con su estado (`data-charge-status`). */
export async function expectChargeStatus(page: Page, chargeId: string, label: string): Promise<void> {
  await expect(page.locator(`[data-charge="${chargeId}"]`)).toHaveAttribute("data-charge-status", label);
}
