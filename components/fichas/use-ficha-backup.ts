/**
 * FC-3g (T4, §24.6, FC-D13) · `useFichaBackup(scope)` — firma CONGELADA (`UseFichaBackupResult`, fichas-ui-types.ts).
 *
 * La carpeta de respaldo: cada ficha que el profesional guarda (o edita, enmienda o anula EN ESTE dispositivo) se
 * escribe como PDF en una carpeta de su computadora, con File System Access (Chrome/Edge de escritorio o la PWA). En
 * los demás navegadores, descarga común.
 *
 * Reglas que este archivo hace cumplir:
 * 1. Bytes SIEMPRE desde la ruta auditada `/api/pacientes/{id}/fichas/{rootId}/pdf` (C-FC7): el server audita
 *    `clinicalNote.download` antes del primer byte y aplica el rate limit. Nunca se arma el PDF en el cliente.
 * 2. El permiso se pide AL PRINCIPIO del gesto (`saveFichaBackup`: `requestPermission` es lo primero, sincrónico,
 *    antes de cualquier await). Chrome exige activación transitoria para mostrar el prompt; un await antes (aunque
 *    sea cargar el módulo) la consume y el permiso falla con `SecurityError`. Por eso el handle se lee del IndexedDB
 *    al montar y queda en un ref: en el click ya está en memoria.
 * 3. Nada del respaldo en el first load: `lib/hc-backup*` entran por `import()` y por el chunk que YA existe de
 *    `backup-setup.tsx` (lo usa el menú «⋯»). Un `import()` nuevo armaría un chunk nuevo y cada chunk suma ~20 B al
 *    runtime de webpack de TODAS las rutas (`/agenda` no tiene margen, handoff de FC-3i1). Acá solo queda el
 *    chequeo barato de `showDirectoryPicker` y la descarga de respaldo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BACKUP_COPY as COPY } from "@/components/fichas/fichas-copy";
import type {
  FichaBackupOutcome,
  FichaBackupScope,
  FichaBackupStatus,
  FichaBackupTarget,
  UseFichaBackupResult,
} from "@/components/fichas/fichas-ui-types";
import type { BackupRuntime } from "@/components/fichas/backup-setup";
import type { BackupDirHandle } from "@/lib/hc-backup";

/** Ruta auditada de la descarga (C-FC7). La enmienda da 404: siempre el id de la raíz (handoff de FC-2g). */
export function fichaPdfUrl(t: Pick<FichaBackupTarget, "patientId" | "noteId">): string {
  return `/api/pacientes/${encodeURIComponent(t.patientId)}/fichas/${encodeURIComponent(t.noteId)}/pdf`;
}

/**
 * `BackupSetup` lo dispara al elegir, cambiar u olvidar la carpeta: el hook de la HC (montado una vez por perfil)
 * vuelve a leer el estado sin que el caller tenga que cablear `refresh` hasta el diálogo.
 */
export const BACKUP_CHANGED_EVENT = "kinesoft:hc-backup-changed";

const loadBackupRuntime = (): Promise<BackupRuntime> => import("@/components/fichas/backup-setup").then((m) => m.backupRuntime);

/** Chequeo sincrónico y barato (el completo, con mobile y contexto seguro, es `detectBackupSupport` del diferido). */
function mayHavePicker(): boolean {
  return typeof window !== "undefined" && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

/**
 * Fallback de Safari/Firefox/mobile: descarga común desde la ruta auditada. `attachment` + mismo origen: el navegador
 * baja el archivo sin navegar. Un <a> y no `window.open`: no abre una pestaña en blanco ni lo frena el bloqueador.
 */
function downloadFallback(target: FichaBackupTarget): FichaBackupOutcome {
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
    return { ok: false, error: COPY.failed };
  }
}

export type BackupSaveDeps = {
  /** El handle autorizado o por autorizar (null = sin carpeta / sin soporte → descarga común). */
  getHandle: () => BackupDirHandle | null;
  load: () => Promise<Pick<BackupRuntime, "backupPathFor" | "writeBackupFile" | "downloadErrorMessage">>;
  fetch: typeof fetch;
  download: (target: FichaBackupTarget) => FichaBackupOutcome;
  onStatus: (s: FichaBackupStatus) => void;
};

/**
 * El cuerpo de `save`, fuera del hook para probarlo sin React (`tests/unit/use-ficha-backup.test.ts`).
 * NO es `async` a propósito: todo lo que va antes del primer `await` corre dentro del gesto, y así queda explícito
 * que `requestPermission` es lo primero que pasa. Si el permiso ya está concedido, Chrome devuelve `granted` sin
 * prompt y sin necesitar el gesto (es el caso de la sobrescritura después de editar: ahí ya pasó el await de la action).
 */
export function saveFichaBackup(target: FichaBackupTarget, deps: BackupSaveDeps): Promise<FichaBackupOutcome> {
  const handle = deps.getHandle();
  if (!handle) return Promise.resolve(deps.download(target));
  let permission: Promise<PermissionState>;
  try {
    permission = Promise.resolve(handle.requestPermission({ mode: "readwrite" }));
  } catch {
    permission = Promise.resolve("denied");
  }
  return (async (): Promise<FichaBackupOutcome> => {
    const state = await permission.catch((): PermissionState => "denied");
    if (state !== "granted") {
      deps.onStatus("needs-permission");
      return { ok: false, error: COPY.permissionDenied };
    }
    deps.onStatus("ready");
    try {
      const rt = await deps.load();
      const res = await deps.fetch(fichaPdfUrl(target), { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const body = await res.text().catch(() => null);
        return { ok: false, error: rt.downloadErrorMessage(res.status, body) };
      }
      const blob = await res.blob();
      const path = rt.backupPathFor(target);
      await rt.writeBackupFile(handle, path, blob);
      return { ok: true, via: "folder", path: path.display };
    } catch (e) {
      // La carpeta se movió o se borró: el handle quedó huérfano. Se ofrece elegirla de nuevo.
      if ((e as { name?: string } | null)?.name === "NotFoundError") {
        deps.onStatus("unconfigured");
        return { ok: false, error: COPY.folderMissing };
      }
      return { ok: false, error: COPY.failed };
    }
  })();
}

export function useFichaBackup(scope: FichaBackupScope | null): UseFichaBackupResult {
  const tenantId = scope?.tenantId ?? null;
  const userId = scope?.userId ?? null;
  // `checking` en el SSR y el primer render: nunca se ofrece la carpeta antes de saber (y no hay mismatch).
  const [status, setStatus] = useState<FichaBackupStatus>("checking");
  const [version, setVersion] = useState(0);
  const handleRef = useRef<BackupDirHandle | null>(null);

  useEffect(() => {
    let alive = true;
    handleRef.current = null;
    if (!tenantId || !userId || !mayHavePicker()) {
      setStatus("unsupported");
      return;
    }
    setStatus("checking");
    loadBackupRuntime()
      .then(async (rt): Promise<FichaBackupStatus | null> => {
        if (!rt.detectBackupSupport(window)) return "unsupported";
        const stored = await rt.readBackup({ tenantId, userId });
        if (!alive) return null;
        if (!stored) return "unconfigured";
        handleRef.current = stored.handle;
        const p = await stored.handle.queryPermission({ mode: "readwrite" }).catch((): PermissionState => "prompt");
        return p === "granted" ? "ready" : "needs-permission";
      })
      // IndexedDB bloqueado o el chunk no bajó: descarga común, que siempre funciona.
      .catch((): FichaBackupStatus => "unsupported")
      .then((s) => {
        if (alive && s) setStatus(s);
      });
    return () => {
      alive = false;
    };
  }, [tenantId, userId, version]);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(BACKUP_CHANGED_EVENT, bump);
    return () => window.removeEventListener(BACKUP_CHANGED_EVENT, bump);
  }, []);

  const save = useCallback(
    (target: FichaBackupTarget) =>
      saveFichaBackup(target, {
        getHandle: () => handleRef.current,
        load: loadBackupRuntime,
        fetch: (input, init) => fetch(input, init),
        download: downloadFallback,
        onStatus: setStatus,
      }),
    []
  );

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { status, save, refresh };
}
