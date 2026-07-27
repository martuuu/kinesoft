"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS, parseARS } from "@/lib/format";
import type { ServiceRow } from "@/lib/services-types";
import {
  createService,
  updateService,
  deleteService,
} from "@/lib/services";
import { ErrorBox } from "../controls";

export function ServicesPanel({
  services,
  practitioners,
}: {
  services: ServiceRow[];
  practitioners: { id: string; name: string }[];
}) {
  const [editing, setEditing] = useState<ServiceRow | null>(null);
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
          <EyebrowLabel>Servicios del consultorio</EyebrowLabel>
          <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
            Aparecen en el modal de nuevo turno y en el turnero público.
          </div>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> Nuevo servicio
        </Button>
      </header>
      {services.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
          Todavía no cargaste servicios. Creá el primero arriba.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {services.map((s) => (
            <li
              key={s.id}
              onClick={() => setEditing(s)}
              style={{
                padding: "14px 20px",
                display: "grid",
                gridTemplateColumns: "1.4fr 1fr 100px 110px 80px",
                gap: 14,
                alignItems: "center",
                borderBottom: "1px solid rgba(15,30,51,0.04)",
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
                {s.description && (
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{s.description}</div>
                )}
              </div>
              <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
                {s.practitionerName ?? "Todos los kinesiólogos"}
              </div>
              <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)", textAlign: "right" }}>
                {s.durationMin} min
              </div>
              <div className="k-mono" style={{ fontSize: 13, fontWeight: 700, textAlign: "right" }}>
                {s.priceCents > 0 ? formatARS(s.priceCents) : "—"}
              </div>
              <div style={{ fontSize: 11, color: "var(--navy-300)", textAlign: "right" }}>
                {s.bookingsCount} turnos
              </div>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <ServiceModal practitioners={practitioners} onClose={() => setCreating(false)} />
      )}
      {editing && (
        <ServiceModal practitioners={practitioners} service={editing} onClose={() => setEditing(null)} />
      )}
    </Card>
  );
}

function ServiceModal({
  practitioners,
  service,
  onClose,
}: {
  practitioners: { id: string; name: string }[];
  service?: ServiceRow;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const payload = {
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? ""),
        durationMin: Number(formData.get("durationMin") ?? 45),
        priceCents: parseARS(String(formData.get("price") ?? "")) ?? 0,
        practitionerId: String(formData.get("practitionerId") ?? ""),
      };
      const r = service
        ? await updateService(service.id, payload)
        : await createService(payload);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  const confirm = useConfirm();
  const onDelete = async () => {
    if (!service) return;
    const ok = await confirm({
      title: `¿Eliminar el servicio "${service.name}"?`,
      confirmLabel: "Eliminar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await deleteService(service.id);
      if (!r.ok) setError(r.error);
      else {
        onClose();
        router.refresh();
      }
    });
  };

  return (
    <Modal onClose={onClose} title={service ? "Editar servicio" : "Nuevo servicio"} width={520}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Nombre" name="name" required defaultValue={service?.name ?? ""} />
        <FormField
          as="textarea"
          label="Descripción"
          name="description"
          defaultValue={service?.description ?? ""}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField
            label="Duración (min)"
            name="durationMin"
            type="number"
            min={5}
            max={480}
            defaultValue={service?.durationMin ?? 45}
            required
          />
          <FormField
            label="Precio (ARS)"
            name="price"
            type="number"
            min={0}
            step={50}
            defaultValue={service ? service.priceCents / 100 : 0}
          />
        </div>
        <FormField
          as="select"
          label="Profesional asignado"
          name="practitionerId"
          defaultValue={service?.practitionerId ?? ""}
          options={[
            { value: "", label: "Todos los kinesiólogos" },
            ...practitioners.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />

        {error && <ErrorBox>{error}</ErrorBox>}

        <div
          style={{
            display: "flex",
            justifyContent: service ? "space-between" : "flex-end",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
          }}
        >
          {service && (
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
