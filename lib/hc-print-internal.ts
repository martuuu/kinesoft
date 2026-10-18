import "server-only";

/**
 * Historia clínica imprimible, lado server (C-FC4, §24.6): carga de la fuente y cierre del `HcPrintableV1` con su
 * sha256 y código de verificación. NEUTRAL: no nombra el modelo de notas (lo fija `tests/unit/fc1b3-server-stubs`).
 *
 * Por qué el loader RECIBE las filas de las entradas en vez de leerlas (FC-2e, desvío del C-FC4 literal): leerlas acá
 * obliga a nombrar la tabla o el accessor de Prisma, y este archivo es neutral. La lectura de las entradas (gate
 * `canRead`, tope de 300, ORDER BY) vive en el módulo de impresión del equipo (FC-2g) y en el de compartir (FC-2d), que
 * sí pueden nombrar el modelo; acá se completa lo que no es de la entrada: consultorio, sede, paciente, honorífico y
 * firma de cada autor. Son 2 sentencias: con la lectura del caller, la fuente sale en 3 (≤ 4 de C-FC4).
 *
 * `sha256Hex` lo implementó FC-1b3 (FC-2b lo usa para «Compartida · desactualizada»).
 */
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { isLateEntry } from "@/lib/diagnoses-logic";
import type { DiagnosisSnapshot, DiagnosisSource } from "@/lib/diagnoses-types";
import { canonicalJson, verificationCodeFromSha256, type HcPrintSource, type HcPrintSourceEntry } from "@/lib/hc-print-model";
import type { HcPrintableContentV1, HcPrintableMetaV1, HcPrintableV1 } from "@/lib/hc-print-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

/** sha256 en hex minúscula del texto en UTF-8. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Tope de entradas por documento (C-FC7: 300 fichas). Lo aplica quien lee las filas; acá se exporta como contrato. */
export const HC_PRINT_MAX_ENTRIES = 300;

/**
 * Una entrada tal como la lee el caller (columnas de la tabla, con nombres neutrales). `parentId` = la raíz que
 * enmienda (null = raíz); `label` = etiqueta YA resuelta del tipo de entrada (el enum no viaja: hallazgo 2 de §24.2).
 */
export type HcPrintEntryRow = {
  id: string;
  parentId: string | null;
  revision: number;
  label: string;
  title: string | null;
  occurredAt: Date;
  createdAt: Date;
  body: string;
  bodyDoc: unknown;
  diagnoses: unknown;
  authorName: string;
  authorPractitionerId: string | null;
  authorLicense: string | null;
  importSource: unknown;
  voidedAt: Date | null;
  voidReason: string | null;
};

const DIAGNOSIS_SOURCES: ReadonlySet<DiagnosisSource> = new Set(["icd11", "tenant", "kine", "text"]);

/**
 * `diagnoses` (jsonb) → snapshots. La base ya lo acota con CHECK (M14) y el server lo congela al guardar; acá solo se
 * descarta lo que no tenga forma (mejor un diagnóstico menos en el PDF que un 500 al descargar la HC).
 */
function toDiagnosisSnapshots(raw: unknown): DiagnosisSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: DiagnosisSnapshot[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (typeof o.title !== "string" || !o.title.trim()) continue;
    const source = DIAGNOSIS_SOURCES.has(o.source as DiagnosisSource) ? (o.source as DiagnosisSource) : "text";
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    out.push({ v: 1, source, refId: str(o.refId), code: str(o.code), title: o.title, uri: str(o.uri), release: str(o.release) });
  }
  return out;
}

const byChrono = (a: HcPrintEntryRow, b: HcPrintEntryRow) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type HeaderRow = {
  tenantName: string;
  tenantPhone: string | null;
  logoStorageKey: string | null;
  firstName: string;
  lastName: string;
  documentId: string | null;
  dateOfBirth: Date | null;
  address: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  locationPhone: string | null;
};

/**
 * Completa la fuente imprimible: consultorio (membrete: sede del turno si `locationId`, si no la principal), paciente y,
 * por autor, honorífico y si tiene firma cargada. `null` = paciente ajeno o inexistente (la ruta responde 404).
 *
 * El `tenantId` va a mano en cada WHERE: en prod la conexión tiene BYPASSRLS y es la única barrera. Las entradas se
 * agrupan raíz → enmiendas en orden cronológico (desempate `createdAt`, `id`: estable entre lecturas, así el código de
 * verificación no cambia por el orden); una enmienda cuya raíz no vino en `rows` se descarta (no se imprime suelta).
 */
export async function loadHcPrintSourceInTx(
  tx: DbClient,
  actor: Actor,
  p: { patientId: string; rows: readonly HcPrintEntryRow[]; truncated?: boolean; locationId?: string | null },
): Promise<HcPrintSource | null> {
  const tenantId = actor.tenantId;
  const locationId = p.locationId ?? null;
  // 1 sentencia: consultorio + paciente + sede. LATERAL elige la sede del turno (activa) o, si no, la principal.
  const [head] = await tx.$queryRaw<HeaderRow[]>(Prisma.sql`
    SELECT t.name AS "tenantName", t.phone AS "tenantPhone", t."logoStorageKey",
           pa."firstName", pa."lastName", pa."documentId", pa."dateOfBirth",
           l.address, l."addressLine2", l.city, l.province, l.phone AS "locationPhone"
      FROM "Tenant" t
      JOIN "Patient" pa ON pa.id = ${p.patientId} AND pa."tenantId" = t.id
      LEFT JOIN LATERAL (
        SELECT lo.address, lo."addressLine2", lo.city, lo.province, lo.phone
          FROM "Location" lo
         WHERE lo."tenantId" = t.id AND lo.active
           AND (lo.id = ${locationId} OR lo."isPrimary")
         ORDER BY (lo.id = ${locationId}) DESC NULLS LAST, lo."isPrimary" DESC, lo."sortOrder", lo.id
         LIMIT 1
      ) l ON true
     WHERE t.id = ${tenantId}`);
  if (!head) return null;

  // 1 sentencia: honorífico y firma de los autores (los ids vienen de filas del tenant; igual se filtra por tenant).
  const authorIds = [...new Set(p.rows.map((r) => r.authorPractitionerId).filter((x): x is string => !!x))];
  const authors = authorIds.length
    ? await tx.practitioner.findMany({
        where: { tenantId, id: { in: authorIds } },
        select: { id: true, honorific: true, signatureStorageKey: true },
      })
    : [];
  const authorById = new Map(authors.map((a) => [a.id, a]));
  const signatureKeys: Record<string, string> = {};
  for (const a of authors) if (a.signatureStorageKey) signatureKeys[a.id] = a.signatureStorageKey;

  const toEntry = (r: HcPrintEntryRow): HcPrintSourceEntry => {
    const author = r.authorPractitionerId ? authorById.get(r.authorPractitionerId) : undefined;
    return {
      id: r.id,
      revision: r.revision,
      label: r.label,
      title: r.title,
      occurredAt: r.occurredAt,
      createdAt: r.createdAt,
      body: r.body,
      bodyDoc: r.bodyDoc ?? null,
      diagnoses: toDiagnosisSnapshots(r.diagnoses),
      authorName: r.authorName,
      authorHonorific: author?.honorific ?? null,
      authorLicense: r.authorLicense,
      authorPractitionerId: author ? author.id : null,
      authorHasSignature: !!author?.signatureStorageKey,
      importSource: r.importSource ?? null,
      lateEntry: isLateEntry({ importSource: r.importSource ?? null, createdAt: r.createdAt, occurredAt: r.occurredAt }),
      voidedAt: r.voidedAt,
      voidReason: r.voidReason,
    };
  };

  const sorted = [...p.rows].sort(byChrono);
  const amendmentsByRoot = new Map<string, HcPrintEntryRow[]>();
  for (const r of sorted) {
    if (!r.parentId) continue;
    const list = amendmentsByRoot.get(r.parentId) ?? [];
    list.push(r);
    amendmentsByRoot.set(r.parentId, list);
  }
  const entries = sorted
    .filter((r) => !r.parentId)
    .map((root) => ({ root: toEntry(root), amendments: (amendmentsByRoot.get(root.id) ?? []).map(toEntry) }));

  const addressLine =
    [head.address, head.addressLine2, head.city, head.province]
      .map((s) => s?.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(", ") || null;
  return {
    tenant: {
      name: head.tenantName,
      addressLine,
      phone: head.locationPhone?.trim() || head.tenantPhone?.trim() || null,
      hasLogo: !!head.logoStorageKey,
    },
    patient: {
      firstName: head.firstName,
      lastName: head.lastName,
      documentId: head.documentId,
      // Fecha calendario sin hora (excepción `dateOfBirth` de AGENTS §4): se guarda a medianoche UTC.
      dateOfBirth: head.dateOfBirth ? head.dateOfBirth.toISOString().slice(0, 10) : null,
    },
    entries,
    truncated: p.truncated ?? false,
    assetKeys: { logoKey: head.logoStorageKey, signatureKeys },
  };
}

/**
 * Pedido de `loadHcAssets` a partir de la fuente y de los `signatureOwners` del contenido: el logo solo si el
 * membrete lo anuncia, y una firma por `imageRef` (la del AUTOR, FC-D26). Sin `assetKeys` → sin imágenes.
 */
export function hcAssetRequest(
  src: HcPrintSource,
  signatureOwners: Readonly<Record<string, string>>,
): { logoKey: string | null; signatures: { ref: string; key: string | null }[] } {
  const keys = src.assetKeys;
  return {
    logoKey: src.tenant.hasLogo ? (keys?.logoKey ?? null) : null,
    signatures: Object.keys(signatureOwners)
      .sort()
      .map((ref) => ({ ref, key: keys?.signatureKeys[signatureOwners[ref]] ?? null })),
  };
}

/**
 * Contenido + meta (sin código) → `HcPrintableV1` con `verificationCode` = `verificationCodeFromSha256` del sha256 de
 * `canonicalJson(content)`; devuelve ese sha256 (va a `snapshotSha256`). El código sale del CONTENIDO y no del meta:
 * la misma ficha descargada dos veces (otra hora, otra persona) tiene el mismo código.
 */
export function finalizeHcPrintable(
  content: HcPrintableContentV1,
  meta: Omit<HcPrintableMetaV1, "verificationCode">,
): { printable: HcPrintableV1; sha256: string } {
  const sha256 = sha256Hex(canonicalJson(content));
  return {
    printable: { v: 1, content, meta: { ...meta, verificationCode: verificationCodeFromSha256(sha256) } },
    sha256,
  };
}
