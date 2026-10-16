import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { SupportContact } from "@/components/ui/support-contact";
import { BRAND_NAME } from "@/lib/brand";
import { LANDING_NAV } from "./site-header";
import s from "./site-footer.module.css";

/**
 * [VX2-c1] Footer (brief VX §3.1). Repite las anclas del header: sin JS el menú mobile no abre, y acá quedan a mano.
 * El contacto de soporte sale de `SupportContact` (mailto si hay `NEXT_PUBLIC_SUPPORT_EMAIL`, texto neutro si no).
 */
const LINKS = [
  ...LANDING_NAV,
  { href: "#contacto", label: "Contacto" },
  { href: "/login", label: "Ingresar" },
  { href: "/signup", label: "Crear cuenta" },
];

export function SiteFooter() {
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
              ¿Dudas? <SupportContact capital subject={`Consulta desde la web de ${BRAND_NAME}`} />.
            </p>
          </div>
          <nav aria-label="Pie de página">
            <ul className={s.links} role="list">
              {LINKS.map((l) => (
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
