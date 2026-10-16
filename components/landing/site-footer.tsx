import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { SupportContact } from "@/components/ui/support-contact";
import { supportEmail } from "@/lib/support-contact";
import { BRAND_NAME } from "@/lib/brand";
import { LANDING_NAV, directoryNavLinks } from "./site-header";
import s from "./site-footer.module.css";

/**
 * [VX2-c1] Footer (brief VX §3.1). Repite las anclas del header: sin JS el menú mobile no abre, y acá quedan a mano.
 * El contacto de soporte sale de `SupportContact` (mailto si hay `NEXT_PUBLIC_SUPPORT_EMAIL`). Sin email (VX-Z): el
 * texto neutro de `SupportContact` («Escribile al equipo de KineSoft») dejaba al visitante sin a dónde ir, y en la
 * landing el formulario de `#contacto` está en la misma página: «¿Dudas? Escribinos.» con link ahí.
 */
const LINKS = [
  ...LANDING_NAV,
  { href: "#contacto", label: "Contacto" },
  { href: "/login", label: "Ingresar" },
  { href: "/signup", label: "Crear cuenta" },
];

export function SiteFooter({ email = supportEmail() }: { email?: string | null } = {}) {
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
              {email ? (
                <SupportContact capital email={email} subject={`Consulta desde la web de ${BRAND_NAME}`} />
              ) : (
                <a href="#contacto" className="k-link">
                  Escribinos
                </a>
              )}
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
        </div>
      </div>
    </footer>
  );
}
