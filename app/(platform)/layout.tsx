import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { resolveSupportTarget } from "@/lib/support-session-internal";
import { endSupport } from "@/lib/platform-support";
import { safeNext } from "@/lib/safe-next";
import { PlatformShell } from "@/components/plataforma/platform-shell";

/**
 * Guard + shell del grupo `(platform)` (BO3-A, plan §19.5 «Superadmin sin consultorio casa»).
 *
 * El bug: `/plataforma` colgaba de `app/(app)/layout.tsx`, que arma un Actor de CONSULTORIO (`tryGetActor` →
 * `buildActor`). Un superadmin sin consultorio propio (o con el suyo suspendido) rebotaba a /onboarding,
 * /sin-acceso o /suspendido, justo desde el panel en el que se arreglan esos casos; y con una sesión de soporte
 * abierta, el shell mostraba el consultorio destino. Acá no se arma Actor: solo `requirePlatformAdmin` (sesión
 * verificada + perfil, la misma foto del request).
 *
 * - Sin sesión → `/login?next=<path>`: es lo que hace cualquier ruta privada, no revela nada nuevo.
 * - Con sesión pero sin `isPlatformAdmin` (o deshabilitado) → `notFound()`: un usuario de consultorio no se entera
 *   de que la sección existe (antes se lo mandaba a /dashboard, lo que la confirmaba).
 * - Cualquier otro error (DB caída) se propaga al error boundary: no se disfraza de 404.
 *
 * Las páginas y cada lectura/acción de `lib/platform-*` vuelven a llamar `requirePlatformAdmin` por su cuenta: este
 * layout es UX y primer filtro, no la única barrera (un layout no corre en las server actions).
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  let actor: PlatformActor;
  try {
    actor = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      // `x-pathname` lo pisa el middleware en cada request; safeNext descarta todo lo que no sea un path propio.
      const raw = headers().get("x-pathname");
      const next = (raw ? safeNext(raw, "") : "") || "/plataforma";
      redirect(`/login?next=${encodeURIComponent(next)}`);
    }
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  // Sin cookie de soporte: null y cero queries. Con cookie: la fila abierta del propio superadmin (o null y se
  // descarta si quedó vieja). `resolveSupportTarget` y no `resolveSupportSession` porque el chip muestra el nombre.
  const target = await resolveSupportTarget(actor.userId);

  return (
    <PlatformShell
      email={actor.email}
      hasHome={actor.homeTenantId !== null}
      support={target ? { tenantName: target.tenant.name } : null}
      endSupportAction={endSupport}
    >
      {children}
    </PlatformShell>
  );
}
