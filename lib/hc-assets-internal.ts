import "server-only";

/**
 * Logo del consultorio y firmas escaneadas para embeber en el PDF y el Word (C-FC5, §24.6). Bucket privado
 * `practice-assets`; las claves salen de las filas (`Tenant.logoStorageKey`, `Practitioner.signatureStorageKey`, vía
 * `hcAssetRequest` de `lib/hc-print-internal.ts`), nunca del cliente. NEUTRAL: no nombra el modelo de notas.
 *
 * Falla BLANDA (contrato de FC-2e): un asset que no baja, pesa de más, no es PNG/JPEG por magic bytes o tiene
 * dimensiones absurdas queda afuera y el documento sale igual sin él. Un logo roto no puede impedir que el paciente
 * reciba su ficha ni que el profesional descargue la HC. Se loguea el motivo, nunca la clave (lleva el tenantId).
 *
 * El chequeo de tipo y dimensiones (`readImageInfo` y `PRACTICE_ASSET_LIMITS` de `lib/file-sniff.ts`, los mismos de la
 * subida de FC-2f) se repite acá: lo que se embebe lo decide el contenido del objeto en Storage, no lo que se validó al
 * subirlo (un objeto reemplazado a mano en la consola no tiene que romper react-pdf ni inflar la función).
 */
import { PRACTICE_ASSET_LIMITS, readImageInfo, type PracticeAssetKind } from "@/lib/file-sniff";
import { logger } from "@/lib/logger";
import { storageDownload } from "@/lib/storage-internal";

export type HcImageAsset = { mime: "image/png" | "image/jpeg"; bytes: Uint8Array; width: number; height: number };
/** `signatures` va por `imageRef` opaco del contenido imprimible (no por id de practitioner). */
export type HcRenderAssets = { logo: HcImageAsset | null; signatures: Readonly<Record<string, HcImageAsset>> };

async function loadOne(key: string, what: PracticeAssetKind): Promise<HcImageAsset | null> {
  const { maxBytes, maxPx } = PRACTICE_ASSET_LIMITS[what];
  try {
    const r = await storageDownload("practice-assets", key, maxBytes);
    if (!r.ok) {
      logger.warn("hc.asset.skipped", { what, reason: r.reason });
      return null;
    }
    const bytes = r.data;
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      logger.warn("hc.asset.skipped", { what, reason: "size" });
      return null;
    }
    const info = readImageInfo(bytes);
    if (!info || info.width > maxPx || info.height > maxPx) {
      logger.warn("hc.asset.skipped", { what, reason: "type" });
      return null;
    }
    return { ...info, bytes };
  } catch (err) {
    // `storageDownload` no tira por contrato; esto cubre la red de abajo o un bug: igual, falla blanda.
    logger.warn("hc.asset.skipped", { what, reason: "error", err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Baja en paralelo el logo y las firmas pedidas. Nunca tira: lo que falla queda en null / fuera del mapa. Dos refs con
 * la misma clave se bajan una sola vez.
 */
export async function loadHcAssets(p: {
  logoKey: string | null;
  signatures: { ref: string; key: string | null }[];
}): Promise<HcRenderAssets> {
  const byKey = new Map<string, Promise<HcImageAsset | null>>();
  for (const s of p.signatures) {
    if (s.key && !byKey.has(s.key)) byKey.set(s.key, loadOne(s.key, "signature"));
  }
  const logoP = p.logoKey ? loadOne(p.logoKey, "logo") : Promise.resolve(null);
  const [logo, ...sigs] = await Promise.all([logoP, ...p.signatures.map((s) => (s.key ? byKey.get(s.key)! : null))]);
  const signatures: Record<string, HcImageAsset> = {};
  p.signatures.forEach((s, i) => {
    const a = sigs[i];
    if (a) signatures[s.ref] = a;
  });
  return { logo, signatures };
}
