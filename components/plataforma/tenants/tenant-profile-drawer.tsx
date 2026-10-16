"use client";

/**
 * [BO3-B] «Editar datos» del Resumen del consultorio: nombre, razón social, CUIT y contacto público vía
 * `updatePlatformTenantProfile` (BO2-D, revisa EV-D6), con CAS contra `expectedUpdatedAt`.
 *
 * Igual que «Editar suscripción»: solo viajan las claves cambiadas (el audit `platform.tenant.profile` registra
 * QUÉ cambió; mandar todo pisaría lo que el OWNER cambió desde Configuración en el medio). Vacío = borrar (null),
 * salvo el nombre, que es obligatorio.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { updatePlatformTenantProfile } from "@/lib/platform-tenant-lifecycle";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { REBASED_FORM_COPY, rebaseForm } from "@/components/plataforma/tenants/rebase-form";
import type { UpdatePlatformTenantProfileInput } from "@/lib/platform-tenants-schemas";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { ErrorBox } from "@/components/plataforma/tenants/detail-ui";

export type TenantProfileFormState = {
  name: string;
  legalName: string;
  taxId: string;
  phone: string;
  whatsapp: string;
  publicEmail: string;
};

const KEYS = ["name", "legalName", "taxId", "phone", "whatsapp", "publicEmail"] as const;

export function profileFormFromDetail(
  d: Pick<PlatformTenantDetail, "name" | "legalName" | "taxId" | "phone" | "whatsapp" | "publicEmail">
): TenantProfileFormState {
  return {
    name: d.name,
    legalName: d.legalName ?? "",
    taxId: d.taxId ?? "",
    phone: d.phone ?? "",
    whatsapp: d.whatsapp ?? "",
    publicEmail: d.publicEmail ?? "",
  };
}

/** `tenantId` + versión + solo lo que cambió (comparando sin espacios de más). Vacío = null. */
export function buildProfilePayload(
  tenantId: string,
  expectedUpdatedAt: string,
  initial: TenantProfileFormState,
  form: TenantProfileFormState
): UpdatePlatformTenantProfileInput {
  const payload: UpdatePlatformTenantProfileInput = { tenantId, expectedUpdatedAt };
  for (const k of KEYS) {
    const next = form[k].trim();
    if (next === initial[k].trim()) continue;
    if (k === "name") payload.name = next;
    else payload[k] = next === "" ? null : next;
  }
  return payload;
}

export function isProfileChanged(initial: TenantProfileFormState, form: TenantProfileFormState): boolean {
  return Object.keys(buildProfilePayload("", "", initial, form)).length > 2;
}

export function TenantProfileForm({
  form,
  dirty,
  pending,
  error,
  fieldErrors,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: TenantProfileFormState;
  dirty: boolean;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  onChange: (key: keyof TenantProfileFormState, value: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const fe = (k: string) => fieldErrors[k]?.[0];
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }}>
      <FormField label="Nombre" required value={form.name} onChange={(v) => onChange("name", v)} error={fe("name")} disabled={pending} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 12 }}>
        <FormField label="Razón social" value={form.legalName} onChange={(v) => onChange("legalName", v)} error={fe("legalName")} disabled={pending} />
        <FormField label="CUIT" value={form.taxId} onChange={(v) => onChange("taxId", v)} error={fe("taxId")} disabled={pending} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 12 }}>
        <FormField type="tel" label="Teléfono" value={form.phone} onChange={(v) => onChange("phone", v)} error={fe("phone")} disabled={pending} />
        <FormField type="tel" label="WhatsApp" value={form.whatsapp} onChange={(v) => onChange("whatsapp", v)} error={fe("whatsapp")} disabled={pending} />
      </div>
      <FormField
        type="email"
        label="Email público"
        value={form.publicEmail}
        onChange={(v) => onChange("publicEmail", v)}
        hint="Lo ven los pacientes en los turnos online. Vacío = no se muestra."
        error={fe("publicEmail")}
        disabled={pending}
      />
      <p style={{ margin: 0, fontSize: 12, color: "var(--navy-300)", lineHeight: 1.45 }}>
        Son los mismos datos que el consultorio edita en Configuración. El cambio queda registrado en Actividad.
      </p>
      {error && <ErrorBox>{error}</ErrorBox>}
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

export function TenantProfileDrawer({ detail }: { detail: PlatformTenantDetail }) {
  const router = useRouter();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(detail.updatedAt);
  const [baseline, setBaseline] = useState<TenantProfileFormState>(() => profileFormFromDetail(detail));
  const [form, setForm] = useState<TenantProfileFormState>(baseline);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // El refresh trae otra versión → se resincronizan versión y baseline. BO-Z B8: con el Drawer abierto y una versión
  // AJENA (no la del propio guardado, que ya quedó en `version`), el form se rebasea sobre la baseline nueva solo en
  // los campos no tocados (`rebaseForm`, porqué allá) y se avisa. Solo cuando cambia la versión del server: el resto
  // del objeto es nuevo en cada render.
  useEffect(() => {
    const next = profileFormFromDetail(detail);
    if (open && detail.updatedAt !== version) {
      const r = rebaseForm(baseline, next, form);
      setForm(r.form);
      if (r.changed) setError(REBASED_FORM_COPY);
    }
    setVersion(detail.updatedAt);
    setBaseline(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updatedAt]);

  const dirty = isProfileChanged(baseline, form);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!dirty || pending) return;
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await runPlatform(() => updatePlatformTenantProfile(buildProfilePayload(detail.id, version, baseline, form)));
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        // refresh-ok: la action falló y no revalida; si fue «otro cambio se guardó antes», trae la versión vigente.
        router.refresh();
        return;
      }
      setVersion(res.data.updatedAt);
      setBaseline(form);
      setOpen(false);
      toast.success("Datos del consultorio actualizados");
    } catch {
      setError("No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setForm(baseline);
          setError(null);
          setFieldErrors({});
          setOpen(true);
        }}
      >
        Editar datos
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Editar datos del consultorio" dirty={dirty} width={480}>
        <TenantProfileForm
          form={form}
          dirty={dirty}
          pending={pending}
          error={error}
          fieldErrors={fieldErrors}
          onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </>
  );
}
