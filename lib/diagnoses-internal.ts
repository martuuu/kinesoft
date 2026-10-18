import "server-only";

/**
 * Diagnósticos: resolución server-side de las refs que manda la UI (C-FC2, §24.4).
 *
 * El cliente NUNCA manda el snapshot: manda `{kind, id}` o `{kind:"text", text}` y este módulo re-lee cada ref desde la
 * base (CIE-11 no retirado salvo que ya estuviera congelado en `keep`, propio del tenant y vivo, `Condition` global o
 * del tenant con el módulo `diagnostico`) y congela `{v, source, refId, code, title, uri, release}`. Así un cliente
 * adulterado no puede inventar un código ni colar un diagnóstico de otro consultorio (las FK saltean RLS).
 *
 * FC-1b3 publica la firma; FC-2c la implementa. Tira hasta entonces: FC-2a testea con esta firma.
 */
import type { DiagnosisRef, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

export type ResolveDiagnosesResult = { ok: true; snapshots: DiagnosisSnapshot[] } | { ok: false; error: string };

export async function resolveDiagnosesInTx(
  tx: DbClient,
  actor: Actor,
  refs: DiagnosisRef[],
  opts?: { keep?: DiagnosisSnapshot[] },
): Promise<ResolveDiagnosesResult> {
  void tx;
  void actor;
  void refs;
  void opts;
  throw new Error("resolveDiagnosesInTx: no implementado (FC-2c).");
}
