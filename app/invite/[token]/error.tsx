"use client";

import { AuthShell } from "@/components/auth/auth-shell";
import { RouteError } from "@/components/ui/route-error";

/**
 * BO1-D — boundary de la invitación. El token va en el path: `reportClientError` y el server lo tapan
 * (`/invite/[token]`) antes de loguear.
 *
 * VX2-b1: `/invite` no tiene layout propio, así que el error ocupaba la pantalla pelado (sin logo ni salida). Va en el
 * mismo `AuthShell centered` que la página, con la h1 en el error (una por página).
 */
export default function InviteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthShell variant="centered" introAs="p">
      <RouteError {...props} title="No pudimos abrir la invitación" kind="invite" headingAs="h1" />
    </AuthShell>
  );
}
