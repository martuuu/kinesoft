"use client";

/**
 * Pasos 2 (consultorio), 3 (horario) y 7 (listo) del alta (A3c-S-signup).
 * Cada paso es idempotente del lado del server: re-entrar edita, no duplica.
 */
import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { saveOnboardingClinic, completeOnboarding } from "@/lib/onboarding";
import { setBusinessHours } from "@/lib/tenant-settings";
import { BUSINESS_HOUR_MAX, BUSINESS_HOUR_MIN, AGENDA_SLOT_OPTIONS } from "@/lib/tenant-settings-constants";
import { formatARS } from "@/lib/format";
import type { OnboardingTenant } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, StepFooter, useStepNav } from "./step-nav";

// ── Paso 2 ────────────────────────────────────────────────────────────

export function StepClinic({
  tenant,
  patientIdentity,
}: {
  tenant: OnboardingTenant | null;
  patientIdentity: boolean;
}) {
  const { go, refresh } = useStepNav();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});

  const onSubmit = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await saveOnboardingClinic({
        name: String(fd.get("name") ?? ""),
        phone: String(fd.get("phone") ?? ""),
        whatsapp: String(fd.get("whatsapp") ?? ""),
        publicEmail: String(fd.get("publicEmail") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      go(3);
      refresh();
    });
  };

  return (
    <>
      <StepHeader
        eyebrow="Paso 2 · Consultorio"
        title={tenant ? "Datos del consultorio" : "Contanos de tu consultorio"}
        blurb="El nombre y los datos de contacto que van a ver tus pacientes. El teléfono, el WhatsApp y el email público son opcionales."
      />
      {patientIdentity ? (
        <InlineError>
          Esta cuenta se usa en el portal de pacientes, así que no puede crear un consultorio. Registrate como
          profesional con otro email.
        </InlineError>
      ) : (
        <form action={onSubmit} style={{ display: "grid", gap: 14 }}>
          <FormField
            label="Nombre del consultorio"
            name="name"
            required
            autoFocus={!tenant}
            defaultValue={tenant?.name ?? ""}
            placeholder="Centro Kinésico Movare"
            error={fieldErrors.name?.[0]}
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            <FormField
              label="Teléfono"
              name="phone"
              type="tel"
              defaultValue={tenant?.phone ?? ""}
              placeholder="011 4555-1234"
              error={fieldErrors.phone?.[0]}
            />
            <FormField
              label="WhatsApp"
              name="whatsapp"
              type="tel"
              defaultValue={tenant?.whatsapp ?? ""}
              placeholder="+54 9 11 5555-1234"
              error={fieldErrors.whatsapp?.[0]}
            />
          </div>
          <FormField
            label="Email público"
            name="publicEmail"
            type="email"
            defaultValue={tenant?.publicEmail ?? ""}
            placeholder="turnos@movare.com.ar"
            hint="Opcional. Si lo dejás vacío, no se muestra ningún email."
            error={fieldErrors.publicEmail?.[0]}
          />
          {tenant && (
            <p style={{ fontSize: 12, color: "var(--navy-500)", margin: 0 }}>
              Tu turnero online: <strong>/c/{tenant.slug}/booking</strong>
            </p>
          )}
          {error && <InlineError>{error}</InlineError>}
          <StepFooter primaryType="submit" primaryLabel={tenant ? "Guardar y seguir" : "Crear consultorio"} pending={pending} />
        </form>
      )}
    </>
  );
}

// ── Paso 3 ────────────────────────────────────────────────────────────

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function StepHours({ tenant }: { tenant: OnboardingTenant }) {
  const { go } = useStepNav();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const starts = Array.from({ length: BUSINESS_HOUR_MAX - BUSINESS_HOUR_MIN }, (_, i) => BUSINESS_HOUR_MIN + i);
  const ends = Array.from({ length: BUSINESS_HOUR_MAX - BUSINESS_HOUR_MIN }, (_, i) => BUSINESS_HOUR_MIN + 1 + i);

  const onSubmit = (fd: FormData) => {
    setError(null);
    const s = Number(fd.get("start"));
    const e = Number(fd.get("end"));
    if (s >= e) {
      setError("El cierre tiene que ser después de la apertura.");
      return;
    }
    start(async () => {
      const r = await setBusinessHours({ start: s, end: e, slotMinutes: Number(fd.get("slot")) });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      go(4);
    });
  };

  const onBack = async () => {
    if (dirty && !(await confirm({ title: "¿Salir sin guardar?", message: "Perdés los cambios del horario.", confirmLabel: "Salir" }))) return;
    go(2);
  };

  return (
    <>
      <StepHeader
        eyebrow="Paso 3 · Horario"
        title="¿En qué horario atendés?"
        blurb="Define la franja que muestra la agenda y los horarios que ofrece el turnero online. Los horarios por profesional llegan más adelante."
      />
      <form ref={formRef} action={onSubmit} onInput={onFormInput} onChange={onFormInput} style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <FormField
            as="select"
            label="Abre"
            name="start"
            defaultValue={String(tenant.businessHoursStart)}
            options={starts.map((h) => ({ value: String(h), label: hourLabel(h) }))}
          />
          <FormField
            as="select"
            label="Cierra"
            name="end"
            defaultValue={String(tenant.businessHoursEnd)}
            options={ends.map((h) => ({ value: String(h), label: hourLabel(h) }))}
          />
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 8 }}>
            Turnos cada
          </legend>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {AGENDA_SLOT_OPTIONS.map((m) => (
              <label
                key={m}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12,
                  background: "rgba(255,255,255,0.8)", border: "1px solid rgba(15,30,51,0.08)", cursor: "pointer", fontSize: 14,
                }}
              >
                <input type="radio" name="slot" value={m} defaultChecked={tenant.agendaSlotMinutes === m} />
                {m === 60 ? "1 hora" : "30 minutos"}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <InlineError>{error}</InlineError>}
        <StepFooterWithBack onBack={onBack} pending={pending} />
      </form>
    </>
  );
}

/** Igual que StepFooter pero con "Volver" que pasa por el dirty-guard. */
function StepFooterWithBack({ onBack, pending }: { onBack: () => void; pending: boolean }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, marginTop: 10, paddingTop: 18,
        borderTop: "1px solid rgba(15,30,51,0.06)", flexWrap: "wrap",
      }}
    >
      <Button type="button" variant="ghost" onClick={onBack} disabled={pending}>
        Volver
      </Button>
      <div style={{ flex: 1 }} />
      <Button type="submit" variant="primary" disabled={pending} style={{ padding: "12px 18px" }}>
        {pending ? "Guardando…" : "Guardar y seguir"} <IconArrow size={14} />
      </Button>
    </div>
  );
}

// ── Paso 7 ────────────────────────────────────────────────────────────

export function StepDone({
  tenant,
  servicesCount,
  insurers,
  invitationsCount,
}: {
  tenant: OnboardingTenant;
  servicesCount: number;
  insurers: { name: string; isParticular: boolean; copagoCents: number }[];
  invitationsCount: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const particular = insurers.find((i) => i.isParticular);
  const others = insurers.filter((i) => !i.isParticular);

  const finish = () => {
    setError(null);
    start(async () => {
      const r = await completeOnboarding();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.replace("/agenda");
    });
  };

  const items: { label: string; value: string; step: number }[] = [
    { label: "Consultorio", value: tenant.name, step: 2 },
    { label: "Horario", value: `${hourLabel(tenant.businessHoursStart)} a ${hourLabel(tenant.businessHoursEnd)} · turnos cada ${tenant.agendaSlotMinutes} min`, step: 3 },
    { label: "Servicios", value: `${servicesCount} cargado${servicesCount === 1 ? "" : "s"}`, step: 4 },
    {
      label: "Obras sociales",
      value:
        (others.length ? others.map((o) => o.name).join(", ") + " + " : "") +
        `Particular${particular && particular.copagoCents > 0 ? ` (${formatARS(particular.copagoCents)})` : ""}`,
      step: 5,
    },
    { label: "Equipo", value: invitationsCount ? `${invitationsCount} invitación${invitationsCount === 1 ? "" : "es"} enviada${invitationsCount === 1 ? "" : "s"}` : "Solo vos, por ahora", step: 6 },
  ];

  return (
    <>
      <StepHeader
        eyebrow="Paso 7 · Listo"
        title="Tu consultorio está listo"
        blurb="Revisá el resumen. Horario, servicios, obras sociales y equipo se ajustan después desde Configuración."
      />
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((it) => (
          <div
            key={it.label}
            style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 14,
              background: "rgba(255,255,255,0.7)", border: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <span
              style={{
                width: 22, height: 22, borderRadius: 7, background: "var(--lime-300)", flexShrink: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <IconCheck size={11} stroke={3} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>{it.label}</div>
              <div style={{ fontSize: 14, color: "var(--navy-900)" }}>{it.value}</div>
            </div>
            <Link href={`/onboarding?step=${it.step}`} style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600 }}>
              Editar
            </Link>
          </div>
        ))}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter back={6} primaryLabel="Ir a mi agenda" onPrimary={finish} pending={pending} />
    </>
  );
}
