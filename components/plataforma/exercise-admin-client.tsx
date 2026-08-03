"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { Tag } from "@/components/ui/tag";
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
  type GlobalExerciseAdminRow,
} from "@/lib/exercises-admin";
import { MediaManager, type MediaItem } from "@/components/plataforma/media-manager";
import { ArticleEditor, type ArticleData } from "@/components/plataforma/article-editor";

type FullExercise = Awaited<ReturnType<typeof getGlobalExerciseForAdmin>>;

export function ExerciseAdminClient({
  exercises,
  tagOptions,
}: {
  exercises: GlobalExerciseAdminRow[];
  tagOptions: TagOption[];
}) {
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const visible = showArchived ? exercises : exercises.filter((e) => !e.archived);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "var(--navy-900)", margin: 0 }}>
            Catálogo de ejercicios
          </h1>
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 0" }}>
            Ejercicios y terapias manuales globales — la base de conocimiento compartida.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 12.5, color: "var(--navy-500)", display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Ver archivados
          </label>
          <Button variant="primary" onClick={() => setCreating(true)}>
            Nuevo ejercicio
          </Button>
        </div>
      </div>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        {visible.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
            No hay ejercicios{showArchived ? "" : " activos"}.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {visible.map((e) => (
              <li key={e.id}>
                <button
                  onClick={() => setEditingId(e.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "14px 18px",
                    border: "none",
                    borderBottom: "1px solid rgba(15,30,51,0.05)",
                    background: e.archived ? "rgba(15,30,51,0.03)" : "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    opacity: e.archived ? 0.6 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "var(--navy-900)", display: "flex", alignItems: "center", gap: 8 }}>
                      {e.name}
                      {e.archived && <Tag tone="soft">Archivado</Tag>}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--navy-400)", marginTop: 2 }}>
                      {e.tags.filter((t) => t.kind === "MUSCLE_GROUP").map((t) => t.label).join(", ") || "—"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                    {e.kind === "MANUAL_THERAPY" && <Tag tone="lime">Maniobra</Tag>}
                    <Tag tone={e.isBasic ? "soft" : "sky"}>{e.isBasic ? "Común" : "Pro"}</Tag>
                    <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>N{e.difficulty}</span>
                    {e.mediaCount > 0 && (
                      <span className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>{e.mediaCount}📎</span>
                    )}
                    {e.hasArticle && <Tag tone="sky">artículo</Tag>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {creating && (
        <ExerciseDrawer
          mode="create"
          tagOptions={tagOptions}
          onClose={() => setCreating(false)}
        />
      )}
      {editingId && (
        <ExerciseDrawer
          mode="edit"
          exerciseId={editingId}
          tagOptions={tagOptions}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function ExerciseDrawer({
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

  // Load the full exercise (media/article/tags) when editing.
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
  }, []);

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
      message: "Se borra definitivamente. Si está usado en planes o diagnósticos, no se podrá (archivalo en su lugar).",
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

  return (
    <Drawer open onClose={onClose} title={mode === "create" ? "Nuevo ejercicio" : "Editar ejercicio"} width={480}>
      {loading ? (
        <div style={{ padding: 20, color: "var(--navy-500)" }}>Cargando…</div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
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

            <label style={{ fontSize: 12.5, color: "var(--navy-700)", display: "inline-flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={isBasic} onChange={(e) => setIsBasic(e.target.checked)} />
              Plan <strong>{isBasic ? "Común" : "Pro"}</strong>{" "}
              <span style={{ color: "var(--navy-400)" }}>
                ({isBasic ? "visible en todos los planes" : "solo Pro/Enterprise"})
              </span>
            </label>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <FormField label="Series" name="defaultSets" type="number" defaultValue={ex?.defaultSets != null ? String(ex.defaultSets) : ""} hint="opcional" />
              <FormField label="Reps" name="defaultReps" type="number" defaultValue={ex?.defaultReps != null ? String(ex.defaultReps) : ""} hint="opcional" />
              <FormField label="Tiempo (s)" name="durationSeconds" type="number" defaultValue={ex?.durationSeconds != null ? String(ex.durationSeconds) : ""} hint="opcional" />
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
            <FormField as="textarea" label="Instrucciones (markdown)" name="instructions" defaultValue={ex?.instructions ?? ""} />
            <FormField as="textarea" label="Cues / coaching" name="cues" defaultValue={ex?.cues ?? ""} />

            {error && (
              <div style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}>
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancelar</Button>
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
                    (m): MediaItem => ({ id: m.id, type: m.type, url: m.url, caption: m.caption, order: m.order }),
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

              <section style={{ display: "flex", justifyContent: "space-between", gap: 8, borderTop: "1px solid rgba(15,30,51,0.08)", paddingTop: 14 }}>
                {ex.archivedAt ? (
                  <Button type="button" variant="ghost" onClick={() => doArchive(false)} disabled={pending}>Restaurar</Button>
                ) : (
                  <Button type="button" variant="ghost" onClick={() => doArchive(true)} disabled={pending}>Archivar</Button>
                )}
                <button
                  type="button"
                  onClick={doDelete}
                  disabled={pending}
                  style={{ background: "none", border: "none", color: "#9F1F1F", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
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
