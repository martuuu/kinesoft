"use client";

/**
 * CF3b PH-U1 (M24, contrato FOTO en `wip-20/cf3-handoffs.md`) — sección «Tu foto» de Configuración › «Mi agenda».
 *
 * - Vista previa con `PractitionerPhoto` (PH-U2): el MISMO marco que ven los pacientes en el turnero y la sede (fondo
 *   blanco, sombra con el color del consultorio, logo chico abajo a la derecha con `useTenantBrand().logoUrl`).
 * - «Subir foto» / «Cambiar foto»: el `<input type="file">` (PNG/JPEG/WEBP) es el control real y su `<label>` tiene cara
 *   de botón (un solo tab stop, foco visible en el label: `photo-section.module.css`). El nombre accesible es el texto
 *   del label (sin `aria-label`: WCAG 2.5.3, el nombre tiene que contener lo que se lee) y los formatos van por
 *   `aria-describedby`. La foto se achica en el cliente
 *   (`preparePhotoUpload`, lib/photo-resize.ts: 512×512 cover, PNG si tiene transparencia, JPEG 0,85 si no, ≤ 1 MB) y
 *   va como `FormData` (campo `file`) a `uploadOwnPhoto`.
 * - «Quitar foto» con `useConfirm` → `removeOwnPhoto`.
 * - Switch «Mostrar mi foto…» → `setOwnShowPhotoPublic` (del profesional en ESTE consultorio), deshabilitado sin foto
 *   (`photoSwitchUiOf`). Optimista con vuelta atrás, como los otros switches de la pestaña.
 * Cada acción guarda al toque: sin dirty-guard. Al subir o quitar, el avatar del shell cambia en el momento
 * (`useSetUserPhotoUrl`), sin esperar a que el layout se vuelva a pintar.
 *
 * Modo lectura del consultorio: la foto es de la PERSONA (como la matrícula de `license-section.tsx`), así que subir y
 * quitar no se bloquean acá (decide la action); el switch sí, porque es un dato del consultorio.
 */
import { useEffect, useId, useState, useTransition } from "react";
import { Button, buttonClassName } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PractitionerPhoto } from "@/components/ui/practitioner-photo";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useTenantBrand } from "@/components/layout/tenant-brand-context";
import { useSetUserPhotoUrl } from "@/components/layout/user-photo-context";
import { removeOwnPhoto, setOwnShowPhotoPublic, uploadOwnPhoto } from "@/lib/user-photo";
import { PHOTO_ACCEPT, preparePhotoUpload } from "@/lib/photo-resize";
import { MI_AGENDA_COPY, PHOTO_COPY as COPY, photoSwitchUiOf } from "./mi-agenda-logic";
import { ErrorBox } from "../controls";
import styles from "./photo-section.module.css";

const hintStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4, margin: 0 };
const rowLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--navy-900)" };

/** `ConfiguracionMiAgendaData.photo` (contrato FOTO). */
export type PhotoSectionData = { url: string | null; showPublic: boolean };

type Busy = "upload" | "remove" | null;

export function PhotoSection({
  initial,
  name,
  readOnly = false,
}: {
  initial: PhotoSectionData;
  /** Nombre del profesional: las iniciales del marco sin foto. */
  name: string;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const { logoUrl } = useTenantBrand();
  const setShellPhoto = useSetUserPhotoUrl();
  const [url, setUrl] = useState<string | null>(initial.url);
  const [showPublic, setShowPublic] = useState(initial.showPublic);
  const [busy, setBusy] = useState<Busy>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchPending, start] = useTransition();
  const inputId = useId();
  const formatsId = useId();
  const switchHintId = useId();
  // Cuando llega el árbol nuevo (las actions de PH-S revalidan `"/", "layout"`) manda el server.
  useEffect(() => setUrl(initial.url), [initial.url]);
  useEffect(() => setShowPublic(initial.showPublic), [initial.showPublic]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Vaciar el input: elegir la MISMA foto otra vez (después de un error) tiene que volver a disparar `change`.
    e.target.value = "";
    if (!file || busy) return;
    setPhotoError(null);
    setBusy("upload");
    try {
      const prepared = await preparePhotoUpload(file);
      if (!prepared.ok) {
        setPhotoError(prepared.error);
        return;
      }
      const form = new FormData();
      form.append("file", prepared.file);
      const r = await uploadOwnPhoto(form);
      if (!r.ok) {
        setPhotoError(r.error);
        return;
      }
      setUrl(r.data.photoUrl);
      setShellPhoto(r.data.photoUrl);
      toast.success(COPY.uploaded);
    } catch {
      setPhotoError(MI_AGENDA_COPY.network);
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    if (busy || !url) return;
    const ok = await confirm({ title: COPY.removeTitle, message: COPY.removeMessage, confirmLabel: COPY.remove, tone: "danger" });
    if (!ok) return;
    setPhotoError(null);
    setBusy("remove");
    try {
      const r = await removeOwnPhoto();
      if (!r.ok) {
        setPhotoError(r.error);
        return;
      }
      setUrl(null);
      setShellPhoto(null);
      toast.success(COPY.removed);
    } catch {
      setPhotoError(MI_AGENDA_COPY.network);
    } finally {
      setBusy(null);
    }
  };

  const sw = photoSwitchUiOf({ hasPhoto: url !== null, showPublic, readOnly, pending: switchPending });
  const toggle = () => {
    if (sw.disabled) return;
    const prev = showPublic;
    const next = !prev;
    setShowPublic(next);
    setSwitchError(null);
    start(async () => {
      try {
        const r = await setOwnShowPhotoPublic(next);
        if (!r.ok) {
          setShowPublic(prev);
          setSwitchError(r.error);
          return;
        }
        setShowPublic(r.data.showPhotoPublic);
      } catch {
        setShowPublic(prev);
        setSwitchError(MI_AGENDA_COPY.network);
      }
    });
  };

  return (
    <div style={{ display: "grid", gap: 14 }} data-photo-section={url ? "with-photo" : "empty"}>
      <div className={styles.row}>
        <div aria-busy={busy !== null || undefined} style={{ flex: "none" }}>
          {/* `eager`: es lo primero de la pestaña (el default `lazy` es para tarjetas debajo del pliegue). */}
          <PractitionerPhoto src={url} name={name} logoUrl={logoUrl} size={96} loading="eager" />
        </div>
        <div className={styles.actions}>
          <div className={styles.buttons}>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <input
                id={inputId}
                type="file"
                name="file"
                accept={PHOTO_ACCEPT}
                className={styles.input}
                aria-describedby={formatsId}
                disabled={busy !== null}
                onChange={onPick}
              />
              <label htmlFor={inputId} className={buttonClassName({ variant: "primary", size: "sm", className: styles.label })}>
                {busy === "upload" ? COPY.uploading : url ? COPY.change : COPY.upload}
              </label>
            </span>
            {url && (
              <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={busy !== null}>
                {busy === "remove" ? COPY.removing : COPY.remove}
              </Button>
            )}
          </div>
          <p id={formatsId} style={hintStyle}>
            {COPY.formats}
          </p>
          <p style={{ ...hintStyle, color: "var(--navy-700)" }}>{COPY.note}</p>
        </div>
      </div>
      {photoError && <ErrorBox>{photoError}</ErrorBox>}

      <div style={{ borderTop: "1px solid rgba(15,30,51,0.08)", paddingTop: 14, display: "grid", gap: 4 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: sw.disabled ? "default" : "pointer" }}>
          <Switch on={sw.on} onChange={toggle} disabled={sw.disabled} aria-label={COPY.publicLabel} aria-describedby={switchHintId} />
          <span style={rowLabel}>{COPY.publicLabel}</span>
        </label>
        <div id={switchHintId} style={hintStyle} data-photo-public-hint>
          {sw.hint}
        </div>
        {switchError && <ErrorBox>{switchError}</ErrorBox>}
      </div>
    </div>
  );
}
