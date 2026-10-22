"use server";

/**
 * Página pública del link de pago `/pagar/[token]` (T5, contrato C-TP9 del plan §25.7). **Stub de TP-K2 (tanda T5c):**
 * firma congelada para que la página (TP-3i) compile en paralelo. TP-2d la implementa: sin Actor, rate limit
 * 60/min/IP, zod `^[A-Za-z0-9_-]{22}$`, `prismaService`, consultorio suspendido → `unavailable`, y **el GET nunca
 * escribe** (los antivirus de mail abren los links).
 *
 * El stub devuelve `null` (= «inexistente» en el contrato): no lee la base, así que no hay link que mostrar, y una
 * página que llegue antes que el server cae en el estado inexistente en vez de inventar uno.
 */
import type { PublicPaymentLink } from "@/lib/payment-links-types";

export async function getPublicPaymentLink(token: string): Promise<PublicPaymentLink | null> {
  void token;
  return null;
}
