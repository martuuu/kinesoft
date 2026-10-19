"use client";

/**
 * FC-3g (T4, §24.6, FC-D13) · `BackupSetup` — props CONGELADAS (`BackupSetupProps`, fichas-ui-types.ts).
 *
 * DIFERIDO (§24.9): lo cargan «Mis fichas» en Configuración y el menú «⋯» de la HC («Carpeta de respaldo») por
 * `next/dynamic`; nunca entra al first load de `/pacientes/[id]` (`hc-first-load-guard`). Su chunk es también el
 * que `use-ficha-backup.ts` baja por `import()` para leer el handle (`backupRuntime`): un solo chunk diferido para
 * todo el respaldo, sin sumarle otro al runtime de webpack.
 *
 * Qué hace:
 * - Aviso de datos de salud y casilla OBLIGATORIA «Esta computadora la uso solo yo»: los PDF quedan en el disco sin
 *   cifrar, fuera de la sesión de KineSoft; en una PC compartida (recepción) cualquiera que abra la carpeta los ve.
 *   Sin la casilla tildada no se abre el selector (y `chooseBackupFolder` lo vuelve a chequear).
 * - Elegir / cambiar la carpeta (`showDirectoryPicker`, llamado PRIMERO dentro del click), dar permiso de nuevo
 *   (`requestPermission`, idem) y dejar de usarla (borra el handle del IndexedDB; los PDF ya escritos quedan).
 * - Fuera de Chrome/Edge de escritorio o la PWA: dice que el PDF se descarga y nada más.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { BACKUP_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { BackupSetupProps } from "@/components/fichas/fichas-ui-types";
import { BACKUP_CHANGED_EVENT } from "@/components/fichas/use-ficha-backup";
import { downloadErrorMessage } from "@/components/fichas/ficha-share-download-logic";
import { backupPathFor, detectBackupSupport, writeBackupFile } from "@/lib/hc-backup";
import {
  chooseBackupFolder,
  clearBackup,
  readBackup,
  type DirectoryPickerHost,
  type StoredBackup,
} from "@/lib/hc-backup-idb";

/** Lo que `useFichaBackup` usa del respaldo, por el mismo chunk que este componente (ver arriba). */
export const backupRuntime = { detectBackupSupport, readBackup, backupPathFor, writeBackupFile, downloadErrorMessage };
export type BackupRuntime = typeof backupRuntime;

export type BackupSetupPhase = "checking" | "unsupported" | "unconfigured" | "needs-permission" | "ready";

function notifyChanged() {
  try {
    window.dispatchEvent(new Event(BACKUP_CHANGED_EVENT));
  } catch {
    // Sin window (no pasa en el cliente): el hook se re-lee al volver a montar.
  }
}

export function BackupSetup({ scope, variant, onClose, onConfigured }: BackupSetupProps) {
  const [phase, setPhase] = useState<BackupSetupPhase>("checking");
  const [record, setRecord] = useState<StoredBackup | null>(null);
  const [soloUser, setSoloUser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tenantId, userId } = scope;

  useEffect(() => {
    let alive = true;
    void (async (): Promise<[BackupSetupPhase, StoredBackup | null]> => {
      if (!detectBackupSupport(typeof window === "undefined" ? null : window)) return ["unsupported", null];
      const stored = await readBackup({ tenantId, userId });
      if (!stored) return ["unconfigured", null];
      const p = await stored.handle.queryPermission({ mode: "readwrite" }).catch((): PermissionState => "prompt");
      return [p === "granted" ? "ready" : "needs-permission", stored];
    })()
      .catch((): [BackupSetupPhase, StoredBackup | null] => ["unsupported", null])
      .then(([p, r]) => {
        if (!alive) return;
        setPhase(p);
        setRecord(r);
      });
    return () => {
      alive = false;
    };
  }, [tenantId, userId]);

  const changed = useCallback(() => {
    notifyChanged();
    onConfigured?.();
  }, [onConfigured]);

  /** Click de «Elegir/Cambiar carpeta»: `chooseBackupFolder` abre el selector ANTES de cualquier await. */
  const onChoose = () => {
    const pending = chooseBackupFolder({ tenantId, userId }, soloUser, window as unknown as DirectoryPickerHost);
    setError(null);
    setBusy(true);
    void pending.then((r) => {
      setBusy(false);
      if (r.ok) {
        setRecord(r.record);
        setPhase("ready");
        setSoloUser(false);
        changed();
      } else if (!r.cancelled) setError(soloUser ? COPY.chooseFailed : COPY.soloUserRequired);
    });
  };

  /** «Dar permiso ahora»: `requestPermission` es lo primero del click (mismo motivo). */
  const onGrant = () => {
    if (!record) return;
    let pending: Promise<PermissionState>;
    try {
      pending = Promise.resolve(record.handle.requestPermission({ mode: "readwrite" }));
    } catch {
      pending = Promise.resolve("denied");
    }
    setError(null);
    void pending
      .catch((): PermissionState => "denied")
      .then((p) => {
        if (p === "granted") {
          setPhase("ready");
          changed();
        } else setError(COPY.permissionDenied);
      });
  };

  const onForget = () => {
    setBusy(true);
    setError(null);
    void clearBackup({ tenantId, userId })
      .then(() => {
        setRecord(null);
        setPhase("unconfigured");
        changed();
      })
      .catch(() => setError(COPY.failed))
      .finally(() => setBusy(false));
  };

  return (
    <BackupSetupView
      variant={variant}
      phase={phase}
      folderName={record?.folderName ?? null}
      soloUser={soloUser}
      busy={busy}
      error={error}
      onSoloUserChange={setSoloUser}
      onChoose={onChoose}
      onGrant={onGrant}
      onForget={onForget}
      onClose={onClose}
    />
  );
}

export type BackupSetupViewProps = {
  variant: BackupSetupProps["variant"];
  phase: BackupSetupPhase;
  folderName: string | null;
  soloUser: boolean;
  busy: boolean;
  error: string | null;
  onSoloUserChange: (v: boolean) => void;
  onChoose: () => void;
  onGrant: () => void;
  onForget: () => void;
  onClose?: () => void;
};

/** Presentacional (render test en node, sin efectos). */
export function BackupSetupView(p: BackupSetupViewProps) {
  const checkId = useId();
  const hintId = `${checkId}-hint`;
  const configured = p.phase === "ready" || p.phase === "needs-permission";
  const pickable = p.phase !== "checking" && p.phase !== "unsupported";
  return (
    <section aria-label={COPY.title} style={{ display: "grid", gap: 12 }} data-backup-phase={p.phase}>
      {p.variant === "panel" && <h3 style={{ margin: 0, fontSize: 15, color: "var(--navy-900)" }}>{COPY.title}</h3>}
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>{COPY.intro}</p>

      {p.phase === "checking" && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
          {COPY.checking}
        </p>
      )}
      {p.phase === "unsupported" && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
          {COPY.unsupported}
        </p>
      )}

      {configured && p.folderName && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-900)", fontWeight: 600 }}>
          {COPY.ready(p.folderName)}
        </p>
      )}
      {p.phase === "needs-permission" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", flex: "1 1 220px" }}>{COPY.needsPermission}</p>
          <Button type="button" variant="ghost" size="sm" onClick={p.onGrant} disabled={p.busy}>
            {COPY.grant}
          </Button>
        </div>
      )}

      {pickable && (
        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: "var(--r-md)",
            background: "var(--sky-50)",
            border: "1px solid var(--sky-200)",
          }}
        >
          <p id={hintId} style={{ margin: 0, fontSize: 13, color: "var(--navy-900)" }}>
            {COPY.soloUserHint}
          </p>
          <label htmlFor={checkId} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, cursor: "pointer" }}>
            <input
              id={checkId}
              type="checkbox"
              checked={p.soloUser}
              disabled={p.busy}
              aria-describedby={hintId}
              onChange={(e) => p.onSoloUserChange(e.currentTarget.checked)}
              style={{ width: 18, height: 18 }}
            />
            {COPY.soloUser}
          </label>
        </div>
      )}

      {p.error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: "var(--danger-fg)" }}>
          {p.error}
        </p>
      )}

      {(pickable || p.onClose) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          {configured && (
            <Button type="button" variant="ghost" onClick={p.onForget} disabled={p.busy}>
              {COPY.forget}
            </Button>
          )}
          {p.onClose && (
            <Button type="button" variant="ghost" onClick={p.onClose}>
              {COPY.close}
            </Button>
          )}
          {pickable && (
            <Button type="button" onClick={p.onChoose} disabled={p.busy || !p.soloUser} aria-describedby={hintId}>
              {configured ? COPY.change : COPY.choose}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
