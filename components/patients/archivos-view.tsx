"use client";

/**
 * HC Archivos tab — uploads, list, signed downloads, delete. Lazy
 * loads on tab open via `listPatientFiles`. Re-fetches on every
 * successful mutation (controlled by a `bump` counter so the effect
 * dep array re-fires).
 */
import { useEffect, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconFile, IconX } from "@/components/ui/icons";
import {
  deletePatientFile,
  getDownloadUrl,
  listPatientFiles,
  uploadPatientFile,
} from "@/lib/files";
import type { PatientFileRow } from "@/lib/files-types";

const FILE_CATEGORIES: { value: string; label: string }[] = [
  { value: "REPORT", label: "Informe / estudio" },
  { value: "DERIVATION", label: "Derivación" },
  { value: "CONSENT", label: "Consentimiento" },
  { value: "IMAGE", label: "Imagen / video" },
  { value: "RECEIPT", label: "Recibo" },
  { value: "OTHER", label: "Otro" },
];

export function ArchivosView({ patientId }: { patientId: string }) {
  const [files, setFiles] = useState<PatientFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

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

  const onUpload = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await uploadPatientFile(patientId, formData);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      refresh();
    });
  };

  const onDelete = (id: string) => {
    if (!confirm("¿Eliminar este archivo?")) return;
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
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 14 }}>
      <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
          Subir archivo
        </div>
        <form action={onUpload} style={{ display: "grid", gap: 10 }}>
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
            }}
          >
            <input type="file" name="file" required style={{ display: "none" }} />
            <IconFile size={20} />
            <div style={{ marginTop: 6, fontWeight: 600 }}>Elegir archivo</div>
            <div style={{ fontSize: 10.5, color: "var(--navy-300)", marginTop: 2 }}>
              Hasta 25 MB · PDF, jpg, png…
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
          {error && (
            <div
              style={{
                padding: 8,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 11.5,
              }}
            >
              {error}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Subiendo…" : "Subir"}
          </Button>
        </form>
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
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
          <span style={{ textAlign: "right" }}>Acción</span>
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
                {f.hasDownload && (
                  <button
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
                <button
                  onClick={() => onDelete(f.id)}
                  style={{
                    background: "transparent",
                    color: "#9F1F1F",
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
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
