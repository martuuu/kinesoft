/**
 * CF3 (SD-U, §30 D-CF3-9) · sede digital `/<slug>`: server component puro (sin JS, sin providers, sin framer, toast,
 * modal ni drawer: guard `public-surface-imports`). Recibe SOLO el DTO cerrado de SD-K (`ClinicSite`).
 *
 * Diseño: dirección A del prototipo (`design_source/sede/sede-a.html`, editorial centrada) + «Quién atiende cada día»
 * de la B (`sede-b.html`), elegida por Martin. Para cambiar el orden alcanza con `SEDE_SECTIONS`: cada sección es un
 * componente independiente con su `id` de ancla. BR-H (05-nov): el encabezado pasó a foto + velo en el color del
 * consultorio con el logo grande (`sede-hero.tsx`) y las secciones toman la paleta (barra de acento en las tarjetas,
 * «Semana» sobre un fondo teñido, contacto en el color del consultorio en vez de navy fijo). PH-U2 (05-nov): cada
 * tarjeta de profesional lleva su foto (o sus iniciales) en el marco de `PractitionerPhoto`, con el logo de la sede.
 *
 * Accesibilidad: una sola h1 (el nombre), landmarks header/nav/main/footer, skip link, cada sección con su h2
 * (`aria-labelledby`), tabla de horarios con `th scope`, links externos avisan «se abre en otra pestaña», targets ≥ 40 px.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { KineLogo } from "@/components/ui/kine-logo";
import { buttonClassName } from "@/components/ui/button";
import { PractitionerPhoto } from "@/components/ui/practitioner-photo";
import {
  personInitials,
  siteClosedDays,
  siteWeekTable,
  siteWhoByDay,
} from "@/lib/clinic-site-logic";
import type { ClinicSite } from "@/lib/clinic-site-types";
import {
  SEDE_COPY as C,
  clinicMonogram,
  firstNameOf,
  licenseText,
  placeText,
  sedeChannels,
} from "./sede-copy";
import { SedeHero } from "./sede-hero";
import { SedeIcon, SedeIconSprite } from "./sede-icons";
import s from "./sede.module.css";

type SectionId = "profesionales" | "semana" | "visita" | "contacto";

/** Orden de las secciones (A + grilla de B). Sacar o mover una fila cambia el layout; el nav se arma de acá. */
export const SEDE_SECTIONS: readonly SectionId[] = ["profesionales", "semana", "visita", "contacto"];

function ClinicMark({ site, size }: { site: ClinicSite; size: "sm" | "xl" }) {
  if (site.logoUrl) {
    // BR-H: en el encabezado el logo es protagonista (88-104 px de alto). El ancho queda libre (`width: auto` en el
    // CSS): un isotipo cuadrado queda cuadrado y un logo horizontal se ve entero en vez de achicarse dentro de un
    // cuadrado. Los atributos 1:1 solo reservan el alto (la fila es solo del logo: que cambie el ancho no corre nada).
    const px = size === "xl" ? 104 : 36;
    return (
      // eslint-disable-next-line @next/next/no-img-element -- ruta propia cacheable (`/<slug>/logo`): next/image la re-optimizaría por request
      <img
        src={site.logoUrl}
        alt={size === "xl" ? `Logo de ${site.name}` : ""}
        width={px}
        height={px}
        className={size === "xl" ? `${s.logo} ${s.logoXl}` : s.logo}
        decoding="async"
      />
    );
  }
  return (
    <span className={size === "xl" ? `${s.mono} ${s.monoXl}` : s.mono} aria-hidden="true">
      {clinicMonogram(site.name)}
    </span>
  );
}

function BookLink({
  href,
  size,
  variant = "primary",
  className,
  label,
  children,
}: {
  href: string;
  size: "sm" | "md" | "lg";
  variant?: "primary" | "lime";
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} prefetch={false} className={buttonClassName({ variant, size, className })} aria-label={label}>
      {children}
    </Link>
  );
}

function SectionHead({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) {
  return (
    <div className={s.head}>
      <span className={s.eyebrow}>{eyebrow}</span>
      <h2 className={s.h2} id={id}>
        {title}
      </h2>
    </div>
  );
}

function ProsSection({ site }: { site: ClinicSite }) {
  return (
    <section className={s.section} id="profesionales" aria-labelledby="sede-pros-title">
      <div className="k-container">
        <SectionHead id="sede-pros-title" eyebrow={C.prosEyebrow} title={C.prosTitle} />
        {site.practitioners.length === 0 ? (
          // CF3 ZF3: sin teléfono ni WhatsApp no se invita a «escribinos o llamanos» (no hay a dónde).
          <p className={s.empty}>{sedeChannels(site.contact).length > 0 ? C.prosEmpty : C.prosEmptyNoContact}</p>
        ) : (
          <div className={s.pros}>
            {site.practitioners.map((p) => {
              const titleId = `sede-pro-${p.id}`;
              const lic = licenseText(p.license);
              return (
                <article key={p.id} className={`${s.card} ${s.pro}`} aria-labelledby={titleId}>
                  <div className={s.proHead}>
                    {/* PH-U2: foto (opt-in del profesional, `showPhotoPublic`) o iniciales en el marco de la primitiva,
                        con el logo de la sede en la insignia. Decorativa: el nombre es el h3 de al lado. */}
                    <PractitionerPhoto src={p.photoUrl} name={p.name} logoUrl={site.logoUrl} size={96} nameShown />
                    <div className={s.proId}>
                      <h3 className={s.proName} id={titleId}>
                        {p.name}
                      </h3>
                      {p.specialty && <p className={s.proSpec}>{p.specialty}</p>}
                      {lic && <p className={s.proLic}>{lic}</p>}
                    </div>
                  </div>
                  {p.services.length > 0 && (
                    <ul className={`${s.list} ${s.svc}`} role="list" aria-label={`Servicios de ${p.name}`}>
                      {/* Martin (05-nov): la sede no muestra precios. El valor aparece recién en el turnero, en el resumen,
                          cuando el paciente eligió servicio y horario. */}
                      {p.services.map((svc) => (
                        <li key={svc.id}>
                          <span className={s.svcName}>
                            {svc.name}
                            <span className={s.svcDur}>{svc.durationMin} min</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <BookLink href={p.bookingUrl} size="md" className={s.proCta} label={`Sacar turno con ${p.name}`}>
                    Sacar turno con {firstNameOf(p.name)}
                  </BookLink>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function WeekSection({ site }: { site: ClinicSite }) {
  const days = siteWhoByDay(site);
  if (days.length === 0) return null;
  const closed = siteClosedDays(days);
  const legend = site.practitioners.filter((p) => p.hours.length > 0);
  return (
    <section className={`${s.section} ${s.sectionTint}`} id="semana" aria-labelledby="sede-week-title">
      <div className="k-container">
        <SectionHead id="sede-week-title" eyebrow={C.weekEyebrow} title={C.weekTitle} />
        {legend.length > 1 && (
          <div className={s.weekHead}>
            <ul className={`${s.list} ${s.legend}`} role="list" aria-label="Profesionales">
              {legend.map((p) => (
                <li key={p.id}>
                  <span className={s.ini} aria-hidden="true">
                    {personInitials(p.name)}
                  </span>
                  {p.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ol className={`${s.list} ${s.week}`} role="list">
          {days.map((d) => (
            <li key={d.dow} className={s.day}>
              <h3 className={s.dayName}>
                <abbr title={d.day} style={{ textDecoration: "none" }}>
                  {d.short}
                </abbr>
              </h3>
              <ul className={`${s.list} ${s.slots}`} role="list">
                {d.slots.map((slot) => (
                  <li key={slot.practitionerId} className={s.slot}>
                    <span className={s.ini} aria-hidden="true">
                      {slot.initials}
                    </span>
                    <div>
                      <span className={s.slotName}>{firstNameOf(slot.name)}</span>
                      <span className="k-sr-only">{slot.name}: </span>
                      <span className={s.slotTime}>{slot.label}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className={`${s.note} ${s.weekNote}`}>
          {closed.length > 0 ? `${closed.join(", ")}: sin turnos. ` : ""}
          {C.weekNote}
        </p>
      </div>
    </section>
  );
}

/**
 * CF3 ZF3: ¿se pinta «Horarios y sede»? La misma regla para la sección y para el nav (antes el nav linkeaba
 * `#visita` / `#coberturas` aunque la sección volviera null: anclas rotas).
 */
function visitShown(site: ClinicSite): boolean {
  if (siteWeekTable(site)) return true;
  return site.locations.some((l) => l.address || l.city) || site.coverages.length > 0 || site.practitioners.length > 0;
}

function VisitSection({ site }: { site: ClinicSite }) {
  const table = siteWeekTable(site);
  const located = site.locations.filter((l) => l.address || l.city);
  if (!visitShown(site)) return null;
  return (
    <section className={s.section} id="visita" aria-labelledby="sede-visit-title">
      <div className="k-container">
        <SectionHead id="sede-visit-title" eyebrow={C.visitEyebrow} title={C.visitTitle} />
        <div className={table ? s.visit : `${s.visit} ${s.visitSingle}`}>
          {table && (
            <div className={s.card}>
              <h3 className={s.h3}>{C.hoursTitle}</h3>
              <table className={s.hours}>
                <caption className="k-sr-only">{C.hoursCaption}</caption>
                <tbody>
                  {table.map((row) => (
                    <tr key={row.dow} className={row.ranges.length === 0 ? s.closed : undefined}>
                      <th scope="row">{row.day}</th>
                      <td>{row.label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className={s.note}>{C.weekNote}</p>
            </div>
          )}
          <div className={`${s.card} ${s.stack}`}>
            {located.length > 0 && (
              <div className={s.stack}>
                <h3 className={s.h3}>{located.length > 1 ? C.locationsTitle : C.locationTitle}</h3>
                <ul className={`${s.list} ${s.facts}`} role="list">
                  {located.map((l, i) => {
                    const place = placeText(l);
                    return (
                      <li key={`${i}-${l.name}`} className={s.fact}>
                        <span className={s.factIco}>
                          <SedeIcon id="pin" />
                        </span>
                        <div>
                          <p className={s.factLabel}>{located.length > 1 ? l.name : C.addressLabel}</p>
                          {place && <p className={s.factValue}>{place}</p>}
                          {l.mapsUrl && (
                            <a href={l.mapsUrl} target="_blank" rel="noopener noreferrer">
                              {C.map}
                              <span className="k-sr-only">
                                {located.length > 1 ? ` de ${l.name}` : ""} {C.newTab}
                              </span>
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            <div id="coberturas" className={s.coverages}>
              <h3 className={s.h3}>{C.coveragesTitle}</h3>
              {site.coverages.length > 0 ? (
                <>
                  <ul className={`${s.list} ${s.chips}`} role="list" aria-label={C.coveragesLabel}>
                    {site.coverages.map((c) => (
                      <li key={c} className={s.chip}>
                        {c}
                      </li>
                    ))}
                  </ul>
                  <p className={s.note}>{C.coveragesNote}</p>
                </>
              ) : (
                <p className={s.note}>{C.coveragesEmpty}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ContactSection({ site }: { site: ClinicSite }) {
  const channels = sedeChannels(site.contact);
  if (channels.length === 0) return null;
  return (
    <section className={s.section} id="contacto" aria-labelledby="sede-contact-title">
      <div className="k-container">
        <div className={s.band}>
          <div>
            <h2 className={s.h2} id="sede-contact-title">
              {C.contactTitle}
            </h2>
            <p>{site.online.bookingOpen ? C.contactLead : C.contactLeadNoBooking}</p>
          </div>
          <div className={s.bandCtas}>
            {channels.map((ch) =>
              ch.external ? (
                <a key={ch.id} href={ch.href} target="_blank" rel="noopener noreferrer" className={buttonClassName({ variant: "lime", size: "lg" })}>
                  <SedeIcon id={ch.id} />
                  {ch.label}
                  <span className="k-sr-only">
                    {" "}
                    al {ch.display} {C.newTab}
                  </span>
                </a>
              ) : (
                <a key={ch.id} href={ch.href} className={buttonClassName({ variant: "ghost", size: "lg", className: s.onDark })}>
                  <SedeIcon id={ch.id} />
                  <span className="k-sr-only">{ch.label}: </span>
                  {ch.display}
                </a>
              )
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** ¿Se pinta la sección? (para el nav: un ancla a una sección que no está es un link roto). */
function sectionShown(id: SectionId, site: ClinicSite): boolean {
  if (id === "semana") return siteWhoByDay(site).length > 0;
  if (id === "contacto") return sedeChannels(site.contact).length > 0;
  if (id === "visita") return visitShown(site);
  return true;
}

const SECTION_VIEW: Record<SectionId, (p: { site: ClinicSite }) => ReactNode> = {
  profesionales: ProsSection,
  semana: WeekSection,
  visita: VisitSection,
  contacto: ContactSection,
};

const NAV: { id: SectionId; href: string; label: string }[] = [
  { id: "profesionales", href: "#profesionales", label: C.navPros },
  { id: "visita", href: "#visita", label: C.navVisit },
  { id: "visita", href: "#coberturas", label: C.navCoverages },
  { id: "contacto", href: "#contacto", label: C.navContact },
];

export function SedePage({ site }: { site: ClinicSite }) {
  const shown = SEDE_SECTIONS.filter((id) => sectionShown(id, site));
  const primary = site.locations.find((l) => l.address || l.city) ?? null;
  const primaryPlace = primary ? [primary.address, primary.city].filter(Boolean).join(", ") : null;
  return (
    <div className={s.page} data-palette={site.palette === "sky" ? undefined : site.palette} data-surface="sede">
      <SedeIconSprite />
      <a className="k-skip-link" href="#main">
        {C.skip}
      </a>
      <header className={s.top}>
        <div className={`k-container ${s.topIn}`}>
          <a className={s.brand} href="#main" aria-label={`${site.name}, inicio`}>
            <ClinicMark site={site} size="sm" />
            <span className={s.brandName}>{site.name}</span>
          </a>
          <nav className={s.topNav} aria-label={C.navLabel}>
            {NAV.filter((n) => shown.includes(n.id)).map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
          </nav>
          {site.online.bookingOpen && (
            <BookLink href={site.bookingUrl} size="sm" className={s.topCta}>
              {C.book}
            </BookLink>
          )}
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <SedeHero labelledBy="sede-h1">
          <span className={`${s.heroMark} k-enter`}>
            <ClinicMark site={site} size="xl" />
          </span>
          <h1 className={`${s.h1} k-enter k-enter-d1`} id="sede-h1">
            {site.name}
            {site.tagline && <small>{site.tagline}</small>}
          </h1>
          {site.description && <p className={`${s.lead} k-enter k-enter-d2`}>{site.description}</p>}
          <div className={`${s.ctas} k-enter k-enter-d3`}>
            {site.online.bookingOpen && (
              // Lima sobre el velo oscuro: el primario (--sky-700) casi no se distinguía del fondo (--sky-800).
              <BookLink href={site.bookingUrl} size="lg" variant="lime">
                <SedeIcon id="cal" />
                {C.book}
              </BookLink>
            )}
            {site.practitioners.length > 0 && (
              <a className={buttonClassName({ variant: "ghost", size: "lg", className: s.onDark })} href="#profesionales">
                {C.seePros}
              </a>
            )}
          </div>
          {(primaryPlace || site.openingSummary) && (
            <ul className={`${s.list} ${s.quick} k-enter k-enter-d3`} role="list">
              {primaryPlace && (
                <li>
                  <SedeIcon id="pin" />
                  {primaryPlace}
                </li>
              )}
              {site.openingSummary && (
                <li>
                  <SedeIcon id="clock" />
                  <span className="k-sr-only">Horario de atención: </span>
                  {site.openingSummary}
                </li>
              )}
            </ul>
          )}
        </SedeHero>

        {shown.map((id) => {
          const View = SECTION_VIEW[id];
          return <View key={id} site={site} />;
        })}
      </main>

      <footer className={s.footer}>
        <div className={`k-container ${s.made}`}>
          <span>© {site.name}</span>
          <a href="/">
            {/* El sello de la marca (Sello C, `KineLogo`), no el ícono viejo del prototipo (Martin, 05-nov). */}
            <KineLogo size={18} markOnly />
            Hecho con {BRAND_NAME}
          </a>
        </div>
      </footer>
    </div>
  );
}
