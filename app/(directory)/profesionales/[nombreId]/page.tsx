import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { env } from "@/lib/env";
import { BRAND_NAME } from "@/lib/brand";
import { directoryMode } from "@/lib/directory-mode";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import {
  findDirectoryProfessional,
  jsonLdScript,
  parseNombreId,
  professionalJsonLd,
  slugifyName,
} from "@/lib/directory-logic";
import type { DirectoryProfessional } from "@/lib/directory-types";
import { ButtonLink } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { DirectoryAvatar, DirectoryCrumbs, JsonLd } from "@/components/directory/directory-shell";
import {
  LICENSE_VERIFIED_HINT,
  LICENSE_VERIFIED_LABEL,
  coverageNames,
  directoryRobots,
  directoryTitle,
  displayName,
  licenseLabel,
  metaDescription,
  placeLabel,
  summarize,
} from "@/components/directory/directory-copy";
import s from "@/components/directory/directory.module.css";

/**
 * DIR-3a (C-DIR5) · `/profesionales/[nombreId]`: perfil público de UNA persona (DIR-D1: el consentimiento es suyo).
 *
 * - `nombreId` = `<slugifyName(publicName)>-<profileId>`. El id sale del último «-» (`parseNombreId`); si el nombre no
 *   es el canónico (cambió el nombre público, o alguien tipeó otro) → `permanentRedirect` al canónico: un link viejo
 *   no se rompe y hay una sola URL por perfil.
 * - No publicado (no está en el snapshot: sin consentimiento, retirado, oculto por Plataforma, sin consultorio
 *   reservable) → `notFound()` (DIR-D23: 404, no 410; no se distingue el motivo).
 * - ISR: `generateStaticParams` vacío = se renderiza en la primera visita y se cachea `revalidate` segundos; el retiro
 *   del consentimiento invalida el tag del snapshot y, con él, esta página.
 * - JSON-LD `Person` sin matrícula, email, foto ni rating (DIR-D21); la matrícula SÍ va en el HTML si está cargada,
 *   con «Verificada» solo si Plataforma la verificó (DIR-D10).
 */
export const revalidate = 600;

/**
 * DIR-Z-F1: `force-static`. El 404 (y cualquier render) de esta ruta arma también el `not-found` del ROOT: Next 14.2
 * lo pasa como prop `notFound` del `LayoutRouter` raíz y RSC lo evalúa aunque no se muestre
 * (`next/dist/server/app-render/create-component-tree.js`, `notFoundComponent`). Ese 404 lee la cookie de sesión
 * (VX2-b1) y en un render ISR eso tiraba «Page changed from static to dynamic at runtime, reason: cookies» → 500 en
 * `next start` (medido: 500 en `/consultorios/no-existe` aun con `app/(directory)/not-found.tsx` estático). Con
 * `force-static`, `cookies()`/`headers()` devuelven vacío y la página no usa ninguno ni la query: el 404 del root ve
 * «sin sesión» y la ficha sigue siendo ISR (`revalidate`). Smoke: `scripts/smoke-directory.mjs`.
 */
export const dynamic = "force-static";

export function generateStaticParams(): { nombreId: string }[] {
  return [];
}

type Props = { params: { nombreId: string } };

async function loadProfessional(nombreId: string): Promise<{ pro: DirectoryProfessional; canonical: boolean } | null> {
  const parsed = parseNombreId(nombreId);
  if (!parsed) return null;
  const pro = findDirectoryProfessional(await getDirectorySnapshot(), parsed.profileId);
  if (!pro) return null;
  return { pro, canonical: parsed.nameSlug === slugifyName(pro.publicName) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const mode = directoryMode();
  if (mode === "off") return { robots: { index: false, follow: false } };
  const found = await loadProfessional(params.nombreId);
  if (!found) return { robots: { index: false, follow: false } };
  const { pro } = found;
  const name = displayName(pro);
  const title = directoryTitle(pro.publicName, "Profesionales");
  const where = summarize(
    [...new Set(pro.clinics.map((c) => placeLabel(c.city, c.provinceCode)).filter((x): x is string => !!x))],
    2
  );
  const specs = pro.specialties.map((x) => x.name).join(", ");
  const description = metaDescription(
    `${name}${specs ? `, ${specs}` : ""}${where ? ` en ${where}` : ""}. Sacá turno online.`
  );
  return {
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: { absolute: title },
    description,
    alternates: { canonical: pro.path },
    robots: directoryRobots(mode),
    openGraph: { type: "profile", locale: "es_AR", siteName: BRAND_NAME, title, description, url: pro.path },
  };
}

export default async function ProfesionalPage({ params }: Props) {
  if (directoryMode() === "off") notFound();
  const found = await loadProfessional(params.nombreId);
  if (!found) notFound();
  const { pro, canonical } = found;
  if (!canonical) permanentRedirect(pro.path);

  const name = displayName(pro);
  const coverages = coverageNames(pro.coverages, pro.acceptsParticular);

  return (
    <>
      <JsonLd json={jsonLdScript(professionalJsonLd(pro, env.NEXT_PUBLIC_APP_URL))} />
      <DirectoryCrumbs items={[{ href: "/profesionales", label: "Profesionales" }, { label: pro.publicName }]} />

      <div className={s.hero}>
        <DirectoryAvatar initials={pro.initials} large />
        <div className={s.heroText}>
          <h1 className={s.h1}>{name}</h1>
          {pro.specialties.length > 0 && (
            <ul className={s.chips} role="list" aria-label="Especialidades">
              {pro.specialties.map((sp) => (
                <li key={sp.slug} className={s.chip}>
                  {sp.name}
                </li>
              ))}
            </ul>
          )}
          {pro.license && (
            <p className={s.metaLine}>
              <span>{licenseLabel(pro.license)}</span>
              {pro.license.verified && (
                <span className={s.verified} title={LICENSE_VERIFIED_HINT}>
                  <IconCheck size={14} />
                  {LICENSE_VERIFIED_LABEL}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className={s.layout}>
        <div className={s.stack}>
          {pro.bio && (
            <section className={`${s.card} ${s.section}`} aria-labelledby="pro-presentacion">
              <h2 id="pro-presentacion" className={s.h2}>
                Presentación
              </h2>
              <p className={s.bio}>{pro.bio}</p>
            </section>
          )}

          <section id="consultorios" className={`${s.card} ${s.section}`} aria-labelledby="pro-consultorios">
            <h2 id="pro-consultorios" className={s.h2}>
              {pro.clinics.length === 1 ? "Dónde atiende" : "Dónde atiende (elegí uno para sacar turno)"}
            </h2>
            <ul className={s.list} role="list">
              {pro.clinics.map((c) => {
                const place = placeLabel(c.city, c.provinceCode);
                return (
                  <li key={c.slug} className={s.place}>
                    <div className={s.placeText}>
                      <p className={s.placeName}>
                        <Link href={c.path}>{c.name}</Link>
                      </p>
                      {place && <p className={`${s.muted} ${s.small}`}>{place}</p>}
                    </div>
                    {/* El turnero es dinámico (lee la sesión): sin prefetch. */}
                    <ButtonLink
                      href={c.bookingHref}
                      variant="primary"
                      size="sm"
                      prefetch={false}
                      aria-label={`Sacar turno con ${name} en ${c.name}`}
                    >
                      Sacar turno
                    </ButtonLink>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div className={s.stack}>
          <section className={`${s.card} ${s.section}`} aria-labelledby="pro-coberturas">
            <h2 id="pro-coberturas" className={s.h2}>
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
