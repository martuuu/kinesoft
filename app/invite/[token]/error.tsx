"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * BO1-D — boundary de la invitación. El token va en el path: `reportClientError` y el server lo tapan
 * (`/invite/[token]`) antes de loguear.
 */
export default function InviteError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} title="No pudimos abrir la invitación" kind="invite" />;
}
