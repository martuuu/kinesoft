"use client";

import { createContext } from "react";
import { updateAgendaViewPrefs } from "@/lib/preferences";
import type { SalaLocationScope } from "@/lib/sala-location-filter";

/**
 * [CF2 · D-CF2-5] Contexto de sede de /sala: lo provee `SalaClient` (first load) y lo leen los headers de las caras
 * (`sala-location.tsx`, en sus chunks). Va aparte del selector a propósito: si `SalaClient` importara
 * `sala-location.tsx`, el `<select>` y el link viajarían en el JS inicial de /sala (meta del brief: ≤ +0,5 kB) aunque
 * solo los dibujan las caras.
 *
 * La sede es la MISMA preferencia que la agenda (`agendaPrefs.locationId`): elegirla acá cambia la de la agenda y al
 * revés. Se guarda en silencio (sin toast ni rollback): es preferencia de pantalla y el filtro ya se aplicó; si el
 * guardado falla, la próxima visita arranca con la anterior y nada más.
 */
export type SalaLocationValue = SalaLocationScope & { setLocationId: (id: string | null) => void };

/** `null` = sin filtro (menos de 2 sedes, o sin provider: tests, demo). */
export const SalaLocationContext = createContext<SalaLocationValue | null>(null);

/** Guarda la sede en `agendaPrefs` con la action de la agenda, sin avisar ni tirar. */
export function persistSalaLocation(locationId: string | null): Promise<void> {
  return updateAgendaViewPrefs({ locationId }).then(
    () => undefined,
    () => undefined
  );
}
