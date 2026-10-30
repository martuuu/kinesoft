"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
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
  setTenantBookingCap,
  setTenantAgendaRules,
} from "@/lib/tenant-settings";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import {
  AGENDA_SLOT_OPTIONS,
  BUSINESS_HOUR_MIN,
  BUSINESS_HOUR_MAX,
} from "@/lib/tenant-settings-constants";
import {
  INTERVAL_CAP_COUNT_MAX,
  INTERVAL_CAP_COUNT_MIN,
  INTERVAL_CAP_MINUTES,
  parseBookingCapPair,
} from "@/lib/booking-cap-config";
import { Switch, ErrorBox } from "../controls";
import { TENANT_BASICS_STALE_ERROR } from "../config-copy";
import styles from "../configuracion.module.css";
import { useAlertPrefs } from "@/components/providers/arrival-alerts";
import { AlertModeControl } from "@/components/realtime/alert-prefs-controls";
import type { PracticeAssetState } from "./practice-asset-field";
import { HC_VISIBILITY_COPY as VIS_COPY, hcVisibilityChange, hcVisibilityOf, type HcVisibility } from "./fichas-settings-logic";
import { BRAND_NAME } from "@/lib/brand";
import {
  AGENDA_RULES_COPY,
  DEFAULT_AGENDA_STEP_MIN,
  PUBLIC_MIN_LEAD_MAX_MINUTES,
  SLOT_STEP_OPTIONS,
  parseTenantAgendaRules,
  type TenantAgendaRulesWrite,
} from "@/lib/agenda-rules-config";
import { leadFromParts, leadToParts, type LeadUnit } from "@/lib/lead-time";

// [FC-3i] El logo baja del chunk de «Mis fichas» (mismo `import()` que configuracion-client): ver
// `practice-asset-field.tsx` (sin chunk compartido nuevo). Con SSR (default de `dynamic`): la tarjeta sale pintada.
const LogoAssetField = dynamic(() => import("./fichas-panel").then((m) => m.LogoAssetField), {
  loading: () => <div aria-busy="true" style={{ minHeight: 120 }} />,
});

/**
 * Configuración → General. T3d-1g (C-AS1): por CAPACIDAD, no por rol (antes `role === OWNER || ADMIN`, que le
 * deshabilitaba el horario a un Profesional con «Configuración» y le dejaba ver deshabilitado lo delicado a la
 * Secretaria). Lo operativo (horario y vista de agenda) es `tenant.admin`; lo delicado (datos del consultorio,
 * «Funciones del consultorio» con el turnero y «quién ve la HC») es `tenant.sensitive` y sin él NO SE MUESTRA: una
 * tarjeta deshabilitada le hacía creer a la Secretaria que algo estaba roto. El server lo exige igual.
 */
export function GeneralPanel({
  tenant,
  admin,
  sensitive,
  support = false,
  logo = null,
  onDirtyChange,
}: {
  tenant: TenantSettings;
  /** `tenant.admin` («Configuración»): horario y vista de agenda del consultorio. */
  admin: boolean;
  /** `tenant.sensitive`: datos del consultorio, turnero y «quién ve la HC». Sin él, esas tarjetas no se muestran. */
  sensitive: boolean;
  /** BO3-F: sesión de soporte. Ve lo de Configuración, pero no puede abrir la HC a otros ni guardar preferencias propias. */
  support?: boolean;
  /** [FC-3i] Logo del consultorio (`tenant.sensitive`); null = sin la tarjeta (la página no lo leyó). */
  logo?: PracticeAssetState | null;
  /**
   * [CF-ZF4 · B18] Dirty-guard del shell (el patrón de Profesionales): el tope y las reglas de la agenda se editan en
   * línea, sin Drawer, y cambiar de pestaña de Configuración desmontaba la tarjeta y perdía lo cargado sin avisar.
   */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const [capDirty, setCapDirty] = useState(false);
  const [rulesDirty, setRulesDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(capDirty || rulesDirty);
  }, [capDirty, rulesDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const { agenda, setAgenda } = useTweaks();
  const [pending, start] = useTransition();
  const [shared, setShared] = useState(tenant.sharedPatientView);
  // [T4-Z] Transición y error propios del radio de la HC: con el `pending`/`error` del panel, «Guardando…» se
  // encendía también al guardar el horario y el error del radio caía en el ErrorBox del fondo, lejos de la Card.
  const [sharedPending, startShared] = useTransition();
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoursStart, setHoursStart] = useState(tenant.businessHoursStart);
  const [hoursEnd, setHoursEnd] = useState(tenant.businessHoursEnd);
  const [slotMinutes, setSlotMinutes] = useState(tenant.agendaSlotMinutes);
  const [hoursMsg, setHoursMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [basicsMsg, setBasicsMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [basicsStale, setBasicsStale] = useState(false);

  // Sync when the server re-renders the tenant prop (the action's `revalidatePath` brings the new tree, PF-0d).
  useEffect(() => { setHoursStart(tenant.businessHoursStart); }, [tenant.businessHoursStart]);
  useEffect(() => { setHoursEnd(tenant.businessHoursEnd); }, [tenant.businessHoursEnd]);
  useEffect(() => { setSlotMinutes(tenant.agendaSlotMinutes); }, [tenant.agendaSlotMinutes]);

  const canAdmin = admin;

  const saveHours = () => {
    setHoursMsg(null);
    start(async () => {
      const r = await setBusinessHours({ start: hoursStart, end: hoursEnd, slotMinutes });
      if (!r.ok) {
        setHoursMsg({ tone: "err", text: r.error });
      } else {
        // [PF1.1-config · C-PF4] Sin `router.refresh()`: la action revalida `/configuracion`.
        setHoursMsg({ tone: "ok", text: "Horario actualizado." });
      }
    });
  };

  // [FC-3i] El radio (`HcVisibilityCard`) ya confirmó si amplía; acá solo se aplica, optimista con vuelta atrás.
  const applyShared = (value: boolean) => {
    setSharedError(null);
    setShared(value);
    startShared(async () => {
      const r = await setSharedPatientView(value);
      if (!r.ok) {
        setShared(!value);
        setSharedError(r.error);
      }
      // [PF1.1-config · C-PF4] Sin `router.refresh()`: la action revalida `/configuracion`.
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
        setBasicsMsg({ tone: "ok", text: "Guardado." });
        // refresh-ok: el nombre del consultorio se ve en el shell (selector de consultorio); la action revalida
        // `/configuracion` pero no re-renderiza el layout `(app)` (mismo caso que el cambio de plan).
        router.refresh();
      }
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      {!sensitive && (
        <div data-sensitive-note style={{ fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
          Algunas opciones las maneja el titular o el administrador.
        </div>
      )}
      {sensitive && (
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Datos del consultorio</EyebrowLabel>
        <form action={onBasicsSubmit} style={{ display: "grid", gap: 12, marginTop: 10 }}>
          {/* `key` = updatedAt: al recargar (o después de guardar) los defaultValue vuelven a leer lo último del server. */}
          <FormField key={`name-${tenant.updatedAt}`} label="Nombre del consultorio" name="name" defaultValue={tenant.name} required />
          <div className={styles.twoCol}>
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
                  // refresh-ok: «Recargar» explícito del usuario tras el rechazo por CAS (la action no cambió nada).
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
                  color: basicsMsg.tone === "ok" ? "var(--navy-900)" : "var(--danger-fg)",
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
      )}

      {sensitive && <FeaturesCard tenant={tenant} />}

      {sensitive && (
        <HcVisibilityCard
          shared={shared}
          onApply={applyShared}
          pending={pending || sharedPending}
          saving={sharedPending}
          error={sharedError}
          support={support}
        />
      )}

      {sensitive && logo && (
        <Card style={{ padding: 20 }}>
          <LogoAssetField initial={logo} disabled={support} />
        </Card>
      )}

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
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
            <span style={{ fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Vista de agenda
            </span>
            <select
              className={styles.select}
              value={slotMinutes}
              onChange={(e) => setSlotMinutes(Number(e.target.value))}
              disabled={!canAdmin}
            >
              {/* T3 (§23.8): 15 también (el server ya lo aceptaba; la grilla de 15' la dibuja Día/Semana). */}
              {AGENDA_SLOT_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 60 ? "Cada 1 hora" : `Cada ${m} minutos`}
                </option>
              ))}
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
                  ? "var(--success-bg)"
                  : "var(--danger-bg)",
              color: hoursMsg.tone === "ok" ? "var(--success-fg)" : "var(--danger-fg)",
              fontSize: 12,
            }}
          >
            {hoursMsg.text}
          </div>
        )}
      </Card>

      <BookingCapCard tenant={tenant} admin={canAdmin} onDirtyChange={setCapDirty} />

      {/* CF-U4: a diferencia del tope (deshabilitado sin «Configuración»), esta tarjeta no se monta: es nueva y no
          hay a quién confundir con un control que «desapareció»; el server lo exige igual (`requireTenantAdmin`). */}
      {canAdmin && <AgendaRulesCard tenant={tenant} onDirtyChange={setRulesDirty} />}

      {/* BO3-F: las preferencias son de la cuenta que mira; las del superadmin como soporte no se guardan (su sesión
          es de solo lectura fuera de las actions de Configuración) y no le sirven al consultorio. */}
      {!support && (
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Mi vista de agenda</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 8, lineHeight: 1.45 }}>
          Personalización por usuario: cada uno ajusta su propia vista semanal y se guarda en tu cuenta. También
          la cambiás desde «Apariencia», en el menú de tu cuenta.
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

/**
 * «Turnos por profesional» (T3e-2c; decisión 6 del 19-oct, plan §23.7): el tope del consultorio, que hereda cada
 * profesional salvo que en Profesionales diga «Sin tope» o tenga uno propio. Vacío = sin tope. `tenant.admin` como el
 * horario: es operativo (la Secretaria con «Configuración» lo maneja). La validación es la misma que la del server
 * (`parseBookingCapPair`), así el botón no se prende con un par a medias.
 */
function BookingCapCard({
  tenant,
  admin,
  onDirtyChange,
}: {
  tenant: TenantSettings;
  admin: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [pending, start] = useTransition();
  const savedCount = tenant.bookingCapCount == null ? "" : String(tenant.bookingCapCount);
  const savedInterval = String(tenant.bookingCapIntervalMin ?? 15);
  const [count, setCount] = useState(savedCount);
  const [interval, setIntervalMin] = useState(savedInterval);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => { setCount(savedCount); }, [savedCount]);
  useEffect(() => { setIntervalMin(savedInterval); }, [savedInterval]);

  // Sin N el intervalo no se guarda (vacío = sin tope). El select no se deshabilita: un control apagado sin motivo a la
  // vista parecía roto (mismo criterio que T3d-1g) y elegir primero el intervalo y después N es igual de válido.
  const empty = count.trim() === "";
  const parsed = parseBookingCapPair(empty ? null : count.trim(), empty ? null : Number(interval));
  const dirty = empty ? tenant.bookingCapCount != null : count.trim() !== savedCount || interval !== savedInterval;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const save = () => {
    setMsg(null);
    if (!parsed.ok) {
      setMsg({ tone: "err", text: parsed.error });
      return;
    }
    start(async () => {
      const r = await setTenantBookingCap({ count: parsed.cap?.count ?? null, intervalMin: parsed.cap?.intervalMin ?? null });
      if (!r.ok) setMsg({ tone: "err", text: r.error });
      // [PF1.1-config · C-PF4] Sin `router.refresh()`: la action revalida `/configuracion`.
      else setMsg({ tone: "ok", text: parsed.cap ? "Tope guardado." : "Sin tope: guardado." });
    });
  };

  return (
    <Card style={{ padding: 20 }} data-booking-cap-card>
      <EyebrowLabel>Turnos por profesional</EyebrowLabel>
      <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 14, lineHeight: 1.45 }}>
        Cuántos turnos puede tener cada profesional que empiecen en el mismo intervalo (10:00, 10:15…), de cualquier
        servicio. Desde el segundo turno, la agenda te avisa; pasado el tope, se carga como <strong>sobreturno</strong> si
        lo confirmás, y el turnero online no lo ofrece. Dejalo vacío para no poner tope. Cada profesional puede tener el
        suyo en Profesionales.
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Máximo de turnos por profesional
          </span>
          <input
            className={styles.select}
            type="number"
            inputMode="numeric"
            min={INTERVAL_CAP_COUNT_MIN}
            max={INTERVAL_CAP_COUNT_MAX}
            step={1}
            placeholder="Sin tope"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            disabled={!admin}
            aria-label="Máximo de turnos por profesional (vacío: sin tope)"
            style={{ width: 120, cursor: "text" }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Cada
          </span>
          <select
            className={styles.select}
            value={interval}
            onChange={(e) => setIntervalMin(e.target.value)}
            disabled={!admin}
            aria-label="Intervalo del tope"
          >
            {INTERVAL_CAP_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="primary"
          onClick={save}
          disabled={pending || !admin || !dirty}
          style={{ marginLeft: "auto" }}
        >
          {pending ? "Guardando…" : "Guardar tope"}
        </Button>
      </div>
      {msg && (
        <div
          role={msg.tone === "err" ? "alert" : "status"}
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 10,
            background: msg.tone === "ok" ? "var(--success-bg)" : "var(--danger-bg)",
            color: msg.tone === "ok" ? "var(--success-fg)" : "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          {msg.text}
        </div>
      )}
    </Card>
  );
}

type TenantAgendaRulesSaved = {
  agendaSlotStepMin: number | null;
  publicSlotStepMin: number | null;
  publicMinLeadMinutes: number | null;
};

/** Form de «Reglas de la agenda» (strings, como los inputs). Anticipación vacía = NULL = default (1 hora). */
export type TenantAgendaRulesDraft = { agendaStep: string; publicStep: string; leadValue: string; leadUnit: LeadUnit };

const LEAD_UNIT_LABEL: Record<LeadUnit, string> = { hours: "horas", days: "días", weeks: "semanas" };

/**
 * Puro: lo guardado → form. La agenda no tiene opción «sin configurar» (NULL = 15, CF-D6): muestra 15. La anticipación
 * abre con `leadToParts` (la mayor unidad que divide exacto) para que abrir y guardar sin tocar sea la identidad.
 */
export function tenantAgendaRulesDraft(saved: TenantAgendaRulesSaved): TenantAgendaRulesDraft {
  const lead = saved.publicMinLeadMinutes == null ? null : leadToParts(saved.publicMinLeadMinutes);
  return {
    agendaStep: String(saved.agendaSlotStepMin ?? DEFAULT_AGENDA_STEP_MIN),
    publicStep: saved.publicSlotStepMin == null ? "" : String(saved.publicSlotStepMin),
    leadValue: lead ? String(lead.value) : "",
    leadUnit: lead?.unit ?? "hours",
  };
}

/**
 * Puro: form → input de `setTenantAgendaRules` (form entero, vacío = NULL). Si el select de la agenda sigue en lo que
 * mostró al abrir, se manda lo guardado: así un NULL (hereda el default) no se convierte en un 15 fijo por haber
 * guardado otro campo. La validación final es la del server (`parseTenantAgendaRules`), con su copy y su campo.
 */
export function tenantAgendaRulesInput(
  d: TenantAgendaRulesDraft,
  saved: TenantAgendaRulesSaved
): { ok: true; input: TenantAgendaRulesWrite } | { ok: false; field: keyof TenantAgendaRulesWrite; error: string } {
  const agenda =
    d.agendaStep === String(saved.agendaSlotStepMin ?? DEFAULT_AGENDA_STEP_MIN) ? saved.agendaSlotStepMin : Number(d.agendaStep);
  const v = d.leadValue.trim();
  let lead: number | null = null;
  if (v !== "") {
    // Enteros: «1,5 horas» daría 90' y al reabrir `leadToParts` lo mostraría como «2 horas» (no es la identidad).
    if (!/^\d+$/.test(v)) return { ok: false, field: "publicMinLeadMinutes", error: AGENDA_RULES_COPY.minLead };
    lead = leadFromParts(Number(v), d.leadUnit);
  }
  const parsed = parseTenantAgendaRules({
    agendaSlotStepMin: agenda,
    publicSlotStepMin: d.publicStep === "" ? null : Number(d.publicStep),
    publicMinLeadMinutes: lead,
  });
  if (!parsed.ok) return { ok: false, field: parsed.field, error: parsed.error };
  return { ok: true, input: parsed.data };
}

/**
 * «Reglas de la agenda» (CF-U4; §28, decisiones 3 y 6 de Martin del 30-oct; M20): cada cuánto ofrece horarios el
 * selector de la agenda (15/30/45/60) y el turnero (automático o 15/30/45/60), y la anticipación mínima del turnero
 * (horas/días/semanas, hasta 8 semanas; vacío = 1 hora). Las hereda cada profesional sin valor propio; la anticipación
 * de un servicio del profesional manda sobre esta. `tenant.admin`, como el tope.
 */
function AgendaRulesCard({ tenant, onDirtyChange }: { tenant: TenantSettings; onDirtyChange?: (dirty: boolean) => void }) {
  const [pending, start] = useTransition();
  // `?? null`: fixtures viejos (cast) sin los campos de M20 no rompen el render.
  const saved: TenantAgendaRulesSaved = {
    agendaSlotStepMin: tenant.agendaSlotStepMin ?? null,
    publicSlotStepMin: tenant.publicSlotStepMin ?? null,
    publicMinLeadMinutes: tenant.publicMinLeadMinutes ?? null,
  };
  const savedKey = `${saved.agendaSlotStepMin}|${saved.publicSlotStepMin}|${saved.publicMinLeadMinutes}`;
  const [draft, setDraft] = useState<TenantAgendaRulesDraft>(() => tenantAgendaRulesDraft(saved));
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [fieldErr, setFieldErr] = useState<Partial<Record<keyof TenantAgendaRulesWrite, string>>>({});
  // Sync cuando la action revalida y llega el tenant nuevo (mismo criterio que el horario).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(tenantAgendaRulesDraft(saved)); }, [savedKey]);

  const initial = tenantAgendaRulesDraft(saved);
  const dirty =
    draft.agendaStep !== initial.agendaStep ||
    draft.publicStep !== initial.publicStep ||
    draft.leadValue.trim() !== initial.leadValue ||
    (draft.leadValue.trim() !== "" && draft.leadUnit !== initial.leadUnit);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const set = (p: Partial<TenantAgendaRulesDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setMsg(null);
    setFieldErr({});
  };

  const save = () => {
    setMsg(null);
    setFieldErr({});
    const r0 = tenantAgendaRulesInput(draft, saved);
    if (!r0.ok) {
      // El error va al lado del campo (no se repite abajo).
      setFieldErr({ [r0.field]: r0.error });
      return;
    }
    start(async () => {
      const r = await setTenantAgendaRules(r0.input);
      if (!r.ok) {
        const fe: Partial<Record<string, string[]>> = r.fieldErrors ?? {};
        setFieldErr({
          agendaSlotStepMin: fe.agendaSlotStepMin?.[0],
          publicSlotStepMin: fe.publicSlotStepMin?.[0],
          publicMinLeadMinutes: fe.publicMinLeadMinutes?.[0],
        });
        // Con campo, el error va al lado del campo; sin campo (permiso, «Datos inválidos»), abajo.
        if (!r.fieldErrors) setMsg({ tone: "err", text: r.error });
      }
      // [PF1.1-config · C-PF4] Sin `router.refresh()`: la action revalida `/configuracion`.
      else setMsg({ tone: "ok", text: "Reglas guardadas." });
    });
  };

  const labelStyle = { fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" } as const;
  const errLine = (t?: string) =>
    t ? (
      <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)", textTransform: "none", letterSpacing: 0 }}>
        {t}
      </span>
    ) : null;

  return (
    <Card style={{ padding: 20 }} data-agenda-rules-card>
      <EyebrowLabel>Reglas de la agenda</EyebrowLabel>
      <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4, marginBottom: 14, lineHeight: 1.45 }}>
        Cada cuánto se ofrecen horarios al dar un turno y en el turnero online, y con cuánta anticipación se pueden
        pedir turnos online. Cada profesional puede tener sus propios intervalos en Profesionales, y cada servicio del
        profesional su propia anticipación.
      </div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
          <span style={labelStyle}>Horarios de la agenda cada</span>
          <select
            className={styles.select}
            value={draft.agendaStep}
            onChange={(e) => set({ agendaStep: e.target.value })}
            disabled={pending}
            aria-label="Horarios de la agenda cada"
            aria-invalid={!!fieldErr.agendaSlotStepMin || undefined}
          >
            {SLOT_STEP_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          {errLine(fieldErr.agendaSlotStepMin)}
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
          <span style={labelStyle}>Horarios del turnero cada</span>
          <select
            className={styles.select}
            value={draft.publicStep}
            onChange={(e) => set({ publicStep: e.target.value })}
            disabled={pending}
            aria-label="Horarios del turnero cada"
            aria-invalid={!!fieldErr.publicSlotStepMin || undefined}
          >
            <option value="">{AGENDA_RULES_COPY.publicStepAuto}</option>
            {SLOT_STEP_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          {errLine(fieldErr.publicSlotStepMin)}
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
          <span style={labelStyle} id="agenda-rules-lead-l">Anticipación mínima del turnero</span>
          <div role="group" aria-labelledby="agenda-rules-lead-l" style={{ display: "flex", gap: 6 }}>
            <input
              className={styles.select}
              type="number"
              inputMode="numeric"
              min={0}
              max={Math.floor(PUBLIC_MIN_LEAD_MAX_MINUTES / leadFromParts(1, draft.leadUnit))}
              step={1}
              value={draft.leadValue}
              onChange={(e) => set({ leadValue: e.target.value })}
              disabled={pending}
              aria-label="Anticipación mínima del turnero"
              aria-invalid={!!fieldErr.publicMinLeadMinutes || undefined}
              aria-describedby="agenda-rules-lead-hint"
              style={{ width: 80, cursor: "text" }}
            />
            <select
              className={styles.select}
              value={draft.leadUnit}
              onChange={(e) => set({ leadUnit: e.target.value as LeadUnit })}
              disabled={pending}
              aria-label="Unidad de la anticipación mínima"
            >
              {(["hours", "days", "weeks"] as const).map((u) => (
                <option key={u} value={u}>
                  {LEAD_UNIT_LABEL[u]}
                </option>
              ))}
            </select>
          </div>
          <span id="agenda-rules-lead-hint" style={{ fontSize: 12, color: "var(--navy-500)" }}>
            Por defecto, 1 hora. Hasta 8 semanas.
          </span>
          {errLine(fieldErr.publicMinLeadMinutes)}
        </div>
        <Button
          type="button"
          variant="primary"
          onClick={save}
          disabled={pending || !dirty}
          style={{ marginLeft: "auto", alignSelf: "flex-end" }}
        >
          {pending ? "Guardando…" : "Guardar reglas"}
        </Button>
      </div>
      {msg && (
        <div
          role={msg.tone === "err" ? "alert" : "status"}
          style={{
            marginTop: 12,
            padding: 10,
            borderRadius: 10,
            background: msg.tone === "ok" ? "var(--success-bg)" : "var(--danger-bg)",
            color: msg.tone === "ok" ? "var(--success-fg)" : "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          {msg.text}
        </div>
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
        className={styles.select}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
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
 * "Funciones del consultorio" (EV0, EV-K). T3d-1g: solo se monta con `tenant.sensitive` (el turnero del consultorio). Lo que el consultorio puede prender
 * por su cuenta (hoy: los turnos online) y, de solo lectura, el tipo de
 * consultorio y el plan, que cambia /plataforma (EV-D5/D6). Futuros toggles del
 * consultorio van como otra `PrefRow` acá, cada uno con su action que pase por
 * `applyTenantEntitlementsInTx` (source `tenant-settings`) y su key en la
 * allowlist de C-EV5.
 */
function FeaturesCard({ tenant }: { tenant: TenantSettings }) {
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
          // refresh-ok: los turnos online son un módulo del consultorio (entitlements): cambian el shell, que la
          // action revalida con `revalidatePath("/", "layout")` pero el árbol de la action no re-renderiza `(app)`.
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
              {/* PL-Z A1: el turnero también filtra por profesional (PL-1); sin decirlo, prender el del consultorio
                  parecía no hacer nada si nadie tenía prendido el suyo. */}
              Tus pacientes reservan solos desde un link público. Solo se ofrecen los servicios marcados como
              públicos y los profesionales que tengan prendido «Aparece en el turnero online» (Configuración →
              Profesionales).
            </>
          }
          on={booking}
          onChange={() => void toggleBooking()}
          disabled={pending}
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
                background: "color-mix(in srgb, var(--navy-900) 4%, transparent)",
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
          hint={`Define qué secciones ves en ${BRAND_NAME}. Para cambiarlo, escribinos desde la pestaña Soporte.`}
        >
          <ReadOnlyValue>{VERTICAL_LABEL[tenant.vertical]}</ReadOnlyValue>
        </PrefRow>
        <PrefRow label="Plan" hint="Los usuarios que incluye y el uso, en la pestaña «Plan y uso».">
          {/* PL-1: plan SaaS (Individual/Consultorio/Clínica/Libre), de `Tenant.saasPlan`. */}
          <ReadOnlyValue>{SAAS_PLAN_LABEL[tenant.saasPlan]}</ReadOnlyValue>
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
        background: "color-mix(in srgb, var(--navy-900) 6%, transparent)",
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
    // C3: el Switch queda a la derecha del texto también a 390 (antes bajaba abajo); un control ancho (`children`,
    // el segmentado de avisos o un valor) sí baja cuando no entra.
    <div className={styles.prefRow} data-wide={children ? "" : undefined}>
      <div className={styles.prefText}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{label}</div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.4 }}>{hint}</div>
      </div>
      {children ?? (
        <Switch on={on} onChange={() => onChange?.(!on)} disabled={disabled} aria-label={label} />
      )}
    </div>
  );
}

/**
 * [FC-3i] «¿Quién ve la historia clínica de cada paciente?» (antes el switch «Vista compartida del consultorio»).
 * Hallazgo 13 (§24.2): el copy viejo decía «El Titular y los administradores ven todo, con cualquiera de los dos
 * modos», falso desde PL-1b: el rol solo ya no abre la HC; la ven si ATIENDEN (`lib/visibility.ts`, regla 1 y nivel
 * 0). Radio y no switch: las dos opciones se leen enteras antes de elegir, y el default («Cada profesional») queda
 * nombrado. Ampliar a «Todos» pide confirmación (`useConfirm`): abre la HC de cada paciente a todo el equipo clínico.
 * Achicar se aplica directo (es lo seguro).
 */
function HcVisibilityCard({
  shared,
  onApply,
  pending,
  saving,
  error,
  support,
}: {
  shared: boolean;
  onApply: (value: boolean) => void;
  pending: boolean;
  /** Solo este radio guardando (no el horario ni los datos del consultorio). */
  saving: boolean;
  error: string | null;
  support: boolean;
}) {
  const confirm = useConfirm();
  const current = hcVisibilityOf(shared);
  const disabled = support || pending;
  const choose = async (next: HcVisibility) => {
    const step = hcVisibilityChange(current, next);
    if (step === "noop") return;
    if (step === "confirm") {
      const ok = await confirm({
        title: VIS_COPY.widenTitle,
        message: VIS_COPY.widenMessage,
        confirmLabel: VIS_COPY.widenConfirm,
        cancelLabel: VIS_COPY.widenCancel,
        tone: "danger",
      });
      if (!ok) return;
    }
    onApply(next === "all");
  };
  const options: { value: HcVisibility; label: string; hint: string }[] = [
    { value: "own", label: VIS_COPY.visibilityOwn, hint: VIS_COPY.visibilityOwnHint },
    { value: "all", label: VIS_COPY.visibilityAll, hint: VIS_COPY.visibilityAllHint },
  ];
  return (
    <Card style={{ padding: 20 }}>
      <fieldset data-hc-visibility style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} disabled={disabled}>
        <legend style={{ padding: 0, fontSize: 15, fontWeight: 600, color: "var(--navy-900)" }}>
          {VIS_COPY.visibilityQuestion}
        </legend>
        {/* [T4-Z] Sin role/aria-label propios: el `fieldset` + `legend` ya agrupan y nombran los radios; un
            radiogroup adentro hacía que el lector leyera la pregunta dos veces. */}
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          {options.map((o) => {
            const on = current === o.value;
            return (
              <label
                key={o.value}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  padding: "10px 12px",
                  minHeight: 44,
                  borderRadius: 10,
                  border: `1px solid ${on ? "var(--sky-300)" : "var(--navy-100)"}`,
                  background: on ? "var(--sky-50)" : "transparent",
                  cursor: disabled ? "default" : "pointer",
                }}
              >
                <input
                  type="radio"
                  name="hc-visibility"
                  value={o.value}
                  checked={on}
                  onChange={() => void choose(o.value)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{o.label}</span>
                  <span style={{ display: "block", fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.45 }}>
                    {o.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 10, lineHeight: 1.45 }}>{VIS_COPY.visibilityRoles}</div>
      {/* [T4-Z] Live region siempre montada: si aparece junto con el texto, el lector no la anuncia. */}
      <div role="status" style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: saving ? 8 : 0 }}>
        {saving ? "Guardando…" : ""}
      </div>
      {error && (
        <div style={{ marginTop: 10 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      )}
      {support && (
        <div data-support-note style={{ marginTop: 10, fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
          {VIS_COPY.supportNote}
        </div>
      )}
      {shared && (
        <div
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 10,
            background: "var(--warn-bg)",
            border: "1px solid var(--warn-border)",
            fontSize: 12.5,
            color: "var(--navy-700)",
            lineHeight: 1.45,
          }}
        >
          <strong>Atención:</strong> {VIS_COPY.visibilityAllWarning}
        </div>
      )}
    </Card>
  );
}
