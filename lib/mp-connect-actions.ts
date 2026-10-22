"use server";

/**
 * Cuentas de Mercado Pago del vendedor (T5, contrato C-TP4 del plan §25.4). **Stub de TP-K2 (tanda T5c):** las firmas
 * están congeladas para que la UI (TP-3a/3b) y los tests compilen en paralelo con el server (T5d). TP-2b las implementa:
 * `getActor()` → zod → `where: { tenantId }` a mano → `runWithRls`, la cookie `kine_mp_oauth` y el step-up de la cuenta
 * del consultorio. Hasta entonces devuelven error **sin tocar la base ni la red**: un stub que «funcionara a medias»
 * podría dejar una cuenta conectada sin credencial sellada.
 *
 * Los tests que TP-2b da vuelta: `tests/integration/tp2o-mp-connect.test.ts` (`it.fails("[TP-2o] …")`).
 */
import type { ActionResult } from "@/lib/validation";
import type { MpAccountView, OnlinePaymentsSettingsView } from "@/lib/mp-connect-types";

// Mismo texto en los cinco stubs de T5c: la UI que llegue antes que el server lo muestra tal cual.
const NOT_YET = "todavía no disponible";

export async function startMpConnect(input: { target: "own" | "clinic" }): Promise<ActionResult<{ url: string }>> {
  void input;
  return { ok: false, error: NOT_YET };
}

export async function disconnectMpAccount(input: {
  target: "own" | "clinic";
}): Promise<ActionResult<{ cancelledLinks: number }>> {
  void input;
  return { ok: false, error: NOT_YET };
}

export async function setMpLinksDelegated(input: {
  target: "own" | "clinic";
  delegated: boolean;
}): Promise<ActionResult> {
  void input;
  return { ok: false, error: NOT_YET };
}

/** Contrato: `null` = el actor no tiene profesional propio (no hay «Mi Mercado Pago»). El stub no lee la base. */
export async function getMyMpAccount(): Promise<MpAccountView | null> {
  return null;
}

/** Contrato: `null` = sin `tenant.sensitive` (la pestaña «Cobros online» no existe para ese actor). */
export async function getOnlinePaymentsSettings(): Promise<OnlinePaymentsSettingsView | null> {
  return null;
}
