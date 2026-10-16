import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { BRAND_NAME } from "@/lib/brand";
import { directoryMode } from "@/lib/directory-mode";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import {
  DIRECTORY_PAGE_SIZE,
  directoryFacets,
  directoryQuery,
  filterProfessionals,
  normalizeCity,
  paginate,
  parseDirectoryFilters,
} from "@/lib/directory-logic";
import type { DirectoryProfessional } from "@/lib/directory-types";
import {
  DirectoryEmpty,
  DirectoryFiltersForm,
  DirectoryPager,
  ProfessionalCard,
} from "@/components/directory/directory-list";
import { directoryRobots, directoryTitle } from "@/components/directory/directory-copy";
import s from "@/components/directory/directory.module.css";

/**
 * DIR-3a (C-DIR5) · `/profesionales`: lista del directorio con filtros por GET y paginado en server de a 24.
 *
 * - Los filtros viven en la URL (`especialidad`, `cobertura`, `provincia`, `ciudad`, `pagina`): se comparten, el botón
 *   de atrás funciona y sin JS anda igual. Lo que no tiene forma válida se descarta en `parseDirectoryFilters`.
 * - Leer `searchParams` hace la ruta dinámica en Next 14 (no hay ISR por query); el costo por request es igual de
 *   chico porque los datos salen del snapshot cacheado (`unstable_cache`, 10 min / tag `global:directory`) y se
 *   filtran en memoria. `revalidate = 600` queda como contrato de C-DIR5 y rige para el fetch cacheado.
 * - `directoryMode() === "off"` → 404 antes de leer nada.
 */
export const revalidate = 600;

type Props = { searchParams?: Record<string, string | string[] | undefined> };

export async function generateMetadata({ searchParams = {} }: Props): Promise<Metadata> {
  const mode = directoryMode();
  if (mode === "off") return { robots: { index: false, follow: false } };
  const f = parseDirectoryFilters(searchParams);
  const thin = Boolean(f.especialidad || f.cobertura || f.provincia || f.ciudad);
  const title = directoryTitle("Profesionales");
  const description = `Buscá profesionales de la salud que dan turnos online con ${BRAND_NAME} y sacá turno directo en su consultorio.`;
  const canonical = `/profesionales${directoryQuery({ ...f, especialidad: null, cobertura: null, provincia: null, ciudad: null })}`;
  return {
    metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
    title: { absolute: title },
    description,
    alternates: { canonical },
    robots: directoryRobots(mode, { thin }),
    openGraph: { type: "website", locale: "es_AR", siteName: BRAND_NAME, title, description, url: canonical },
  };
}

/** Ciudades para el `<datalist>`: una por ciudad normalizada, con la grafía de la primera que aparece. */
function cityOptions(pros: DirectoryProfessional[]): string[] {
  const by = new Map<string, string>();
  for (const p of pros) for (const c of p.clinics) if (c.city && !by.has(normalizeCity(c.city))) by.set(normalizeCity(c.city), c.city);
  return [...by.values()].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
}

export default async function ProfesionalesPage({ searchParams = {} }: Props) {
  if (directoryMode() === "off") notFound();
  const snapshot = await getDirectorySnapshot();
  const filters = parseDirectoryFilters(searchParams);
  const facets = { ...directoryFacets(snapshot.professionals), cities: cityOptions(snapshot.professionals) };
  const result = paginate(filterProfessionals(snapshot.professionals, filters), filters.pagina);
  // Fuera de rango → la última (C-DIR5): el paginado y el resumen usan la página efectiva, no la pedida.
  const shown = { ...filters, pagina: result.page };
  const from = (result.page - 1) * DIRECTORY_PAGE_SIZE + 1;

  return (
    <>
      <div className={s.intro}>
        <p className={s.eyebrow}>Directorio</p>
        <h1 className={s.h1}>Buscá un profesional</h1>
        <p className={s.lead}>
          Profesionales de la salud que dan turnos online. Elegí por especialidad, cobertura o zona y sacá turno
          directo en su consultorio.
        </p>
      </div>

      <DirectoryFiltersForm filters={filters} facets={facets} />

      <section
        aria-labelledby={result.total > 0 ? "dir-resultados" : undefined}
        aria-label={result.total > 0 ? undefined : "Resultados"}
      >
        {result.total === 0 ? (
          <DirectoryEmpty filters={filters} facets={facets} anyPublished={snapshot.professionals.length > 0} />
        ) : (
          <>
            <div className={s.resultsHead}>
              <h2 id="dir-resultados" className={s.h2}>
                {result.total === 1 ? "1 profesional" : `${result.total} profesionales`}
              </h2>
              {result.totalPages > 1 && (
                <p className={`${s.muted} ${s.small}`}>
                  Mostrando {from}–{from + result.items.length - 1} de {result.total}
                </p>
              )}
            </div>
            <ul className={s.grid} role="list">
              {result.items.map((p) => (
                <li key={p.profileId}>
                  <ProfessionalCard pro={p} />
                </li>
              ))}
            </ul>
            <DirectoryPager filters={shown} page={result.page} totalPages={result.totalPages} />
          </>
        )}
      </section>
    </>
  );
}
