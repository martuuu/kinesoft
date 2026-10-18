import "server-only";

/**
 * Diagnósticos: resolución server-side de las refs que manda la UI (C-FC2, §24.4).
 *
 * El cliente NUNCA manda el snapshot: manda `{kind, id}` o `{kind:"text", text}` y este módulo re-lee cada ref desde la
 * base (CIE-11 no retirado salvo que ya estuviera congelado en `keep`, propio del tenant y vivo, `Condition` global o
 * del tenant con el módulo `diagnostico`) y congela `{v, source, refId, code, title, uri, release}`. Así un cliente
 * adulterado no puede inventar un código ni colar un diagnóstico de otro consultorio (las FK saltean RLS y en prod la
 * conexión tiene BYPASSRLS: el `tenantId` del `where` es la única barrera).
 *
 * El gate de la FICHA (módulo `evoluciones`, `clinical.read`, acceso full al paciente, profesional) lo decide el caller
 * (`lib/clinical-notes.ts`) antes de llamar: acá solo se decide si cada diagnóstico es elegible para este consultorio.
 */
import type { DiagnosisRef, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { DIAGNOSES_MAX, DIAGNOSIS_COPY, DIAGNOSIS_TEXT_MAX, DIAGNOSIS_TEXT_MIN } from "@/lib/diagnoses-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";

export type ResolveDiagnosesResult = { ok: true; snapshots: DiagnosisSnapshot[] } | { ok: false; error: string };

type IdKind = Exclude<DiagnosisRef["kind"], "text">;
const keyOf = (source: IdKind, id: string) => `${source}:${id}`;

/**
 * ¿El `keep` que pasa el caller tiene forma de snapshot? Lo lee de la ficha guardada (no del cliente), pero es un JSON
 * de la base: uno roto no se re-congela, se re-lee como cualquier ref nueva.
 */
function isSnapshot(s: unknown): s is DiagnosisSnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return (
    o.v === 1 &&
    (o.source === "icd11" || o.source === "tenant" || o.source === "kine" || o.source === "text") &&
    typeof o.title === "string" &&
    (o.refId === null || typeof o.refId === "string")
  );
}

/**
 * Refs → snapshots congelados, en el orden recibido (el primero es el principal). A lo sumo 3 lecturas (una por fuente,
 * solo las que aparecen), dentro de la tx del caller.
 *
 * - `keep` (editar): lo ya congelado en la ficha se conserva TAL CUAL si la ref vuelve a venir, sin re-leer. Es lo que
 *   pide la licencia y la Ley 26.529: una ficha firmada no cambia el título porque la OMS lo retiró o lo reformuló en
 *   una release nueva, ni porque alguien renombró o archivó un propio, ni porque al consultorio le sacaron el módulo de
 *   Kinesiología. Fuera de `keep`, un retirado se rechaza (`retired`) y lo archivado, ajeno o inexistente da
 *   `notAvailable`.
 * - Kinesiología (FC-D25): `code` null aunque la `Condition` tenga `cie10` (no se mezclan sistemas ni licencias).
 * - Texto libre (FC-D27): trim, 2..120. El zod del caller ya lo valida; se re-chequea porque esta función es la
 *   barrera y la puede llamar otro camino.
 * - Una ref repetida se guarda una sola vez (la primera posición gana: el principal no se mueve).
 */
export async function resolveDiagnosesInTx(
  tx: DbClient,
  actor: Actor,
  refs: DiagnosisRef[],
  opts?: { keep?: DiagnosisSnapshot[] },
): Promise<ResolveDiagnosesResult> {
  if (refs.length === 0) return { ok: true, snapshots: [] };

  const kept = new Map<string, DiagnosisSnapshot>();
  for (const s of opts?.keep ?? []) {
    if (isSnapshot(s) && s.source !== "text" && s.refId) kept.set(keyOf(s.source, s.refId), s);
  }

  // Dedupe antes de contar: «ME84 dos veces» no tiene que dar «hasta 5».
  const unique: DiagnosisRef[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const k = r.kind === "text" ? `text:${r.text.trim().toLowerCase()}` : keyOf(r.kind, r.id);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(r);
  }
  if (unique.length > DIAGNOSES_MAX) return { ok: false, error: DIAGNOSIS_COPY.tooMany };

  const need = (kind: IdKind) =>
    unique.flatMap((r) => (r.kind === kind && !kept.has(keyOf(kind, r.id)) ? [r.id] : []));
  const icdIds = need("icd11");
  const tenantIds = need("tenant");
  const kineIds = need("kine");

  // Sin el módulo, ni se consulta: una ref de Kinesiología nueva es «no disponible» (la congelada en `keep` sigue).
  if (kineIds.length > 0 && !modulesFor(actor.entitlements).has("diagnostico")) {
    return { ok: false, error: DIAGNOSIS_COPY.notAvailable };
  }

  const [icdRows, tenantRows, kineRows] = await Promise.all([
    icdIds.length
      ? tx.diagnosisCode.findMany({
          where: { id: { in: icdIds }, system: "ICD11_MMS" },
          select: { id: true, code: true, title: true, uri: true, release: true, retiredAt: true },
        })
      : [],
    tenantIds.length
      ? tx.tenantDiagnosis.findMany({
          // tenantId a mano: en prod BYPASSRLS, y un id de otro consultorio no puede «existir» para este.
          where: { id: { in: tenantIds }, tenantId: actor.tenantId, archivedAt: null },
          select: { id: true, code: true, title: true },
        })
      : [],
    kineIds.length
      ? tx.condition.findMany({
          // Global (tenantId NULL) o propia de ESTE consultorio; nunca la custom de otro.
          where: { id: { in: kineIds }, OR: [{ tenantId: null }, { tenantId: actor.tenantId }] },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const icd = new Map(icdRows.map((r) => [r.id, r]));
  const own = new Map(tenantRows.map((r) => [r.id, r]));
  const kine = new Map(kineRows.map((r) => [r.id, r]));

  const snapshots: DiagnosisSnapshot[] = [];
  for (const r of unique) {
    if (r.kind === "text") {
      const title = r.text.trim();
      if (title.length < DIAGNOSIS_TEXT_MIN || title.length > DIAGNOSIS_TEXT_MAX) {
        return { ok: false, error: DIAGNOSIS_COPY.textLength };
      }
      snapshots.push({ v: 1, source: "text", refId: null, code: null, title, uri: null, release: null });
      continue;
    }
    const frozen = kept.get(keyOf(r.kind, r.id));
    if (frozen) {
      snapshots.push(frozen);
      continue;
    }
    if (r.kind === "icd11") {
      const row = icd.get(r.id);
      if (!row) return { ok: false, error: DIAGNOSIS_COPY.notAvailable };
      if (row.retiredAt) return { ok: false, error: DIAGNOSIS_COPY.retired };
      // Título oficial sin tocar + URI + release: lo que exige la licencia en almacenamiento (§24.2 hallazgo 1).
      snapshots.push({ v: 1, source: "icd11", refId: row.id, code: row.code, title: row.title, uri: row.uri, release: row.release });
    } else if (r.kind === "tenant") {
      const row = own.get(r.id);
      if (!row) return { ok: false, error: DIAGNOSIS_COPY.notAvailable };
      snapshots.push({ v: 1, source: "tenant", refId: row.id, code: row.code, title: row.title, uri: null, release: null });
    } else {
      const row = kine.get(r.id);
      if (!row) return { ok: false, error: DIAGNOSIS_COPY.notAvailable };
      snapshots.push({ v: 1, source: "kine", refId: row.id, code: null, title: row.name, uri: null, release: null });
    }
  }
  return { ok: true, snapshots };
}
