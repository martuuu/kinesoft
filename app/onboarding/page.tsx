import Link from "next/link";
import { redirect } from "next/navigation";
import { OnboardingShell, StepHeader } from "@/components/onboarding/onboarding-shell";
import { StepClinic, StepDone, StepHours } from "@/components/onboarding/steps-basic";
import { StepInsurers, StepServices } from "@/components/onboarding/steps-catalog";
import { PendingInvites, StepTeam } from "@/components/onboarding/step-team";
import { StepLocation, StepMyHours } from "@/components/onboarding/steps-agenda";
import { getSessionUser, loadOnboardingContext } from "@/lib/onboarding-internal";
import { maxReachableStep, resolveStep, STEP } from "@/lib/onboarding-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Alta del consultorio · KineSoft" };

/**
 * Stepper de alta self-service (A3c-S-signup). Fuera del grupo `(app)` a
 * propósito: el layout de la app manda acá a quien no tiene consultorio (o
 * lo tiene sin terminar), y este árbol no puede depender de un Actor.
 *
 * El paso se toma de `?step=` y se acota con lo que ya existe
 * (`resolveStep`): sin tenant solo hay Consultorio; sin servicios no se pasa
 * de Servicios. Un tenant con el alta cerrada nunca llega acá
 * (`loadOnboardingContext` → "done" → /dashboard).
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: { step?: string; crear?: string };
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/onboarding");

  const ctx = await loadOnboardingContext(user, { skipInvites: searchParams.crear === "1" });

  if (ctx.kind === "done") redirect("/dashboard");

  if (ctx.kind === "unverified") {
    return (
      <OnboardingShell current={null}>
        <StepHeader
          eyebrow="Confirmá tu email"
          title="Te falta un paso"
          blurb={`Te mandamos un email a ${ctx.email} para confirmar tu cuenta. Abrí el link y volvé: seguimos desde acá.`}
        />
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
          ¿No llega? Revisá spam o promociones.{" "}
          <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
            Volver al login
          </Link>
        </p>
      </OnboardingShell>
    );
  }

  if (ctx.kind === "invites") {
    return (
      <OnboardingShell current={null}>
        <PendingInvites invites={ctx.invites} />
      </OnboardingShell>
    );
  }

  const step = resolveStep(searchParams.step, ctx.progress);

  return (
    // Hasta dónde se puede saltar desde el riel: lo ya recorrido según el estado.
    <OnboardingShell current={step} maxReachable={maxReachableStep(ctx.progress)}>
      {step === STEP.clinic || !ctx.tenant ? (
        <StepClinic tenant={ctx.tenant} patientIdentity={ctx.patientIdentity} />
      ) : step === STEP.location ? (
        <StepLocation location={ctx.location} />
      ) : step === STEP.hours ? (
        <StepHours tenant={ctx.tenant} />
      ) : step === STEP.myHours && ctx.schedule ? (
        // key = versión: si la semana cambió (otra pestaña, conflicto), el
        // refresh remonta el editor con lo guardado en vez de mostrar el borrador viejo.
        <StepMyHours key={ctx.schedule.view.version ?? "plantilla"} schedule={ctx.schedule} locations={ctx.locations} />
      ) : step === STEP.services || step === STEP.myHours ? (
        // (Tu horario sin practitioner propio no debería pasar: el bootstrap lo crea.)
        <StepServices services={ctx.services} />
      ) : step === STEP.insurers ? (
        <StepInsurers insurers={ctx.insurers} />
      ) : step === STEP.team ? (
        <StepTeam invitations={ctx.invitations} vertical={ctx.tenant?.vertical} />
      ) : (
        <StepDone
          tenant={ctx.tenant}
          location={ctx.location}
          schedule={ctx.schedule}
          servicesCount={ctx.services.length}
          insurers={ctx.insurers}
          invitationsCount={ctx.invitations.length}
        />
      )}
    </OnboardingShell>
  );
}
