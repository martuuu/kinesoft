import "server-only";

/**
 * FC-2a · Piezas server-only de las escrituras de fichas (C-FC3 «Reglas del server»). Viven fuera de
 * `lib/clinical-notes.ts` porque ese archivo es `"use server"` (solo exporta actions async) y estas piezas se arman
 * dentro de la tx de cada action. La lógica pura (qué body/bodyDoc, el registro de importación, los hechos del audit)
 * está en `lib/clinical-notes-logic.ts` con su unit test; acá solo lo que toca Prisma.
 *
 * Por qué cada cosa va EN LA MISMA TX de la ficha:
 *  - los diagnósticos se re-leen y congelan acá (regla 2): si se resolvieran antes de la tx, un código retirado o un
 *    propio archivado entre la lectura y el INSERT quedaría guardado igual;
 *  - la matrícula se lee del Practitioner del autor en la tx (regla 3, +1 sentencia): lo que se congela es la que tenía
 *    al firmar, no la de una sesión cacheada;
 *  - el diagnóstico activo del paciente (regla 5) se escribe en la misma tx para que nunca quede un `diagnosisTitle`
 *    que apunta a una ficha que no se guardó (CAS perdido, 23505, 24 h).
 */
import { Prisma } from "@prisma/client";
import { resolveDiagnosesInTx } from "@/lib/diagnoses-internal";
import { activeDiagnosisTitle } from "@/lib/diagnoses-logic";
import type { DiagnosisRef, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { hcDocToPlainText, type HcDoc } from "@/lib/hc-doc";
import { formatLicense } from "@/lib/hc-print-model";
import { noteBodyFields } from "@/lib/clinical-notes-logic";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

/**
 * `body`/`bodyDoc` listos para el `data` de Prisma. `bodyDoc: null` → `Prisma.DbNull` (SQL NULL; un `null` pelado en
 * una columna Json de Prisma no compila y `JsonNull` guardaría el literal JSON `null`, que el CHECK de M14 rechaza).
 */
export function noteBodyData(p: {
  body?: string;
  bodyDoc?: { doc: HcDoc };
}): { body: string; bodyDoc: Prisma.InputJsonValue | typeof Prisma.DbNull } | undefined {
  const f = noteBodyFields(p, hcDocToPlainText);
  if (!f) return undefined;
  return { body: f.body, bodyDoc: f.bodyDoc === null ? Prisma.DbNull : (f.bodyDoc as unknown as Prisma.InputJsonValue) };
}

export type NoteDiagnosesResult =
  | { ok: true; snapshots: DiagnosisSnapshot[] | undefined }
  | { ok: false; error: string };

/**
 * Regla 2: refs de la UI → snapshots congelados, re-leídos en la base (el título y el código del cliente nunca llegan
 * acá: el zod solo acepta refs). `undefined` = no vino (no se toca); `null`/`[]` = sin diagnósticos.
 * `keep` (solo editar): el snapshot actual de la ficha, así un CIE-11 que la OMS retiró después de firmar se conserva
 * tal cual se guardó en vez de rechazar la edición entera.
 */
export async function resolveNoteDiagnosesInTx(
  tx: DbClient,
  actor: Actor,
  refs: DiagnosisRef[] | null | undefined,
  keep?: DiagnosisSnapshot[]
): Promise<NoteDiagnosesResult> {
  if (refs === undefined) return { ok: true, snapshots: undefined };
  if (refs === null || refs.length === 0) return { ok: true, snapshots: [] };
  const r = await resolveDiagnosesInTx(tx, actor, refs, keep && keep.length ? { keep } : undefined);
  return r.ok ? { ok: true, snapshots: r.snapshots } : { ok: false, error: r.error };
}

/**
 * Snapshots → valor de la columna. `[]` → SQL NULL: el CHECK de M14 exige 1..5 elementos (sin diagnósticos es NULL,
 * no un array vacío).
 */
export function diagnosesData(
  snapshots: DiagnosisSnapshot[] | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (snapshots === undefined) return undefined;
  return snapshots.length ? (snapshots as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

/** `ClinicalNote.diagnoses` guardado → snapshots (para el `keep` de editar). Forma inesperada → []. */
export function storedDiagnoses(raw: Prisma.JsonValue | null): DiagnosisSnapshot[] {
  return Array.isArray(raw) ? (raw as unknown as DiagnosisSnapshot[]) : [];
}

/**
 * Regla 3: la matrícula con la que firma (`formatLicense(Practitioner.licenseNumber)`), al crear o enmendar. Con
 * `tenantId` a mano: en prod la conexión tiene BYPASSRLS. Sin matrícula cargada → null (la ficha se guarda igual; el
 * PDF sale sin matrícula, mejor que bloquear la HC por un dato de perfil).
 */
export async function authorLicenseInTx(tx: DbClient, tenantId: string, practitionerId: string): Promise<string | null> {
  const p = await tx.practitioner.findFirst({
    where: { id: practitionerId, tenantId },
    select: { licenseNumber: true },
  });
  return formatLicense(p?.licenseNumber);
}

/**
 * Regla 5: «Usar como diagnóstico activo» → `Patient.diagnosisTitle` = «{código} {título}» del principal (el primero),
 * ≤80. `diagnosisNote` no se toca (es texto del profesional, no sale de la ficha). Devuelve si escribió, para el audit.
 */
export async function applyActiveDiagnosisInTx(
  tx: DbClient,
  p: { tenantId: string; patientId: string; setActive: boolean | undefined; snapshots: DiagnosisSnapshot[] | undefined }
): Promise<boolean> {
  const principal = p.snapshots?.[0];
  if (!p.setActive || !principal) return false;
  await tx.patient.updateMany({
    where: { id: p.patientId, tenantId: p.tenantId },
    data: { diagnosisTitle: activeDiagnosisTitle(principal) },
  });
  return true;
}
