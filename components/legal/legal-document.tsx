import Link from "next/link";
import type { ReactNode } from "react";
import { KineLogo } from "@/components/ui/kine-logo";
import { BRAND_NAME } from "@/lib/brand";
import { LEGAL_ENTITY, LEGAL_VERSION, LEGAL_VERSION_LABEL } from "@/lib/legal";
import { LegalLinks } from "./legal-links";
import s from "./legal-document.module.css";

/**
 * [LG-P] Marco y documento de `/terminos` y `/privacidad` (PV §27, bloque LG).
 *
 * Server components puros, sin JS propio (las páginas son `force-static`): un documento legal se tiene que poder leer,
 * imprimir y enlazar por sección sin depender de nada. Superficie pública (C-F7): sin framer, toast, modal ni drawer
 * (lo vigila `tests/unit/public-surface-imports.test.ts`, que recorre `app/(legal)/`).
 *
 * Estructura: una sola h1 (el título), la versión vigente (`LEGAL_VERSION_LABEL`, sin banner de borrador: decisión de
 * PV), la línea del operador SOLO si Martin cargó los datos en `LEGAL_ENTITY`, un índice con anclas y secciones
 * numeradas con `id` estable (los mails de soporte pueden linkear `/privacidad#cookies`).
 */

export type EntityData = typeof LEGAL_ENTITY;
export type LegalSection = { id: string; title: string; content: ReactNode };

/**
 * «Operado por X · CUIT Y · Domicilio: Z», solo con lo que haya. Sin razón social → `null` (no se muestra la línea):
 * un CUIT o un domicilio sueltos, sin saber de quién son, no informan nada. Nunca un «null» ni un dato inventado.
 */
export function legalEntityLine(entity: EntityData): string | null {
  if (!entity.name) return null;
  const parts = [`Operado por ${entity.name}`];
  if (entity.cuit) parts.push(`CUIT ${entity.cuit}`);
  if (entity.address) parts.push(`Domicilio: ${entity.address}`);
  return parts.join(" · ");
}

/** Marco de las dos páginas (lo monta `app/(legal)/layout.tsx`): header con el logo, `<main id="main">` y pie. */
export function LegalShell({ children }: { children: ReactNode }) {
  return (
    <div className={`k-app ${s.page}`} data-surface="legal">
      <a className="k-skip-link" href="#main">
        Saltar al contenido
      </a>
      <header className={`k-container-narrow ${s.top}`}>
        <Link href="/" className={s.logo} aria-label={`${BRAND_NAME}, inicio`}>
          <KineLogo size={30} />
        </Link>
        <Link href="/login" prefetch={false} className={`k-link ${s.topLink}`}>
          Ingresar
        </Link>
      </header>
      <main id="main" className={`k-container-narrow ${s.main}`}>
        {children}
      </main>
      <footer className={`k-container-narrow ${s.foot}`}>
        <span>© 2026 {BRAND_NAME}</span>
        <LegalLinks />
      </footer>
    </div>
  );
}

export function LegalDocument({
  title,
  lead,
  sections,
  entity = LEGAL_ENTITY,
}: {
  title: string;
  lead: ReactNode;
  sections: LegalSection[];
  entity?: EntityData;
}) {
  const entityLine = legalEntityLine(entity);
  return (
    <article className={s.doc}>
      <header className={s.head}>
        <h1 className={`k-display ${s.title}`}>{title}</h1>
        <p className={s.version}>
          <time dateTime={LEGAL_VERSION}>{LEGAL_VERSION_LABEL}</time>
        </p>
        {entityLine && <p className={s.entity}>{entityLine}</p>}
        <div className={s.lead}>{lead}</div>
      </header>

      <nav aria-labelledby="indice" className={s.toc}>
        <h2 id="indice" className={s.tocTitle}>
          Contenido
        </h2>
        <ol>
          {sections.map((sec) => (
            <li key={sec.id}>
              <a href={`#${sec.id}`}>{sec.title}</a>
            </li>
          ))}
        </ol>
      </nav>

      {sections.map((sec, i) => (
        <section key={sec.id} id={sec.id} aria-labelledby={`${sec.id}-titulo`} className={s.section}>
          <h2 id={`${sec.id}-titulo`} className={s.sectionTitle}>
            <span className={s.num}>{i + 1}.</span> {sec.title}
          </h2>
          <div className={s.prose}>{sec.content}</div>
        </section>
      ))}

      <p className={s.back}>
        <a href="#indice">Volver al índice</a>
      </p>
    </article>
  );
}
