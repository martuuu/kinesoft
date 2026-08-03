"use client";

/**
 * Platform-superadmin tag (category) authoring panel.
 *
 * Mirrors the config CRUD panels (diagnosticos / insurers): a section per
 * tag kind → "Nueva categoría" opens a Modal → server action in a
 * `useTransition` → `useConfirm` for danger deletes → `router.refresh()` +
 * toast on every result.
 *
 * The exercise-relevant kinds (MUSCLE_GROUP / EQUIPMENT / DISCIPLINE / GOAL)
 * are always shown and fully editable. The condition-taxonomy kinds
 * (ZONE / SUBZONE / SYMPTOM / …) are managed elsewhere, so they render
 * read-only inside a collapsed "otras categorías" section.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TagKind } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  createTag,
  renameTag,
  deleteTag,
  type TagAdminRow,
} from "@/lib/tags-admin";

const KIND_LABEL: Record<TagKind, string> = {
  MUSCLE_GROUP: "Grupo muscular",
  EQUIPMENT: "Elementos",
  DISCIPLINE: "Disciplina / rama",
  GOAL: "Objetivo",
  ZONE: "Zona",
  SUBZONE: "Subzona",
  SYMPTOM: "Síntoma",
  TRIGGER: "Desencadenante",
  PHASE: "Fase",
  CHAIN: "Cadena",
};

/** Exercise-catalog kinds, always shown + editable, in display order. */
const EDITABLE_KINDS: TagKind[] = ["MUSCLE_GROUP", "EQUIPMENT", "DISCIPLINE", "GOAL"];
/** Condition-taxonomy kinds — read-only here (authored elsewhere). */
const READONLY_KINDS: TagKind[] = ["ZONE", "SUBZONE", "SYMPTOM", "TRIGGER", "PHASE", "CHAIN"];

function usageLabel(t: TagAdminRow): string {
  const parts: string[] = [];
  if (t.exerciseCount > 0) parts.push(`${t.exerciseCount} ej.`);
  if (t.conditionCount > 0) parts.push(`${t.conditionCount} diag.`);
  return parts.length ? parts.join(" · ") : "sin uso";
}

export function TagAdminPanel({ tags }: { tags: TagAdminRow[] }) {
  const byKind = new Map<TagKind, TagAdminRow[]>();
  for (const t of tags) {
    const arr = byKind.get(t.kind) ?? [];
    arr.push(t);
    byKind.set(t.kind, arr);
  }

  const readonlyWithTags = READONLY_KINDS.filter((k) => (byKind.get(k)?.length ?? 0) > 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {EDITABLE_KINDS.map((kind) => (
        <KindSection key={kind} kind={kind} tags={byKind.get(kind) ?? []} />
      ))}

      {readonlyWithTags.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <details>
            <summary
              style={{
                padding: "16px 20px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--navy-700)",
                listStyle: "revert",
              }}
            >
              Otras categorías (taxonomía de diagnósticos) — solo lectura
            </summary>
            <div style={{ padding: "4px 20px 20px" }}>
              <p style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 0, marginBottom: 14, lineHeight: 1.45 }}>
                Estas categorías forman la taxonomía clínica y se gestionan desde
                el editor de diagnósticos.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {readonlyWithTags.map((kind) => (
                  <div key={kind}>
                    <EyebrowLabel style={{ marginBottom: 8 }}>{KIND_LABEL[kind]}</EyebrowLabel>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {(byKind.get(kind) ?? []).map((t) => (
                        <span
                          key={t.slug}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 12px",
                            borderRadius: 999,
                            border: "1px solid rgba(15,30,51,0.08)",
                            background: "rgba(15,30,51,0.02)",
                            fontSize: 12.5,
                            color: "var(--navy-500)",
                          }}
                        >
                          {t.label}
                          <span style={{ fontSize: 11, color: "var(--navy-300)" }}>{usageLabel(t)}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}

function KindSection({ kind, tags }: { kind: TagKind; tags: TagAdminRow[] }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TagAdminRow | null>(null);

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          borderBottom: tags.length > 0 ? "1px solid rgba(15,30,51,0.06)" : "none",
        }}
      >
        <div>
          <EyebrowLabel>{KIND_LABEL[kind]}</EyebrowLabel>
          <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 4 }}>
            {tags.length} {tags.length === 1 ? "categoría" : "categorías"}
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + Nueva categoría
        </Button>
      </header>

      {tags.length === 0 ? (
        <div style={{ padding: "20px", fontSize: 13, color: "var(--navy-500)" }}>
          Todavía no hay categorías de {KIND_LABEL[kind].toLowerCase()}.
        </div>
      ) : (
        <div style={{ padding: 16, display: "flex", flexWrap: "wrap", gap: 10 }}>
          {tags.map((t) => (
            <TagChip
              key={t.slug}
              tag={t}
              onEdit={() => setEditing(t)}
            />
          ))}
        </div>
      )}

      {creating && (
        <TagModal
          kind={kind}
          onClose={() => setCreating(false)}
        />
      )}
      {editing && (
        <TagModal
          kind={kind}
          existing={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.1)",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

function TagChip({ tag, onEdit }: { tag: TagAdminRow; onEdit: () => void }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px 6px 14px",
        borderRadius: 999,
        border: "1px solid rgba(15,30,51,0.1)",
        background: "rgba(255,255,255,0.6)",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{tag.label}</span>
      <span style={{ fontSize: 11, color: "var(--navy-300)" }}>{usageLabel(tag)}</span>
      <button type="button" onClick={onEdit} style={miniBtn}>
        Editar
      </button>
      <DeleteTagButton tag={tag} />
    </div>
  );
}

function DeleteTagButton({ tag }: { tag: TagAdminRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  const toast = useToast();

  const onClick = async () => {
    const detachParts: string[] = [];
    if (tag.exerciseCount > 0) {
      detachParts.push(`${tag.exerciseCount} ejercicio${tag.exerciseCount === 1 ? "" : "s"}`);
    }
    if (tag.conditionCount > 0) {
      detachParts.push(`${tag.conditionCount} diagnóstico${tag.conditionCount === 1 ? "" : "s"}`);
    }
    const message = detachParts.length
      ? `Se desvinculará de ${detachParts.join(" y ")}. Esta acción es definitiva.`
      : "Esta acción es definitiva.";

    const ok = await confirm({
      title: `¿Eliminar "${tag.label}"?`,
      message,
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;

    start(async () => {
      const r = await deleteTag(tag.slug);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Categoría eliminada");
      router.refresh();
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      style={{ ...miniBtn, color: "#9F1F1F", borderColor: "rgba(159,31,31,0.25)" }}
    >
      {pending ? "…" : "Eliminar"}
    </button>
  );
}

function TagModal({
  kind,
  existing,
  onClose,
}: {
  kind: TagKind;
  existing?: TagAdminRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    setError(null);
    const label = String(formData.get("label") ?? "");
    start(async () => {
      const r = existing
        ? await renameTag(existing.slug, label)
        : await createTag({ label, kind });
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success(existing ? "Categoría actualizada" : "Categoría creada");
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      onClose={onClose}
      title={existing ? "Editar categoría" : "Nueva categoría"}
      description={KIND_LABEL[kind]}
      width={460}
    >
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField
          label="Nombre"
          name="label"
          required
          autoFocus
          defaultValue={existing?.label ?? ""}
          placeholder="Ej. Isquiotibiales"
        />
        {error && (
          <div
            role="alert"
            style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Guardando…" : existing ? "Guardar cambios" : "Crear categoría"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
