/**
 * WA-U4 (T6, §26.5) · «Te vamos a avisar por WhatsApp» cruzando la navegación dura del turnero.
 *
 * El wizard sale con `location.assign` (a `/booking/<id>/ok` o a Mercado Pago) y la confirmación no recibe el resultado
 * del submit; `PublicBookingStatus` tampoco lo trae (y no debe: el status es público por id y el turnero no puede
 * revelar qué consintió una ficha, contrato de WA-S8). Así que el wizard deja una marca en `sessionStorage` por turno:
 * sobrevive la ida y vuelta de Mercado Pago en la misma pestaña (su back_url no lleva nuestros parámetros).
 * Descartado `?wa=1` en el link: falsificable y cambiaba el destino que fija el test de TP-0. Sin storage (Safari
 * privado, bloqueado) la línea no sale: fallar callando es el lado seguro (nunca prometer avisos que no van a salir).
 * Módulo mínimo y sin imports de valor: lo cargan el first load del turnero (tope 115 kB) y `/booking/[id]/*`.
 */
import type { TurneroWaConsentOutcome } from "@/lib/public-booking-types";

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export const waSavedKey = (bookingId: string) => `kinesoft:wa-saved:${bookingId}`;

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    // Safari privado / cookies bloqueadas: el acceso mismo tira.
    return null;
  }
}

/** Solo `saved` (el consentimiento quedó anclado al celular tipeado). `invalid_phone`/`unavailable`: nada. */
export function rememberWaSaved(
  bookingId: string,
  outcome: TurneroWaConsentOutcome | undefined,
  storage: Storage | null = sessionStore(),
): void {
  if (outcome !== "saved" || !storage) return;
  try {
    storage.setItem(waSavedKey(bookingId), "1");
  } catch {
    // Cuota o storage bloqueado: la confirmación no dice nada (lado seguro).
  }
}

export function readWaSaved(bookingId: string, storage: Storage | null = sessionStore()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(waSavedKey(bookingId)) === "1";
  } catch {
    return false;
  }
}
