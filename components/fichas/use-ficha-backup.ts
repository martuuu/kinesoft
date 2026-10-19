/**
 * [FC-3k] `useFichaBackup` · stub FUNCIONAL con la firma congelada (`UseFichaBackupResult`, fichas-ui-types.ts).
 *
 * FC-3g lo implementa con la carpeta de respaldo (§24.6, FC-D13): File System Access en Chrome/Edge de escritorio o
 * la PWA, el handle en IndexedDB crudo (`lib/hc-backup-idb.ts`, base `hc-backup`, clave `{tenant}:{user}`), el permiso
 * pedido AL PRINCIPIO del gesto (antes de cualquier await) y la ruta de `backupPathFor` (`lib/hc-backup.ts`). Esos
 * módulos se cargan por `import()` dentro de `save`/la detección: el hook puede vivir en la tarjeta (first load) sin
 * arrastrar el respaldo (`hc-first-load-guard.test.ts` prohíbe alcanzarlos estático).
 *
 * Hasta entonces: `status` = `unsupported` y `save` descarga el PDF desde la ruta AUDITADA de la ficha (C-FC7, por el
 * id de la raíz), que es exactamente el fallback de Safari/Firefox. Nunca se arma el PDF en el cliente.
 */
import { useCallback, useState } from "react";
import type {
  FichaBackupOutcome,
  FichaBackupScope,
  FichaBackupStatus,
  FichaBackupTarget,
  UseFichaBackupResult,
} from "@/components/fichas/fichas-ui-types";

/** Ruta auditada de la descarga (C-FC7). La enmienda da 404: siempre el id de la raíz (handoff de FC-2g). */
export function fichaPdfUrl(t: Pick<FichaBackupTarget, "patientId" | "noteId">): string {
  return `/api/pacientes/${encodeURIComponent(t.patientId)}/fichas/${encodeURIComponent(t.noteId)}/pdf`;
}

export function useFichaBackup(scope: FichaBackupScope | null): UseFichaBackupResult {
  void scope;
  const [status] = useState<FichaBackupStatus>("unsupported");

  const save = useCallback(async (target: FichaBackupTarget): Promise<FichaBackupOutcome> => {
    // `attachment` + mismo origen: el navegador baja el archivo sin navegar. Un <a> y no `window.open`: no abre una
    // pestaña en blanco ni lo frena el bloqueador de pop-ups.
    try {
      const a = document.createElement("a");
      a.href = fichaPdfUrl(target);
      a.rel = "noopener";
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true, via: "download" };
    } catch {
      return { ok: false, error: "No pudimos descargar el PDF. Probá de nuevo." };
    }
  }, []);

  const refresh = useCallback(() => {}, []);
  return { status, save, refresh };
}
