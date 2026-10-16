import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { directoryQuery } from "@/lib/directory-logic";
import { provinceName } from "@/lib/ar-provinces";
import type { DirectoryFilters, DirectoryProfessional, DirectorySpecialty, ProvinceCode } from "@/lib/directory-types";
import { DirectoryAvatar } from "./directory-shell";
import { coverageNames, displayName, placeLabel, summarize } from "./directory-copy";
import s from "./directory.module.css";

/**
 * DIR-3a: piezas de `/profesionales`. Todo server: los filtros son un `<form method="get">` (funcionan sin JS, C-DIR5)
 * y el paginado son links. Cero JS propio en la página.
 */

type Facets = {
  specialties: DirectorySpecialty[];
  coverages: { name: string; payerSlug: string }[];
  provinces: { code: ProvinceCode; name: string }[];
  cities: string[];
};

export function DirectoryFiltersForm({ filters, facets }: { filters: DirectoryFilters; facets: Facets }) {
  const hasFilter = Boolean(filters.especialidad || filters.cobertura || filters.provincia || filters.ciudad);
  return (
    <form method="get" action="/profesionales" className={`${s.card} ${s.filters}`} role="search" aria-label="Filtrar profesionales">
      <div className="k-field">
        <label className="k-label" htmlFor="dir-especialidad">
          Especialidad
        </label>
        <select id="dir-especialidad" name="especialidad" className="k-input" defaultValue={filters.especialidad ?? ""}>
          <option value="">Todas</option>
          {facets.specialties.map((sp) => (
            <option key={sp.slug} value={sp.slug}>
              {sp.name}
            </option>
          ))}
        </select>
      </div>
      <div className="k-field">
        <label className="k-label" htmlFor="dir-cobertura">
          Cobertura
        </label>
        <select id="dir-cobertura" name="cobertura" className="k-input" defaultValue={filters.cobertura ?? ""}>
          <option value="">Todas</option>
          <option value="particular">Particular (sin cobertura)</option>
          {facets.coverages.map((c) => (
            <option key={c.payerSlug} value={c.payerSlug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="k-field">
        <label className="k-label" htmlFor="dir-provincia">
          Provincia
        </label>
        <select id="dir-provincia" name="provincia" className="k-input" defaultValue={filters.provincia ?? ""}>
          <option value="">Todas</option>
          {facets.provinces.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="k-field">
        <label className="k-label" htmlFor="dir-ciudad">
          Ciudad
        </label>
        <input
          id="dir-ciudad"
          name="ciudad"
          className="k-input"
          type="text"
          list="dir-ciudades"
          autoComplete="address-level2"
          maxLength={80}
          defaultValue={filters.ciudad ?? ""}
          placeholder="Ej.: Rosario"
        />
        <datalist id="dir-ciudades">
          {facets.cities.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
      <div className={s.filterActions}>
        <button type="submit" className="k-btn k-btn-primary k-btn-md">
          Buscar
        </button>
        {hasFilter && (
          <ButtonLink href="/profesionales" variant="ghost" size="md">
            Limpiar
          </ButtonLink>
        )}
      </div>
    </form>
  );
}

/** Card de un profesional en la lista. El nombre es el link al perfil; «Sacar turno» va directo si atiende en uno. */
export function ProfessionalCard({ pro, headingLevel = 3 }: { pro: DirectoryProfessional; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const name = displayName(pro);
  const places = [...new Set(pro.clinics.map((c) => placeLabel(c.city, c.provinceCode)).filter((x): x is string => !!x))];
  const coverages = coverageNames(pro.coverages, pro.acceptsParticular);
  const single = pro.clinics.length === 1 ? pro.clinics[0] : null;
  return (
    <article className={`${s.card} ${s.proCard}`}>
      <div className={s.proHead}>
        <DirectoryAvatar initials={pro.initials} />
        <div className={s.heroText}>
          <H className={s.proName}>
            <Link href={pro.path}>{name}</Link>
          </H>
          {pro.specialties.length > 0 && (
            <ul className={s.chips} role="list" aria-label="Especialidades">
              {pro.specialties.slice(0, 3).map((sp) => (
                <li key={sp.slug} className={s.chip}>
                  {sp.name}
                </li>
              ))}
              {pro.specialties.length > 3 && (
                <li className={`${s.chip} ${s.chipSoft}`}>+{pro.specialties.length - 3}</li>
              )}
            </ul>
          )}
        </div>
      </div>
      <dl className={s.proBody}>
        {places.length > 0 && (
          <div className={s.metaLine}>
            <dt className={s.metaLabel}>Atiende en</dt>
            <dd>{summarize(places, 2)}</dd>
          </div>
        )}
        {coverages.length > 0 && (
          <div className={s.metaLine}>
            <dt className={s.metaLabel}>Coberturas</dt>
            <dd>{summarize(coverages)}</dd>
          </div>
        )}
      </dl>
      <div className={s.proActions}>
        {single ? (
          // `prefetch={false}`: el turnero es dinámico (lee la sesión); prefetchear 24 tarjetas le pega al server por nada.
          <ButtonLink href={single.bookingHref} variant="primary" size="sm" prefetch={false} aria-label={`Sacar turno con ${name}`}>
            Sacar turno
          </ButtonLink>
        ) : (
          <ButtonLink href={`${pro.path}#consultorios`} variant="primary" size="sm" aria-label={`Elegí consultorio para sacar turno con ${name}`}>
            Elegí consultorio
          </ButtonLink>
        )}
        <ButtonLink href={pro.path} variant="ghost" size="sm" aria-label={`Ver perfil de ${name}`}>
          Ver perfil
        </ButtonLink>
      </div>
    </article>
  );
}

/** Lo que el vacío ofrece sacar: cada filtro activo con su link sin él (C-DIR5: «Probá sacar un filtro»). */
export function activeFilterChips(
  f: DirectoryFilters,
  facets: Pick<Facets, "specialties" | "coverages">
): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  const href = (o: Partial<DirectoryFilters>) => `/profesionales${directoryQuery(f, { ...o, pagina: 1 })}`;
  if (f.especialidad) {
    const n = facets.specialties.find((x) => x.slug === f.especialidad)?.name ?? f.especialidad;
    out.push({ label: `Especialidad: ${n}`, href: href({ especialidad: null }) });
  }
  if (f.cobertura) {
    const n =
      f.cobertura === "particular"
        ? "Particular"
        : facets.coverages.find((x) => x.payerSlug === f.cobertura)?.name ?? f.cobertura;
    out.push({ label: `Cobertura: ${n}`, href: href({ cobertura: null }) });
  }
  if (f.provincia) out.push({ label: `Provincia: ${provinceName(f.provincia)}`, href: href({ provincia: null }) });
  if (f.ciudad) out.push({ label: `Ciudad: ${f.ciudad}`, href: href({ ciudad: null }) });
  return out;
}

export function DirectoryEmpty({
  filters,
  facets,
  anyPublished,
}: {
  filters: DirectoryFilters;
  facets: Pick<Facets, "specialties" | "coverages">;
  anyPublished: boolean;
}) {
  const chips = activeFilterChips(filters, facets);
  if (!anyPublished) {
    return (
      <div className={`${s.card} ${s.empty}`}>
        <h2 className={s.h2}>Todavía no hay profesionales publicados</h2>
        <p className={s.muted}>Volvé en unos días: los profesionales se suman cuando eligen publicar su perfil.</p>
      </div>
    );
  }
  return (
    <div className={`${s.card} ${s.empty}`}>
      <h2 className={s.h2}>No encontramos profesionales con esos filtros</h2>
      <p className={s.muted}>Probá sacar un filtro.</p>
      {chips.length > 0 && (
        <ul className={s.emptyList} role="list">
          {chips.map((c) => (
            <li key={c.label}>
              <ButtonLink href={c.href} variant="ghost" size="sm">
                <span className="k-sr-only">Sacar el filtro </span>
                {c.label} <span aria-hidden="true">✕</span>
              </ButtonLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DirectoryPager({ filters, page, totalPages }: { filters: DirectoryFilters; page: number; totalPages: number }) {
  if (totalPages <= 1) return null;
  const href = (p: number) => `/profesionales${directoryQuery(filters, { pagina: p })}`;
  return (
    <nav className={s.pager} aria-label="Paginado">
      {page > 1 ? (
        <ButtonLink href={href(page - 1)} variant="ghost" size="sm" rel="prev">
          ← Anterior
        </ButtonLink>
      ) : (
        <span className={s.pagerSpacer} />
      )}
      <p className={`${s.muted} ${s.small}`}>
        Página {page} de {totalPages}
      </p>
      {page < totalPages ? (
        <ButtonLink href={href(page + 1)} variant="ghost" size="sm" rel="next">
          Siguiente →
        </ButtonLink>
      ) : (
        <span className={s.pagerSpacer} />
      )}
    </nav>
  );
}
