/**
 * [VX F-b1 · C-F4] AuthShell v2: el marco de las pantallas de auth y de acceso.
 *
 * Tres variantes, portadas del prototipo `design_source/vx0/`:
 * - `product` (login, `login-c.html`): panel oscuro de producto + form; < 1024 el panel se va.
 * - `split` (signup, `signup.html`): intro + card + puntos en un contenedor de 1200 centrado. Es el default
 *   (D-VX21) para que los 13 consumidores de hoy compilen sin tocarlos; VX2 migra cada uno a su variante.
 * - `centered` (forgot, reset, status, invite, mfa, cuenta): logo arriba y card de hasta 460 centrada.
 *
 * Server component con CSS Module: nada de framer ni providers (C-F3, superficie pública). Las entradas son
 * `.k-enter*` de globals.css (C-F2), que respetan `prefers-reduced-motion`. Sin blobs con `filter: blur`
 * (D-VX9): el AuthShell viejo tenía dos y en mobile costaban GPU; el fondo es `--bg-public` (gradientes pintados).
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import { ProductPanel } from "./product-panel";
import s from "./auth-shell.module.css";


export type AuthShellVariant = "product" | "split" | "centered";
export type AuthShellProps = {
  /** D-VX21: default "split" (compat con los 13 consumidores de hoy). */
  variant?: AuthShellVariant;
  /** Intro (split): eyebrow + título + bajada. product/centered los ignoran. */
  eyebrow?: string;
  heading?: string;
  blurb?: string;
  /** Una sola h1 por página: los consumidores migrados pasan "p" y ponen la h1 en la card. Default "h1" (compat). */
  introAs?: "h1" | "p";
  /** split: bloque debajo de la intro (los 3 puntos del signup). */
  aside?: React.ReactNode;
  /** Arriba a la derecha (split/centered): p. ej. «¿Ya tenés cuenta? Ingresá». */
  topRight?: React.ReactNode;
  footerLinks?: { label: string; href: string }[];
  /** Contenido de la card (form, estado). */
  children: React.ReactNode;
};

function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
      <KineLogo size={32} light={light} />
    </Link>
  );
}

function Footer({ links, className }: { links?: AuthShellProps["footerLinks"]; className: string }) {
  return (
    <footer className={className}>
      <span>© 2026 {BRAND_NAME}</span>
      {links?.map((l) => (
        <span key={l.href} className={s.footLink}>
          <span aria-hidden="true">·</span>
          <Link href={l.href} className="k-link">
            {l.label}
          </Link>
        </span>
      ))}
    </footer>
  );
}

export function AuthShell({
  variant = "split",
  eyebrow,
  heading,
  blurb,
  introAs = "h1",
  aside,
  topRight,
  footerLinks,
  children,
}: AuthShellProps): JSX.Element {
  if (variant === "product") {
    return (
      <div className={`k-app ${s.product}`} data-variant="product">
        <ProductPanel />
        <div className={s.productSide}>
          <header className={s.productTop}>
            <Logo />
          </header>
          <main id="main" className={s.productMain}>
            <div className={`${s.productForm} k-enter k-enter-d1`}>
              <div className={s.productCard}>{children}</div>
            </div>
          </main>
          <Footer links={footerLinks} className={s.productFoot} />
        </div>
      </div>
    );
  }

  if (variant === "centered") {
    return (
      <div className={`k-app ${s.publicBg} ${s.centered}`} data-variant="centered">
        <header className={s.top}>
          <Logo />
          {topRight && <div className={s.topRight}>{topRight}</div>}
        </header>
        <main id="main" className={s.centeredMain}>
          <div className={`${s.card} ${s.centeredCard} k-enter`}>{children}</div>
        </main>
        <Footer links={footerLinks} className={s.foot} />
      </div>
    );
  }

  // split
  const IntroTag = introAs;
  const hasIntro = Boolean(eyebrow || heading || blurb);
  const layout = !hasIntro && !aside ? s.splitCardOnly : aside ? s.splitWithAside : s.splitNoAside;
  return (
    <div className={`k-app ${s.publicBg} ${s.splitPage}`} data-variant="split">
      <header className={`k-container ${s.top}`}>
        <Logo />
        {topRight && <div className={s.topRight}>{topRight}</div>}
      </header>
      <main id="main" className={`k-container ${s.splitMain}`}>
        <div className={`${s.split} ${layout}`}>
          {hasIntro && (
            // < 768 la intro se va (form arriba del pliegue). Con introAs="h1" (consumidores de compat) solo se oculta a
            // la vista: si no, la página se quedaría sin su única h1 para lectores de pantalla.
            <div className={`${s.intro} ${introAs === "h1" ? s.introKeepH1 : ""} k-enter`}>
              {eyebrow && (
                <span className={s.eyebrow}>
                  <span className={s.eyebrowDot} aria-hidden="true" />
                  {eyebrow}
                </span>
              )}
              {heading && <IntroTag className={s.introTitle}>{heading}</IntroTag>}
              {blurb && <p className={s.introBlurb}>{blurb}</p>}
            </div>
          )}
          <div className={s.cardCol}>
            <div className={`${s.card} k-enter k-enter-d1`}>{children}</div>
          </div>
          {aside && <div className={`${s.points} k-enter k-enter-d2`}>{aside}</div>}
        </div>
      </main>
      <Footer links={footerLinks} className={`k-container ${s.foot} ${s.splitFoot}`} />
    </div>
  );
}
