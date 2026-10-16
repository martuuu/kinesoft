import Link from "next/link";
import { Button, ButtonLink, type ButtonVariant } from "@/components/ui/button";

/**
 * Piezas de las pantallas de estado en `AuthShell variant="centered"` (VX2-b1): `/plataforma-mfa/*`, `/verificar-acceso`,
 * `/sin-acceso`, `/suspendido`, `/cuenta-desactivada`, `/mantenimiento`, `/elegir-consultorio`, `/invite/<token>` y el 404.
 * Nacieron acá como molde de `/plataforma-mfa` (BO4) y `/verificar-acceso` ya las importaba; VX2-b1 las generaliza en
 * vez de abrir un archivo nuevo en `components/` (dueño único por archivo en la ola).
 *
 * Server-safe (sin "use client" ni hooks) y sin primitivas de modal/toast: las importan superficies públicas, que el
 * guard `public-surface-imports` (C-F3) vigila.
 *
 * Por qué la h1 vive en la card: antes la intro del AuthShell `split` era la h1 y la card repetía el título en un h2
 * (dos títulos que decían lo mismo con palabras distintas). En `centered` la intro no se pinta, así que la única h1
 * de la página es esta (§5, «una h1 por página»).
 */

export function StatusHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <>
      {eyebrow && (
        <p
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--sky-700)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            margin: "0 0 10px",
          }}
        >
          {eyebrow}
        </p>
      )}
      <h1 className="k-display" style={{ fontSize: 26, margin: "0 0 12px", lineHeight: 1.15, color: "var(--navy-900)" }}>
        {title}
      </h1>
    </>
  );
}

/** Párrafo de la card. `muted` = texto secundario (navy-500: 7:1 sobre blanco; navy-300 no llegaba a AA). */
export function StatusText({ children, muted = false, last = false }: { children: React.ReactNode; muted?: boolean; last?: boolean }) {
  return (
    <p
      style={{
        fontSize: muted ? 14 : 15,
        color: muted ? "var(--navy-500)" : "var(--navy-700)",
        margin: last ? "0 0 20px" : "0 0 12px",
        lineHeight: 1.55,
      }}
    >
      {children}
    </p>
  );
}

/** CTA a ancho completo: un solo `<a>` (ButtonLink), sin el `<Link><Button/></Link>` anidado de antes. */
export function StatusLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
}) {
  return (
    <ButtonLink href={href} variant={variant} size="md" block style={{ marginTop: 10 }}>
      {children}
    </ButtonLink>
  );
}

/** «Cerrar sesión» como form POST (sin JS): la salida que ninguna de estas pantallas puede esconder. */
export function SignOutButton({ variant = "ghost", next }: { variant?: ButtonVariant; next?: string }) {
  const action = next ? `/api/auth/sign-out?next=${encodeURIComponent(next)}` : "/api/auth/sign-out";
  return (
    <form action={action} method="post" style={{ marginTop: 10 }}>
      <Button type="submit" variant={variant} size="md" block>
        Cerrar sesión
      </Button>
    </form>
  );
}

// ── Nombres de BO4 (los usan las dos pantallas de MFA, /verificar-acceso y el test boz-ui). ──

export const MfaHeading = StatusHeading;

export function MfaText({ children }: { children: React.ReactNode }) {
  return <StatusText last>{children}</StatusText>;
}

export function MfaGoButton({ href, children }: { href: string; children: React.ReactNode }) {
  return <StatusLink href={href}>{children}</StatusLink>;
}

/**
 * Salida siempre visible: quien no tiene el teléfono a mano no queda encerrado en esta pantalla. BO-Z C3: «Ir a mi
 * consultorio» solo si tiene uno (`homeTenantId`): a un superadmin sin consultorio propio lo mandaba a /dashboard, que
 * lo rebotaba a /onboarding a crear uno.
 */
export function MfaFooter({ hasHome }: { hasHome: boolean }) {
  return (
    <div style={{ marginTop: 18, display: "grid", gap: 12 }}>
      <SignOutButton />
      {hasHome && (
        <Link href="/dashboard" className="k-link" style={{ fontSize: 14, textAlign: "center" }}>
          Ir a mi consultorio
        </Link>
      )}
    </div>
  );
}
