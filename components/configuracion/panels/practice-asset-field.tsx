"use client";

/**
 * [FC-3i] Logo del consultorio (General, `tenant.sensitive`) y firma propia («Mis fichas»): elegir una imagen, ver la
 * vista previa, cambiarla o quitarla (C-FC9). Un solo componente para los dos porque la máquina es la misma. Viaja
 * SOLO en el chunk de «Mis fichas»: General lo pide por `next/dynamic` al mismo módulo (`LogoAssetField` de
 * fichas-panel.tsx). Importarlo estático desde los dos paneles hacía que webpack armara un chunk compartido más
 * (este archivo + `lib/file-sniff` + el copy): cada chunk nuevo suma ~20 B al runtime de TODAS las rutas, y /agenda
 * no tiene margen (handoff de FC-3i1).
 *
 * Por qué así:
 *  - Chequeo en el cliente ANTES de subir: tamaño/tipo (`precheckPracticeAssetFile`) y después magic bytes y
 *    dimensiones con el MISMO `checkPracticeAsset` de la action (`lib/file-sniff.ts`, puro). Un SVG renombrado o una
 *    foto de 4000 px se frenan acá sin viajar; la action lo repite (es la barrera).
 *  - `expectedUpdatedAt` (C-FC9 lo acepta opcional): viaja el `updatedAt` que conocemos; si otra pestaña lo cambió
 *    la action responde conflicto y no se pisa. Después de subir se guarda el `updatedAt` nuevo que devuelve.
 *  - La vista previa es una URL firmada de 60 s (`getPracticeAssetPreviewUrl`): se pide al montar y después de cada
 *    cambio, nunca en el SSR (no hace falta para pintar la página y vencería en el HTML cacheado).
 *  - Quitar pide confirmación (`useConfirm`): las fichas que se impriman desde ahora salen sin la imagen.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { FICHAS_SETTINGS_COPY as COPY } from "./fichas-settings-copy";
import { checkPracticeAsset, type PracticeAssetKind } from "@/lib/file-sniff";
import {
  getPracticeAssetPreviewUrl,
  removeOwnSignature,
  removeTenantLogo,
  uploadOwnSignature,
  uploadTenantLogo,
} from "@/lib/practice-assets";
import { PRACTICE_ASSET_ACCEPT, precheckPracticeAssetFile } from "./mis-fichas-logic";

export type PracticeAssetState = { has: boolean; updatedAt: string | null };

type Msg = { tone: "ok" | "err"; text: string } | null;

export function PracticeAssetField({
  kind,
  initial,
  label,
  hint,
  formatHint,
  disabled = false,
}: {
  kind: PracticeAssetKind;
  initial: PracticeAssetState;
  label: string;
  hint: string;
  /** Formato aceptado, literal de C-FC9 («Subí el logo en PNG o JPG (hasta 1 MB).»). */
  formatHint: string;
  /** Soporte o modo lectura: se ve, no se cambia. */
  disabled?: boolean;
}) {
  const [state, setState] = useState<PracticeAssetState>(initial);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const inputId = `practice-asset-${kind}`;

  // Vista previa: al montar y cada vez que cambia la imagen (`updatedAt` nuevo). Sin imagen no se pide nada.
  useEffect(() => {
    let alive = true;
    setPreviewFailed(false);
    if (!state.has) {
      setPreview(null);
      return;
    }
    void getPracticeAssetPreviewUrl(kind)
      .then((r) => {
        if (!alive) return;
        if (r.ok) setPreview(r.data.url);
        else setPreviewFailed(true);
      })
      .catch(() => alive && setPreviewFailed(true));
    return () => {
      alive = false;
    };
  }, [kind, state.has, state.updatedAt]);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setMsg(null);
    const quick = precheckPracticeAssetFile(kind, file);
    if (quick) {
      setMsg({ tone: "err", text: quick });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    start(async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const checked = checkPracticeAsset(kind, bytes, file.type);
        if (!checked.ok) {
          setMsg({ tone: "err", text: checked.error });
          return;
        }
        const fd = new FormData();
        fd.set("file", file);
        fd.set("expectedUpdatedAt", state.updatedAt ?? "");
        const r = kind === "logo" ? await uploadTenantLogo(fd) : await uploadOwnSignature(fd);
        if (!r.ok) {
          setMsg({ tone: "err", text: r.error });
          return;
        }
        setState({ has: true, updatedAt: r.data.updatedAt });
        setMsg({ tone: "ok", text: COPY.uploaded });
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      } finally {
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: kind === "logo" ? COPY.removeLogoTitle : COPY.removeSignatureTitle,
      message: kind === "logo" ? COPY.removeLogoMessage : COPY.removeSignatureMessage,
      confirmLabel: COPY.remove,
      cancelLabel: COPY.cancel,
      tone: "danger",
    });
    if (!ok) return;
    setMsg(null);
    start(async () => {
      try {
        const r = kind === "logo" ? await removeTenantLogo() : await removeOwnSignature();
        if (!r.ok) {
          setMsg({ tone: "err", text: r.error });
          return;
        }
        setState({ has: false, updatedAt: null });
        setMsg({ tone: "ok", text: COPY.removed });
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      }
    });
  };

  return (
    <div data-practice-asset={kind} style={{ display: "grid", gap: 10 }}>
      <div>
        <div id={`${inputId}-label`} style={{ fontSize: 15, fontWeight: 600, color: "var(--navy-900)" }}>
          {label}
        </div>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, lineHeight: 1.45 }}>
          {hint} {formatHint}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div
          style={{
            width: 160,
            height: 80,
            borderRadius: "var(--r-md)",
            border: "1px dashed var(--navy-100)",
            background: "var(--card-bg)",
            display: "grid",
            placeItems: "center",
            overflow: "hidden",
            flex: "none",
          }}
        >
          {state.has && preview ? (
            // Imagen privada por URL firmada de 60 s: `next/image` no aplica (no se optimiza ni se cachea).
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={preview}
              alt={COPY.previewAlt(label)}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: 12, color: "var(--navy-500)", padding: 8, textAlign: "center" }}>
              {state.has ? (previewFailed ? COPY.previewUnavailable : "…") : COPY.noImage}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={PRACTICE_ASSET_ACCEPT}
            disabled={disabled || pending}
            onChange={(e) => onFile(e.target.files?.[0])}
            style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            tabIndex={-1}
            aria-hidden="true"
          />
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || pending}
            aria-describedby={`${inputId}-label`}
            onClick={() => inputRef.current?.click()}
          >
            {pending ? COPY.uploading : state.has ? COPY.replace : COPY.upload}
          </Button>
          {state.has && (
            <Button type="button" variant="ghost" disabled={disabled || pending} onClick={() => void onRemove()}>
              {COPY.remove}
            </Button>
          )}
        </div>
      </div>
      {msg && (
        <div
          role={msg.tone === "err" ? "alert" : "status"}
          style={{ fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--success-fg)" : "var(--danger-fg)" }}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
