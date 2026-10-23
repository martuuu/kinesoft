import "server-only";
import { normalizeArMobile } from "@/lib/phone-e164";
import type { TurneroWaConsentOutcome } from "@/lib/public-booking-types";

/**
 * WA-S8 / ZF2 · Decisiones puras del consentimiento de WhatsApp del turnero (unit: tests/unit/public-booking-wa-consent.test.ts;
 * la escritura en la tx del alta y los dos roles: tests/integration/wa-s8-turnero.test.ts).
 *
 * Por qué un módulo server aparte (ZF2, handoff de INT): vivían en `lib/public-booking-types.ts`, que importa el wizard
 * del turnero (cliente, tope de 115 kB), y `decideTurneroWaConsent` VALUE-importaba `@/lib/phone-e164`: el normalizador
 * de celulares viajaba en el first load del turnero sin que el cliente lo usara. Solo los llama `lib/public-booking.ts`.
 */

/**
 * `requested` = la casilla; `accountActive` = `whatsappNotices` recalculado en el submit. null = no se pidió (no se
 * escribe nada ni hay flag). Con `saved`, `e164` es el número que se ancla en `Patient.waPhoneE164` (WA-D17). `saved`
 * acá es «se puede guardar»: si la ficha existente no es de ese número, el alta lo baja a `not_saved`
 * (`turneroConsentFitsFicha`).
 */
export function decideTurneroWaConsent(o: {
  requested: boolean | undefined;
  accountActive: boolean;
  phone: string;
}): { outcome: "saved"; e164: string } | { outcome: Exclude<TurneroWaConsentOutcome, "saved" | "not_saved"> } | null {
  if (o.requested !== true) return null;
  if (!o.accountActive) return { outcome: "unavailable" };
  const n = normalizeArMobile(o.phone);
  return n.ok ? { outcome: "saved", e164: n.e164 } : { outcome: "invalid_phone" };
}

/**
 * ZF2 (hallazgo 2) · ¿Se puede anclar el consentimiento tipeado en la ficha que usa la reserva?
 *   - Ficha NUEVA (la creó esta misma reserva): sí, el número es el de quien la creó.
 *   - Ficha EXISTENTE (match por DNI): solo si su celular, normalizado, es el MISMO E.164 tipeado. Antes se escribía
 *     siempre con el número tipeado: un anónimo con el DNI de otro pisaba `waPhoneE164`/`waConsentAt` de esa ficha. El
 *     aviso no se desviaba (el canal quedaba `phone_changed`), pero le cortaba los avisos al paciente real y el rastro del
 *     consentimiento quedaba a nombre de alguien que no era él. Un celular cambiado lo actualiza la Secretaría o el portal.
 */
export function turneroConsentFitsFicha(o: { createdHere: boolean; fichaPhone: string | null; e164: string }): boolean {
  if (o.createdHere) return true;
  const n = normalizeArMobile(o.fichaPhone);
  return n.ok && n.e164 === o.e164;
}
