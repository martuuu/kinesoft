import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ResendVerification } from "@/components/screens/resend-verification";
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
 *
 * IAM-3a: «done» solo con una membresía USABLE. Quien tiene membresías pero
 * ninguna usable (suspendido, sin profesional) ve acá sus invitaciones o el
 * alta de su propio consultorio, en vez de rebotar a /dashboard → layout →
 * /onboarding (bucle del 14-oct). El layout a ese usuario lo manda a
 * /sin-acceso, que tiene un link a esta pantalla.
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
    // IAM-2d: antes la única salida era «Volver al login» (que con la sesión abierta no lleva a ningún
    // lado). Ahora: reenviar la verificación (C-IAM6) y «Cambiar de email», que cierra la sesión y vuelve
    // a /signup — un email mal tipeado no se corrige en la cuenta pendiente: se crea otra.
    return (
      <OnboardingShell current={null}>
        <StepHeader
          eyebrow="Confirmá tu email"
          title="Te falta un paso"
          blurb={`Te mandamos un email a ${ctx.email} para confirmar tu cuenta. Abrí el link y volvé: seguimos desde acá.`}
        />
        <div style={{ display: "grid", gap: 12, maxWidth: 360 }}>
          <ResendVerification email={ctx.email} label="Reenviar el email" variant="primary" />
          <form action="/api/auth/sign-out?next=/signup" method="post">
            <Button type="submit" variant="ghost" style={{ width: "100%", justifyContent: "center" }}>
              Cambiar de email
            </Button>
          </form>
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
            ¿No llega? Revisá spam o promociones.
          </p>
        </div>
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
