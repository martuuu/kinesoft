"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS, parseARS } from "@/lib/format";
import type { InsurerRow } from "@/lib/insurers-types";
import {
  createInsurer,
  updateInsurer,
  deleteInsurer,
} from "@/lib/insurers";
import { ErrorBox } from "../controls";

export function InsurersPanel({ insurers }: { insurers: InsurerRow[] }) {
  const [editing, setEditing] = useState<InsurerRow | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <header
        style={{
          padding: "16px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <div>
          <EyebrowLabel>Obras Sociales y Prepagas</EyebrowLabel>
          <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
            Cada paciente puede tener una cobertura. El copago lo paga el paciente; el monto fijo es lo que le abona la prestadora al kine por sesión.
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> Nueva obra social
        </Button>
      </header>
      {insurers.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          No hay obras sociales cargadas.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {insurers.map((i) => (
            <li
              key={i.id}
              onClick={() => setEditing(i)}
              style={{
                padding: "14px 20px",
                display: "grid",
                gridTemplateColumns: "1.4fr 110px 110px 80px 80px",
                gap: 14,
                alignItems: "center",
                borderBottom: "1px solid rgba(15,30,51,0.04)",
                cursor: "pointer",
                opacity: i.active ? 1 : 0.55,
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                  {i.name}
                  {i.isParticular && <Tag tone="soft">Por defecto</Tag>}
                </div>
                {i.isParticular ? (
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                    Pacientes sin obra social. Ajustá el copago = precio particular.
                  </div>
                ) : (
                  i.notes && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{i.notes}</div>
                )}
              </div>
              <Money label="Copago" amount={i.copagoCents} />
              <Money label="Monto fijo" amount={i.fixedFeeCents} />
              <div style={{ fontSize: 11, color: "var(--navy-300)", textAlign: "right" }}>
                {i.patientsCount} pac.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                {i.active ? <Tag tone="lime">Activa</Tag> : <Tag tone="soft">Inactiva</Tag>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && <InsurerModal onClose={() => setCreating(false)} />}
      {editing && <InsurerModal insurer={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function Money({ label, amount }: { label: string; amount: number }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 10, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </div>
      <div className="k-mono" style={{ fontSize: 13, fontWeight: 700 }}>
        {amount > 0 ? formatARS(amount) : "—"}
      </div>
    </div>
  );
}

function InsurerModal({ insurer, onClose }: { insurer?: InsurerRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(insurer?.active ?? true);

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const payload = {
        name: String(formData.get("name") ?? ""),
        copagoCents: parseARS(String(formData.get("copago") ?? "")) ?? 0,
        fixedFeeCents: parseARS(String(formData.get("fixedFee") ?? "")) ?? 0,
        active,
        notes: String(formData.get("notes") ?? ""),
      };
      const r = insurer
        ? await updateInsurer(insurer.id, payload)
        : await createInsurer(payload);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  const confirm = useConfirm();
  const onDelete = async () => {
    if (!insurer) return;
    const ok = await confirm({
      title: `¿Eliminar "${insurer.name}"?`,
      message: "Si tiene pacientes asociados, se desactiva en su lugar.",
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteInsurer(insurer.id);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  return (
    <Modal
      onClose={onClose}
      title={insurer ? "Editar obra social" : "Nueva obra social"}
      width={520}
    >
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre" name="name" required defaultValue={insurer?.name ?? ""} placeholder="OSDE, Swiss Medical…" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField
            label="Copago (paciente, ARS)"
            name="copago"
            type="number"
            min={0}
            step={50}
            defaultValue={insurer ? insurer.copagoCents / 100 : 0}
            hint="Lo que paga el paciente por sesión"
          />
          <FormField
            label="Monto fijo (prestadora, ARS)"
            name="fixedFee"
            type="number"
            min={0}
            step={50}
            defaultValue={insurer ? insurer.fixedFeeCents / 100 : 0}
            hint="Lo que abona la prestadora al kine"
          />
        </div>
        <FormField as="textarea" label="Notas internas" name="notes" defaultValue={insurer?.notes ?? ""} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Activa (aparece en el selector de cobertura)
        </label>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div
          style={{
            display: "flex",
            justifyContent: insurer && !insurer.isParticular ? "space-between" : "flex-end",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          {insurer && !insurer.isParticular && (
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              style={{
                background: "transparent",
                border: "none",
                color: "#9F1F1F",
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 700,
              }}
            >
              Eliminar
            </button>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
