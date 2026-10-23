"use server";

/**
 * TV (T7, §26.4 C-TV): actions del staff para las pantallas de la sala (drawer «Pantallas» de /sala).
 *
 * STUB de TV-1k (ola X1): publica las firmas para que la UI (TV-2w1/TV-2w2) compile en paralelo. Lo implementa TV-2s
 * (X2) con el gate de C-TV en todas: `agenda.operateAll` + `assertModule("salaEspera")` + `runWithRls` +
 * `where: { tenantId }`, sede validada contra el tenant, `auditInTx` en todas y 20 códigos por hora por usuario.
 *   - `createReceptionDisplay`: tope `MAX_LIVE_DISPLAYS` (10) y nombre único entre las vivas; devuelve el primer código.
 *   - `updateReceptionDisplay`: CAS con `expectedUpdatedAt`; `mediaUrl` crudo → `parseYouTubeUrl` → kind + ref.
 *   - `regenerateDisplayPairingCode`: código nuevo (el anterior deja de servir).
 *   - `revokeReceptionDisplay`: limpia los hashes y deja `revokedAt` / `revokedByUserId`.
 */
import type { ActionResult } from "@/lib/validation";
import type {
  DisplayIdInput,
  DisplayListItem,
  DisplayPairingCode,
  DisplayUpdateInput,
  DisplayUpsertInput,
  DisplaysPanel,
} from "@/lib/reception-displays-types";

const NOT_IMPLEMENTED = "not implemented";

export async function getDisplaysPanel(): Promise<ActionResult<DisplaysPanel>> {
  return { ok: false, error: NOT_IMPLEMENTED };
}

export async function createReceptionDisplay(
  _input: DisplayUpsertInput,
): Promise<ActionResult<{ display: DisplayListItem; pairing: DisplayPairingCode }>> {
  return { ok: false, error: NOT_IMPLEMENTED };
}

export async function updateReceptionDisplay(_input: DisplayUpdateInput): Promise<ActionResult<{ display: DisplayListItem }>> {
  return { ok: false, error: NOT_IMPLEMENTED };
}

export async function regenerateDisplayPairingCode(_input: DisplayIdInput): Promise<ActionResult<DisplayPairingCode>> {
  return { ok: false, error: NOT_IMPLEMENTED };
}

export async function revokeReceptionDisplay(_input: DisplayIdInput): Promise<ActionResult> {
  return { ok: false, error: NOT_IMPLEMENTED };
}
