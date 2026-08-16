"use client";

/**
 * Global-catalog exercise editor (create / edit) — platform superadmin only.
 *
 * Extracted so BOTH surfaces can open the same editor:
 *   · Plataforma → Ejercicios (the admin table)
 *   · /biblioteca and /terapia-manual (superadmin clicking a catalog card)
 *
 * Edit mode lazily loads the full row (tags + media + article) through
 * `getGlobalExerciseForAdmin`, which is GLOBAL-only (`tenantId: null`) — a
 * tenant-private exercise has no global row, so callers must only open this for
 * catalog items.
 */
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { TagCombobox, type TagOption } from "@/components/ui/tag-combobox";
import { ensureTag } from "@/lib/exercises";
import {
  createGlobalExercise,
  updateGlobalExercise,
  archiveGlobalExercise,
  restoreGlobalExercise,
  hardDeleteGlobalExercise,
  getGlobalExerciseForAdmin,
} from "@/lib/exercises-admin";
import { MediaManager, type MediaItem } from "@/components/plataforma/media-manager";
import { ArticleEditor, type ArticleData } from "@/components/plataforma/article-editor";

type FullExercise = Awaited<ReturnType<typeof getGlobalExerciseForAdmin>>;

export function ExerciseDrawer({
  mode,
  exerciseId,
  tagOptions,
  onClose,
}: {
  mode: "create" | "edit";
  exerciseId?: string;
  tagOptions: TagOption[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Full data for edit (media/article/current fields) — loaded lazily.
  const [full, setFull] = useState<FullExercise>(null);
  const [loading, setLoading] = useState(mode === "edit");
  const [tagSlugs, setTagSlugs] = useState<string[]>([]);
  const [isBasic, setIsBasic] = useState(true);
  const [kind, setKind] = useState<"EXERCISE" | "MANUAL_THERAPY">("EXERCISE");

  useEffect(() => {
    if (mode !== "edit" || !exerciseId) return;
    let alive = true;
    getGlobalExerciseForAdmin(exerciseId).then((ex) => {
      if (!alive) return;
      setFull(ex);
      setLoading(false);
      if (ex) {
        setTagSlugs(ex.tags.map((t) => t.tag.slug));
        setIsBasic(ex.isBasic);
        setKind(ex.kind);
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseId, mode]);

  // Refetch after a media/article mutation so the (still-open) drawer shows the
  // fresh list. Only touches `full` — preserves the controlled base-form state.
  const reload = () => {
    if (exerciseId) getGlobalExerciseForAdmin(exerciseId).then(setFull);
  };

  const submit = (fd: FormData) => {
    setError(null);
    start(async () => {
      const base = {
        name: String(fd.get("name") ?? "").trim(),
        kind,
        difficulty: String(fd.get("difficulty") ?? "1"),
        // Send null (not "") for cleared numerics so updateGlobalExercise can
        // NULL a previously-set value (converting reps↔tiempo).
        defaultSets: fd.get("defaultSets") ? Number(fd.get("defaultSets")) : null,
        defaultReps: fd.get("defaultReps") ? Number(fd.get("defaultReps")) : null,
        durationSeconds: fd.get("durationSeconds") ? Number(fd.get("durationSeconds")) : null,
        isBasic,
        description: String(fd.get("description") ?? ""),
        instructions: String(fd.get("instructions") ?? ""),
        cues: String(fd.get("cues") ?? ""),
        tagSlugs,
      };
      const result =
        mode === "create"
          ? await createGlobalExercise(base)
          : await updateGlobalExercise({ ...base, id: exerciseId });
      if (!result.ok) {
        setError(result.error);
        toast.error("No se pudo guardar", { description: result.error });
        return;
      }
      toast.success(mode === "create" ? "Ejercicio creado" : "Ejercicio actualizado");
      router.refresh();
      if (mode === "create") onClose();
    });
  };

  const doArchive = (archived: boolean) => {
    if (!exerciseId) return;
    start(async () => {
      const r = archived ? await archiveGlobalExercise(exerciseId) : await restoreGlobalExercise(exerciseId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(archived ? "Archivado" : "Restaurado");
      router.refresh();
      onClose();
    });
  };

  const doDelete = async () => {
    if (!exerciseId) return;
    const ok = await confirm({
      title: "Borrar ejercicio",
      message:
        "Se borra definitivamente. Si está usado en planes o diagnósticos, no se podrá (archivalo en su lugar).",
      confirmLabel: "Borrar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await hardDeleteGlobalExercise(exerciseId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Ejercicio borrado");
      router.refresh();
      onClose();
    });
  };

  const ex = full;
  // Edit mode where the row didn't resolve = not a global catalog exercise.
  const missing = mode === "edit" && !loading && !ex;

  return (
    <Drawer
      open
      onClose={onClose}
      title={mode === "create" ? "Nuevo ejercicio" : "Editar ejercicio"}
      // Fits the 3-up Series/Reps/Tiempo row plus the media + article editors.
      width={600}
    >
      {loading ? (
        <div style={{ padding: 20, color: "var(--navy-500)", fontSize: 13 }}>Cargando…</div>
      ) : missing ? (
        <div style={{ display: "grid", gap: 12, padding: 4 }}>
          <p style={{ fontSize: 13, color: "var(--navy-700)", margin: 0, lineHeight: 1.5 }}>
            Este ejercicio no pertenece al catálogo global, así que no se edita desde acá.
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {mode === "edit" && ex && (
            <a
              href={`/biblioteca/${ex.slug}`}
              style={{
                justifySelf: "start",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--sky-700)",
                textDecoration: "none",
              }}
            >
              Ver ficha completa →
            </a>
          )}
          <form action={submit} style={{ display: "grid", gap: 12 }}>
            <FormField label="Nombre" name="name" required defaultValue={ex?.name ?? ""} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={{ fontSize: 12, display: "grid", gap: 6 }}>
                <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Tipo</span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "EXERCISE" | "MANUAL_THERAPY")}
                  style={selectStyle}
                >
                  <option value="EXERCISE">Ejercicio</option>
                  <option value="MANUAL_THERAPY">Terapia manual / maniobra</option>
                </select>
              </label>
              <FormField
                label="Dificultad (1-5)"
                name="difficulty"
                type="number"
                defaultValue={String(ex?.difficulty ?? 1)}
              />
            </div>

            <label
              style={{
                fontSize: 12.5,
                color: "var(--navy-700)",
                display: "inline-flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input type="checkbox" checked={isBasic} onChange={(e) => setIsBasic(e.target.checked)} />
              Plan <strong>{isBasic ? "Común" : "Pro"}</strong>{" "}
              <span style={{ color: "var(--navy-400)" }}>
                ({isBasic ? "visible en todos los planes" : "solo Pro/Enterprise"})
              </span>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <FormField
                label="Series"
                name="defaultSets"
                type="number"
                defaultValue={ex?.defaultSets != null ? String(ex.defaultSets) : ""}
                hint="opcional"
              />
              <FormField
                label="Reps"
                name="defaultReps"
                type="number"
                defaultValue={ex?.defaultReps != null ? String(ex.defaultReps) : ""}
                hint="opcional"
              />
              <FormField
                label="Tiempo (s)"
                name="durationSeconds"
                type="number"
                defaultValue={ex?.durationSeconds != null ? String(ex.durationSeconds) : ""}
                hint="opcional"
              />
            </div>

            <div style={{ fontSize: 12, display: "grid", gap: 6 }}>
              <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Categorías / tags</span>
              <TagCombobox
                suggestions={tagOptions}
                value={tagSlugs}
                onChange={setTagSlugs}
                onCreate={async (label) => {
                  const t = await ensureTag(label);
                  return t;
                }}
              />
              <span style={{ fontSize: 10.5, color: "var(--navy-300)" }}>
                Grupo muscular, elementos, disciplina… Creá categorías nuevas en Plataforma → Tags.
              </span>
            </div>

            <FormField as="textarea" label="Descripción" name="description" defaultValue={ex?.description ?? ""} />
            <FormField
              as="textarea"
              label="Instrucciones (markdown)"
              name="instructions"
              defaultValue={ex?.instructions ?? ""}
            />
            <FormField as="textarea" label="Cues / coaching" name="cues" defaultValue={ex?.cues ?? ""} />

            {error && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: "rgba(228,70,70,0.1)",
                  color: "#9F1F1F",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {mode === "create" ? "Crear" : "Guardar"}
              </Button>
            </div>
          </form>

          {mode === "edit" && ex && (
            <>
              <section style={{ display: "grid", gap: 8 }}>
                <h3 style={sectionH}>Media</h3>
                <MediaManager
                  exerciseId={ex.id}
                  media={ex.media.map(
                    (m): MediaItem => ({
                      id: m.id,
                      type: m.type,
                      url: m.url,
                      caption: m.caption,
                      order: m.order,
                    }),
                  )}
                  onChanged={reload}
                />
              </section>

              <section style={{ display: "grid", gap: 8 }}>
                <h3 style={sectionH}>Ejercicio completo (artículo)</h3>
                <ArticleEditor
                  exerciseId={ex.id}
                  article={
                    ex.article
                      ? ({
                          title: ex.article.title,
                          subtitle: ex.article.subtitle,
                          focus: ex.article.focus,
                          readingMinutes: ex.article.readingMinutes,
                          bodyMarkdown: ex.article.bodyMarkdown,
                          references: ex.article.references,
                        } satisfies ArticleData)
                      : null
                  }
                  onChanged={reload}
                />
              </section>

              <section
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  borderTop: "1px solid rgba(15,30,51,0.08)",
                  paddingTop: 14,
                }}
              >
                {ex.archivedAt ? (
                  <Button type="button" variant="ghost" onClick={() => doArchive(false)} disabled={pending}>
                    Restaurar
                  </Button>
                ) : (
                  <Button type="button" variant="ghost" onClick={() => doArchive(true)} disabled={pending}>
                    Archivar
                  </Button>
                )}
                <button
                  type="button"
                  onClick={doDelete}
                  disabled={pending}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#9F1F1F",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Borrar definitivamente
                </button>
              </section>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

const selectStyle: React.CSSProperties = {
  marginTop: 0,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.95)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
};

const sectionH: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  margin: 0,
};
