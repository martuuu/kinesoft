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
import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useToast } from "@/components/ui/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { FICHA_CARD_COPY, HC_HOME_COPY } from "@/components/fichas/fichas-copy";
import type { FichaMenuProps } from "@/components/fichas/ficha-card-logic";
import type { FichaBackupScope } from "@/components/fichas/fichas-ui-types";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { HC_EXPORT_COPY } from "@/lib/hc-export-logic";

const loadWordImport = () => import("@/components/fichas/word-import-drawer");
const WordImportDrawer = dynamic(() => loadWordImport().then((m) => m.WordImportDrawer), { ssr: false, loading: () => null });
const loadBackupSetup = () => import("@/components/fichas/backup-setup");
const loadModal = () => import("@/components/ui/modal");
/**
 * T4-Z: el panel del «⋯» es el MISMO `FichaMenu` diferido de la tarjeta (mismo `import()` → mismo chunk, +0 kB). Se
 * precarga al pasar el mouse o enfocar el botón, igual que en la tarjeta.
 */
type HcMenuItemId = "importWord" | "backupFolder";
const loadFichaMenu = () => import("@/components/fichas/ficha-menu");
const HcMenu = dynamic(
  () => loadFichaMenu().then((m) => m.FichaMenu as (p: FichaMenuProps<HcMenuItemId>) => JSX.Element),
  { ssr: false, loading: () => null }
);
/**
 * FC-3i1 (bundle, §24.9): el `Modal` de la carpeta de respaldo viajaba ESTÁTICO en el first load de /pacientes/[id]
 * (Modal + focus trap ≈ 1,5 kB gz) solo para un diálogo que se abre desde el menú «⋯». Ahora Modal y `BackupSetup`
 * bajan juntos, en el mismo `import()`, al elegir la opción (la precarga del `pointerenter` ya trae los dos).
 */
const BackupDialog = dynamic(
  () =>
    Promise.all([loadModal(), loadBackupSetup()]).then(([{ Modal }, { BackupSetup }]) => {
      function BackupDialogInner({ scope, onClose }: { scope: FichaBackupScope; onClose: () => void }) {
        return (
          <Modal open onClose={onClose} title={HC_HOME_COPY.backupFolder} width={520}>
            <BackupSetup scope={scope} variant="dialog" onClose={onClose} />
          </Modal>
        );
      }
      return BackupDialogInner;
    }),
  { ssr: false, loading: () => null }
);

/** Ruta auditada de la HC completa (C-FC7). Solo PDF (FC-D31). */
export function hcRecordPdfUrl(patientId: string): string {
  return `/api/pacientes/${encodeURIComponent(patientId)}/historia-clinica/pdf`;
}

/**
 * Status de la ruta → mensaje para el toast (null = OK). Pura, con test.
 * - 413: el texto plano que manda la ruta (FC-D31); si viniera vacío, el mismo copy de `HC_EXPORT_COPY`.
 * - 429: rate limit (5 / 10 min, la HC completa es el render caro).
 * - 503: el audit falló y la ruta no mandó nada a propósito (C-FC7) → el mismo copy que la descarga de una ficha.
 * - 500, 404 y cualquier otro: «No pudimos armar el archivo». No se distingue el 404 (paciente ajeno o sin acceso): el
 *   botón solo existe si la HC se ve, así que un 404 acá es una carrera.
 */
export function hcRecordDownloadError(status: number, bodyText: string | null): string | null {
  if (status >= 200 && status < 300) return null;
  const text = bodyText?.trim() ?? "";
  if (status === 413) return text || HC_EXPORT_COPY.recordTooLarge;
  if (status === 429) return HC_EXPORT_COPY.rateLimited;
  if (status === 503) return FICHA_CARD_COPY.downloadUnavailable;
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

export function HcHeaderActions({ patientId, patientName, hasNotes, canWrite, backupScope, onImported }: HcHeaderActionsProps) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `hc-more-${patientId}`;

  const showImport = canWrite;
  const showBackup = backupScope != null;
  const hasMenu = showImport || showBackup;

  const menuItems: { id: HcMenuItemId; label: string }[] = [
    ...(showImport ? [{ id: "importWord" as const, label: HC_HOME_COPY.importWord }] : []),
    ...(showBackup ? [{ id: "backupFolder" as const, label: HC_HOME_COPY.backupFolder }] : []),
  ];

  const preloadMenu = () => {
    // Precarga barata de lo que el menú abre (chunks chicos; mammoth no: lo carga el drawer al leer).
    void loadFichaMenu().catch(() => {});
    if (showImport) void loadWordImport().catch(() => {});
    if (showBackup) void Promise.all([loadModal(), loadBackupSetup()]).catch(() => {});
  };

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) menuBtnRef.current?.focus();
  };

  const onMenuSelect = (id: HcMenuItemId) => {
    // T4-Z (a11y): el foco vuelve a «⋯» antes de desmontar el panel; si no, queda en el <body> y el drawer/diálogo
    // que se abre lo devuelve ahí al cerrarse.
    menuBtnRef.current?.focus();
    setMenuOpen(false);
    if (id === "importWord") setImportOpen(true);
    else setBackupOpen(true);
  };

  const downloadRecord = async () => {
    if (downloading) return;
    setDownloading(true);
    // La HC completa tarda varios segundos en armarse: sin aviso el click parece no haber hecho nada. Mismo id → no
    // se apila con un segundo click; se cierra al terminar (bien o mal).
    const progressId = `hc-dl:${patientId}`;
    toast.info(HC_HOME_COPY.preparingPdf, { id: progressId, duration: 0 });
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
      toast.dismiss(progressId);
      setDownloading(false);
    }
  };

  const printHref = `/pacientes/${encodeURIComponent(patientId)}/imprimir`;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", position: "relative" }}>
      {hasNotes && (
        <>
          <a
            className={buttonClassName({ variant: "ghost", size: "sm" })}
            href={printHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none" }}
          >
            {HC_HOME_COPY.print}
          </a>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void downloadRecord()}
            disabled={downloading}
            aria-busy={downloading || undefined}
            data-hc-download-record=""
          >
            {HC_HOME_COPY.downloadRecord}
          </Button>
        </>
      )}
      {hasMenu && (
        <div style={{ position: "relative" }}>
          <button
            ref={menuBtnRef}
            type="button"
            className={buttonClassName({ variant: "ghost", size: "sm" })}
            aria-label={HC_HOME_COPY.moreActions}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={() => setMenuOpen((v) => !v)}
            onPointerEnter={preloadMenu}
            onFocus={preloadMenu}
            style={{ fontSize: 16, fontWeight: 700, lineHeight: 1, minWidth: 44 }}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menuOpen && (
            <HcMenu
              id={menuId}
              label={HC_HOME_COPY.moreActions}
              items={menuItems}
              onSelect={onMenuSelect}
              onClose={closeMenu}
              triggerRef={menuBtnRef}
            />
          )}
        </div>
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
        <BackupDialog scope={backupScope} onClose={() => setBackupOpen(false)} />
      )}
    </div>
  );
}
