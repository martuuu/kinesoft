import "server-only";

/**
 * PDF de la historia clínica con react-pdf (C-FC5, §24.6). Server-only: `@react-pdf/renderer` está en
 * `serverComponentsExternalPackages` y nunca entra a un bundle de cliente (`tests/unit/hc-heavy-deps.test.ts`).
 * NEUTRAL: no nombra el modelo de notas.
 *
 * FC-1b3 deja la firma y el tope; FC-2e implementa el render (Noto Sans de `lib/hc-pdf/fonts`, registro copiado del
 * spike de FC-1c). Hasta entonces tira: los consumidores de T4c lo testean con un renderer fake.
 */
import type { HcImageAsset, HcRenderAssets } from "@/lib/hc-assets-internal";
import type { HcPrintableV1 } from "@/lib/hc-print-types";

export type { HcImageAsset, HcRenderAssets };

/** Tope del PDF compartido o descargado: más que esto es error `tooLarge` (probá sin logo o sin firma). */
export const HC_PDF_MAX_BYTES = 4 * 1024 * 1024;

export async function renderHcPdf(doc: HcPrintableV1, assets: HcRenderAssets): Promise<Uint8Array> {
  void doc;
  void assets;
  throw new Error("renderHcPdf: no implementado (FC-2e).");
}
