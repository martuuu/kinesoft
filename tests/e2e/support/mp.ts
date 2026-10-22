import { expect, type Page } from "@playwright/test";
import { ownerClient } from "../../helpers/tenant-factory";
import type { PaymentPolicyInput } from "../../../lib/booking-payment-policy-types";
import { readFixture } from "./fixture";

/**
 * TP-E (T5) · helpers de las specs de cobro online contra el Mercado Pago FALSO (`MP_CONNECT_MODE=fake`, lo fija
 * `start-server.mjs`). Nada de esto habla con Mercado Pago real ni con el sandbox: el simulador vive en el MISMO proceso
 * del `next start` (`/api/mp/fake/*`, `lib/mp-connect/fake-mp.ts`).
 *
 * Por qué la cuenta se conecta por la UI (OAuth del simulador) y no con `connectFakeAccount` de
 * `tests/helpers/mp-connect-fake.ts`: el store del fake (tokens, preferencias, pagos) está en memoria del server. Una
 * credencial sellada desde el proceso de Playwright tendría tokens que el fake del server no conoce, y la primera
 * preferencia fallaría con 401. Por la UI, los tokens los emite el fake del server y el callback los sella con la
 * clave dev de ESE proceso: es el camino de prod.
 */

/** ¿El profesional del fixture tiene una cuenta ACTIVE? (la lee el canal owner del Docker local). */
async function activeAccountOf(practitionerId: string, tenantId: string) {
  const db = ownerClient();
  try {
    return await db.mpAccount.findFirst({
      where: { tenantId, practitionerId, status: "ACTIVE" },
      select: { id: true, mpNickname: true, linksDelegated: true, liveMode: true },
    });
  } finally {
    await db.$disconnect();
  }
}

/**
 * Conecta la cuenta de Mercado Pago del profesional (el OWNER del fixture) con el «Vendedor de prueba 1» del
 * simulador, por la UI real: Configuración → «Mi Mercado Pago» → «Conectar Mercado Pago» → autorización del fake →
 * callback → `?mp=ok`. Si ya está conectada (otra spec de la corrida lo hizo), no hace nada.
 */
export async function connectFakeMpViaUi(page: Page): Promise<void> {
  const fx = readFixture();
  if (await activeAccountOf(fx.practitionerId, fx.tenantId)) return;
  await page.goto("/configuracion?tab=mercado-pago");
  const panel = page.locator("[data-my-mp-panel]");
  await expect(panel.getByText("Sin conectar", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Conectar Mercado Pago" }).click();
  // Autorización del simulador (mismo origen: `${APP_URL}/api/mp/fake/authorization`).
  await page.waitForURL(/\/api\/mp\/fake\/authorization/);
  await page.getByRole("button", { name: "Autorizar como Vendedor de prueba 1" }).click();
  await page.waitForURL(/\/configuracion/);
  await expect(page.getByText("Listo: tu Mercado Pago quedó conectado.")).toBeVisible();
}

/** Política de cobro del turnero escrita directo en la base local (dato de la corrida, como el global-setup). */
export async function setPaymentPolicy(policy: Partial<PaymentPolicyInput> & Pick<PaymentPolicyInput, "mode">): Promise<void> {
  const fx = readFixture();
  const data = {
    mode: policy.mode,
    chargeKind: policy.chargeKind ?? "COPAGO",
    fixedCents: policy.fixedCents ?? null,
    percentBps: policy.percentBps ?? null,
    useClinicAccount: policy.useClinicAccount ?? false,
    cancellationNote: policy.cancellationNote ?? null,
    updatedByUserId: fx.owner.id,
  };
  const db = ownerClient();
  try {
    await db.bookingPaymentPolicy.upsert({ where: { tenantId: fx.tenantId }, create: { tenantId: fx.tenantId, ...data }, update: data });
  } finally {
    await db.$disconnect();
  }
}

/**
 * Copago de «Particular» del consultorio (lo pone el OWNER en la vida real; `tenant-bootstrap` y la factory lo crean en
 * $ 0). Con $ 0, la precedencia de la agenda (lib/copago.ts, AUDIT §5.5) resuelve el copago de un paciente particular
 * en $ 0 y el turnero NO cobra nada aunque el wizard cotice el precio del servicio (hallazgo de TP-E, ver el reporte).
 */
export async function setParticularCopago(cents: number): Promise<void> {
  const fx = readFixture();
  const db = ownerClient();
  try {
    await db.insurer.updateMany({ where: { tenantId: fx.tenantId, isParticular: true }, data: { copagoCents: cents } });
  } finally {
    await db.$disconnect();
  }
}

/**
 * En el checkout del simulador (`/api/mp/fake/checkout/<preferencia>`), aprieta un resultado. El fake POSTea el
 * webhook firmado a la ruta real y redirige a la `back_url` que corresponda (salvo el reintegro, que muestra el
 * resultado del webhook).
 */
export async function simulateOnFakeCheckout(
  page: Page,
  outcome: "Simular pago aprobado" | "Simular pago rechazado" | "Simular reintegro"
): Promise<void> {
  await expect(page).toHaveURL(/\/api\/mp\/fake\/checkout\//);
  await page.getByRole("button", { name: outcome }).click();
}
