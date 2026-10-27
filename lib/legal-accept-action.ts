"use server";

/**
 * PV ZF1a (ZA M1) · action de `/aceptar-terminos`: registra la aceptación de los Términos y la Política de privacidad de
 * quien llega sin haberla dado por ninguna de las otras puertas. Hoy: el titular dado de alta desde /plataforma, que
 * activa su clave en `/reset` y antes entraba directo al panel (el alta por email, el onboarding y las invitaciones ya
 * la piden con la misma casilla, LG-S).
 *
 * - Sesión VERIFICADA contra GoTrue (`getVerifiedSessionUser`): es una prueba de consentimiento, no puede salir de una
 *   cookie sin validar. Sin sesión → `/login`.
 * - zod: `acceptLegal` con la regla común (`legalAcceptedFromForm`: solo un sí explícito) y `next` por `safeNext`
 *   (default `/dashboard`): el destino viaja en un hidden y nunca puede ser un open redirect.
 * - Sin la casilla vuelve a la página con `?error=legal` (funciona sin JS: el form postea directo a esta action).
 * - Ya aceptada la versión vigente → no se registra otra vez (mismo criterio que onboarding/invitación).
 * - El evento va por `recordLegalAcceptanceInTx` (el único escritor de `UserSecurityEvent`, SERVICE_ONLY) en una tx de
 *   `prismaService`: superficie sin Actor (el titular todavía puede no tener consultorio usable) y la fila es del
 *   usuario, no de un tenant (`tenantId` null, como la del alta por email).
 */
import { redirect } from "next/navigation";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { hasAcceptedCurrentLegal, recordLegalAcceptanceInTx } from "@/lib/legal-acceptance-internal";
import { LEGAL_ACCEPT_PATH, legalAcceptedFromForm } from "@/lib/legal";
import { safeNext } from "@/lib/safe-next";

const AcceptLegalInput = z.object({
  acceptLegal: z.unknown().transform(legalAcceptedFromForm),
  next: z.unknown().transform((v) => safeNext(typeof v === "string" ? v : null, "/dashboard")),
});

export async function acceptLegalAndContinue(formData: FormData): Promise<void> {
  const user = await getVerifiedSessionUser();
  if (!user) redirect("/login");

  const d = AcceptLegalInput.parse({ acceptLegal: formData.get("acceptLegal"), next: formData.get("next") });
  if (!d.acceptLegal) redirect(`${LEGAL_ACCEPT_PATH}?${new URLSearchParams({ next: d.next, error: "legal" })}`);

  if (!(await hasAcceptedCurrentLegal(user.id))) {
    await prismaService.$transaction((tx) =>
      recordLegalAcceptanceInTx(tx, { userId: user.id, via: "platform_activation" })
    );
  }
  redirect(d.next);
}
