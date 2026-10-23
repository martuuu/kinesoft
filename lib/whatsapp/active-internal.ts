import "server-only";
import { whatsappMode, type WhatsappMode } from "@/lib/env";
import { getLiveAccountCached, type LiveWaAccount } from "@/lib/whatsapp/account-internal";
import { logger } from "@/lib/logger";

/**
 * ZF2 (T6+T7 cierre; hallazgo de ZB + handoff de WA-U3) · La regla «el consultorio tiene WhatsApp activo», en UN lugar.
 * Antes estaba triplicada (`turneroWhatsAppActive` en public-booking-internal, `agendaWhatsAppFor` en agenda-page-loader,
 * `tenantWhatsAppActive` en whatsapp-patient-ui-internal), cada copia con su comentario «misma regla que las otras». ZB
 * encontró que el turnero prometía «te avisamos por WhatsApp» con los DOS avisos automáticos apagados: la regla común
 * no alcanzaba para esa superficie, y por eso las variantes son explícitas:
 *
 *   - `"channel"` (panel / compartir): modo ≠ off, cuenta ACTIVE y en el MISMO modo que el env (una cuenta `fake` con
 *     `WHATSAPP_MODE=sandbox` no manda: el outbox re-chequea, C-WA7). Lo usan la agenda (sección WhatsApp del drawer:
 *     el recordatorio a mano no depende del switch automático), las pantallas del paciente (casilla de consentimiento,
 *     compartir ficha) y el portal (dar el consentimiento: vale para documentos y avisos manuales).
 *   - `"notices"` (avisos automáticos): lo de `channel` Y al menos uno de `autoBookingNotice` / `autoReminder`. Es lo
 *     que promete el turnero («Quiero recibir avisos de este turno»): con los dos apagados no sale ningún aviso solo.
 *
 * Lectura: `getLiveAccountCached` (tag `whatsappAccount(tenantId)`), en caliente 0 sentencias. Con `off` corta ANTES de
 * leer (regla de T6: el modo apagado no agrega queries). Si la lectura falla, false y log sin PHI: ninguna de estas
 * superficies depende de WhatsApp para funcionar.
 */

export type WaActivePurpose = "channel" | "notices";
export type WaActiveAccount = Pick<LiveWaAccount, "status" | "mode" | "autoBookingNotice" | "autoReminder">;

/** Regla pura (unit: tests/unit/wa-zf2-active.test.ts). */
export function isWhatsAppActive(a: WaActiveAccount | null | undefined, mode: WhatsappMode, purpose: WaActivePurpose): boolean {
  if (mode === "off" || !a) return false;
  if (a.status !== "ACTIVE" || a.mode !== mode) return false;
  return purpose === "channel" ? true : a.autoBookingNotice || a.autoReminder;
}

export async function tenantWhatsAppActiveFor(
  tenantId: string,
  purpose: WaActivePurpose,
  o: { mode?: WhatsappMode; logEvent: string }
): Promise<boolean> {
  const mode = o.mode ?? whatsappMode();
  if (mode === "off") return false;
  try {
    return isWhatsAppActive(await getLiveAccountCached(tenantId), mode, purpose);
  } catch (e) {
    logger.warn(o.logEvent, { tenantId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
