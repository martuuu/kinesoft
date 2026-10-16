"use client";

import { useRef, useState, useTransition } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { TagCombobox, type TagOption } from "@/components/ui/tag-combobox";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { useToast } from "@/components/ui/toast";
import { createExercise, ensureTag } from "@/lib/exercises";
import tapStyles from "@/components/biblioteca/biblioteca.module.css";

/**
 * [PF1.2-planes-bib] Alta de ejercicio / maniobra propia.
 *
 * Antes era un overlay armado a mano dentro de `biblioteca-client.tsx` (sin foco atrapado, sin Esc, sin dirty-guard,
 * cada campo con el contorno de foco apagado). AGENTS §5: los formularios de carga van en `Drawer` con dirty-guard, con
 * `FormField` (44 px, foco de `.k-input`). Vive en su archivo para que la página lo baje con `next/dynamic` recién al
 * abrirlo (C-PF2): arrastra `TagCombobox` y las actions de alta.
 */
export function CreateExerciseDrawer({
  tags,
  onClose,
  kind = "EXERCISE",
}: {
  tags: TagOption[];
  onClose: () => void;
  kind?: "EXERCISE" | "MANUAL_THERAPY";
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [availableTags, setAvailableTags] = useState(tags);
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef, { tags: selectedTags });
  const manual = kind === "MANUAL_THERAPY";
  const noun = manual ? "maniobra" : "ejercicio";

  const onCreateTag = async (label: string) => {
    const created = await ensureTag(label, "GOAL");
    setAvailableTags((s) => (s.find((t) => t.slug === created.slug) ? s : [...s, created]));
    return created;
  };

  const submit = (form: FormData) => {
    setError(null);
    start(async () => {
      const r = await createExercise({
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? "") || undefined,
        difficulty: Number(form.get("difficulty")) || 1,
        defaultSets: Number(form.get("defaultSets")) || 3,
        defaultReps: Number(form.get("defaultReps")) || 12,
        equipment: String(form.get("equipment") ?? "") || undefined,
        muscleGroups: String(form.get("muscleGroups") ?? "") || undefined,
        cues: String(form.get("cues") ?? "") || undefined,
        instructions: String(form.get("instructions") ?? "") || undefined,
        tagSlugs: selectedTags,
        kind,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(manual ? "Maniobra creada" : "Ejercicio creado");
      onClose();
      // EV2-Z (PF-0d): `createExercise` revalida /biblioteca y /terapia-manual (+ tags): sin segundo render.
    });
  };

  return (
    <Drawer open onClose={onClose} title={manual ? "Nueva maniobra" : "Nuevo ejercicio"} dirty={dirty} width={560}>
      <form ref={formRef} action={submit} onInput={onFormInput} onChange={onFormInput} className={tapStyles.tapScope} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre" name="name" required placeholder={manual ? "Movilización de rótula" : "Sentadilla búlgara"} />
        <FormField label="Grupo muscular" name="muscleGroups" placeholder="Cuádriceps, glúteo" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
          <FormField label="Series" name="defaultSets" type="number" min={1} max={10} defaultValue={3} />
          <FormField label="Repeticiones" name="defaultReps" type="number" min={1} max={100} defaultValue={12} />
          <FormField label="Dificultad" name="difficulty" type="number" min={1} max={5} defaultValue={1} tooltip="De 1 a 5" />
        </div>
        <FormField label="Equipo" name="equipment" placeholder="Banda, foam roller" />
        <FormField label="Descripción" name="description" as="textarea" rows={3} />
        <FormField label="Indicaciones para el paciente" name="cues" as="textarea" rows={2} />
        <div className="k-field">
          <span className="k-label">Etiquetas</span>
          <TagCombobox
            suggestions={availableTags}
            value={selectedTags}
            onChange={setSelectedTags}
            onCreate={onCreateTag}
            placeholder="Escribí y tocá Enter para crear una etiqueta"
          />
        </div>

        {error && (
          <p role="alert" style={{ margin: 0, padding: 10, borderRadius: 10, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 13 }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creando…" : `Crear ${noun}`}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
