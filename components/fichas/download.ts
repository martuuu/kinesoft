/**
 * [FC-3e2] Descarga de una ficha (PDF / Word) desde la ruta AUDITADA (C-FC7). Nunca se arma el archivo en el cliente.
 *
 * Por qué `fetch` + blob y no un `<a href download>` directo (lo que hace el fallback de `useFichaBackup`): con el
 * link, un 413 («demasiado pesada»), un 429 (rate limit) o un 503 (falló el audit) navegan a una página de texto
 * plano o bajan un archivo roto, y el profesional no entiende qué pasó. Con `fetch` se lee el status y se dice en un
 * toast (`downloadErrorMessage`). El archivo de una ficha es chico (≤ 4 MB, `HC_PDF_MAX_BYTES`): tenerlo en memoria
 * como blob no es un problema.
 *
 * El nombre lo pone el server (`Content-Disposition`, `hcFileBase` + `hcShortId`); acá solo se lee.
 */
import type { HcFichaFormat } from "@/lib/hc-export-logic";
import { FICHA_CARD_COPY as CARD_COPY } from "@/components/fichas/fichas-copy";
import { downloadErrorMessage, filenameFromDisposition, fichaDownloadUrl } from "@/components/fichas/ficha-share-download-logic";

export type FichaDownloadResult = { ok: true; filename: string } | { ok: false; error: string };

/** Lo que usa del toast (inyectado: así el módulo no depende del provider y el test pasa un doble). */
export type DownloadToast = {
  info: (title: string, opts?: { id?: string; duration?: number }) => string;
  error: (title: string, opts?: { id?: string }) => string;
  dismiss: (id: string) => void;
};

export async function downloadFicha(
  input: { patientId: string; rootId: string; format: HcFichaFormat },
  toast?: DownloadToast | null,
  deps: { fetch?: typeof fetch; save?: (blob: Blob, filename: string) => void } = {},
): Promise<FichaDownloadResult> {
  const doFetch = deps.fetch ?? fetch;
  const save = deps.save ?? saveBlob;
  // El PDF tarda 1-2 s en armarse: sin un aviso el click parece no haber hecho nada y se repite (cada uno cuenta
  // para el rate limit de 60 / 10 min). Mismo id → el aviso se reemplaza, no se apila.
  const progressId = `ficha-dl:${input.rootId}:${input.format}`;
  toast?.info(CARD_COPY.downloading, { id: progressId, duration: 0 });
  const done = (r: FichaDownloadResult): FichaDownloadResult => {
    toast?.dismiss(progressId);
    if (!r.ok) toast?.error(r.error);
    return r;
  };
  let res: Response;
  try {
    res = await doFetch(fichaDownloadUrl(input.patientId, input.rootId, input.format), {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return done({ ok: false, error: CARD_COPY.downloadNetwork });
  }
  if (!res.ok) {
    let body: string | null = null;
    try {
      body = await res.text();
    } catch {
      body = null;
    }
    return done({ ok: false, error: downloadErrorMessage(res.status, body) });
  }
  try {
    const blob = await res.blob();
    const filename = filenameFromDisposition(res.headers.get("Content-Disposition"), `ficha.${input.format}`);
    save(blob, filename);
    return done({ ok: true, filename });
  } catch {
    return done({ ok: false, error: CARD_COPY.downloadNetwork });
  }
}

/**
 * Blob → descarga. El object URL se revoca después de un tick: revocarlo en el mismo turno que el click cancela la
 * descarga en Safari.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
