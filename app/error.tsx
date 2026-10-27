"use client";

import { AuthShell } from "@/components/auth/auth-shell";
import { RouteError } from "@/components/ui/route-error";

/**
 * HD-8 — boundary raíz. Los grupos con layout propio ((app), (auth), (booking), (portal), (platform), onboarding,
 * /tv, /invite) tienen su `error.tsx`, pero los segmentos sueltos (`/cuenta/*`, `/sin-acceso`, `/suspendido`,
 * `/verificar-acceso`, `/elegir-consultorio`, `/plataforma-mfa`, la landing…) no: un throw ahí caía en
 * `global-error.tsx`, que reemplaza el documento entero sin `globals.css`. Acá el error queda dentro del layout raíz.
 *
 * Mismo patrón que `app/invite/[token]/error.tsx`: `AuthShell centered` (server component sin framer ni providers:
 * vale para superficies públicas, C-F3) con la h1 en el error. `RouteError` reporta por beacon (`reportClientError`,
 * kind «route») y nunca muestra `error.message`, solo el `digest`.
 */
export default function RootError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthShell variant="centered" introAs="p">
      <RouteError {...props} kind="route" headingAs="h1" />
    </AuthShell>
  );
}
