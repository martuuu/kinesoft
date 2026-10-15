"use client";

/**
 * [EV0-P3] Drawer "Editar suscripción" del detalle de un consultorio
 * (/plataforma/consultorios/[id], plan §15.4). Edita exactamente lo que EV-D6
 * deja tocar desde /plataforma — tipo, plan, estado de la suscripción, fin del
 * trial y turnos online — vía `updatePlatformTenant` (EV-P1), que re-chequea
 * superadmin, valida con un zod `.strict()` y escribe con CAS.
 *
 * Por qué solo se mandan los campos cambiados (`buildUpdatePayload`): el
 * escritor único audita en el tenant afectado lo que llega en el patch; mandar
 * los cinco siempre ensuciaría el log con "cambios" que nadie hizo y, peor,
 * pisaría con el valor viejo una columna que otro superadmin cambió en el medio
 * si el CAS algún día se relajara.
 *
 * BO3-B sumó el cupo de profesionales a medida (`seatLimitOverride`, BO-D7). PL-1d
 * lo reemplaza: el plan es el SaaS (Individual / Consultorio / Clínica / Libre) y
 * los cupos a medida son por tipo (usuarios, profesionales, no clínicos). Se ven
 * con Libre (que vive de ellos) o si ya hay alguno cargado; en otro plan son una
 * excepción y se abren con «Fijar cupos a medida». Vacío = el del plan. Vive en la
 * pestaña «Suscripción» del detalle.
 *
 * CAS: la primera versión es `detail.updatedAt`; después de cada guardado se usa
 * la `data.updatedAt` que devuelve la action (el `router.refresh()` puede tardar
 * en traer el detail nuevo, y reabrir el Drawer con la versión vieja daría un
 * stale falso).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SaasPlan, SubscriptionStatus, TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { updatePlatformTenant } from "@/lib/platform-tenants";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { REBASED_FORM_COPY, rebaseForm } from "@/components/plataforma/tenants/rebase-form";
import {
  SAAS_PLAN_VALUES,
  SUBSCRIPTION_STATUS_VALUES,
  TENANT_VERTICAL_VALUES,
  type UpdatePlatformTenantInput,
} from "@/lib/platform-tenants-schemas";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import type { PlanLimits } from "@/lib/saas-plans-types";
import { SEAT_LIMIT_OVERRIDE_MAX } from "@/lib/platform-tenants-schemas";
import { SUBSCRIPTION_STATUS_LABEL } from "@/components/plataforma/tenants/labels";

export type TenantEditFormState = {
  vertical: TenantVertical;
  saasPlan: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  /** Día AR "YYYY-MM-DD" del `<input type="date">`; "" = sin trial. */
  trialEndsOn: string;
  publicBookingEnabled: boolean;
  /** PL-1d: cupos a medida como texto del input; "" = el del plan (null). */
  maxUsersOverride: string;
  maxProfessionalsOverride: string;
  maxStaffOverride: string;
};

const OVERRIDE_KEYS = ["maxUsersOverride", "maxProfessionalsOverride", "maxStaffOverride"] as const;
type OverrideKey = (typeof OVERRIDE_KEYS)[number];

const asText = (n: number | null) => (n == null ? "" : String(n));

/** Copy literal del plan §15.4 para el `useConfirm` al pasar a General. */
export const GENERAL_DOWNGRADE_COPY =
  "Pasar a Clínica general oculta Planes, Sesiones, Diagnóstico y Ejercicios. No se borra nada.";

export function formFromDetail(d: PlatformTenantDetail): TenantEditFormState {
  return {
    vertical: d.vertical,
    saasPlan: d.saasPlan,
    subscriptionStatus: d.subscriptionStatus,
    trialEndsOn: d.trialEndsOn ?? "",
    publicBookingEnabled: d.publicBookingEnabled,
    maxUsersOverride: asText(d.maxUsersOverride),
    maxProfessionalsOverride: asText(d.maxProfessionalsOverride),
    maxStaffOverride: asText(d.maxStaffOverride),
  };
}

/**
 * "" → null (volver al cupo del plan); un entero → ese número. Lo que no es un entero viaja como NaN para que el
 * zod del server lo rechace con su copy (no se adivina lo que quiso tipear).
 */
export function parseSeatOverride(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

/**
 * Lo que viaja a `updatePlatformTenant`: `tenantId` + la versión del CAS + solo
 * las keys que cambiaron respecto de `initial`. Trial vacío = `null` (borrar el
 * trial); ausente = no tocar.
 */
export function buildUpdatePayload(
  tenantId: string,
  expectedUpdatedAt: string,
  initial: TenantEditFormState,
  form: TenantEditFormState,
): UpdatePlatformTenantInput {
  const payload: UpdatePlatformTenantInput = { tenantId, expectedUpdatedAt };
  if (form.vertical !== initial.vertical) payload.vertical = form.vertical;
  if (form.saasPlan !== initial.saasPlan) payload.saasPlan = form.saasPlan;
  if (form.subscriptionStatus !== initial.subscriptionStatus) payload.subscriptionStatus = form.subscriptionStatus;
  if (form.trialEndsOn !== initial.trialEndsOn) payload.trialEndsOn = form.trialEndsOn === "" ? null : form.trialEndsOn;
  if (form.publicBookingEnabled !== initial.publicBookingEnabled) payload.publicBookingEnabled = form.publicBookingEnabled;
  for (const k of OVERRIDE_KEYS) {
    if (form[k].trim() !== initial[k].trim()) payload[k] = parseSeatOverride(form[k]);
  }
  return payload;
}

export function isFormChanged(initial: TenantEditFormState, form: TenantEditFormState): boolean {
  return Object.keys(buildUpdatePayload("", "", initial, form)).length > 2;
}

/** Pasar a General esconde los módulos clínicos: pide confirmación (solo al bajar, no al subir). */
export function isGeneralDowngrade(prev: TenantVertical, next: TenantVertical): boolean {
  return next === "GENERAL" && prev !== "GENERAL";
}

const verticalOptions = TENANT_VERTICAL_VALUES.map((v) => ({ value: v, label: VERTICAL_LABEL[v] }));
const planOptions = SAAS_PLAN_VALUES.map((v) => ({ value: v, label: SAAS_PLAN_LABEL[v] }));

/**
 * PL-1d: ¿se muestran los cupos a medida? Con Libre siempre (sin cupos = sin límite, y es donde se pactan); en otro
 * plan, solo si ya hay alguno cargado (una excepción vigente no se esconde) o si el superadmin la abrió a mano.
 */
export function showSeatOverrides(form: TenantEditFormState, opened: boolean): boolean {
  return opened || form.saasPlan === "LIBRE" || OVERRIDE_KEYS.some((k) => form[k].trim() !== "");
}

const OVERRIDE_FIELDS: { key: OverrideKey; limit: keyof PlanLimits; label: string; min: 0 | 1 }[] = [
  { key: "maxUsersOverride", limit: "maxUsers", label: "Usuarios en total", min: 1 },
  { key: "maxProfessionalsOverride", limit: "maxProfessionals", label: "Profesionales", min: 0 },
  { key: "maxStaffOverride", limit: "maxStaff", label: "No clínicos (Secretaria, Facturación, Administración)", min: 0 },
];

/** Placeholder del cupo: el del plan (valores sembrados de `SaasPlanConfig`, `PLAN_DEFAULTS`). */
function planDefaultText(plan: SaasPlan, limit: keyof PlanLimits): string {
  const v = PLAN_DEFAULTS[plan].limits[limit];
  return v == null ? "Sin límite (el del plan)" : `${v} (el del plan)`;
}
const statusOptions = SUBSCRIPTION_STATUS_VALUES.map((v) => ({ value: v, label: SUBSCRIPTION_STATUS_LABEL[v] }));

/** Cuerpo del Drawer, controlado y sin efectos: se puede montar con props en un render test. */
export function TenantEditForm({
  form,
  dirty,
  pending,
  error,
  fieldErrors,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: TenantEditFormState;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  onChange: <K extends keyof TenantEditFormState>(key: K, value: TenantEditFormState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const fieldError = (k: string) => fieldErrors[k]?.[0];
  // Solo abre la sección: no es parte del form (no viaja ni se rebasea).
  const [overridesOpened, setOverridesOpened] = useState(false);
  const overridesVisible = showSeatOverrides(form, overridesOpened);
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }}>
      <FormField
        as="select"
        label="Tipo de consultorio"
        value={form.vertical}
        options={verticalOptions}
        onChange={(v) => onChange("vertical", v as TenantVertical)}
        error={fieldError("vertical")}
        disabled={pending}
      />
      <FormField
        as="select"
        label="Plan"
        value={form.saasPlan}
        options={planOptions}
        onChange={(v) => onChange("saasPlan", v as SaasPlan)}
        hint="Si con el plan nuevo no entra el equipo actual, no se guarda: para bajar de plan hay que elegir quiénes pierden el acceso."
        error={fieldError("saasPlan")}
        disabled={pending}
      />
      <FormField
        as="select"
        label="Estado de la suscripción"
        value={form.subscriptionStatus}
        options={statusOptions}
        onChange={(v) => onChange("subscriptionStatus", v as SubscriptionStatus)}
        hint="Es informativo hasta que exista la facturación."
        error={fieldError("subscriptionStatus")}
        disabled={pending}
      />
      <div style={{ display: "grid", gap: 6 }}>
        <FormField
          type="date"
          label="Fin de la prueba"
          value={form.trialEndsOn}
          onChange={(v) => onChange("trialEndsOn", v)}
          hint="Vacío = sin prueba. El día que elijas cuenta entero."
          error={fieldError("trialEndsOn")}
          disabled={pending}
        />
        {form.trialEndsOn !== "" && (
          <button
            type="button"
            onClick={() => onChange("trialEndsOn", "")}
            disabled={pending}
            style={{
              justifySelf: "start",
              background: "none",
              border: "none",
              padding: 0,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--sky-700)",
              cursor: "pointer",
            }}
          >
            Quitar el trial
          </button>
        )}
      </div>
      {overridesVisible ? (
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          <legend style={{ padding: 0, marginBottom: 4, fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
            Cupos a medida
          </legend>
          <p style={{ margin: 0, fontSize: 12, color: "var(--navy-300)", lineHeight: 1.45 }}>
            {form.saasPlan === "LIBRE"
              ? "En Libre, un cupo vacío es sin límite."
              : "Excepción al plan. Vacío = el del plan."}{" "}
            Bajarlo no saca a nadie: solo frena nuevas invitaciones.
          </p>
          {OVERRIDE_FIELDS.map((f) => (
            <FormField
              key={f.key}
              type="number"
              label={f.label}
              value={form[f.key]}
              min={f.min}
              max={SEAT_LIMIT_OVERRIDE_MAX}
              step={1}
              placeholder={planDefaultText(form.saasPlan, f.limit)}
              onChange={(v) => onChange(f.key, v)}
              error={fieldError(f.key)}
              disabled={pending}
            />
          ))}
        </fieldset>
      ) : (
        <button
          type="button"
          onClick={() => setOverridesOpened(true)}
          disabled={pending}
          style={{
            justifySelf: "start",
            background: "none",
            border: "none",
            padding: 0,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--sky-700)",
            cursor: "pointer",
          }}
        >
          Fijar cupos a medida
        </button>
      )}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: 12,
          borderRadius: "var(--r-sm)",
          background: "rgba(255,255,255,0.7)",
          border: "1px solid rgba(15,30,51,0.08)",
          cursor: pending ? "not-allowed" : "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={form.publicBookingEnabled}
          onChange={(e) => onChange("publicBookingEnabled", e.target.checked)}
          disabled={pending}
          style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--sky-700)" }}
        />
        <span style={{ display: "grid", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>Turnos online</span>
          <span style={{ fontSize: 12, color: "var(--navy-300)" }}>
            Apagados, la página pública muestra &quot;Turnos online no disponibles&quot;.
          </span>
        </span>
      </label>

      {error && (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "rgba(225,75,75,0.08)",
            border: "1px solid rgba(225,75,75,0.25)",
            color: "#9F1F1F",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || pending}>
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
    </form>
  );
}

/** Botón "Editar suscripción" + Drawer. Vive en el header del detail. */
export function TenantEditDrawer({ detail }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();

  const [open, setOpen] = useState(false);
  // Versión del CAS y foto "guardada" del form. Se resincronizan cuando el
  // refresh trae un detail nuevo (otro guardado, o el propio).
  const [version, setVersion] = useState(detail.updatedAt);
  const [baseline, setBaseline] = useState<TenantEditFormState>(() => formFromDetail(detail));
  const [form, setForm] = useState<TenantEditFormState>(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // El refresh trae otra versión → se resincronizan versión y baseline. BO-Z B8: con el Drawer abierto y una versión
  // AJENA (no la del propio guardado, que ya quedó en `version`), el form se rebasea sobre la baseline nueva solo en
  // los campos no tocados (`rebaseForm`, porqué allá) y se avisa. Solo cuando cambia la versión del server: el resto
  // del objeto es nuevo en cada render.
  useEffect(() => {
    const next = formFromDetail(detail);
    if (open && detail.updatedAt !== version) {
      const r = rebaseForm(baseline, next, form);
      setForm(r.form);
      if (r.changed) setError(REBASED_FORM_COPY);
    }
    setVersion(detail.updatedAt);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updatedAt]);

  const dirty = isFormChanged(baseline, form);

  const openDrawer = () => {
    setForm(baseline);
    setError(null);
    setFieldErrors({});
    setOpen(true);
  };

  const onChange = async <K extends keyof TenantEditFormState>(key: K, value: TenantEditFormState[K]) => {
    if (key === "vertical" && isGeneralDowngrade(form.vertical, value as TenantVertical)) {
      const ok = await confirm({
        title: "¿Pasar a Clínica general?",
        message: GENERAL_DOWNGRADE_COPY,
        confirmLabel: "Pasar a general",
        cancelLabel: "Dejar como está",
        tone: "danger",
      });
      if (!ok) return;
    }
    setForm((f) => ({ ...f, [key]: value }));
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await runPlatform(() => updatePlatformTenant(buildUpdatePayload(detail.id, version, baseline, form)));
      if (!res.ok) {
        // Stale incluido: el Drawer queda abierto con lo que cargó el superadmin.
        // `router.refresh()` trae el detail actual y el efecto de `detail.updatedAt`
        // resincroniza versión y baseline: sin esto, reintentar mandaba la misma
        // versión vieja y volvía a dar stale para siempre (revisión EV0). El form
        // no se toca, así que el cambio cargado no se pierde.
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        router.refresh();
        return;
      }
      setVersion(res.data.updatedAt);
      setBaseline(form);
      setOpen(false);
      toast.success("Suscripción actualizada");
      router.refresh();
    } catch {
      setError("No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button type="button" variant="primary" onClick={openDrawer}>
        Editar suscripción
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Editar suscripción"
        dirty={dirty}
        width={440}
      >
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
          {detail.name} · <span style={{ fontFamily: "var(--font-mono)" }}>{detail.slug}</span>
        </p>
        <TenantEditForm
          form={form}
          dirty={dirty}
          pending={pending}
          error={error}
          fieldErrors={fieldErrors}
          onChange={(k, v) => void onChange(k, v)}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </>
  );
}
