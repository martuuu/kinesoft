"use client";

/**
 * Paso Equipo (opcional) del alta y la pantalla de "tenés una invitación
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
import { STEP } from "@/lib/onboarding-logic";
import { INVITABLE_ROLES, roleLabel as labelOf, roleDescription } from "@/lib/roles";
import type { Role, TenantVertical } from "@prisma/client";
import type { OnboardingInvitation, PendingInvite } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, ItemRow, StepFooter, useStepNav } from "./step-nav";

type InvitableRole = "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING";

/**
 * Etiqueta única de `lib/roles.ts` (IAM-0c). Acá el rol llega como `string`
 * (`OnboardingInvitation`/`PendingInvite`): uno desconocido se muestra tal
 * cual en vez de romper. Sin vertical → «Kinesiólogo/a» (el alta todavía no
 * le pasa la del consultorio: handoff de IAM-0c a `app/onboarding/page.tsx`).
 */
const ROLE_SET: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]);
const roleLabel = (r: string, vertical?: TenantVertical | null) =>
  ROLE_SET.has(r) ? labelOf(r as Role, vertical) : r;

/**
 * Selector de rol con la descripción del elegido debajo (un <option> nativo
 * no admite segunda línea). Controlado solo para el texto de ayuda; el valor
 * viaja por FormData como antes. Se remonta con el form (`formKey`), así que
 * vuelve al default después de cada invitación.
 */
function RoleSelect({ vertical }: { vertical?: TenantVertical | null }) {
  const [role, setRole] = useState<InvitableRole>("PRACTITIONER");
  return (
    <FormField
      as="select"
      label="Rol"
      name="role"
      value={role}
      onChange={(v) => setRole(v as InvitableRole)}
      hint={roleDescription(role, vertical)}
      options={INVITABLE_ROLES.map((r) => ({ value: r, label: labelOf(r, vertical) }))}
    />
  );
}

export function StepTeam({
  invitations,
  vertical,
}: {
  invitations: OnboardingInvitation[];
  /** Vertical del consultorio en alta, para «Kinesiólogo/a» vs «Profesional». */
  vertical?: TenantVertical | null;
}) {
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
        role: String(fd.get("role") ?? "PRACTITIONER") as InvitableRole,
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
        eyebrow={`Paso ${STEP.team} · Equipo (opcional)`}
        title="¿Trabajás con más gente?"
        blurb="Invitá a otros profesionales o a quien te ayuda con la agenda. Les llega un mail para crear su cuenta y sumarse. Podés hacerlo después desde Configuración."
      />
      {invitations.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 18 }}>
          {invitations.map((i) => (
            <ItemRow
              key={i.id}
              title={`${i.firstName} ${i.lastName}`}
              meta={`${i.email} · ${roleLabel(i.role, vertical)} · pendiente`}
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
          <RoleSelect vertical={vertical} />
        </div>
        <div>
          <Button type="submit" variant="ghost" disabled={pending}>
            <IconPlus size={14} /> Invitar
          </Button>
        </div>
      </form>
      {error && <InlineError>{error}</InlineError>}
      <StepFooter
        back={STEP.insurers}
        primaryLabel="Seguir"
        onPrimary={() => go(STEP.done)}
        pending={pending}
        skip={invitations.length === 0 ? { label: "Ahora no", onClick: () => go(STEP.done) } : undefined}
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
