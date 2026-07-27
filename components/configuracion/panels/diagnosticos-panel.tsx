"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  createCustomCondition,
  updateCustomCondition,
  deleteCustomCondition,
  type CustomConditionRow,
} from "@/lib/conditions";

export function DiagnosticosPanel({ conditions }: { conditions: CustomConditionRow[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomConditionRow | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
          <div>
            <EyebrowLabel>Diagnósticos personalizados</EyebrowLabel>
            <p style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 6, maxWidth: 640, lineHeight: 1.45 }}>
              Crea diagnósticos propios cuando el catálogo CIE-10 base no alcanza.
              Quedan disponibles para todo el consultorio y se pueden asignar como
              diagnóstico confirmado desde la pantalla de Diagnóstico.
            </p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            + Nuevo diagnóstico
          </Button>
        </div>
      </Card>

      {conditions.length === 0 ? (
        <Card style={{ padding: 32, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Todavía no creaste diagnósticos personalizados.
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 18px",
              display: "grid",
              gridTemplateColumns: "1.6fr 110px 1fr 90px 110px",
              gap: 14,
              fontSize: 10,
              fontWeight: 700,
              color: "var(--navy-300)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              borderBottom: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <span>Nombre</span>
            <span>CIE-10</span>
            <span>Mecanismo</span>
            <span>Severidad</span>
            <span style={{ textAlign: "right" }}>Acciones</span>
          </div>
          {conditions.map((c) => (
            <div
              key={c.id}
              style={{
                padding: "14px 18px",
                display: "grid",
                gridTemplateColumns: "1.6fr 110px 1fr 90px 110px",
                gap: 14,
                alignItems: "center",
                fontSize: 13,
                borderBottom: "1px solid rgba(15,30,51,0.04)",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{c.name}</div>
                {c.summary && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.summary}
                  </div>
                )}
              </div>
              <div className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {c.cie10 ?? "—"}
              </div>
              <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{c.mechanism ?? "—"}</div>
              <div>
                {c.severity ? (
                  <Tag
                    tone={
                      c.severity === "SEVERE"
                        ? "soft"
                        : c.severity === "MODERATE"
                          ? "sky"
                          : "lime"
                    }
                  >
                    {c.severity === "MILD" ? "Leve" : c.severity === "MODERATE" ? "Mod." : "Severa"}
                  </Tag>
                ) : (
                  <span style={{ fontSize: 12, color: "var(--navy-300)" }}>—</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  style={miniBtn}
                >
                  Editar
                </button>
                <DeleteConditionButton id={c.id} name={c.name} onDone={() => router.refresh()} />
              </div>
            </div>
          ))}
        </Card>
      )}

      {creating && (
        <CustomConditionModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
      {editing && (
        <CustomConditionModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.1)",
  borderRadius: 999,
  padding: "5px 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

function DeleteConditionButton({
  id,
  name,
  onDone,
}: {
  id: string;
  name: string;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const onClick = async () => {
    const ok = await confirm({
      title: `¿Eliminar "${name}"?`,
      message: "Esta acción es definitiva.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await deleteCustomCondition(id);
      if (!r.ok) {
        setError(r.error);
        toast.error(r.error);
        return;
      }
      onDone();
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      style={{ ...miniBtn, color: "#9F1F1F", borderColor: "rgba(159,31,31,0.25)" }}
      title={error ?? undefined}
    >
      {pending ? "…" : "Eliminar"}
    </button>
  );
}

function CustomConditionModal({
  existing,
  onClose,
  onSaved,
}: {
  existing?: CustomConditionRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (formData: FormData) => {
    setError(null);
    const payload = {
      name: String(formData.get("name") ?? ""),
      cie10: String(formData.get("cie10") ?? ""),
      summary: String(formData.get("summary") ?? ""),
      severity:
        (formData.get("severity") as "MILD" | "MODERATE" | "SEVERE" | "") ||
        undefined,
      mechanism: String(formData.get("mechanism") ?? ""),
      redFlags: String(formData.get("redFlags") ?? ""),
    };
    start(async () => {
      const r = existing
        ? await updateCustomCondition(existing.id, payload)
        : await createCustomCondition(payload);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onSaved();
    });
  };
  return (
    <Modal
      onClose={onClose}
      title={existing ? "Editar diagnóstico" : "Nuevo diagnóstico personalizado"}
      width={560}
    >
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField
          label="Nombre"
          name="name"
          required
          defaultValue={existing?.name ?? ""}
          placeholder="Ej. Tendinopatía rotuliana posquirúrgica"
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField
            label="CIE-10 (opcional)"
            name="cie10"
            defaultValue={existing?.cie10 ?? ""}
            placeholder="M76.5"
          />
          <FormField
            as="select"
            label="Severidad"
            name="severity"
            defaultValue={existing?.severity ?? ""}
            options={[
              { value: "", label: "—" },
              { value: "MILD", label: "Leve" },
              { value: "MODERATE", label: "Moderada" },
              { value: "SEVERE", label: "Severa" },
            ]}
          />
        </div>
        <FormField
          label="Mecanismo (opcional)"
          name="mechanism"
          defaultValue={existing?.mechanism ?? ""}
          placeholder="Sobrecarga / Trauma / Repetitivo / Postural"
        />
        <FormField
          as="textarea"
          label="Resumen clínico (opcional)"
          name="summary"
          defaultValue={existing?.summary ?? ""}
          placeholder="Breve descripción del cuadro y abordaje sugerido."
        />
        <FormField
          as="textarea"
          label="Red flags (opcional)"
          name="redFlags"
          defaultValue={existing?.redFlags ?? ""}
          placeholder="Cuándo derivar al especialista."
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
            {pending ? "Guardando…" : existing ? "Guardar cambios" : "Crear diagnóstico"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
