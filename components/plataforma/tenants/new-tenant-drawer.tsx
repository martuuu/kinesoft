"use client";

/**
 * [BO3-B] «Nuevo consultorio» de /plataforma/consultorios (plan §19.5 fila BO3-B). Drawer sobre
 * `createTenantWithOwner` (BO2-A): consultorio + titular + suscripción inicial + mail de activación.
 *
 * Idempotencia: un UUID por instancia del Drawer (`idempotencyKey`). Un doble clic o un reintento tras un corte de
 * red manda la MISMA clave y el server devuelve el consultorio del primero con `replayed: true`. La clave se renueva
 * solo al empezar otra alta («Dar de alta otro»), nunca al reintentar un error.
 *
 * Resultado (contrato del brief BO3):
 *   - `replayed` → «Ya estaba creado» (no se dice «mail enviado»: este pedido no mandó nada);
 *   - `!emailSent` → caja con el `activationUrl` para copiar y el aviso de que es una credencial; sin
 *     `activationUrl` (tampoco se pudo generar), link a Usuarios → «Mandar link de acceso» (BO-Z B2);
 *   - si no, «Le mandamos el mail de activación a …». Siempre con link al detalle.
 *
 * El form es controlado y sin efectos (`NewTenantForm`, `NewTenantResult`): se montan con props en el render test.
 */
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { IconCheck } from "@/components/ui/icons";
import { createTenantWithOwner } from "@/lib/platform-provisioning";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import {
  MAX_TRIAL_DAYS,
  type CreateTenantWithOwnerInputType,
  type CreateTenantWithOwnerResult,
} from "@/lib/platform-provisioning-schemas";
import { SAAS_PLAN_VALUES, TENANT_VERTICAL_VALUES } from "@/lib/platform-tenants-schemas";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { slugify } from "@/lib/onboarding-logic";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import { tenantHref } from "@/components/plataforma/tenants/labels";
import { CheckRow, ErrorBox, WarnBox } from "@/components/plataforma/tenants/detail-ui";
import { ONE_TIME_LINK_COPY, userHref } from "@/components/plataforma/users/users-logic";

export type NewTenantFormState = {
  clinicName: string;
  /** "" = se deriva del nombre en el server (`freeSlugFor`). */
  slug: string;
  vertical: TenantVertical;
  /** PL-1d: plan SaaS. */
  plan: SaasPlan;
  /** Texto del input: "" = el del catálogo del plan. */
  trialDays: string;
  ownerEmail: string;
  ownerFirstName: string;
  ownerLastName: string;
  /**
   * PL-1d (C-PL5): el titular atiende pacientes. false = Titular administrador sin agenda (sin `Practitioner`), que
   * no ve historia clínica (PL-D4, decisión 8 de Martin).
   */
  ownerClinical: boolean;
  starterServices: boolean;
  onboardingCompleted: boolean;
};

/**
 * Default: Kine Individual con la prueba del plan (PL-1d, §20.5.8: toda alta nace INDIVIDUAL con 14 días, como el
 * alta web). Consultorio / Clínica / Libre se eligen a mano y nacen sin prueba salvo que se cargue.
 */
export function emptyNewTenantForm(): NewTenantFormState {
  return {
    clinicName: "",
    slug: "",
    vertical: "KINESIOLOGY",
    plan: "INDIVIDUAL",
    trialDays: String(PLAN_DEFAULTS.INDIVIDUAL.trialDays),
    ownerEmail: "",
    ownerFirstName: "",
    ownerLastName: "",
    ownerClinical: true,
    starterServices: true,
    onboardingCompleted: true,
  };
}

/** Hubo algo cargado: el Drawer pide confirmación antes de descartarlo. */
export function isNewTenantDirty(form: NewTenantFormState): boolean {
  const base = emptyNewTenantForm();
  return (Object.keys(base) as (keyof NewTenantFormState)[]).some((k) => form[k] !== base[k]);
}

/**
 * Cómo va a quedar la dirección del turnero. Es una VISTA PREVIA: si el derivado del nombre ya está tomado, el
 * server le agrega un sufijo (`freeSlugFor`); un slug tipeado y tomado rebota con error en el campo.
 */
export function slugPreview(form: Pick<NewTenantFormState, "clinicName" | "slug">): string {
  const typed = form.slug.trim().toLowerCase();
  if (typed) return typed;
  // `slugify("")` cae a "consultorio": sin nombre no hay nada que previsualizar.
  return form.clinicName.trim() ? slugify(form.clinicName) : "";
}

/**
 * Lo que viaja a `createTenantWithOwner`. Slug y trial vacíos no se mandan (el server usa el derivado y el del
 * catálogo). Un trial no numérico viaja como NaN para que el zod del server lo rechace con su copy.
 */
export function buildCreatePayload(form: NewTenantFormState, idempotencyKey: string): CreateTenantWithOwnerInputType {
  const payload: CreateTenantWithOwnerInputType = {
    clinicName: form.clinicName,
    vertical: form.vertical,
    plan: form.plan,
    ownerEmail: form.ownerEmail,
    ownerFirstName: form.ownerFirstName,
    ownerLastName: form.ownerLastName,
    ownerClinical: form.ownerClinical,
    starterServices: form.starterServices,
    onboardingCompleted: form.onboardingCompleted,
    idempotencyKey,
  };
  if (form.slug.trim()) payload.slug = form.slug.trim();
  const t = form.trialDays.trim();
  if (t !== "") payload.trialDays = /^\d+$/.test(t) ? Number(t) : Number.NaN;
  return payload;
}

/** UUID v4 (el server lo valida). `randomUUID` exige contexto seguro; fallback a `getRandomValues`. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const verticalOptions = TENANT_VERTICAL_VALUES.map((v) => ({ value: v, label: VERTICAL_LABEL[v] }));
const planOptions = SAAS_PLAN_VALUES.map((v) => ({ value: v, label: SAAS_PLAN_LABEL[v] }));

function trialHint(form: NewTenantFormState): string {
  const t = form.trialDays.trim();
  if (t === "") {
    const d = PLAN_DEFAULTS[form.plan].trialDays;
    return d > 0 ? `Vacío = el del plan (${d} días). 0 = sin prueba.` : "Vacío o 0 = sin prueba (el plan no trae).";
  }
  if (t === "0") return "Sin prueba: la suscripción arranca activa.";
  return `Hoy cuenta como el primer día. Máximo ${MAX_TRIAL_DAYS}.`;
}

export function NewTenantForm({
  form,
  pending,
  error,
  fieldErrors,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: NewTenantFormState;
  pending: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  onChange: <K extends keyof NewTenantFormState>(key: K, value: NewTenantFormState[K]) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const fe = (k: string) => fieldErrors[k]?.[0];
  const preview = slugPreview(form);
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }} noValidate>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--navy-300)", marginBottom: 8 }}>CONSULTORIO</legend>
        <FormField
          label="Nombre"
          required
          value={form.clinicName}
          onChange={(v) => onChange("clinicName", v)}
          error={fe("clinicName")}
          disabled={pending}
          autoFocus
        />
        <div style={{ display: "grid", gap: 4 }}>
          <FormField
            label="Slug"
            value={form.slug}
            onChange={(v) => onChange("slug", v)}
            placeholder="Se arma solo con el nombre"
            error={fe("slug")}
            disabled={pending}
            tooltip="La parte de la dirección del turno online"
          />
          <span data-testid="slug-preview" style={{ fontSize: 12, color: "var(--navy-500)", overflowWrap: "anywhere" }}>
            {preview ? (
              <>
                Turnos online: <span style={{ fontFamily: "var(--font-mono)" }}>/c/{preview}/booking</span>
                {!form.slug.trim() && " (si ya existe, se le suma un número)"}
              </>
            ) : (
              "Escribí el nombre para ver la dirección."
            )}
          </span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 12 }}>
          <FormField
            as="select"
            label="Tipo de consultorio"
            value={form.vertical}
            options={verticalOptions}
            onChange={(v) => onChange("vertical", v as TenantVertical)}
            error={fe("vertical")}
            disabled={pending}
          />
          <FormField
            as="select"
            label="Plan"
            value={form.plan}
            options={planOptions}
            onChange={(v) => onChange("plan", v as SaasPlan)}
            error={fe("plan")}
            disabled={pending}
          />
        </div>
        <FormField
          type="number"
          label="Días de prueba"
          value={form.trialDays}
          min={0}
          max={MAX_TRIAL_DAYS}
          step={1}
          onChange={(v) => onChange("trialDays", v)}
          hint={trialHint(form)}
          error={fe("trialDays")}
          disabled={pending}
        />
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 14 }}>
        <legend style={{ fontSize: 12, fontWeight: 700, color: "var(--navy-300)", marginBottom: 8 }}>TITULAR</legend>
        <FormField
          type="email"
          label="Email"
          required
          value={form.ownerEmail}
          onChange={(v) => onChange("ownerEmail", v)}
          hint="Le llega el mail para activar la cuenta. Si ya tiene cuenta, entra con la suya."
          error={fe("ownerEmail")}
          disabled={pending}
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(180px, 100%), 1fr))", gap: 12 }}>
          <FormField
            label="Nombre"
            required
            value={form.ownerFirstName}
            onChange={(v) => onChange("ownerFirstName", v)}
            error={fe("ownerFirstName")}
            disabled={pending}
          />
          <FormField
            label="Apellido"
            required
            value={form.ownerLastName}
            onChange={(v) => onChange("ownerLastName", v)}
            error={fe("ownerLastName")}
            disabled={pending}
          />
        </div>
        <CheckRow
          checked={form.ownerClinical}
          onChange={(v) => onChange("ownerClinical", v)}
          disabled={pending}
          title="¿Atiende pacientes el titular?"
          hint={
            form.ownerClinical
              ? "Sí: tiene agenda propia y ocupa un lugar de profesional."
              : "No: administra el consultorio sin agenda y no ve historias clínicas (como la Secretaria)."
          }
        />
      </fieldset>

      <div style={{ display: "grid", gap: 8 }}>
        <CheckRow
          checked={form.starterServices}
          onChange={(v) => onChange("starterServices", v)}
          disabled={pending}
          title="Cargar servicios iniciales"
          hint="Los servicios de ejemplo del tipo de consultorio. Después se editan o borran."
        />
        <CheckRow
          checked={form.onboardingCompleted}
          onChange={(v) => onChange("onboardingCompleted", v)}
          disabled={pending}
          title="Alta terminada"
          hint={
            form.onboardingCompleted
              ? "El titular entra directo al panel."
              : "El titular completa los pasos de bienvenida (sede, horarios, servicios)."
          }
        />
      </div>

      {error && <ErrorBox>{error}</ErrorBox>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Creando…" : "Crear consultorio"}
        </Button>
      </div>
    </form>
  );
}

/** Qué pasó con el alta. `ownerEmail` es el que se cargó en el form (el resultado no lo trae). */
export function NewTenantResult({
  result,
  ownerEmail,
  onAnother,
  onClose,
}: {
  result: CreateTenantWithOwnerResult;
  ownerEmail: string;
  onAnother: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const url = !result.replayed && !result.emailSent ? (result.activationUrl ?? null) : null;
  const copy = () => {
    if (!url) return;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {result.replayed ? (
        <WarnBox>
          <strong>Ya estaba creado.</strong> Este pedido se repitió y no se creó nada nuevo ni se mandó otro mail. El
          consultorio es <span style={{ fontFamily: "var(--font-mono)" }}>{result.slug}</span>.
        </WarnBox>
      ) : (
        <div
          role="status"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "rgba(200,245,100,0.18)",
            color: "var(--navy-900)",
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          <strong>Consultorio creado.</strong> Quedó como{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{result.slug}</span>.
          {result.emailSent && <> Le mandamos el mail de activación a {ownerEmail}.</>}
        </div>
      )}

      {/* [BO-Z B2] El mail no salió: con link → copiarlo; SIN link (generateLink también falló) antes quedaba solo
          «copiá el link» sin link que copiar. Ahora se manda desde Usuarios, que genera uno nuevo. En un replay el
          pedido original pudo haber fallado el mail: se avisa igual (el link no se re-emite en un replay). */}
      {!result.replayed && !result.emailSent && url && (
        <WarnBox>
          <strong>El mail de activación no salió.</strong> Copiá el link y mandáselo al titular por otro medio.{" "}
          {ONE_TIME_LINK_COPY}
        </WarnBox>
      )}
      {!result.replayed && !result.emailSent && !url && (
        <WarnBox>
          <strong>El mail de activación no salió.</strong> No pudimos generar el link de activación. Mandáselo desde{" "}
          <Link href={userHref(result.ownerUserId)} style={{ fontWeight: 700, color: "var(--sky-700)" }}>
            Usuarios
          </Link>{" "}
          → «Mandar link de acceso».
        </WarnBox>
      )}
      {result.replayed && !result.emailSent && (
        <WarnBox>
          El mail de activación del primer pedido no salió: mandalo desde{" "}
          <Link href={userHref(result.ownerUserId)} style={{ fontWeight: 700, color: "var(--sky-700)" }}>
            Usuarios
          </Link>
          .
        </WarnBox>
      )}
      {url && (
        <div style={{ display: "grid", gap: 8 }}>
          <div
            data-testid="activation-link"
            style={{
              padding: 12,
              borderRadius: 12,
              background: "rgba(15,30,51,0.04)",
              fontSize: 12,
              wordBreak: "break-all",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {url}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="button" variant="ghost" onClick={copy}>
              {copied ? (
                <>
                  <IconCheck size={12} stroke={3} /> Copiado
                </>
              ) : (
                "Copiar link"
              )}
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Link href={tenantHref(result.tenantId)} style={{ fontSize: 13, fontWeight: 700, color: "var(--sky-700)" }}>
          Ver el consultorio →
        </Link>
        <span style={{ display: "flex", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onAnother}>
            Dar de alta otro
          </Button>
          <Button type="button" variant="primary" onClick={onClose}>
            Listo
          </Button>
        </span>
      </div>
    </div>
  );
}

/** Botón «Nuevo consultorio» + Drawer. Vive en el header de /plataforma/consultorios. */
export function NewTenantDrawer() {
  const router = useRouter();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewTenantFormState>(emptyNewTenantForm);
  const [key, setKey] = useState<string>(newIdempotencyKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<CreateTenantWithOwnerResult | null>(null);

  const reset = () => {
    setForm(emptyNewTenantForm());
    setKey(newIdempotencyKey());
    setError(null);
    setFieldErrors({});
    setResult(null);
  };

  const onChange = <K extends keyof NewTenantFormState>(k: K, v: NewTenantFormState[K]) => {
    setForm((f) => {
      const next = { ...f, [k]: v };
      // Cambiar el plan trae su prueba del catálogo (PL-D10: solo Individual tiene); se puede pisar después.
      if (k === "plan") next.trialDays = String(PLAN_DEFAULTS[v as SaasPlan].trialDays);
      return next;
    });
    if (fieldErrors[k]) setFieldErrors(({ [k]: _drop, ...rest }) => rest);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await runPlatform(() => createTenantWithOwner(buildCreatePayload(form, key)));
      if (!res.ok) {
        setError(res.error);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      setResult(res.data);
      // PF1.2 (C-PF4): el alta revalida `/plataforma` (layout): la respuesta ya trae la lista con el consultorio nuevo.
      // refresh-ok: un reintento `replayed` vuelve sin revalidar (lo hizo el primero, cuya respuesta se perdió).
      if (res.data.replayed) router.refresh();
    } catch {
      // Misma clave al reintentar: si el primero sí llegó, el server lo devuelve como `replayed`.
      setError("No se pudo crear el consultorio. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  const close = () => {
    setOpen(false);
    // Después de un alta, el próximo Drawer arranca limpio y con otra clave.
    if (result) reset();
  };

  return (
    <>
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          setOpen(true);
        }}
      >
        Nuevo consultorio
      </Button>
      <Drawer
        open={open}
        onClose={close}
        title={result ? "Alta del consultorio" : "Nuevo consultorio"}
        dirty={!result && (isNewTenantDirty(form) || pending)}
        dirtyMessage="Tenés datos cargados del consultorio nuevo. Si cerrás, se pierden."
        width={500}
      >
        {result ? (
          <NewTenantResult result={result} ownerEmail={form.ownerEmail.trim().toLowerCase()} onAnother={reset} onClose={close} />
        ) : (
          <NewTenantForm
            form={form}
            pending={pending}
            error={error}
            fieldErrors={fieldErrors}
            onChange={onChange}
            onSubmit={(e) => void onSubmit(e)}
            onCancel={close}
          />
        )}
      </Drawer>
    </>
  );
}
