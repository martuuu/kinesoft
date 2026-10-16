import Link from "next/link";
import type { ReactNode } from "react";
import { KineLogo } from "@/components/ui/kine-logo";
import { ButtonLink } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import s from "./directory.module.css";

/**
 * DIR-3a: marco de las páginas del directorio (lo monta `app/(directory)/layout.tsx`). Server component, sin JS.
 *
 * No reusa `SiteHeader` de la landing: su nav son anclas de la misma página (`#funciones`, `#precios`…) que acá no
 * existen, y su menú mobile es el único JS de la landing. Este header entra entero a 360 (logo + dos acciones), así
 * que no necesita menú.
 *
 * El `<main id="main">` lo pone este marco y la `h1` la pone cada página (una sola por página).
 */
export function DirectoryShell({ children }: { children: ReactNode }) {
  return (
    <div className={s.page} data-surface="directorio">
      <a className="k-skip-link" href="#main">
        Saltar al contenido
      </a>
      <header className={s.header}>
        <div className={`k-container ${s.nav}`}>
          <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
            <KineLogo size={30} markOnly />
            <span className={s.logoWord} aria-hidden="true">
              {BRAND_NAME}
            </span>
          </Link>
          <nav className={s.navLinks} aria-label="Directorio">
            <Link href="/profesionales" className={s.navLink}>
              Profesionales
            </Link>
            <ButtonLink href="/login" variant="ghost" size="sm" prefetch={false}>
              Ingresar
            </ButtonLink>
          </nav>
        </div>
      </header>
      <main id="main" className={s.main}>
        <div className="k-container">{children}</div>
      </main>
      <footer className={s.footer}>
        <div className="k-container">
          <div className={s.footerGrid}>
            <p className={s.footerBlurb}>
              Los profesionales aparecen en este directorio porque eligieron publicar su perfil, y pueden dejar de
              hacerlo cuando quieran. Los turnos se sacan en el turnero de cada consultorio.
            </p>
            <nav aria-label="Pie de página">
              <ul className={s.footerLinks} role="list">
                <li>
                  <Link href="/profesionales">Profesionales</Link>
                </li>
                <li>
                  <Link href="/">¿Tenés un consultorio?</Link>
                </li>
                <li>
                  <Link href="/login" prefetch={false}>
                    Ingresar
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
          <p className={s.footerBase}>© 2026 {BRAND_NAME}</p>
        </div>
      </footer>
    </div>
  );
}

/** Avatar de iniciales (DIR-D4: v1 sin foto). Decorativo: el nombre está al lado. */
export function DirectoryAvatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return (
    <span className={large ? `${s.avatar} ${s.avatarLg}` : s.avatar} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Migas: «Profesionales › <actual>». La última no es link (`aria-current`). */
export function DirectoryCrumbs({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className={s.crumbs} aria-label="Estás en">
      <ol>
        {items.map((it, i) => (
          <li key={`${i}-${it.label}`}>
            {it.href ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * JSON-LD (C-DIR6). El escape lo hace `jsonLdScript` (`lib/directory-logic.ts`): `JSON.stringify` solo no alcanza,
 * un nombre con «</script>» cerraría el bloque.
 */
export function JsonLd({ json }: { json: string }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
