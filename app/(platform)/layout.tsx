import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { PlatformMfaRequiredError, requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { platformMfaRedirect } from "@/lib/platform-mfa-logic";
import { ForbiddenError, UnauthenticatedError, getAccessSnapshot } from "@/lib/session";
import { displayUserName } from "@/lib/display-name";
import { resolveSupportTarget } from "@/lib/support-session-internal";
import { endSupport } from "@/lib/platform-support";
import { verifyPlatformReauth } from "@/lib/platform-mfa-actions";
import { safeNext } from "@/lib/safe-next";
import { PlatformShell } from "@/components/plataforma/platform-shell";
import { PlatformReauthProvider } from "@/components/plataforma/reauth-modal";

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
 * - BO4, con `PLATFORM_MFA_ENFORCEMENT=enforce`: sin factor TOTP → `/plataforma-mfa/configurar`; con factor y la
 *   sesión en AAL1 → `/plataforma-mfa/verificar`, los dos con `?next=<path>`. Esas pantallas viven FUERA de este
 *   grupo justamente para no entrar en bucle (este layout las volvería a mandar ahí). Se chequea antes del
 *   `ForbiddenError` genérico: el error de MFA hereda de él y si no terminaría en 404.
 *   Si GoTrue no responde (`unavailable`) → `/plataforma-mfa/verificar` (su pantalla de «Reintentar»): no se puede
 *   decidir y no se deja pasar (BO-Z B9; antes se propagaba al error genérico).
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
    // `x-pathname` lo pisa el middleware en cada request; safeNext descarta todo lo que no sea un path propio.
    const raw = headers().get("x-pathname");
    const next = (raw ? safeNext(raw, "") : "") || "/plataforma";
    if (err instanceof UnauthenticatedError) redirect(`/login?next=${encodeURIComponent(next)}`);
    // BO-Z B9: `unavailable` (GoTrue no respondió) va a /plataforma-mfa/verificar, que ya tiene su pantalla «No
    // pudimos comprobar tu verificación» con «Reintentar» y no deja pasar. Antes se tiraba y caía en el error genérico
    // de la app, sin salida. Sigue sin dejar pasar: la pantalla de verificar vuelve a consultar a GoTrue.
    if (err instanceof PlatformMfaRequiredError) {
      redirect(platformMfaRedirect(err.step === "unavailable" ? "verify" : err.step, next));
    }
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  // Sin cookie de soporte: null y cero queries. Con cookie: la fila abierta del propio superadmin (o null y se
  // descarta si quedó vieja). `resolveSupportTarget` y no `resolveSupportSession` porque el chip muestra el nombre.
  // VX0-b (decisión 19): la barra muestra el NOMBRE del superadmin (la misma foto que ya leyó `requirePlatformAdmin`,
  // cacheada por request: sin query); antes mostraba su email como si fuera el nombre.
  const [target, snapshot] = await Promise.all([resolveSupportTarget(actor.userId), getAccessSnapshot()]);

  // El provider del modal de re-verificación envuelve todo el shell: cualquier componente de Plataforma puede usar
  // `usePlatformAction()` para que una acción `high` pida el código y se reintente sola (BO4).
  return (
    <PlatformReauthProvider verifyAction={verifyPlatformReauth}>
      <PlatformShell
        name={displayUserName(snapshot?.profile?.fullName)}
        email={actor.email}
        hasHome={actor.homeTenantId !== null}
        support={target ? { tenantName: target.tenant.name } : null}
        endSupportAction={endSupport}
      >
        {children}
      </PlatformShell>
    </PlatformReauthProvider>
  );
}
