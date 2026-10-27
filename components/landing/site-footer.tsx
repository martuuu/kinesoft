import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { LegalLinks } from "@/components/legal/legal-links";
import { contactHref } from "@/lib/support-contact";
import { BRAND_NAME } from "@/lib/brand";
import { LANDING_NAV, directoryNavLinks } from "./site-header";
import s from "./site-footer.module.css";

/**
 * [VX2-c1] Footer (brief VX §3.1). Repite las anclas del header: sin JS el menú mobile no abre, y acá quedan a mano.
 *
 * PV (§27, TK-U2): «Contacto» y «¿Dudas? Escribinos.» van a `/contacto` (la entrada única que abre un ticket en
 * /plataforma), con o sin `NEXT_PUBLIC_SUPPORT_EMAIL`. Antes eran un `mailto:` (con email) o el ancla `#contacto`
 * (sin email): el mail no dejaba rastro en /plataforma. Los links legales (LG-P) cierran el pie, al lado del ©.
 */
const LINKS = [
  ...LANDING_NAV,
  { href: contactHref(), label: "Contacto" },
  { href: "/login", label: "Ingresar" },
  { href: "/signup", label: "Crear cuenta" },
];

/** `email` se acepta y se ignora (PV: el pie ya no arma un mailto); lo saca INT junto con el de `SupportContact`. */
export function SiteFooter(_props: { email?: string | null } = {}) {
  // DIR-3a: el link al directorio solo con `DIRECTORY_MODE=public` (`directoryNavLinks`), antes de «Ingresar».
  const links = [...LINKS.slice(0, LANDING_NAV.length + 1), ...directoryNavLinks(), ...LINKS.slice(LANDING_NAV.length + 1)];
  return (
    <footer className={s.footer}>
      <div className="k-container">
        <div className={s.grid}>
          <div className={s.brand}>
            <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
              <KineLogo size={28} markOnly />
              <span className={s.logoWord} aria-hidden="true">
                {BRAND_NAME}
              </span>
            </Link>
            <p className={s.blurb}>
              Agenda, turnos online, historia clínica y cobros para tu consultorio. Con herramientas propias para
              kinesiología.
            </p>
            <p className={s.blurb}>
              ¿Dudas?{" "}
              <Link href={contactHref()} className="k-link">
                Escribinos
              </Link>
              .
            </p>
          </div>
          <nav aria-label="Pie de página">
            <ul className={s.links} role="list">
              {links.map((l) => (
                <li key={l.href}>
                  {l.href.startsWith("/") ? <Link href={l.href}>{l.label}</Link> : <a href={l.href}>{l.label}</a>}
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className={s.base}>
          <span>© 2026 {BRAND_NAME}</span>
          <LegalLinks />
        </div>
      </div>
    </footer>
  );
}
