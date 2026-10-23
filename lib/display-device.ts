"use server";

/**
 * TV (T7, §26.4 C-TV): actions del DISPOSITIVO (`/tv`), sin Actor. La identidad es la cookie `kine_tv`
 * (`DISPLAY_COOKIE`, path `/tv`); el server usa `prismaService` con `id` + `tenantId` a mano.
 *
 * STUB de TV-1k (ola X1): firmas para que `/tv` (TV-2u1/TV-2u2) compile en paralelo. Lo implementa TV-2d (X2):
 *   - `pairDisplay({code})`: rate limit 10 cada 10 min + 30 por hora por IP; `updateMany` con CAS (`count === 1`, un
 *     solo uso); `auditInTx("display.paired")`; setea la cookie; ante cualquier fallo, `PAIR_FAILED_MESSAGE`.
 *   - `getDisplayFeed()`: 30 por minuto por pantalla; `resolveDisplaySession()` → `loadDisplayFeed` (sale por
 *     `DisplayFeedSchema` strict).
 */
import type { ActionResult } from "@/lib/validation";
import type { DeviceFeedResult, PairDisplayInput } from "@/lib/reception-displays-types";
import { PAIR_FAILED_MESSAGE } from "@/lib/reception-displays-types";

export async function pairDisplay(_input: PairDisplayInput): Promise<ActionResult> {
  return { ok: false, error: PAIR_FAILED_MESSAGE };
}

export async function getDisplayFeed(): Promise<DeviceFeedResult> {
  return { ok: false, state: "unavailable" };
}
