import "server-only";

/**
 * Historia clínica imprimible, lado server (C-FC4, §24.6): carga de la fuente y cierre del `HcPrintableV1` con su
 * sha256 y código de verificación. NEUTRAL (lo alcanza el grafo de imports del portal): no nombra el modelo de notas.
 *
 * FC-1b3 publica las firmas; FC-2e implementa `loadHcPrintSourceInTx` (≤ 4 sentencias) y `finalizeHcPrintable`.
 * `sha256Hex` va implementado ya: es una línea de `node:crypto` y FC-2b la necesita en T4c para comparar
 * `sha256(hcSourceVersion)` contra `sourceDigest` («Compartida · desactualizada») sin esperar a FC-2e.
 */
import { createHash } from "node:crypto";
import type { HcPrintSource } from "@/lib/hc-print-model";
import type { HcPrintableContentV1, HcPrintableMetaV1, HcPrintableV1 } from "@/lib/hc-print-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

/** sha256 en hex minúscula del texto en UTF-8. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Lee del tenant del actor el paciente y las raíces pedidas con sus enmiendas, con tope `limit` (300 por default en
 * las rutas). `null` = paciente ajeno o inexistente (la ruta responde 404).
 */
export async function loadHcPrintSourceInTx(
  tx: DbClient,
  actor: Actor,
  p: { patientId: string; rootIds: string[] | null; limit?: number },
): Promise<HcPrintSource | null> {
  void tx;
  void actor;
  void p;
  throw new Error("loadHcPrintSourceInTx: no implementado (FC-2e).");
}

/**
 * Contenido + meta (sin código) → `HcPrintableV1` con `verificationCode` = `verificationCodeFromSha256` del sha256 de
 * `canonicalJson(content)`; devuelve ese sha256 (va a `snapshotSha256`).
 */
export function finalizeHcPrintable(
  content: HcPrintableContentV1,
  meta: Omit<HcPrintableMetaV1, "verificationCode">,
): { printable: HcPrintableV1; sha256: string } {
  void content;
  void meta;
  throw new Error("finalizeHcPrintable: no implementado (FC-2e).");
}
