import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Piezas comunes de las dos pantallas de `/plataforma-mfa` (molde de `/cuenta-desactivada`). */

export function MfaHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {eyebrow}
      </div>
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 12px", lineHeight: 1.15 }}>
        {title}
      </h2>
    </>
  );
}

export function MfaText({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 18px", lineHeight: 1.55 }}>{children}</p>;
}

export function MfaGoButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} style={{ display: "block" }}>
      <Button variant="primary" style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
        {children}
      </Button>
    </Link>
  );
}

/**
 * Salida siempre visible: quien no tiene el teléfono a mano no queda encerrado en esta pantalla. BO-Z C3: «Ir a mi
 * consultorio» solo si tiene uno (`homeTenantId`): a un superadmin sin consultorio propio lo mandaba a /dashboard, que
 * lo rebotaba a /onboarding a crear uno.
 */
export function MfaFooter({ hasHome }: { hasHome: boolean }) {
  return (
    <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
      <form action="/api/auth/sign-out" method="post">
        <Button type="submit" variant="ghost" style={{ width: "100%", justifyContent: "center", padding: "10px 18px" }}>
          Cerrar sesión
        </Button>
      </form>
      {hasHome && (
        <Link href="/dashboard" style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600, textAlign: "center" }}>
          Ir a mi consultorio
        </Link>
      )}
    </div>
  );
}
