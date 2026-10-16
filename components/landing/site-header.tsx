import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { ButtonLink } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import { MobileNav } from "./mobile-nav";
import s from "./site-header.module.css";

/**
 * [VX2-c1] Header de la landing (prototipo `landing-b.html`, `shared.js` T.header). Server component: el único JS es
 * el menú mobile (`MobileNav`, < 1024). D-VX29: la landing es estática (ISR) y no lee la cookie, así que «Ingresar»
 * siempre va a `/login`, que ya redirige a quien tiene sesión.
 */
export const LANDING_NAV: readonly { href: string; label: string }[] = [
  { href: "#funciones", label: "Funciones" },
  { href: "#kinesiologia", label: "Kinesiología" },
  { href: "#como-empezar", label: "Cómo empezás" },
  { href: "#precios", label: "Precios" },
  { href: "#preguntas", label: "Preguntas" },
];

/**
 * VX-Z: el CTA decía «Probá gratis» fijo. Ahora sigue la regla del `Hero`: con prueba en el
 * catálogo, «Probá N días gratis»; con 0 o sin catálogo (`null`, base caída en el build ISR), «Creá tu cuenta»: no se
 * promete una prueba que no se pudo leer.
 */
export function signupCtaLabel(trialDays: number | null): string {
  return trialDays != null && trialDays > 0 ? `Probá ${trialDays} días gratis` : "Creá tu cuenta";
}

export function SiteHeader({ trialDays = null }: { trialDays?: number | null }) {
  const ctaLabel = signupCtaLabel(trialDays);
  return (
    <header className={s.header}>
      <div className={`k-container ${s.nav}`}>
        <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
          <KineLogo size={32} markOnly />
          <span className={s.logoWord} aria-hidden="true">
            {BRAND_NAME}
          </span>
        </Link>
        <nav className={s.links} aria-label="Secciones">
          {LANDING_NAV.map((n) => (
            <a key={n.href} href={n.href}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className={s.cta}>
          <ButtonLink href="/login" variant="ghost" size="sm">
            Ingresar
          </ButtonLink>
          <ButtonLink href="/signup" variant="primary" size="sm">
            {ctaLabel}
          </ButtonLink>
        </div>
        <MobileNav links={[...LANDING_NAV, { href: "#contacto", label: "Contacto" }]} ctaLabel={ctaLabel} />
      </div>
    </header>
  );
}
