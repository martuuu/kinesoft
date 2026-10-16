import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { env } from "@/lib/env";
import { BRAND_NAME } from "@/lib/brand";
import { provinceName } from "@/lib/ar-provinces";
import { directoryMode } from "@/lib/directory-mode";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { clinicJsonLd, clinicPath, findDirectoryClinic, jsonLdScript } from "@/lib/directory-logic";
import { ButtonLink } from "@/components/ui/button";
import { DirectoryAvatar, DirectoryCrumbs, JsonLd } from "@/components/directory/directory-shell";
import {
  clinicContactChannels,
  coverageNames,
  directoryRobots,
  directoryTitle,
  displayName,
  metaDescription,
  placeLabel,
  summarize,
} from "@/components/directory/directory-copy";
import s from "@/components/directory/directory.module.css";

/**
 * DIR-3a (C-DIR5) · `/consultorios/[slug]`: página pública de un consultorio listado (C-DIR4: opt-in, no oculto,
 * turnero abierto y ≥ 1 profesional reservable).
 *
 * - Alias (BO2-D): un slug viejo → `permanentRedirect` al vigente, SIN la query: la página es ISR y en Next 14.2 leer
 *   `searchParams` en un render ISR tira DYNAMIC_SERVER_USAGE (500, revisor A de DIR-Z); la página no usa la query.
 *   Solo se redirige si el vigente está en el directorio: un consultorio que no se publicó no revela por acá a qué
 *   slug se mudó (y el redirect terminaría en 404 igual). El slug con forma imposible corta antes de ir a la base.
 * - Profesionales: solo los que publicaron su perfil (DIR-D25); el resto del equipo queda detrás de «Ver todos en el
 *   turnero». Sin email del consultorio (DIR-D15); teléfono y WhatsApp sí.
 */
export const revalidate = 600;

export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Props = { params: { slug: string }; searchParams?: Record<string, string | string[] | undefined> };

/** Slugs de tenant: minúsculas, dígitos y guiones. Lo demás no existe y no vale una query. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function decodeSlug(raw: string): string | null {
  try {
    const slug = decodeURIComponent(raw);
    return SLUG_SHAPE.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const mode = directoryMode();
  if (mode === "off") return { robots: { index: false, follow: false } };
  const slug = decodeSlug(params.slug);
  const clinic = slug ? findDirectoryClinic(await getDirectorySnapshot(), slug) : null;
  if (!clinic) return { robots: { index: false, follow: false } };
  const title = directoryTitle(clinic.name, "Consultorios");
  const where = summarize(
    [...new Set(clinic.locations.map((l) => placeLabel(l.city, l.provinceCode)).filter((x): x is string => !!x))],
    2
  );
  const description = metaDescription(
    clinic.description ?? `${clinic.name}${where ? ` en ${where}` : ""}. Sacá turno online.`
  );
  return {
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: { absolute: title },
    description,
    alternates: { canonical: clinic.path },
    robots: directoryRobots(mode),
    openGraph: { type: "website", locale: "es_AR", siteName: BRAND_NAME, title, description, url: clinic.path },
  };
}

export default async function ConsultorioPage({ params }: Props) {
  if (directoryMode() === "off") notFound();
  const slug = decodeSlug(params.slug);
  if (!slug) notFound();
  const snapshot = await getDirectorySnapshot();
  const clinic = findDirectoryClinic(snapshot, slug);
  if (!clinic) {
    const moved = await resolveSlugAlias(slug);
    if (moved && findDirectoryClinic(snapshot, moved.slug)) {
      // DIR-Z (revisor A, M1): sin `searchParams`. La ruta es ISR y en Next 14.2 leer `searchParams` en un render ISR
      // tira DYNAMIC_SERVER_USAGE (500 en todo alias, con o sin query). La página no usa ningún parámetro de query.
      permanentRedirect(clinicPath(moved.slug));
    }
    notFound();
  }

  const coverages = coverageNames(clinic.coverages, clinic.acceptsParticular);
  const contact = clinicContactChannels(clinic);
  const where = summarize(
    [...new Set(clinic.locations.map((l) => placeLabel(l.city, l.provinceCode)).filter((x): x is string => !!x))],
    2
  );

  return (
    <>
      <JsonLd json={jsonLdScript(clinicJsonLd(clinic, env.NEXT_PUBLIC_APP_URL))} />
      <DirectoryCrumbs items={[{ href: "/profesionales", label: "Directorio" }, { label: clinic.name }]} />

      <div className={s.hero}>
        <div className={s.heroText}>
          <p className={s.eyebrow}>Consultorio</p>
          <h1 className={s.h1}>{clinic.name}</h1>
          {where && <p className={s.lead}>{where}</p>}
          {clinic.specialties.length > 0 && (
            <ul className={s.chips} role="list" aria-label="Especialidades">
              {clinic.specialties.map((sp) => (
                <li key={sp.slug} className={s.chip}>
                  {sp.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={s.layout}>
        <div className={s.stack}>
          {clinic.description && (
            <section className={`${s.card} ${s.section}`} aria-labelledby="cons-sobre">
              <h2 id="cons-sobre" className={s.h2}>
                Sobre el consultorio
              </h2>
              <p className={s.bio}>{clinic.description}</p>
            </section>
          )}

          <section className={`${s.card} ${s.section}`} aria-labelledby="cons-profesionales">
            <h2 id="cons-profesionales" className={s.h2}>
              Profesionales
            </h2>
            {clinic.professionals.length > 0 ? (
              <ul className={s.list} role="list">
                {clinic.professionals.map((p) => {
                  const name = displayName(p);
                  return (
                    <li key={p.profileId} className={s.place}>
                      <div className={s.proHead}>
                        <DirectoryAvatar initials={p.initials} />
                        <div className={s.placeText}>
                          <p className={s.placeName}>
                            <Link href={p.path}>{name}</Link>
                          </p>
                          {p.specialties.length > 0 && (
                            <p className={`${s.muted} ${s.small}`}>{summarize(p.specialties.map((x) => x.name))}</p>
                          )}
                        </div>
                      </div>
                      <ButtonLink
                        href={p.bookingHref}
                        variant="primary"
                        size="sm"
                        prefetch={false}
                        aria-label={`Sacar turno con ${name}`}
                      >
                        Sacar turno
                      </ButtonLink>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={s.muted}>Los profesionales de este consultorio todavía no publicaron su perfil.</p>
            )}
            <p>
              <Link href={clinic.bookingHref} prefetch={false} className="k-link">
                Ver todos en el turnero
              </Link>
            </p>
          </section>
        </div>

        <div className={s.stack}>
          <section className={`${s.card} ${s.ctaCard}`} aria-labelledby="cons-turno">
            <h2 id="cons-turno" className={s.h2}>
              Turnos online
            </h2>
            <p className={s.muted}>Elegí profesional, día y horario en el turnero del consultorio.</p>
            <ButtonLink href={clinic.bookingHref} variant="primary" size="md" block prefetch={false}>
              Sacar turno
            </ButtonLink>
          </section>

          <section className={`${s.card} ${s.section}`} aria-labelledby="cons-sedes">
            <h2 id="cons-sedes" className={s.h2}>
              {clinic.locations.length === 1 ? "Dirección" : "Sedes"}
            </h2>
            <ul className={s.list} role="list">
              {clinic.locations.map((l, i) => {
                const place = [l.city, provinceName(l.provinceCode)].filter(Boolean).join(", ");
                return (
                  <li key={`${i}-${l.name}`} className={s.placeText}>
                    {clinic.locations.length > 1 && <p className={s.placeName}>{l.name}</p>}
                    {l.address && <p>{l.address}</p>}
                    {place && <p className={`${s.muted} ${s.small}`}>{place}</p>}
                  </li>
                );
              })}
            </ul>
          </section>

          {contact.length > 0 && (
            <section className={`${s.card} ${s.section}`} aria-labelledby="cons-contacto">
              <h2 id="cons-contacto" className={s.h2}>
                Contacto
              </h2>
              <ul className={`${s.list} ${s.contact}`} role="list">
                {contact.map((c) => (
                  <li key={c.label}>
                    {c.label}:{" "}
                    {c.external ? (
                      <a href={c.href} rel="noopener noreferrer" target="_blank">
                        {c.value}
                        <span className="k-sr-only"> (se abre en otra pestaña)</span>
                      </a>
                    ) : (
                      <a href={c.href}>{c.value}</a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className={`${s.card} ${s.section}`} aria-labelledby="cons-coberturas">
            <h2 id="cons-coberturas" className={s.h2}>
              Coberturas
            </h2>
            {coverages.length > 0 ? (
              <ul className={s.chips} role="list">
                {coverages.map((c) => (
                  <li key={c} className={`${s.chip} ${s.chipSoft}`}>
                    {c}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.muted}>Consultá las coberturas al sacar turno.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
