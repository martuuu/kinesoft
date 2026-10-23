import "server-only";

/**
 * WA-U3 (T6, brief §26.5) · ¿El consultorio tiene el canal de WhatsApp? Flag `whatsappActive` de las pantallas del
 * paciente (alta, «Editar paciente», compartir ficha).
 *
 * Regla común de `lib/whatsapp/active-internal.ts` (ZF2), variante `channel`: modo ≠ off, cuenta ACTIVE y en el MISMO
 * modo que el env. No exige un aviso automático prendido: compartir una ficha y el consentimiento valen aunque el
 * consultorio haya apagado los avisos de turnos. Con `off`, 0 sentencias; si la lectura falla, false.
 */
import type { WhatsappMode } from "@/lib/env";
import { tenantWhatsAppActiveFor } from "@/lib/whatsapp/active-internal";

export async function tenantWhatsAppActive(tenantId: string, mode?: WhatsappMode): Promise<boolean> {
  return tenantWhatsAppActiveFor(tenantId, "channel", { mode, logEvent: "patients.whatsapp_account_failed" });
}
