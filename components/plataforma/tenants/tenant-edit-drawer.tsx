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
 * CAS: la primera versión es `detail.updatedAt`; después de cada guardado se usa
 * la `data.updatedAt` que devuelve la action (el `router.refresh()` puede tardar
 * en traer el detail nuevo, y reabrir el Drawer con la versión vieja daría un
 * stale falso).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SubscriptionStatus, TenantPlan, TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { updatePlatformTenant } from "@/lib/platform-tenants";
import {
  SUBSCRIPTION_STATUS_VALUES,
  TENANT_PLAN_VALUES,
  TENANT_VERTICAL_VALUES,
  type UpdatePlatformTenantInput,
} from "@/lib/platform-tenants-schemas";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import { SUBSCRIPTION_STATUS_LABEL } from "@/components/plataforma/tenants/labels";

export type TenantEditFormState = {
  vertical: TenantVertical;
  plan: TenantPlan;
  subscriptionStatus: SubscriptionStatus;
  /** Día AR "YYYY-MM-DD" del `<input type="date">`; "" = sin trial. */
  trialEndsOn: string;
  publicBookingEnabled: boolean;
};

/** Copy literal del plan §15.4 para el `useConfirm` al pasar a General. */
export const GENERAL_DOWNGRADE_COPY =
  "Pasar a Consultorio general oculta Planes, Sesiones, Diagnóstico y Ejercicios. No se borra nada.";

export function formFromDetail(d: PlatformTenantDetail): TenantEditFormState {
  return {
    vertical: d.vertical,
    plan: d.plan,
    subscriptionStatus: d.subscriptionStatus,
    trialEndsOn: d.trialEndsOn ?? "",
    publicBookingEnabled: d.publicBookingEnabled,
  };
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
  if (form.plan !== initial.plan) payload.plan = form.plan;
  if (form.subscriptionStatus !== initial.subscriptionStatus) payload.subscriptionStatus = form.subscriptionStatus;
  if (form.trialEndsOn !== initial.trialEndsOn) payload.trialEndsOn = form.trialEndsOn === "" ? null : form.trialEndsOn;
  if (form.publicBookingEnabled !== initial.publicBookingEnabled) payload.publicBookingEnabled = form.publicBookingEnabled;
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
const planOptions = TENANT_PLAN_VALUES.map((v) => ({ value: v, label: PLAN_LABEL[v] }));
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
        value={form.plan}
        options={planOptions}
        onChange={(v) => onChange("plan", v as TenantPlan)}
        hint={form.vertical === "GENERAL" ? "En Consultorio general el plan no cambia módulos todavía." : undefined}
        error={fieldError("plan")}
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
          label="Vencimiento del trial"
          value={form.trialEndsOn}
          onChange={(v) => onChange("trialEndsOn", v)}
          hint="Vacío = sin trial. El día que elijas cuenta entero."
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

  const [open, setOpen] = useState(false);
  // Versión del CAS y foto "guardada" del form. Se resincronizan cuando el
  // refresh trae un detail nuevo (otro guardado, o el propio).
  const [version, setVersion] = useState(detail.updatedAt);
  const [baseline, setBaseline] = useState<TenantEditFormState>(() => formFromDetail(detail));
  const [form, setForm] = useState<TenantEditFormState>(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setVersion(detail.updatedAt);
    setBaseline(formFromDetail(detail));
    // Solo cuando cambia la versión del server: el resto del objeto es nuevo en cada render.
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
        title: "¿Pasar a Consultorio general?",
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
      const res = await updatePlatformTenant(buildUpdatePayload(detail.id, version, baseline, form));
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
