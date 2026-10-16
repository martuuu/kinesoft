import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { getSessionUser } from "@/lib/session-user";

export const metadata = { title: "Página no encontrada · KineSoft", robots: { index: false, follow: false } };

/** Tope para leer la sesión: un 404 no puede quedar esperando a GoTrue (el camino lento de `getSessionUser`). */
const SESSION_TIMEOUT_MS = 1500;

/**
 * La sesión, o null. Nunca tira y nunca espera más de `SESSION_TIMEOUT_MS`.
 *
 * Por qué así: `getSessionUser` (PF-0b) verifica el JWT localmente, sin red, y ya devuelve null sin cookie o fuera de
 * un request (en el prerender del build `cookies()` no está: `readSessionUser` lo atrapa y devuelve null). Si la
 * verificación local no puede probar el token cae a GoTrue; para un 404 eso no vale una espera larga: sin respuesta
 * a tiempo se muestra el CTA sin sesión, que igual funciona (la landing tiene «Ingresar»).
 */
async function sessionOrNull(): Promise<{ id: string } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      getSessionUser(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), SESSION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 404 raíz (VX2-b1, brief §3.3): «No encontramos esta página» + CTA según sesión. Antes el CTA iba siempre a
 * /dashboard, que a una visita sin sesión la rebotaba al login (y un paciente del turnero que tipeó mal el link
 * terminaba en un login que no es para él). Con sesión → «Ir a mi consultorio» (/dashboard decide adónde: app,
 * onboarding, plataforma); sin sesión → «Ir al inicio» (/).
 *
 * Leer la cookie hace que el 404 se renderice por request en vez de ser estático: es lo que pide el CTA según
 * sesión, y el costo es una verificación local de JWT (sin red en el caso normal).
 */
export default async function NotFound() {
  const user = await sessionOrNull();
  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="Error 404" title="No encontramos esta página" />
      <StatusText muted last>
        Puede que el link esté mal copiado o que la página ya no exista.
      </StatusText>
      {user ? (
        <StatusLink href="/dashboard">Ir a mi consultorio</StatusLink>
      ) : (
        <StatusLink href="/">Ir al inicio</StatusLink>
      )}
    </AuthShell>
  );
}
