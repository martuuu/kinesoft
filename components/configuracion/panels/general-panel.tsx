"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useTweaks } from "@/components/layout/tweaks-context";
import type { TenantSettings } from "@/lib/tenant-settings";
import {
  setSharedPatientView,
  updateTenantBasics,
  setBusinessHours,
} from "@/lib/tenant-settings";
import {
  BUSINESS_HOUR_MIN,
  BUSINESS_HOUR_MAX,
} from "@/lib/tenant-settings-constants";
import { Switch, ErrorBox } from "../controls";

export function GeneralPanel({ tenant, role }: { tenant: TenantSettings; role: Role }) {
  const router = useRouter();
  const { agenda, setAgenda } = useTweaks();
  const [pending, start] = useTransition();
  const [shared, setShared] = useState(tenant.sharedPatientView);
  const [error, setError] = useState<string | null>(null);
  const [hoursStart, setHoursStart] = useState(tenant.businessHoursStart);
  const [hoursEnd, setHoursEnd] = useState(tenant.businessHoursEnd);
  const [slotMinutes, setSlotMinutes] = useState(tenant.agendaSlotMinutes);
  const [hoursMsg, setHoursMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [basicsMsg, setBasicsMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Sync when the server refreshes the tenant prop (after router.refresh()).
  useEffect(() => { setHoursStart(tenant.businessHoursStart); }, [tenant.businessHoursStart]);
  useEffect(() => { setHoursEnd(tenant.businessHoursEnd); }, [tenant.businessHoursEnd]);
  useEffect(() => { setSlotMinutes(tenant.agendaSlotMinutes); }, [tenant.agendaSlotMinutes]);

  const canAdmin = role === "OWNER" || role === "ADMIN";

  const saveHours = () => {
    setHoursMsg(null);
    start(async () => {
      const r = await setBusinessHours({ start: hoursStart, end: hoursEnd, slotMinutes });
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
    setBasicsMsg(null);
    start(async () => {
      const r = await updateTenantBasics({
        name: String(formData.get("name") ?? ""),
        legalName: String(formData.get("legalName") ?? ""),
        taxId: String(formData.get("taxId") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        setBasicsMsg({ tone: "err", text: r.error });
      } else {
        setBasicsMsg({ tone: "ok", text: "Guardado ✓" });
        router.refresh();
      }
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
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 }}>
            {basicsMsg && (
              <span
                role={basicsMsg.tone === "err" ? "alert" : "status"}
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: basicsMsg.tone === "ok" ? "var(--navy-900)" : "#9F1F1F",
                }}
              >
                {basicsMsg.text}
              </span>
            )}
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
          Define la franja horaria visible en la agenda y en el turnero público, y cada
          cuánto se dibujan las filas de la agenda.
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
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Vista de agenda</span>
            <select
              value={slotMinutes}
              onChange={(e) => setSlotMinutes(Number(e.target.value))}
              disabled={!canAdmin}
              style={{
                padding: "9px 12px",
                borderRadius: 12,
                border: "1px solid rgba(15,30,51,0.1)",
                background: "rgba(255,255,255,0.95)",
                fontSize: 13.5,
                color: "var(--navy-900)",
                cursor: canAdmin ? "pointer" : "not-allowed",
                outline: "none",
              }}
            >
              <option value={60}>Cada 1 hora</option>
              <option value={30}>Cada 30 minutos</option>
            </select>
          </label>
          <Button
            type="button"
            variant="primary"
            onClick={saveHours}
            disabled={
              pending ||
              !canAdmin ||
              (hoursStart === tenant.businessHoursStart &&
                hoursEnd === tenant.businessHoursEnd &&
                slotMinutes === tenant.agendaSlotMinutes)
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

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Mi vista de agenda</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 8, lineHeight: 1.45 }}>
          Personalización por usuario. Cada profesional ajusta su propia vista semanal;
          las preferencias se guardan en tu cuenta y también están en el panel de Tweaks.
        </div>
        <PrefRow
          label="Encabezado de días"
          hint="Muestra u oculta la tira de días (visible en todas las vistas) y el encabezado de la grilla semanal."
          on={agenda.agendaShowWeekHeader}
          onChange={(v) => setAgenda("agendaShowWeekHeader", v)}
        />
        <PrefRow
          label="Mostrar sábado"
          hint="Incluye la columna del sábado en la vista semanal."
          on={agenda.agendaShowSaturday}
          onChange={(v) => setAgenda("agendaShowSaturday", v)}
        />
        <PrefRow
          label="Mostrar domingo"
          hint="Incluye la columna del domingo en la vista semanal."
          on={agenda.agendaShowSunday}
          onChange={(v) => setAgenda("agendaShowSunday", v)}
        />
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

/** Label + hint on the left, a Switch on the right. Used for per-user prefs. */
function PrefRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "10px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div style={{ maxWidth: 520 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
      </div>
      <Switch on={on} onChange={() => onChange(!on)} />
    </div>
  );
}
