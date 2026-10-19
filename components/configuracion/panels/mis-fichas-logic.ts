/**
 * [FC-3i] Lógica pura de «Mis fichas» (testeable sin DOM): chequeo previo de logo y firma, diagnósticos propios y
 * matrícula. Solo la baja el chunk de «Mis fichas» (que también dibuja el logo de General, por `next/dynamic`).
 */
import { PRACTICE_ASSET_COPY, PRACTICE_ASSET_LIMITS, type PracticeAssetKind } from "@/lib/file-sniff";
import type { TenantDiagnosisRow } from "@/lib/diagnoses-types";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/pjpeg"]);

/** `accept` del input de archivo: lo único que la action acepta (C-FC9). */
export const PRACTICE_ASSET_ACCEPT = "image/png,image/jpeg";

/**
 * Chequeo barato ANTES de leer el archivo a memoria (tamaño y tipo declarado): un PDF de 8 MB elegido por error no se
 * lee ni se manda. Los magic bytes y las dimensiones los mira después `checkPracticeAsset` (el mismo de la action)
 * sobre los bytes, y la action lo repite: esto es UX, no la barrera.
 */
export function precheckPracticeAssetFile(kind: PracticeAssetKind, file: { size: number; type: string }): string | null {
  const format = kind === "logo" ? PRACTICE_ASSET_COPY.logoFormat : PRACTICE_ASSET_COPY.signatureFormat;
  if (file.size <= 0 || file.size > PRACTICE_ASSET_LIMITS[kind].maxBytes) return format;
  const t = file.type.trim().toLowerCase();
  // `type` vacío (algunos navegadores con extensiones raras): lo decide el chequeo de bytes.
  if (t && !ACCEPTED_IMAGE_TYPES.has(t)) return format;
  return null;
}

/** Vivos primero (A-Z, como los manda `listTenantDiagnoses`) y los archivados aparte, plegados. */
export function splitTenantDiagnoses(rows: readonly TenantDiagnosisRow[]): {
  live: TenantDiagnosisRow[];
  archived: TenantDiagnosisRow[];
} {
  return { live: rows.filter((r) => !r.archived), archived: rows.filter((r) => r.archived) };
}

/** Reemplaza una fila por la que devolvió la action (renombrar) o la marca archivada; el orden A-Z se rehace. */
export function applyDiagnosisChange(
  rows: readonly TenantDiagnosisRow[],
  change: { kind: "renamed"; row: TenantDiagnosisRow } | { kind: "archived"; id: string },
): TenantDiagnosisRow[] {
  const next = rows.map((r) =>
    change.kind === "renamed" ? (r.id === change.row.id ? change.row : r) : r.id === change.id ? { ...r, archived: true } : r,
  );
  return next.sort((a, b) => Number(a.archived) - Number(b.archived) || a.title.localeCompare(b.title, "es"));
}

/** Matrícula del form: recortada; vacía → null (la action hace lo mismo y la limita a 60). */
export function normalizeLicenseInput(raw: string): string | null {
  const s = raw.replace(/\s+/g, " ").trim();
  return s ? s : null;
}
