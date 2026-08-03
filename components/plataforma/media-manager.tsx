"use client";

/**
 * MediaManager — platform-superadmin media list + uploader for a GLOBAL
 * catalog exercise. Lists the exercise's media (already sorted by order),
 * lets the admin reorder / delete existing rows, and add new media either by
 * uploading a file (VIDEO / IMAGE / GIF) or pasting a YouTube link.
 *
 * Follows the archivos-view upload pattern (`<form action>` + hidden
 * `<input type="file">`) and the services-panel mutation conventions
 * (useTransition + useToast + useConfirm + router.refresh()). Uploaded files
 * are NOT previewed here — we have no signed URLs on the client, so a row just
 * shows its caption / "archivo".
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  addExerciseMedia,
  deleteExerciseMedia,
  reorderExerciseMedia,
} from "@/lib/exercise-media";

export type MediaItem = {
  id: string;
  type: "VIDEO" | "IMAGE" | "GIF" | "YOUTUBE";
  url: string;
  caption: string | null;
  order: number;
};

type Tone = "sky" | "lime" | "soft";

const TAG_TONE: Record<MediaItem["type"], Tone> = {
  VIDEO: "lime",
  GIF: "lime",
  IMAGE: "sky",
  YOUTUBE: "soft",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.96)",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--navy-500)",
  display: "block",
};

export function MediaManager({
  exerciseId,
  media,
  onChanged,
}: {
  exerciseId: string;
  media: MediaItem[];
  /** Called after a successful add/delete/reorder so the parent can refetch
   *  the exercise (the `media` prop otherwise stays stale in an open drawer). */
  onChanged?: () => void;
}): JSX.Element {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"upload" | "youtube">("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [ytUrl, setYtUrl] = useState("");
  const [ytCaption, setYtCaption] = useState("");
  const uploadRef = useRef<HTMLFormElement>(null);

  const runAdd = (fd: FormData, onDone?: () => void) => {
    setError(null);
    start(async () => {
      const r = await addExerciseMedia(fd);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success("Media agregada");
      onDone?.();
      onChanged?.();
      router.refresh();
    });
  };

  const onUpload = (fd: FormData) => {
    fd.append("exerciseId", exerciseId);
    runAdd(fd, () => {
      uploadRef.current?.reset();
      setFileName(null);
    });
  };

  const onAddYoutube = () => {
    const url = ytUrl.trim();
    if (!url) {
      const msg = "Pegá un link de YouTube.";
      setError(msg);
      toast.error(msg);
      return;
    }
    const fd = new FormData();
    fd.append("exerciseId", exerciseId);
    fd.append("type", "YOUTUBE");
    fd.append("url", url);
    const caption = ytCaption.trim();
    if (caption) fd.append("caption", caption);
    runAdd(fd, () => {
      setYtUrl("");
      setYtCaption("");
    });
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= media.length) return;
    const ids = media.map((m) => m.id);
    const tmp = ids[index];
    ids[index] = ids[target];
    ids[target] = tmp;
    setError(null);
    start(async () => {
      const r = await reorderExerciseMedia(exerciseId, ids);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success("Orden actualizado");
      onChanged?.();
      router.refresh();
    });
  };

  const onDelete = async (item: MediaItem) => {
    const ok = await confirm({
      title: "¿Eliminar esta media?",
      message: "Se quitará del ejercicio para siempre.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await deleteExerciseMedia(item.id);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success("Media eliminada");
      onChanged?.();
      router.refresh();
    });
  };

  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>
        Media del ejercicio
      </div>

      {/* ── Existing media list ─────────────────────────────────────────── */}
      {media.length === 0 ? (
        <div
          style={{
            padding: "20px 14px",
            textAlign: "center",
            fontSize: 12.5,
            color: "var(--navy-300)",
            border: "1.5px dashed rgba(31,79,190,0.25)",
            borderRadius: 14,
            background: "rgba(31,79,190,0.03)",
          }}
        >
          Todavía no hay media. Subí videos, imágenes o pegá un link de YouTube.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {media.map((m, i) => {
            const label =
              m.caption ?? (m.type === "YOUTUBE" ? m.url : "archivo");
            return (
              <li
                key={m.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(15,30,51,0.06)",
                  background: "rgba(255,255,255,0.6)",
                }}
              >
                <Tag tone={TAG_TONE[m.type]}>{m.type}</Tag>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    color: "var(--navy-700)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={label}
                >
                  {label}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <button
                    type="button"
                    onClick={() => move(i, -1)}
                    disabled={pending || i === 0}
                    aria-label="Subir en el orden"
                    style={reorderBtnStyle(pending || i === 0)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(i, 1)}
                    disabled={pending || i === media.length - 1}
                    aria-label="Bajar en el orden"
                    style={reorderBtnStyle(pending || i === media.length - 1)}
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(m)}
                  disabled={pending}
                  aria-label="Eliminar media"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#9F1F1F",
                    cursor: pending ? "not-allowed" : "pointer",
                    fontSize: 12,
                    fontWeight: 700,
                    padding: "5px 8px",
                    borderRadius: 8,
                  }}
                >
                  Eliminar
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Add area (two modes) ────────────────────────────────────────── */}
      <div
        style={{
          borderTop: "1px solid rgba(15,30,51,0.06)",
          paddingTop: 14,
          display: "grid",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", gap: 6 }}>
          <ModeTab active={mode === "upload"} onClick={() => setMode("upload")}>
            Subir archivo
          </ModeTab>
          <ModeTab active={mode === "youtube"} onClick={() => setMode("youtube")}>
            YouTube
          </ModeTab>
        </div>

        {mode === "upload" ? (
          <form ref={uploadRef} action={onUpload} style={{ display: "grid", gap: 10 }}>
            <label style={labelStyle}>
              Tipo
              <select name="type" defaultValue="VIDEO" style={{ ...inputStyle, marginTop: 6, appearance: "auto", background: "#fff" }}>
                <option value="VIDEO">Video</option>
                <option value="IMAGE">Imagen</option>
                <option value="GIF">GIF</option>
              </select>
            </label>

            <label
              style={{
                padding: "18px 14px",
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
              <input
                type="file"
                name="file"
                required
                accept="video/*,image/*"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                style={{ display: "none" }}
              />
              <div style={{ fontWeight: 600 }}>{fileName ?? "Elegir archivo"}</div>
              <div style={{ fontSize: 10.5, color: "var(--navy-300)", marginTop: 2 }}>
                Video o imagen · hasta 50 MB
              </div>
            </label>

            <label style={labelStyle}>
              Epígrafe (opcional)
              <input name="caption" style={{ ...inputStyle, marginTop: 6 }} />
            </label>

            {error && <ErrorBox>{error}</ErrorBox>}

            <Button type="submit" variant="primary" disabled={pending} style={{ justifyContent: "center" }}>
              {pending ? "Subiendo…" : "Subir media"}
            </Button>
          </form>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <label style={labelStyle}>
              Link de YouTube
              <input
                value={ytUrl}
                onChange={(e) => setYtUrl(e.target.value)}
                placeholder="https://youtu.be/…"
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </label>
            <label style={labelStyle}>
              Epígrafe (opcional)
              <input
                value={ytCaption}
                onChange={(e) => setYtCaption(e.target.value)}
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </label>

            {error && <ErrorBox>{error}</ErrorBox>}

            <Button
              type="button"
              variant="primary"
              onClick={onAddYoutube}
              disabled={pending}
              style={{ justifyContent: "center" }}
            >
              {pending ? "Agregando…" : "Agregar"}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function reorderBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 26,
    height: 26,
    borderRadius: 8,
    border: "1px solid rgba(15,30,51,0.1)",
    background: disabled ? "rgba(15,30,51,0.03)" : "rgba(255,255,255,0.8)",
    color: disabled ? "var(--navy-300)" : "var(--navy-700)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 13,
    lineHeight: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        border: active ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.1)",
        background: active ? "rgba(31,79,190,0.1)" : "transparent",
        color: active ? "var(--sky-700)" : "var(--navy-500)",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(228,70,70,0.1)",
        color: "#9F1F1F",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}
