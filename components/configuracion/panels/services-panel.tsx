"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS, parseARS } from "@/lib/format";
import { SERVICE_COLORS } from "@/lib/service-colors";
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
                <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: s.color ?? "rgba(15,30,51,0.12)",
                      flexShrink: 0,
                    }}
                  />
                  {s.name}
                </div>
                {s.description && (
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{s.description}</div>
                )}
              </div>
              <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
                {s.practitionerName ?? "Todos los kinesiólogos"}
              </div>
              <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)", textAlign: "right" }}>
                {s.durationMin} min
                {s.maxConcurrent != null && (
                  <div style={{ fontSize: 10, color: "var(--navy-300)" }}>{s.maxConcurrent}/horario</div>
                )}
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
  const [color, setColor] = useState<string | null>(service?.color ?? null);

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const payload = {
        name: String(formData.get("name") ?? ""),
        description: String(formData.get("description") ?? ""),
        durationMin: Number(formData.get("durationMin") ?? 45),
        priceCents: parseARS(String(formData.get("price") ?? "")) ?? 0,
        practitionerId: String(formData.get("practitionerId") ?? ""),
        maxConcurrent: String(formData.get("maxConcurrent") ?? ""),
        color: String(formData.get("color") ?? ""),
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
    <Drawer open onClose={onClose} title={service ? "Editar servicio" : "Nuevo servicio"} width={480}>
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
          label="Cupos simultáneos por horario"
          name="maxConcurrent"
          type="number"
          min={1}
          max={50}
          placeholder="Ilimitado"
          defaultValue={service?.maxConcurrent ?? ""}
          hint="Vacío = ilimitado (kinesiología: varios pacientes en paralelo). Poné 1 para osteopatía (un turno por horario)."
        />
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

        <div style={{ fontSize: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Color</span>
          <input type="hidden" name="color" value={color ?? ""} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {SERVICE_COLORS.map((c) => {
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(selected ? null : c)}
                  aria-pressed={selected}
                  aria-label={selected ? "Quitar color" : `Elegir color ${c}`}
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: c,
                    cursor: "pointer",
                    padding: 0,
                    border: selected
                      ? "2px solid var(--navy-900)"
                      : "1px solid rgba(15,30,51,0.12)",
                    boxShadow: selected ? "0 0 0 2px #fff inset" : undefined,
                  }}
                />
              );
            })}
          </div>
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            marginTop: 6,
          }}
        >
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {pending ? "Guardando…" : "Guardar"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            style={{ width: "100%", justifyContent: "center" }}
          >
            Cancelar
          </Button>
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
                width: "100%",
                textAlign: "center",
                padding: "6px 0",
              }}
            >
              Eliminar
            </button>
          )}
        </div>
      </form>
    </Drawer>
  );
}
