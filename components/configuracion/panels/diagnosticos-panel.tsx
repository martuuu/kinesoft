"use client";

import { useState, useTransition } from "react";
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
import styles from "../configuracion.module.css";

// [PF1.1-config · C-PF4] Sin `router.refresh()` después de las actions de este archivo: todas revalidan `/configuracion`
// y la respuesta de la action ya trae el árbol nuevo (un refresh era un segundo render entero, PF-0d).

export function DiagnosticosPanel({ conditions }: { conditions: CustomConditionRow[] }) {
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
          {/* C4: a 390 las 5 columnas desbordaban la página; scrolleaban dentro de la card. MB-1e: < 768 cada fila es
              una card sin encabezado, con rótulos propios en CIE-10 y Mecanismo (sin el encabezado, un «—» suelto no
              dice qué falta). Grilla en clases, no inline: un `style` le ganaría al @media. */}
          <div className={styles.tableScroll}>
          <div className={styles.condTable}>
          <div className={styles.condHead}>
            <span>Nombre</span>
            <span>CIE-10</span>
            <span>Mecanismo</span>
            <span>Severidad</span>
            <span style={{ textAlign: "right" }}>Acciones</span>
          </div>
          {conditions.map((c) => (
            <div key={c.id} className={styles.condRow}>
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{c.name}</div>
                {c.summary && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.summary}
                  </div>
                )}
              </div>
              <div className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                <span className={styles.cellLabel}>CIE-10 </span>
                {c.cie10 ?? "—"}
              </div>
              <div className={styles.condMech} style={{ fontSize: 12, color: "var(--navy-500)" }}>
                <span className={styles.cellLabel}>Mecanismo: </span>
                {c.mechanism ?? "—"}
              </div>
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
              <div className={styles.condActions}>
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  style={miniBtn}
                >
                  Editar
                </button>
                <DeleteConditionButton id={c.id} name={c.name} />
              </div>
            </div>
          ))}
          </div>
          </div>
        </Card>
      )}

      {creating && (
        <CustomConditionModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
          }}
        />
      )}
      {editing && (
        <CustomConditionModal
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
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
  onDone?: () => void;
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
      onDone?.();
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      style={{ ...miniBtn, color: "var(--danger-fg)", borderColor: "var(--danger-border)" }}
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
        <div className={styles.twoCol}>
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
            style={{ padding: 10, borderRadius: 10, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 12 }}
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
