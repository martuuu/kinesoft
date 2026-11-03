"use client";

/**
 * [CF2-AD] Quién ve el tag de cobro del copago en la agenda (plan §29 D-CF2-3, brief CF2 A.2): la función dice, por
 * profesional del turno, si el viewer puede cobrarlo (`canCollectCopago`, la regla T3 del server: la Secretaria todo,
 * el profesional lo suyo). La provee `agenda-client`; `MoneyBadge` la lee cuando no le pasan `copago` explícito.
 *
 * Contexto y no prop: el badge está en la card, la Lista, la Semana y Recepción, y bajar una prop por todas esas
 * vistas tocaba media agenda. Sin provider (`null`) = el comportamiento de antes de CF2: solo la plata online.
 * Módulo aparte (no `booking-card.tsx`) para que /sala y las vistas lo importen sin arrastrar la card.
 */
import { createContext, useContext } from "react";

export const MoneyViewerContext = createContext<((practitionerId: string) => boolean) | null>(null);

/** `null` sin provider: nadie ve el tag de copago (comportamiento de antes de CF2). */
export function useMoneyViewer(): ((practitionerId: string) => boolean) | null {
  return useContext(MoneyViewerContext);
}
