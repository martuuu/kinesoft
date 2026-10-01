"use client";

/**
 * Paso 6 (equipo, opcional) del alta y la pantalla de "tenés una invitación
 * pendiente" (A3c-S-signup). Invitar reusa `createInvitation` (mismo mail,
 * mismo rate-limit y misma regla staff ≠ paciente que Configuración).
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/ui/form-field";
import { Button } from "@/components/ui/button";
import { IconArrow, IconPlus, IconX } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { createInvitation, revokeInvitation } from "@/lib/invitations";
import { openPendingInvitation } from "@/lib/onboarding";
import { formatDateAR } from "@/lib/format";
import type { OnboardingInvitation, PendingInvite } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, ItemRow, StepFooter, useStepNav } from "./step-nav";

const ROLE_OPTIONS = [
  { value: "PRACTITIONER", label: "Kinesiólogo/a" },
  { value: "ADMIN", label: "Admin" },
  { value: "ASSISTANT", label: "Asistente / Secretaría" },
  { value: "BILLING", label: "Facturación" },
] as const;
const roleLabel = (r: string) => ROLE_OPTIONS.find((o) => o.value === r)?.label ?? r;

export function StepTeam({ invitations }: { invitations: OnboardingInvitation[] }) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [formKey, setFormKey] = useState(0);

  const onInvite = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await createInvitation({
        email: String(fd.get("email") ?? "").trim(),
        firstName: String(fd.get("firstName") ?? ""),
        lastName: String(fd.get("lastName") ?? ""),
        role: String(fd.get("role") ?? "PRACTITIONER") as (typeof ROLE_OPTIONS)[number]["value"],
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      if (r.data.emailSent) toast.success("Invitación enviada");
      else toast.success("Invitación creada", { description: "No se pudo mandar el mail: compartí el link desde Configuración → Usuarios." });
      setFormKey((k) => k + 1);
      refresh();
    });
  };

  const revoke = async (i: OnboardingInvitation) => {
    if (!(await confirm({ title: `¿Cancelar la invitación a ${i.email}?`, tone: "danger", confirmLabel: "Cancelar invitación", cancelLabel: "Volver" }))) return;
    start(async () => {
      const r = await revokeInvitation(i.id);
      if (!r.ok) toast.error(r.error);
      refresh();
    });
  };

  return (
    <>
      <StepHeader
        eyebrow="Paso 6 · Equipo (opcional)"
        title="¿Trabajás con más gente?"
        blurb="Invitá a otros profesionales o a quien te ayuda con la agenda. Les llega un mail para crear su cuenta y sumarse. Podés hacerlo después desde Configuración."
      />
      {invitations.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {invitations.map((i) => (
            <ItemRow
              key={i.id}
              title={`${i.firstName} ${i.lastName}`}
              meta={`${i.email} · ${roleLabel(i.role)} · pendiente`}
              action={
                <Button type="button" variant="ghost" onClick={() => revoke(i)} disabled={pending} aria-label={`Cancelar invitación a ${i.email}`} style={{ padding: 8 }}>
                  <IconX size={14} />
                </Button>
              }
            />
          ))}
        </div>
      )}
      <form
        key={formKey}
        action={onInvite}
        style={{
          display: "grid", gap: 12, padding: 16, borderRadius: 16,
          background: "rgba(255,255,255,0.55)", border: "1px dashed rgba(15,30,51,0.12)",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <FormField label="Nombre" name="firstName" required error={fieldErrors.firstName?.[0]} />
          <FormField label="Apellido" name="lastName" required error={fieldErrors.lastName?.[0]} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <FormField label="Email" name="email" type="email" required error={fieldErrors.email?.[0]} />
          <FormField
            as="select"
            label="Rol"
            name="role"
            defaultValue="PRACTITIONER"
            options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </div>
        <div>
          <Button type="submit" variant="ghost" disabled={pending}>
            <IconPlus size={14} /> Invitar
          </Button>
        </div>
      </form>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter
        back={5}
        primaryLabel="Seguir"
        onPrimary={() => go(7)}
        pending={pending}
        skip={invitations.length === 0 ? { label: "Ahora no", onClick: () => go(7) } : undefined}
      />
    </>
  );
}

/** Sesión verificada sin consultorio y con invitaciones pendientes para su email. */
export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const accept = (id: string) => {
    setError(null);
    start(async () => {
      const r = await openPendingInvitation(id);
      if (!r.ok) {
        setError(r.error);
        router.refresh();
        return;
      }
      router.push(r.data.url);
    });
  };

  return (
    <>
      <StepHeader
        eyebrow="Invitación pendiente"
        title={invites.length === 1 ? `${invites[0].tenantName} te invitó a su equipo` : "Tenés invitaciones pendientes"}
        blurb="Aceptá la invitación para entrar al consultorio. Si en cambio querés dar de alta tu propio consultorio, también podés."
      />
      <div style={{ display: "grid", gap: 8 }}>
        {invites.map((i) => (
          <ItemRow
            key={i.id}
            title={i.tenantName}
            meta={`${roleLabel(i.role)} · vence el ${formatDateAR(i.expiresAt)}`}
            action={
              <Button type="button" variant="primary" onClick={() => accept(i.id)} disabled={pending}>
                Ver y aceptar <IconArrow size={14} />
              </Button>
            }
          />
        ))}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "22px 0 0", textAlign: "center" }}>
        <Link href="/onboarding?crear=1" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
          Prefiero crear mi propio consultorio
        </Link>
      </p>
    </>
  );
}
