"use client";

/**
 * Pasos Consultorio, Horario y Listo del alta (A3c-S-signup; B5.5 ONB sumó
 * Sede y Tu horario al resumen). Cada paso es idempotente del lado del
 * server: re-entrar edita, no duplica. Los números salen de `STEP`.
 */
import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/ui/form-field";
import { IconCheck } from "@/components/ui/icons";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { saveOnboardingClinic, completeOnboarding } from "@/lib/onboarding";
import { setBusinessHours } from "@/lib/tenant-settings";
import { BUSINESS_HOUR_MAX, BUSINESS_HOUR_MIN, AGENDA_SLOT_OPTIONS } from "@/lib/tenant-settings-constants";
import { formatARS } from "@/lib/format";
import { STEP } from "@/lib/onboarding-logic";
import { formatHHMM, summarizeWeek } from "@/lib/schedule-validate";
import type { OnboardingLocation, OnboardingSchedule, OnboardingTenant } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, StepFooter, useStepNav } from "./step-nav";

// ── Consultorio ────────────────────────────────────────────────────────────

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
      go(STEP.location);
      refresh();
    });
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.clinic} · Consultorio`}
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

// ── Horario del consultorio ────────────────────────────────────────────────────────────

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function StepHours({ tenant }: { tenant: OnboardingTenant }) {
  const { go, refresh } = useStepNav();
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
      // refresh: "Tu horario" arranca de la plantilla que `setBusinessHours`
      // acaba de mover; sin esto el router podría servir la página cacheada.
      go(STEP.myHours);
      refresh();
    });
  };

  const onBack = async () => {
    if (dirty && !(await confirm({ title: "¿Salir sin guardar?", message: "Perdés los cambios del horario.", confirmLabel: "Salir" }))) return;
    go(STEP.location);
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.hours} · Horario`}
        title="¿En qué horario abre el consultorio?"
        blurb="Es el marco general: lo que muestra la agenda y el horario con el que arranca cada profesional. En el paso siguiente ajustás el tuyo día por día."
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
        <StepFooter primaryType="submit" primaryLabel="Guardar y seguir" pending={pending} onBack={onBack} />
      </form>
    </>
  );
}

// ── Listo ────────────────────────────────────────────────────────────

export function StepDone({
  tenant,
  location,
  schedule,
  servicesCount,
  insurers,
  invitationsCount,
}: {
  tenant: OnboardingTenant;
  location: OnboardingLocation | null;
  schedule: OnboardingSchedule | null;
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

  // Lo que rige para la agenda del OWNER: sus franjas, o (sin franjas) el
  // horario del consultorio lun-sáb que le aplica el motor.
  const myWeek = schedule
    ? schedule.view.isFallback
      ? `Lun-Sáb ${formatHHMM(schedule.view.tenantHours.startMin)} a ${formatHHMM(schedule.view.tenantHours.endMin)}`
      : summarizeWeek(schedule.view.ranges)
    : "";
  const place = location ? [location.address, location.city, location.province].filter(Boolean).join(", ") : "";

  // `pending` = el paso no tiene dato propio todavía (se puede terminar igual:
  // la sede existe y el horario por defecto rige), se marca para que se vea.
  const items: { label: string; value: string; step: number; pending?: boolean }[] = [
    { label: "Consultorio", value: tenant.name, step: STEP.clinic },
    {
      label: "Sede",
      value: place ? `${location!.name} · ${place}` : "Sin dirección cargada",
      step: STEP.location,
      pending: !location?.address,
    },
    { label: "Horario del consultorio", value: `${hourLabel(tenant.businessHoursStart)} a ${hourLabel(tenant.businessHoursEnd)} · turnos cada ${tenant.agendaSlotMinutes} min`, step: STEP.hours },
    {
      label: "Tu horario",
      value: schedule?.custom ? myWeek : `${myWeek || "El del consultorio"} (sin ajustar)`,
      step: STEP.myHours,
      pending: !schedule?.custom,
    },
    { label: "Servicios", value: `${servicesCount} cargado${servicesCount === 1 ? "" : "s"}`, step: STEP.services },
    {
      label: "Obras sociales",
      value:
        (others.length ? others.map((o) => o.name).join(", ") + " + " : "") +
        `Particular${particular && particular.copagoCents > 0 ? ` (${formatARS(particular.copagoCents)})` : ""}`,
      step: STEP.insurers,
    },
    { label: "Equipo", value: invitationsCount ? `${invitationsCount} invitación${invitationsCount === 1 ? "" : "es"} enviada${invitationsCount === 1 ? "" : "s"}` : "Solo vos, por ahora", step: STEP.team },
  ];

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.done} · Listo`}
        title="Tu consultorio está listo"
        blurb="Revisá el resumen. Sedes, horarios, servicios, obras sociales y equipo se ajustan después desde Configuración."
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
            {/* Hecho = tilde lima; sin dato propio = punto hueco + "Completar"
                (no cromático solo: cambia el ícono y el texto del link). */}
            <span
              aria-hidden
              style={{
                width: 22, height: 22, borderRadius: 7, flexShrink: 0,
                background: it.pending ? "transparent" : "var(--lime-300)",
                border: it.pending ? "2px dashed rgba(15,30,51,0.2)" : "none",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {!it.pending && <IconCheck size={11} stroke={3} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>{it.label}</div>
              <div style={{ fontSize: 14, color: it.pending ? "var(--navy-500)" : "var(--navy-900)", overflowWrap: "anywhere" }}>
                {it.value}
              </div>
            </div>
            <Link
              href={`/onboarding?step=${it.step}`}
              style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600, padding: "10px 4px", flexShrink: 0 }}
            >
              {it.pending ? "Completar" : "Editar"}
            </Link>
          </div>
        ))}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter back={STEP.team} primaryLabel="Ir a mi agenda" onPrimary={finish} pending={pending} />
    </>
  );
}
