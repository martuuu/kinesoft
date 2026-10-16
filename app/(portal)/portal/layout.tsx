/**
 * Patient portal layout — mobile-first, lightweight.
 *
 * El portal es superficie pública (C-F7): nada de providers de cliente ni framer (C-F3) y presupuesto de 125 kB gz
 * (D-VX22). Sin Tweaks ni sidebar: una barra arriba y una columna.
 *
 * VX2-f (D-VX28): columna con `.k-container-narrow` (720 px + gutter fluido, igual que el resto de las públicas) en vez
 * del `maxWidth: 720` + padding fijo; fuera el blob con blur de fondo (D-VX9: sin blobs con blur). «Mi cuenta» con
 * área táctil de 44 px (criterio AA de VX §5, controles ≥ 44 px en < 768).
 *
 * VX-Z: «Mi cuenta» solo con sesión. Sin sesión llevaba a `/portal/me`, que redirige a `/portal`: un link que vuelve a
 * la misma pantalla. Se lee con `getSessionUser()` (verificación local del token, sin red; memo por request), no con
 * `getPortalAuth()` (consulta las fichas): para decidir un link alcanza con saber si hay sesión.
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import { getSessionUser } from "@/lib/session-user";

export const metadata = { title: `Mi portal · ${BRAND_NAME}` };

const headerLink: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  textDecoration: "none",
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await getSessionUser()) !== null;
  return (
    <div className="k-app" style={{ minHeight: "100vh", background: "var(--bg-app)" }}>
      <header className="k-container-narrow" style={{ paddingTop: 12 }}>
        <div
          className="k-glass"
          style={{
            padding: "2px 8px 2px 16px",
            borderRadius: 999,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Link href="/portal" style={headerLink} aria-label={`${BRAND_NAME} · Mi portal`}>
            <KineLogo size={24} />
          </Link>
          <span style={{ fontSize: 13, color: "var(--navy-500)" }}>para pacientes</span>
          <div style={{ flex: 1 }} />
          {signedIn && (
            <Link href="/portal/me" className="k-link" style={{ ...headerLink, fontSize: 14, padding: "0 8px" }}>
              Mi cuenta
            </Link>
          )}
        </div>
      </header>
      <main className="k-container-narrow" style={{ paddingTop: 24, paddingBottom: 48 }}>
        {children}
      </main>
    </div>
  );
}
