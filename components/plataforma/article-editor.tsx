"use client";

/**
 * ArticleEditor — platform-superadmin editor for the optional long-form
 * "Ejercicio completo" article attached 1:1 to a GLOBAL catalog exercise.
 *
 * A single `<form action>` of FormField inputs prefilled from `article`
 * (null → empty). On submit we build the `upsertExerciseArticle` payload
 * (empty strings omitted → undefined), following the services-panel
 * useTransition + useToast + router.refresh() conventions.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { upsertExerciseArticle } from "@/lib/exercises-admin";

export type ArticleData = {
  title: string | null;
  subtitle: string | null;
  focus: string | null;
  readingMinutes: number | null;
  bodyMarkdown: string | null;
  references: string | null;
};

export function ArticleEditor({
  exerciseId,
  article,
  onChanged,
}: {
  exerciseId: string;
  article: ArticleData | null;
  /** Called after a successful save so the parent can refetch the exercise. */
  onChanged?: () => void;
}): JSX.Element {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (fd: FormData) => {
    setError(null);
    const str = (key: string): string | undefined => {
      const v = String(fd.get(key) ?? "").trim();
      return v === "" ? undefined : v;
    };
    const readingMinutes = Number(fd.get("readingMinutes")) || undefined;
    const payload = {
      exerciseId,
      title: str("title"),
      subtitle: str("subtitle"),
      focus: str("focus"),
      readingMinutes,
      bodyMarkdown: str("bodyMarkdown"),
      references: str("references"),
    };
    start(async () => {
      const r = await upsertExerciseArticle(payload);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      toast.success("Artículo guardado");
      onChanged?.();
      router.refresh();
    });
  };

  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>
        Ejercicio completo
      </div>

      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Título" name="title" defaultValue={article?.title ?? ""} />
        <FormField label="Subtítulo" name="subtitle" defaultValue={article?.subtitle ?? ""} />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: 10 }}>
          <FormField label="Enfoque" name="focus" defaultValue={article?.focus ?? ""} />
          <FormField
            label="Tiempo de lectura (min)"
            name="readingMinutes"
            type="number"
            min={1}
            max={120}
            placeholder="Opcional"
            defaultValue={article?.readingMinutes ?? ""}
          />
        </div>
        <FormField
          as="textarea"
          label="Contenido"
          name="bodyMarkdown"
          rows={10}
          defaultValue={article?.bodyMarkdown ?? ""}
          hint="Soporta markdown: **negrita**, *itálica*, listas con -, > citas, ## subtítulos"
        />
        <FormField
          as="textarea"
          label="Referencias / citas"
          name="references"
          rows={4}
          defaultValue={article?.references ?? ""}
        />

        {error && (
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <Button type="submit" variant="primary" disabled={pending} style={{ justifyContent: "center" }}>
          {pending ? "Guardando…" : "Guardar artículo"}
        </Button>

        <p style={{ margin: 0, fontSize: 11.5, color: "var(--navy-300)", lineHeight: 1.5 }}>
          El artículo es opcional — se muestra al abrir «Ejercicio completo».
        </p>
      </form>
    </Card>
  );
}
