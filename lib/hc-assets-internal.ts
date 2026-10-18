import "server-only";

/**
 * Logo del consultorio y firmas escaneadas para embeber en el PDF y el Word (C-FC5, §24.6). Bucket privado
 * `practice-assets`; las claves salen de las filas (`Tenant.logoStorageKey`, `Practitioner.signatureStorageKey`),
 * nunca del cliente. NEUTRAL: no nombra el modelo de notas.
 *
 * Contrato de FC-2e: falla BLANDA. Un asset que no baja, pesa de más o no es PNG/JPEG queda en null y el documento sale
 * igual sin él (un logo roto no puede impedir que el paciente reciba su ficha). FC-1b3 deja la firma y los tipos; el
 * stub tira hasta que FC-2e lo implemente (los consumidores de T4c lo testean con un fake).
 */

export type HcImageAsset = { mime: "image/png" | "image/jpeg"; bytes: Uint8Array; width: number; height: number };
/** `signatures` va por `imageRef` opaco del contenido imprimible (no por id de practitioner). */
export type HcRenderAssets = { logo: HcImageAsset | null; signatures: Readonly<Record<string, HcImageAsset>> };

export async function loadHcAssets(p: {
  logoKey: string | null;
  signatures: { ref: string; key: string | null }[];
}): Promise<HcRenderAssets> {
  void p;
  throw new Error("loadHcAssets: no implementado (FC-2e).");
}
