"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { IconCheck } from "@/components/ui/icons";
import { useTweaks } from "@/components/layout/tweaks-context";
import type { TenantSettings } from "@/lib/tenant-settings";
import {
  setSharedPatientView,
  updateTenantBasics,
  setBusinessHours,
  setPublicBookingEnabled,
} from "@/lib/tenant-settings";
import { PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import {
  BUSINESS_HOUR_MIN,
  BUSINESS_HOUR_MAX,
} from "@/lib/tenant-settings-constants";
import { Switch, ErrorBox } from "../controls";
import { TENANT_BASICS_STALE_ERROR } from "../config-copy";
import { useAlertPrefs } from "@/components/providers/arrival-alerts";
import { AlertModeControl } from "@/components/realtime/alert-prefs-controls";
import { supportContactText } from "@/lib/support-contact";

export function GeneralPanel({
  tenant,
  role,
  support = false,
}: {
  tenant: TenantSettings;
  role: Role;
  /** BO3-F: sesión de soporte. Ve lo de Configuración, pero no puede abrir la HC a otros ni guardar preferencias propias. */
  support?: boolean;
}) {
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
  const [basicsStale, setBasicsStale] = useState(false);

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
    setBasicsStale(false);
    start(async () => {
      const r = await updateTenantBasics({
        name: String(formData.get("name") ?? ""),
        legalName: String(formData.get("legalName") ?? ""),
        taxId: String(formData.get("taxId") ?? ""),
        expectedUpdatedAt: tenant.updatedAt,
      });
      if (!r.ok) {
        if (r.error === TENANT_BASICS_STALE_ERROR) {
          // No se pisa: se avisa y se ofrece recargar (lo tipeado queda en el form hasta que recargue).
          setBasicsStale(true);
          return;
        }
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
          {/* `key` = updatedAt: al recargar (o después de guardar) los defaultValue vuelven a leer lo último del server. */}
          <FormField key={`name-${tenant.updatedAt}`} label="Nombre del consultorio" name="name" defaultValue={tenant.name} required />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <FormField key={`legal-${tenant.updatedAt}`} label="Razón social" name="legalName" defaultValue={tenant.legalName ?? ""} />
            <FormField key={`tax-${tenant.updatedAt}`} label="CUIT / Identificador fiscal" name="taxId" defaultValue={tenant.taxId ?? ""} />
          </div>
          {basicsStale && (
            <div
              role="alert"
              data-basics-stale
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                padding: 12,
                borderRadius: 10,
                background: "var(--st-noshow-bg)",
                color: "var(--st-noshow-fg)",
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <span>
                <strong>Cambió en otra sesión.</strong> Alguien guardó los datos del consultorio mientras editabas.
                Recargá para ver lo último y volvé a hacer tu cambio.
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setBasicsStale(false);
                  router.refresh();
                }}
              >
                Recargar
              </Button>
            </div>
          )}
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

      <FeaturesCard tenant={tenant} canAdmin={canAdmin} />

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
          <Switch
            on={shared}
            onChange={toggleShared}
            disabled={support || (role !== "OWNER" && role !== "ADMIN")}
            aria-label="Vista compartida del consultorio"
          />
        </div>
        {support && (
          <div data-support-note style={{ marginTop: 10, fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
            Como soporte no podés cambiar quién ve la historia clínica: lo decide el consultorio.
          </div>
        )}
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
          Define la franja horaria visible en la agenda y en los turnos online, y cada
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

      {/* BO3-F: las preferencias son de la cuenta que mira; las del superadmin como soporte no se guardan (su sesión
          es de solo lectura fuera de las actions de Configuración) y no le sirven al consultorio. */}
      {!support && (
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
      )}

      {!support && <AlertPrefsCard />}

      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

/**
 * SV11b (§18.5 «Avisos», SV-D4 enmendada): «Avisos de la sala de espera», por
 * usuario. Cada fila aparece solo si le aplica: la llegada a quien atiende, el
 * llamado a quien opera la agenda de todos (Secretaria, OWNER/ADMIN); un OWNER
 * que atiende ve las dos. El mismo control está en Agenda → «Vista».
 * Default «Visual»: el sonido arranca apagado y cada uno lo prende.
 *
 * Sin canal realtime en el consultorio (driver `off`) la Card se muestra IGUAL,
 * con una nota (FX2b, M4): la preferencia se guarda y rige el día que se
 * encienda la sala en vivo. Ocultarla dejaba a la Secretaria sin saber dónde se
 * configura el llamado (Martin, §18.14: «desde SU configuración»).
 */
export function AlertPrefsCard() {
  const a = useAlertPrefs();
  if (!a.appliesArrival && !a.appliesCall) return null;
  return (
    <Card style={{ padding: 20 }}>
      <EyebrowLabel>Avisos de la sala de espera</EyebrowLabel>
      <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 8, lineHeight: 1.45 }}>
        Un aviso arriba a la derecha (y en el título de la pestaña) aunque estés en otra pantalla. Se
        guarda en tu cuenta.
      </div>
      {!a.live && (
        <div
          data-alerts-off-note
          style={{ fontSize: 12.5, color: "var(--navy-500)", marginBottom: 8, lineHeight: 1.45 }}
        >
          Los avisos se activan cuando la sala en vivo esté encendida en el consultorio.
        </div>
      )}
      {a.appliesArrival && (
        <PrefRow label="Cuando llega un paciente mío" hint="«Llegó María G. · 10:30», con el acceso a la sala.">
          <AlertModeControl
            label="Cuando llega un paciente mío"
            value={a.arrivalAlert}
            onChange={a.setArrivalAlert}
          />
        </PrefRow>
      )}
      {a.appliesCall && (
        <PrefRow
          label="Cuando un profesional llama a un paciente"
          hint="«Pase María G. · Consultorio 2», para saber a quién hacer pasar."
        >
          <AlertModeControl
            label="Cuando un profesional llama a un paciente"
            value={a.callAlert}
            onChange={a.setCallAlert}
          />
        </PrefRow>
      )}
    </Card>
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

/**
 * "Funciones del consultorio" (EV0, EV-K). Lo que el consultorio puede prender
 * por su cuenta (hoy: los turnos online) y, de solo lectura, el tipo de
 * consultorio y el plan, que cambia /plataforma (EV-D5/D6). Futuros toggles del
 * consultorio van como otra `PrefRow` acá, cada uno con su action que pase por
 * `applyTenantEntitlementsInTx` (source `tenant-settings`) y su key en la
 * allowlist de C-EV5.
 */
function FeaturesCard({ tenant, canAdmin }: { tenant: TenantSettings; canAdmin: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [booking, setBooking] = useState(tenant.publicBookingEnabled);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // El origin solo existe en el browser: se completa después de montar para no
  // romper la hidratación (el server renderiza la ruta relativa).
  const path = `/c/${tenant.slug}/booking`;
  const [bookingUrl, setBookingUrl] = useState(path);
  useEffect(() => { setBookingUrl(`${window.location.origin}${path}`); }, [path]);
  useEffect(() => { setBooking(tenant.publicBookingEnabled); }, [tenant.publicBookingEnabled]);

  const toggleBooking = async () => {
    const next = !booking;
    if (!next) {
      const ok = await confirm({
        title: "¿Apagar los turnos online?",
        message:
          "Los pacientes ya no van a poder reservar desde el link. Los turnos que ya reservaron no se tocan.",
        tone: "danger",
        confirmLabel: "Apagar",
        cancelLabel: "Dejarlos activos",
      });
      if (!ok) return;
    }
    setError(null);
    setBooking(next);
    start(async () => {
      try {
        const r = await setPublicBookingEnabled(next);
        if (!r.ok) {
          setBooking(!next);
          setError(r.error);
        } else {
          router.refresh();
        }
      } catch {
        setBooking(!next);
        setError("No pudimos guardar el cambio. Reintentá en un momento.");
      }
    });
  };

  const copy = () => {
    navigator.clipboard.writeText(bookingUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => setError("No pudimos copiar el link. Copialo a mano.")
    );
  };

  return (
    <Card style={{ padding: 20 }}>
      <EyebrowLabel>Funciones del consultorio</EyebrowLabel>
      <div style={{ marginTop: 8 }}>
        <PrefRow
          label="Turnos online"
          hint={
            <>
              Tus pacientes reservan solos desde un link público. Solo se ofrecen los servicios
              marcados como públicos.
            </>
          }
          on={booking}
          onChange={() => void toggleBooking()}
          disabled={!canAdmin || pending}
        />
        {booking && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "0 0 12px",
            }}
          >
            <code
              style={{
                flex: "1 1 260px",
                minWidth: 0,
                padding: "8px 12px",
                borderRadius: 10,
                background: "rgba(15,30,51,0.04)",
                fontSize: 12,
                wordBreak: "break-all",
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--navy-700)",
              }}
            >
              {bookingUrl}
            </code>
            <Button type="button" variant="ghost" onClick={copy}>
              {copied ? <><IconCheck size={12} stroke={3} /> Copiado</> : "Copiar link"}
            </Button>
          </div>
        )}
        <PrefRow
          label="Tipo de consultorio"
          hint={`Define qué secciones ves en KineSoft. Para cambiarlo, ${supportContactText()}.`}
        >
          <ReadOnlyValue>{VERTICAL_LABEL[tenant.vertical]}</ReadOnlyValue>
        </PrefRow>
        <PrefRow label="Plan" hint={`Para cambiar de plan, ${supportContactText()}.`}>
          <ReadOnlyValue>{PLAN_LABEL[tenant.plan]}</ReadOnlyValue>
        </PrefRow>
      </div>
      {error && (
        <div style={{ marginTop: 8 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
    </Card>
  );
}

function ReadOnlyValue({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: "var(--navy-900)",
        padding: "6px 12px",
        borderRadius: 999,
        background: "rgba(15,30,51,0.06)",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Label + hint on the left, a Switch on the right (per-user prefs and the
 * consultorio's features). With `children`, that control replaces the Switch
 * (read-only values in "Funciones del consultorio").
 */
function PrefRow({
  label,
  hint,
  on = false,
  onChange,
  disabled,
  children,
}: {
  label: string;
  hint: ReactNode;
  on?: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        // SV11b: el segmentado de avisos no entra al lado del texto a 360 px;
        // con wrap baja abajo (los Switch, angostos, no cambian).
        flexWrap: "wrap",
        padding: "10px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div style={{ maxWidth: 520, flex: "1 1 220px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
      </div>
      {children ?? (
        <Switch on={on} onChange={() => onChange?.(!on)} disabled={disabled} aria-label={label} />
      )}
    </div>
  );
}
