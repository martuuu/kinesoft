import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { LegalAcceptCheckbox } from "@/components/legal/legal-accept";
import { Button } from "@/components/ui/button";
import { SignOutButton, StatusHeading, StatusText } from "@/app/plataforma-mfa/shared";
import { acceptLegalAndContinue } from "@/lib/legal-accept-action";
import { hasAcceptedCurrentLegal } from "@/lib/legal-acceptance-internal";
import { LEGAL_ACCEPT_ERROR } from "@/lib/legal";
import { legalAcceptHref, legalPageViaFrom } from "@/lib/legal-gate";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { safeNext } from "@/lib/safe-next";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: "Términos y privacidad" };

/**
 * `/aceptar-terminos` (PV ZF1a, ZA M1). El titular dado de alta desde /plataforma activa su clave en `/reset` y el link
 * lo trae acá antes del panel (`PLATFORM_ACTIVATION_NEXT`): es la única puerta de entrada que no pedía la casilla de los
 * Términos y la Política de privacidad (el alta por email, el onboarding y las invitaciones sí, LG-S).
 *
 * FUERA de `(app)` (molde de `/verificar-acceso` y `/cuenta-desactivada`): no depende del gate del layout ni del
 * consultorio. La sesión se verifica contra GoTrue (es un consentimiento). Sin sesión → `/login` con vuelta acá; ya
 * aceptada la versión vigente → directo a `next` (saneado; default `/dashboard`). El form postea a la server action
 * sin JS; la casilla es `required` y, si igual llega sin tildar, la action vuelve con `?error=legal`.
 *
 * LG-G (§27, decisión de Martin del 27-oct: «Cuentas que ya existían: si, da igual. Tenemos que resetar.»): además, el
 * layout de `(app)` manda acá a TODO usuario que entra al workspace sin la versión vigente aceptada, con
 * `&via=app_gate`. `?via=` decide qué se registra (`platform_activation` sin parámetro, el del link de activación;
 * `app_gate` desde el gate; cualquier otro valor → el default) y viaja en un hidden a la action, que lo valida con un
 * enum cerrado. Fuera de `(app)`: el gate no puede rebotar acá en bucle, y «Cerrar sesión» sigue disponible.
 */
export default async function AceptarTerminosPage({
  searchParams,
}: {
  searchParams: { next?: string | string[]; error?: string | string[]; via?: string | string[] };
}) {
  const next = safeNext(typeof searchParams.next === "string" ? searchParams.next : undefined, "/dashboard");
  const via = legalPageViaFrom(searchParams.via);
  const user = await getVerifiedSessionUser();
  if (!user) redirect(`/login?${new URLSearchParams({ next: legalAcceptHref(next, via) })}`);
  if (await hasAcceptedCurrentLegal(user.id)) redirect(next);

  const error = searchParams.error === "legal" ? LEGAL_ACCEPT_ERROR : undefined;
  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="Un paso más" title="Términos y privacidad" />
      <StatusText last>
        Antes de empezar a usar {BRAND_NAME} con los datos de tus pacientes, leé y aceptá los Términos y condiciones y
        la Política de privacidad. Se abren en otra pestaña.
      </StatusText>
      <form action={acceptLegalAndContinue} style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="via" value={via} />
        <LegalAcceptCheckbox id="activation-legal" error={error} />
        <Button type="submit" size="lg" block>
          Continuar
        </Button>
      </form>
      <SignOutButton />
    </AuthShell>
  );
}
