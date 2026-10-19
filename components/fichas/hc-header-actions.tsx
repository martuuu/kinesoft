"use client";

/**
 * FC-3e1 (§24.7 «Inicio de la HC», C-FC7, FC-D31) · Acciones del encabezado de la historia clínica:
 *   - «Imprimir historia clínica» → la página imprimible (auditada en el server, sin tope de tamaño);
 *   - «Descargar historia clínica completa (PDF)» → `GET /api/pacientes/{id}/historia-clinica/pdf`;
 *   - menú «⋯»: «Importar fichas de Word» (`WordImportDrawer`) y «Carpeta de respaldo» (`BackupSetup`).
 *
 * Por qué la descarga va por `fetch` + blob y no por un `<a href>` directo: la ruta responde 413 con el copy de
 * FC-D31 («Usá Imprimir historia clínica»), 429 con el de rate limit y 503 SIN cuerpo si el audit falla (C-FC7). Con
 * un link, cualquiera de esos deja al profesional en una pestaña con texto plano o en blanco; acá se convierten en un
 * toast y el perfil queda donde estaba. 4 MB de tope (el server ya lo hace cumplir) entra sin drama en memoria.
 *
 * Diferidos: `WordImportDrawer` (mammoth detrás) y `BackupSetup` (IndexedDB, File System Access) van por
 * `next/dynamic` y se bajan recién al elegir la opción del menú (§24.9; `hc-first-load-guard` lo frena si alguien
 * los importa estático desde acá).
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import type { FichaBackupScope } from "@/components/fichas/fichas-ui-types";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";

const loadWordImport = () => import("@/components/fichas/word-import-drawer");
const WordImportDrawer = dynamic(() => loadWordImport().then((m) => m.WordImportDrawer), { ssr: false, loading: () => null });
const loadBackupSetup = () => import("@/components/fichas/backup-setup");
const BackupSetup = dynamic(() => loadBackupSetup().then((m) => m.BackupSetup), { ssr: false, loading: () => null });

/** Ruta auditada de la HC completa (C-FC7). Solo PDF (FC-D31). */
export function hcRecordPdfUrl(patientId: string): string {
  return `/api/pacientes/${encodeURIComponent(patientId)}/historia-clinica/pdf`;
}

/**
 * Status de la ruta → mensaje para el toast (null = OK). Pura, con test.
 * - 413: el texto plano que manda la ruta (FC-D31); si viniera vacío, el mismo copy de `HC_EXPORT_COPY`.
 * - 429: rate limit (5 / 10 min, la HC completa es el render caro).
 * - 503 (audit caído, sin cuerpo), 500, 404 y cualquier otro: «No pudimos armar el archivo». No se distingue el 404
 *   (paciente ajeno o sin acceso): el botón solo existe si la HC se ve, así que un 404 acá es una carrera.
 */
export function hcRecordDownloadError(status: number, bodyText: string | null): string | null {
  if (status >= 200 && status < 300) return null;
  const text = bodyText?.trim() ?? "";
  if (status === 413) return text || HC_EXPORT_COPY.recordTooLarge;
  if (status === 429) return HC_EXPORT_COPY.rateLimited;
  return HC_EXPORT_COPY.renderFailed;
}

/**
 * Nombre del archivo desde `Content-Disposition` (`filename*=UTF-8''…` primero: lleva los acentos; si no, el
 * `filename="…"` ASCII). El server ya lo sanea (`attachmentDisposition`); acá solo se lee. Pura, con test.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      const v = decodeURIComponent(star[1].trim());
      if (v) return v;
    } catch {
      // Codificación rota: se cae al `filename` ASCII.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header);
  return plain && plain[1] ? plain[1] : fallback;
}

export type HcHeaderActionsProps = {
  patientId: string;
  patientName: string;
  /** Hay al menos una ficha (anulada incluida): sin fichas imprimir/descargar sacaba una hoja vacía. */
  hasNotes: boolean;
  /** `canWriteClinicalNotes`: importar crea fichas. */
  canWrite: boolean;
  /** Alcance del handle de la carpeta (`{tenant}:{user}`); null = no se ofrece la carpeta (falta el viewer). */
  backupScope: FichaBackupScope | null;
  /** Fichas creadas por el import (una por archivo/parte). */
  onImported?: (notes: ClinicalNoteDTO[]) => void;
};

const MENU_ITEM_STYLE: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  padding: "10px 12px",
  borderRadius: 8,
  fontSize: 13,
  color: "var(--navy-900)",
  cursor: "pointer",
  minHeight: 44,
};

export function HcHeaderActions({ patientId, patientName, hasNotes, canWrite, backupScope, onImported }: HcHeaderActionsProps) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `hc-more-${patientId}`;

  const showImport = canWrite;
  const showBackup = backupScope != null;
  const hasMenu = showImport || showBackup;

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    // Foco al primer ítem al abrir (patrón de menú: la flecha y Enter siguen desde ahí).
    wrapRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(wrapRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const downloadRecord = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(hcRecordPdfUrl(patientId), { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) {
        const text = res.status === 413 ? await res.text().catch(() => "") : null;
        toast.error(hcRecordDownloadError(res.status, text) ?? HC_EXPORT_COPY.renderFailed);
        return;
      }
      const blob = await res.blob();
      const name = filenameFromDisposition(res.headers.get("content-disposition"), "historia-clinica.pdf");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Un tick para que el navegador arranque la descarga antes de soltar el blob (Safari la corta si se revoca ya).
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error("descarga de la HC completa falló", e);
      toast.error(HC_EXPORT_COPY.renderFailed);
    } finally {
      setDownloading(false);
    }
  };

  const printHref = `/pacientes/${encodeURIComponent(patientId)}/imprimir`;

  return (
    <div ref={wrapRef} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", position: "relative" }}>
      {hasNotes && (
        <>
          <a
            className="k-btn k-btn-ghost k-evo-head-btn"
            href={printHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, padding: "8px 12px", textDecoration: "none" }}
          >
            {HC_HOME_COPY.print}
          </a>
          <button
            type="button"
            className="k-btn k-btn-ghost k-evo-head-btn"
            onClick={() => void downloadRecord()}
            disabled={downloading}
            aria-busy={downloading || undefined}
            data-hc-download-record=""
            style={{ fontSize: 12, padding: "8px 12px" }}
          >
            {HC_HOME_COPY.downloadRecord}
          </button>
        </>
      )}
      {hasMenu && (
        <>
          <button
            ref={menuBtnRef}
            type="button"
            className="k-btn k-btn-ghost k-evo-head-btn"
            aria-label={HC_HOME_COPY.moreActions}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((v) => !v)}
            onPointerEnter={() => {
              // Precarga barata de lo que el menú abre (dos chunks chicos; mammoth no: lo carga el drawer al leer).
              if (showImport) void loadWordImport().catch(() => {});
              if (showBackup) void loadBackupSetup().catch(() => {});
            }}
            style={{ fontSize: 16, fontWeight: 700, padding: "6px 12px", lineHeight: 1 }}
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              id={menuId}
              role="menu"
              aria-label={HC_HOME_COPY.moreActions}
              className="k-glass-strong"
              onKeyDown={onMenuKeyDown}
              style={{ position: "absolute", top: "100%", right: 0, marginTop: 4, minWidth: 240, borderRadius: 12, padding: 4, zIndex: 25 }}
            >
              {showImport && (
                <button
                  type="button"
                  role="menuitem"
                  style={MENU_ITEM_STYLE}
                  onClick={() => {
                    setMenuOpen(false);
                    setImportOpen(true);
                  }}
                >
                  {HC_HOME_COPY.importWord}
                </button>
              )}
              {showBackup && (
                <button
                  type="button"
                  role="menuitem"
                  style={MENU_ITEM_STYLE}
                  onClick={() => {
                    setMenuOpen(false);
                    setBackupOpen(true);
                  }}
                >
                  {HC_HOME_COPY.backupFolder}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {importOpen && (
        <WordImportDrawer
          open
          onClose={() => setImportOpen(false)}
          patientId={patientId}
          patientName={patientName}
          onImported={(notes) => onImported?.(notes)}
        />
      )}
      {backupOpen && backupScope && (
        <Modal open onClose={() => setBackupOpen(false)} title={HC_HOME_COPY.backupFolder} width={520}>
          <BackupSetup scope={backupScope} variant="dialog" onClose={() => setBackupOpen(false)} />
        </Modal>
      )}
    </div>
  );
}
