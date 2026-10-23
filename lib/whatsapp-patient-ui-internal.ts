import "server-only";

/**
 * WA-U3 (T6, brief §26.5) · ¿El consultorio manda avisos por WhatsApp? Flag `whatsappActive` de las pantallas del
 * paciente (alta, «Editar paciente», compartir ficha).
 *
 * Misma regla que el turnero (`turneroWhatsAppActive`, lib/public-booking-internal.ts) y la agenda
 * (`agendaWhatsAppInTx`): modo ≠ off, cuenta ACTIVE y en el MISMO modo que el env (una cuenta `fake` con
 * `WHATSAPP_MODE=sandbox` no manda). No se importa la del turnero porque `public-booking-internal` arrastra el ciclo
 * con `lib/public-booking` y el motor de reservas públicas: las páginas de pacientes no tienen por qué cargarlo.
 *
 *   - Con `off` corta ANTES de leer nada: 0 sentencias (regla de T6: el modo apagado no agrega queries).
 *   - La cuenta sale de `getLiveAccountCached` (tag `whatsappAccount(tenantId)`): en caliente 0 sentencias.
 *   - Si la lectura falla, false: la ficha se carga igual, sin la casilla.
 */
import { whatsappMode, type WhatsappMode } from "@/lib/env";
import { getLiveAccountCached } from "@/lib/whatsapp/account-internal";
import { logger } from "@/lib/logger";

export async function tenantWhatsAppActive(tenantId: string, mode: WhatsappMode = whatsappMode()): Promise<boolean> {
  if (mode === "off") return false;
  try {
    const a = await getLiveAccountCached(tenantId);
    return !!a && a.status === "ACTIVE" && a.mode === mode;
  } catch (e) {
    logger.warn("patients.whatsapp_account_failed", { tenantId, err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}
