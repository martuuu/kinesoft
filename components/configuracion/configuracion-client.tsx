"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconCheck, IconPlus, IconX } from "@/components/ui/icons";
import { formatARS } from "@/lib/format";
import type { InsurerRow } from "@/lib/insurers-types";
import type { ServiceRow } from "@/lib/services-types";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { TenantSettings } from "@/lib/tenant-settings";
import {
  createInsurer,
  updateInsurer,
  deleteInsurer,
} from "@/lib/insurers";
import {
  createService,
  updateService,
  deleteService,
} from "@/lib/services";
import {
  createInvitation,
  revokeInvitation,
  regenerateInvitationUrl,
  changeMemberRole,
  removeMember,
} from "@/lib/invitations";
import {
  setSharedPatientView,
  updateTenantBasics,
  setBusinessHours,
} from "@/lib/tenant-settings";
import {
  createCustomCondition,
  updateCustomCondition,
  deleteCustomCondition,
  type CustomConditionRow,
} from "@/lib/conditions";
import {
  BUSINESS_HOUR_MIN,
  BUSINESS_HOUR_MAX,
} from "@/lib/tenant-settings-constants";

type Tab = "general" | "servicios" | "obras-sociales" | "diagnosticos" | "usuarios";

type Props = {
  role: Role;
  tenant: TenantSettings;
  insurers: InsurerRow[];
  services: ServiceRow[];
  team: TeamMemberRow[];
  pending: InvitationRow[];
  practitioners: { id: string; name: string }[];
  customConditions: import("@/lib/conditions").CustomConditionRow[];
};

export function ConfiguracionClient(props: Props) {
  const [tab, setTab] = useState<Tab>("general");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <EyebrowLabel tone="accent">Panel del consultorio</EyebrowLabel>
        <h1 className="k-display" style={{ fontSize: 28, margin: "6px 0 0", letterSpacing: "-0.02em" }}>
          Configuración
        </h1>
      </header>

      <TabsBar tab={tab} setTab={setTab} role={props.role} />

      {tab === "general" && <GeneralPanel tenant={props.tenant} role={props.role} />}
      {tab === "servicios" && (
        <ServicesPanel services={props.services} practitioners={props.practitioners} />
      )}
      {tab === "obras-sociales" && <InsurersPanel insurers={props.insurers} />}
      {tab === "diagnosticos" && <DiagnosticosPanel conditions={props.customConditions} />}
      {tab === "usuarios" && props.role === "OWNER" && (
        <UsersPanel team={props.team} pending={props.pending} />
      )}
    </div>
  );
}

function TabsBar({ tab, setTab, role }: { tab: Tab; setTab: (t: Tab) => void; role: Role }) {
  const tabs: { key: Tab; label: string; ownerOnly?: boolean }[] = [
    { key: "general", label: "General" },
    { key: "servicios", label: "Servicios" },
    { key: "obras-sociales", label: "Obras Sociales" },
    { key: "diagnosticos", label: "Diagnósticos" },
    { key: "usuarios", label: "Usuarios", ownerOnly: true },
  ];
  return (
    <div
      className="k-glass"
      style={{
        display: "inline-flex",
        padding: 4,
        borderRadius: 999,
        gap: 2,
        alignSelf: "flex-start",
      }}
    >
      {tabs.map((t) => {
        if (t.ownerOnly && role !== "OWNER") return null;
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              borderRadius: 999,
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              background: on ? "var(--navy-900)" : "transparent",
              color: on ? "#fff" : "var(--navy-500)",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// General panel — tenant basics + sharedPatientView switch
// ──────────────────────────────────────────────────────────────────────

function GeneralPanel({ tenant, role }: { tenant: TenantSettings; role: Role }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shared, setShared] = useState(tenant.sharedPatientView);
  const [error, setError] = useState<string | null>(null);
  const [hoursStart, setHoursStart] = useState(tenant.businessHoursStart);
  const [hoursEnd, setHoursEnd] = useState(tenant.businessHoursEnd);
  const [hoursMsg, setHoursMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const canAdmin = role === "OWNER" || role === "ADMIN";

  const saveHours = () => {
    setHoursMsg(null);
    start(async () => {
      const r = await setBusinessHours({ start: hoursStart, end: hoursEnd });
      if (!r.ok) {
        setHoursMsg({ tone: "err", text: r.error });
      } else {
        setHoursMsg({ tone: "ok", text: "Horario actualizado." });
        router.refresh();
      }
    });
  };

  const toggleShared = () => {
    setError(null);
    const next = !shared;
    setShared(next);
    start(async () => {
      const r = await setSharedPatientView(next);
      if (!r.ok) {
        setShared(!next);
        setError(r.error);
      } else {
        router.refresh();
      }
    });
  };

  const onBasicsSubmit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await updateTenantBasics({
        name: String(formData.get("name") ?? ""),
        legalName: String(formData.get("legalName") ?? ""),
        taxId: String(formData.get("taxId") ?? ""),
      });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Datos del consultorio</EyebrowLabel>
        <form action={onBasicsSubmit} style={{ display: "grid", gap: 12, marginTop: 10 }}>
          <FormField label="Nombre del consultorio" name="name" defaultValue={tenant.name} required />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormField label="Razón social" name="legalName" defaultValue={tenant.legalName ?? ""} />
            <FormField label="CUIT / Identificador fiscal" name="taxId" defaultValue={tenant.taxId ?? ""} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="submit" variant="primary" disabled={pending}>
              Guardar cambios
            </Button>
          </div>
        </form>
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Vista de pacientes</EyebrowLabel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: 16 }}>
          <div style={{ maxWidth: 560 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--navy-900)" }}>
              Vista compartida del consultorio
            </div>
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, lineHeight: 1.45 }}>
              <strong>Activado</strong>: todos los kinesiólogos ven la historia clínica completa
              de todos los pacientes del consultorio. <strong>Desactivado</strong> (por defecto):
              cada kine sólo ve los pacientes que cargó. Para compartir un paciente puntual con
              otro profesional, usá el botón <strong>Compartir</strong> en el perfil del paciente.
              OWNER/ADMIN siempre ven todo independientemente del modo.
            </div>
          </div>
          <Switch on={shared} onChange={toggleShared} disabled={role !== "OWNER" && role !== "ADMIN"} />
        </div>
        {shared && (
          <div
            style={{
              marginTop: 14,
              padding: 12,
              borderRadius: 10,
              background: "rgba(255,176,32,0.12)",
              border: "1px solid rgba(255,176,32,0.3)",
              fontSize: 12.5,
              color: "var(--navy-700)",
              lineHeight: 1.45,
            }}
          >
            <strong>Atención:</strong> con este modo activado se ignoran los permisos
            individuales otorgados con el botón <em>Compartir</em>. Todos los kinesiólogos
            del consultorio ven los datos completos de todos los pacientes.
          </div>
        )}
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Horario del consultorio</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 14, lineHeight: 1.45 }}>
          Define la franja horaria visible en la agenda y en el turnero público.
          Permitido: <strong>{BUSINESS_HOUR_MIN}:00</strong> a <strong>{BUSINESS_HOUR_MAX}:00</strong>.
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
          <HourSelect
            label="Apertura"
            value={hoursStart}
            onChange={(v) => {
              setHoursStart(v);
              if (v >= hoursEnd) setHoursEnd(Math.min(BUSINESS_HOUR_MAX, v + 1));
            }}
            min={BUSINESS_HOUR_MIN}
            max={BUSINESS_HOUR_MAX - 1}
            disabled={!canAdmin}
          />
          <HourSelect
            label="Cierre"
            value={hoursEnd}
            onChange={setHoursEnd}
            min={Math.max(BUSINESS_HOUR_MIN + 1, hoursStart + 1)}
            max={BUSINESS_HOUR_MAX}
            disabled={!canAdmin}
          />
          <Button
            type="button"
            variant="primary"
            onClick={saveHours}
            disabled={
              pending ||
              !canAdmin ||
              (hoursStart === tenant.businessHoursStart && hoursEnd === tenant.businessHoursEnd)
            }
            style={{ marginLeft: "auto" }}
          >
            {pending ? "Guardando…" : "Guardar horario"}
          </Button>
        </div>
        {hoursMsg && (
          <div
            role={hoursMsg.tone === "err" ? "alert" : "status"}
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 10,
              background:
                hoursMsg.tone === "ok"
                  ? "rgba(200,245,100,0.18)"
                  : "rgba(228,70,70,0.1)",
              color: hoursMsg.tone === "ok" ? "var(--navy-900)" : "#9F1F1F",
              fontSize: 12,
            }}
          >
            {hoursMsg.text}
          </div>
        )}
      </Card>

      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

function HourSelect({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  const options = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        style={{
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: disabled ? "rgba(15,30,51,0.04)" : "#fff",
          fontSize: 14,
          minWidth: 110,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {options.map((h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </label>
  );
}

function Switch({ on, onChange, disabled }: { on: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      disabled={disabled}
      style={{
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 2px 6px rgba(15,30,51,0.18)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Services panel
// ──────────────────────────────────────────────────────────────────────

function ServicesPanel({
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
        priceCents: Math.round(Number(formData.get("price") ?? 0) * 100),
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

  const onDelete = () => {
    if (!service) return;
    if (!confirm(`¿Eliminar el servicio "${service.name}"?`)) return;
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

// ──────────────────────────────────────────────────────────────────────
// Insurers panel
// ──────────────────────────────────────────────────────────────────────

function InsurersPanel({ insurers }: { insurers: InsurerRow[] }) {
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
                <div style={{ fontSize: 14, fontWeight: 600 }}>{i.name}</div>
                {i.notes && (
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{i.notes}</div>
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
        copagoCents: Math.round(Number(formData.get("copago") ?? 0) * 100),
        fixedFeeCents: Math.round(Number(formData.get("fixedFee") ?? 0) * 100),
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

  const onDelete = () => {
    if (!insurer) return;
    if (!confirm(`¿Eliminar "${insurer.name}"? Si tiene pacientes asociados, se desactiva en su lugar.`)) return;
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
            justifyContent: insurer ? "space-between" : "flex-end",
            alignItems: "center",
            marginTop: 6,
          }}
        >
          {insurer && (
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

// ──────────────────────────────────────────────────────────────────────
// Users panel (OWNER only)
// ──────────────────────────────────────────────────────────────────────

function UsersPanel({ team, pending: pendingInvites }: { team: TeamMemberRow[]; pending: InvitationRow[] }) {
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string; emailSent: boolean } | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
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
            <EyebrowLabel>Equipo</EyebrowLabel>
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
              Profesionales y administrativos con acceso al consultorio.
            </div>
          </div>
          <Button variant="primary" onClick={() => setInviting(true)}>
            <IconPlus size={14} /> Invitar usuario
          </Button>
        </header>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {team.map((m) => (
            <TeamRow key={m.membershipId} member={m} />
          ))}
        </ul>
      </Card>

      {pendingInvites.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
            <EyebrowLabel>Invitaciones pendientes</EyebrowLabel>
            <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>
              Compartí el link con el invitado. Al aceptarlo, se suma al equipo.
            </div>
          </header>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {pendingInvites.map((i) => (
              <PendingInviteRow key={i.id} invite={i} />
            ))}
          </ul>
        </Card>
      )}

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onSuccess={(url, emailSent) => {
            setInviting(false);
            setInviteResult({ url, emailSent });
          }}
        />
      )}
      {inviteResult && (
        <ShareInviteModal
          url={inviteResult.url}
          emailSent={inviteResult.emailSent}
          onClose={() => setInviteResult(null)}
        />
      )}
    </div>
  );
}

function TeamRow({ member }: { member: TeamMemberRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const changeRole = (role: Role) => {
    if (member.isYou) return;
    setError(null);
    start(async () => {
      const r = await changeMemberRole(member.membershipId, role);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };
  const remove = () => {
    if (!confirm(`¿Eliminar a ${member.email} del equipo?`)) return;
    setError(null);
    start(async () => {
      const r = await removeMember(member.membershipId);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <li
      style={{
        padding: "14px 20px",
        display: "grid",
        gridTemplateColumns: "1.5fr 1fr 140px 110px",
        gap: 14,
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.04)",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {member.fullName ?? member.email}
          {member.isYou && (
            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--sky-700)", fontWeight: 700 }}>
              (vos)
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{member.email}</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
        {member.specialty ?? "—"}
      </div>
      <select
        value={member.role}
        disabled={member.isYou || pending}
        onChange={(e) => changeRole(e.target.value as Role)}
        style={{
          padding: "8px 10px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: "rgba(255,255,255,0.7)",
          fontSize: 12.5,
          fontWeight: 600,
        }}
      >
        <option value="OWNER">Owner</option>
        <option value="ADMIN">Admin</option>
        <option value="PRACTITIONER">Kinesiólogo</option>
        <option value="ASSISTANT">Asistente</option>
        <option value="BILLING">Facturación</option>
      </select>
      <div style={{ textAlign: "right" }}>
        {!member.isYou && (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            style={{
              background: "transparent",
              border: "none",
              color: "#9F1F1F",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Quitar
          </button>
        )}
        {error && <div style={{ fontSize: 11, color: "#9F1F1F", marginTop: 4 }}>{error}</div>}
      </div>
    </li>
  );
}

function PendingInviteRow({ invite }: { invite: InvitationRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shareResult, setShareResult] = useState<{ url: string; emailSent: boolean } | null>(null);

  const regen = () => {
    start(async () => {
      const r = await regenerateInvitationUrl(invite.id);
      if (r.ok) setShareResult({ url: r.data.url, emailSent: r.data.emailSent });
    });
  };
  const revoke = () => {
    if (!confirm(`¿Revocar la invitación a ${invite.email}?`)) return;
    start(async () => {
      const r = await revokeInvitation(invite.id);
      if (r.ok) router.refresh();
    });
  };

  return (
    <>
      <li
        style={{
          padding: "12px 20px",
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 130px 130px",
          gap: 14,
          alignItems: "center",
          borderBottom: "1px solid rgba(15,30,51,0.04)",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            {invite.firstName} {invite.lastName}
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{invite.email}</div>
        </div>
        <Tag tone="soft">{invite.role}</Tag>
        <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
          Vence {invite.expiresAt.toLocaleDateString("es-AR")}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={regen}
            disabled={pending}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--sky-700)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Reenviar
          </button>
          <button
            type="button"
            onClick={revoke}
            disabled={pending}
            style={{
              background: "transparent",
              border: "none",
              color: "#9F1F1F",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Revocar
          </button>
        </div>
      </li>
      {shareResult && (
        <ShareInviteModal
          url={shareResult.url}
          emailSent={shareResult.emailSent}
          onClose={() => setShareResult(null)}
        />
      )}
    </>
  );
}

function InviteModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (url: string, emailSent: boolean) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await createInvitation({
        email: String(formData.get("email") ?? ""),
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        role: formData.get("role") as
          | "PRACTITIONER"
          | "ADMIN"
          | "ASSISTANT"
          | "BILLING",
        specialty: String(formData.get("specialty") ?? ""),
      });
      if (!r.ok) setError(r.error);
      else {
        router.refresh();
        onSuccess(r.data.url, r.data.emailSent);
      }
    });
  };

  return (
    <Modal onClose={onClose} title="Invitar usuario" width={520}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Email" name="email" type="email" required placeholder="kine@ejemplo.com" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="Nombre" name="firstName" required />
          <FormField label="Apellido" name="lastName" required />
        </div>
        <FormField
          as="select"
          label="Rol"
          name="role"
          defaultValue="PRACTITIONER"
          options={[
            { value: "PRACTITIONER", label: "Kinesiólogo" },
            { value: "ADMIN", label: "Administrador" },
            { value: "ASSISTANT", label: "Asistente" },
            { value: "BILLING", label: "Facturación" },
          ]}
        />
        <FormField label="Especialidad (opcional)" name="specialty" placeholder="Osteopatía, RPG…" />
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creando…" : "Crear invitación"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ShareInviteModal({
  url,
  emailSent,
  onClose,
}: {
  url: string;
  emailSent?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Modal
      onClose={onClose}
      title="Link de invitación"
      description={
        emailSent
          ? "Mandamos el email al invitado. Como backup, también podés compartirle este link."
          : "No pudimos mandar el email automáticamente. Pasale este link al invitado para que se registre."
      }
      width={520}
    >
      {emailSent !== undefined && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: emailSent ? "rgba(200,245,100,0.18)" : "rgba(228,176,32,0.15)",
            color: emailSent ? "var(--navy-900)" : "#7A4A00",
            fontSize: 12.5,
            marginBottom: 10,
          }}
        >
          {emailSent
            ? "✓ Email enviado vía Supabase."
            : "⚠ Email no enviado. Configurá SUPABASE_SERVICE_ROLE_KEY en el server o compartí el link manualmente."}
        </div>
      )}
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "rgba(15,30,51,0.04)",
          fontSize: 12,
          wordBreak: "break-all",
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 10,
        }}
      >
        {url}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
        <Button variant="primary" onClick={copy}>
          {copied ? <><IconCheck size={12} stroke={3} /> Copiado</> : "Copiar link"}
        </Button>
      </div>
    </Modal>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Shared
// ──────────────────────────────────────────────────────────────────────

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(228,70,70,0.1)",
        color: "#9F1F1F",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Diagnósticos panel — CRUD over custom (tenant-scoped) Condition rows
// ──────────────────────────────────────────────────────────────────────

function DiagnosticosPanel({ conditions }: { conditions: CustomConditionRow[] }) {
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
  const onClick = () => {
    if (!confirm(`¿Eliminar "${name}"? Esta acción es definitiva.`)) return;
    setError(null);
    start(async () => {
      const r = await deleteCustomCondition(id);
      if (!r.ok) {
        alert(r.error);
        setError(r.error);
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
