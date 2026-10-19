"use client";

/**
 * HC Archivos tab — uploads, list, signed downloads, delete. Lazy
 * loads on tab open via `listPatientFiles`. Re-fetches on every
 * successful mutation (controlled by a `bump` counter so the effect
 * dep array re-fires).
 */
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconFile, IconX } from "@/components/ui/icons";
import styles from "./archivos-view.module.css";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  confirmPatientFileUpload,
  deletePatientFile,
  getDownloadUrl,
  listPatientFiles,
  requestPatientFileUpload,
  uploadPatientFile,
} from "@/lib/files";
import type { PatientFileRow } from "@/lib/files-types";
import type { PatientFileCategory } from "@prisma/client";
import {
  UPLOAD_COPY,
  putWithXhr,
  runPatientFileUpload,
  uploadProgressPercent,
  validateUploadFile,
  type UploadDeps,
  type UploadState,
} from "@/lib/files-upload-logic";

/*
 * FC-4b (C-FC10): la subida va directo a Storage con una URL firmada (25 MB reales; antes el body de la action cortaba
 * en 4,5 MB). La máquina de estados y el PUT viven en `lib/files-upload-logic.ts` (con test); acá solo se pinta.
 */
const UPLOAD_DEPS: Omit<UploadDeps, "uploadStub"> = {
  request: requestPatientFileUpload,
  put: putWithXhr,
  confirm: confirmPatientFileUpload,
};

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FILE_CATEGORIES: { value: string; label: string }[] = [
  { value: "REPORT", label: "Informe / estudio" },
  { value: "DERIVATION", label: "Derivación" },
  { value: "CONSENT", label: "Consentimiento" },
  { value: "IMAGE", label: "Imagen / video" },
  { value: "RECEIPT", label: "Recibo" },
  { value: "OTHER", label: "Otro" },
];

export function ArchivosView({
  patientId,
  readOnly = false,
}: {
  patientId: string;
  /**
   * Acceso ≠ `full` = solo ver la lista: sin subir, borrar ni descargar (las
   * actions de lib/files.ts ya lo rechazan en el server; esto evita ofrecer
   * botones que fallan). Hoy el perfil solo se monta con acceso `full`, así
   * que el default es editable, igual que `TurnosView`.
   */
  readOnly?: boolean;
}) {
  const [files, setFiles] = useState<PatientFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const confirm = useConfirm();

  // Sequence-guarded fetch: a rapid patientId switch can't have a stale
  // response from the previous patient overwrite the current one.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listPatientFiles(patientId)
      .then((r) => {
        if (cancelled) return;
        setFiles(r);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, bump]);

  const refresh = () => setBump((b) => b + 1);

  // Subida en curso: `null` = no hay. Va fuera de `useTransition` para que la barra se actualice en cada evento de
  // progreso (dentro de una transición React difiere los renders y la barra saltaba de 0 a 100).
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const uploading = upload !== null && upload.phase !== "done";

  // Si se desmonta (cambio de pestaña o de paciente) con un PUT en vuelo, se corta: no queda subiendo en segundo plano
  // un archivo cuya confirmación nadie va a pedir (lo que quede en `pending/` lo barre el cron).
  useEffect(() => () => abortRef.current?.abort(), []);

  const onPick = (file: File | null) => {
    setError(null);
    setChosen(file);
    // Validación previa al elegir: más de 25 MB o un tipo no permitido se avisa antes de apretar «Subir».
    if (file) {
      const v = validateUploadFile(file);
      if (!v.ok) setError(v.error);
    }
  };

  const onUpload = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (uploading) return;
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = chosen ?? (fd.get("file") instanceof File ? (fd.get("file") as File) : null);
    if (!file || file.size === 0) {
      setError(file ? UPLOAD_COPY.empty : UPLOAD_COPY.noFile);
      return;
    }
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    const outcome = await runPatientFileUpload(
      {
        ...UPLOAD_DEPS,
        // El camino stub necesita el paciente: `uploadPatientFile(patientId, formData)`.
        uploadStub: (stubFd) => uploadPatientFile(patientId, stubFd),
      },
      {
        patientId,
        file,
        category: String(fd.get("category") ?? "OTHER") as PatientFileCategory,
        description: String(fd.get("description") ?? ""),
      },
      setUpload,
      ac.signal,
    );
    if (abortRef.current === ac) abortRef.current = null;
    if (ac.signal.aborted && outcome.kind !== "done") {
      // Desmontado o cancelado: no se pinta nada sobre un componente que puede no estar.
      setUpload(null);
      return;
    }
    if (outcome.kind === "done") {
      formRef.current?.reset();
      setChosen(null);
      setUpload(null);
      refresh();
      return;
    }
    setUpload(null);
    if (outcome.kind === "error") setError(outcome.message);
  };

  const onCancel = () => {
    abortRef.current?.abort();
    setError(UPLOAD_COPY.cancelled);
  };

  // A2b-S-ui: `useConfirm` en vez del `window.confirm` nativo (AGENTS §5).
  const onDelete = async (id: string) => {
    const ok = await confirm({
      title: "¿Eliminar este archivo?",
      message: "Se borra de la historia clínica del paciente. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deletePatientFile(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setFiles((s) => s.filter((f) => f.id !== id));
    });
  };

  const onDownload = (id: string) => {
    start(async () => {
      const r = await getDownloadUrl(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.open(r.data.url, "_blank");
    });
  };

  return (
    // MB-1d: grilla por clase (< 768 una columna; ver archivos-view.module.css).
    <div className={`${styles.layout} ${readOnly ? styles.layoutReadOnly : ""}`}>
      {!readOnly && (
      <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
          Subir archivo
        </div>
        <form ref={formRef} onSubmit={onUpload} style={{ display: "grid", gap: 10 }}>
          <label
            style={{
              padding: "20px 14px",
              border: "1.5px dashed rgba(31,79,190,0.4)",
              borderRadius: 14,
              textAlign: "center",
              cursor: "pointer",
              background: "rgba(31,79,190,0.05)",
              fontSize: 12.5,
              color: "var(--navy-700)",
              display: "block",
              position: "relative",
            }}
          >
            <input
              type="file"
              name="file"
              required
              disabled={uploading}
              // `display:none` sacaba el input del orden de foco: con teclado no se podía elegir archivo. Oculto a la
              // vista pero enfocable (el foco se ve en la etiqueta con :focus-within).
              className={styles.fileInput}
              onChange={(e) => onPick(e.currentTarget.files?.[0] ?? null)}
            />
            <IconFile size={20} />
            <div style={{ marginTop: 6, fontWeight: 600, overflowWrap: "anywhere" }}>
              {chosen ? chosen.name : "Elegir archivo"}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--navy-300)", marginTop: 2 }}>
              {chosen ? formatSize(chosen.size) : "Hasta 25 MB · PDF, imágenes, video, Word, Excel…"}
            </div>
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-500)" }}>
            Categoría
            <select
              name="category"
              defaultValue="REPORT"
              style={{
                marginTop: 4,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                fontSize: 13,
              }}
            >
              {FILE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-500)" }}>
            Descripción (opcional)
            <input
              name="description"
              style={{
                marginTop: 4,
                width: "100%",
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                fontSize: 13,
              }}
            />
          </label>
          {upload && upload.phase !== "done" && (
            <UploadProgress state={upload} />
          )}
          {error && (
            <div
              role="alert"
              style={{
                padding: 8,
                borderRadius: 10,
                background: "var(--danger-bg)",
                color: "var(--danger-fg)",
                fontSize: 11.5,
              }}
            >
              {error}
            </div>
          )}
          {uploading ? (
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              // Mientras el server confirma ya no se cancela (ver `runPatientFileUpload`).
              disabled={upload?.phase === "confirming"}
            >
              Cancelar subida
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={pending}>
              Subir
            </Button>
          )}
        </form>
      </Card>
      )}

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className={styles.tableScroll}>
        <div className={styles.table}>
        <div
          style={{
            padding: "12px 18px",
            display: "grid",
            gridTemplateColumns: "1.5fr 1fr 80px 90px 100px",
            gap: 14,
            fontSize: 10,
            fontWeight: 700,
            color: "var(--navy-300)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <span>Nombre</span>
          <span>Categoría</span>
          <span>Tamaño</span>
          <span>Subido</span>
          <span style={{ textAlign: "right" }}>{readOnly ? "" : "Acción"}</span>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: "var(--navy-300)", textAlign: "center", fontSize: 13 }}>
            Cargando archivos…
          </div>
        ) : files.length === 0 ? (
          <div style={{ padding: 24, color: "var(--navy-300)", textAlign: "center", fontSize: 13 }}>
            Sin archivos cargados.
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.id}
              style={{
                padding: "12px 18px",
                display: "grid",
                gridTemplateColumns: "1.5fr 1fr 80px 90px 100px",
                gap: 14,
                alignItems: "center",
                fontSize: 13,
                borderBottom: "1px solid rgba(15,30,51,0.04)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{f.name}</div>
                {f.description && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{f.description}</div>
                )}
              </div>
              <span style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {FILE_CATEGORIES.find((c) => c.value === f.category)?.label ?? f.category}
              </span>
              <span className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {(f.sizeBytes / 1024).toFixed(0)} KB
              </span>
              <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>
                {f.createdAt.toLocaleDateString("es-AR", { day: "2-digit", month: "short", timeZone: "America/Argentina/Buenos_Aires" })}
              </span>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 4 }}>
                {!readOnly && f.hasDownload && (
                  <button
                    type="button"
                    className={styles.action}
                    onClick={() => onDownload(f.id)}
                    style={{
                      background: "rgba(31,79,190,0.08)",
                      color: "var(--sky-700)",
                      border: "none",
                      padding: "5px 10px",
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Descargar
                  </button>
                )}
                {!readOnly && (
                <button
                  type="button"
                  className={styles.action}
                  // Era un ícono solo, sin nombre accesible (el lector decía «botón»).
                  aria-label={`Eliminar ${f.name}`}
                  onClick={() => onDelete(f.id)}
                  style={{
                    background: "transparent",
                    color: "var(--danger-fg)",
                    border: "none",
                    padding: "5px 8px",
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  <IconX size={11} />
                </button>
                )}
              </div>
            </div>
          ))
        )}
        </div>
        </div>
      </Card>
    </div>
  );
}

/** Barra de la subida. Sin total (camino stub) es indeterminada: sin `aria-valuenow`, como pide ARIA. */
function UploadProgress({ state }: { state: UploadState }) {
  const known = state.phase === "uploading" && state.total > 0;
  const pct = known ? uploadProgressPercent(state.loaded, state.total) : state.phase === "confirming" ? 100 : 0;
  const label =
    state.phase === "requesting"
      ? "Preparando la subida…"
      : state.phase === "confirming"
        ? "Verificando el archivo…"
        : known
          ? `Subiendo… ${pct}%`
          : "Subiendo…";
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        role="progressbar"
        aria-label="Progreso de la subida"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known || state.phase === "confirming" ? pct : undefined}
        aria-valuetext={label}
        className={styles.progress}
      >
        <div
          className={`${styles.progressFill} ${known || state.phase === "confirming" ? "" : styles.progressIndeterminate}`}
          style={known || state.phase === "confirming" ? { width: `${pct}%` } : undefined}
        />
      </div>
      <div aria-hidden="true" style={{ fontSize: 11, color: "var(--navy-500)" }}>
        {label}
      </div>
    </div>
  );
}
