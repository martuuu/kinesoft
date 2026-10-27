import { ButtonLink, buttonClassName } from "@/components/ui/button";
import { PATIENTS_PAGE_SIZE } from "@/lib/patients-types";

/**
 * HD-10 (PV §27): paginación del directorio de pacientes. Server component (0 JS): `Link`s armados por la página con
 * `hrefFor(p)` = su `baseQS({ page })`, así una página conserva búsqueda, orden y filtros, y al revés (cambiar un
 * filtro o el orden) la página NO viaja: arranca en la 1. Antes de HD-10 no había páginas: el directorio entero (1.000
 * pacientes = 1.000 filas hidratadas) salía en cada request.
 *
 * En los bordes «Anterior»/«Siguiente» quedan como texto deshabilitado (sin link): un link a la misma página no hace
 * nada y la Secretaría lo lee como roto. Los tres controles miden 44 px (`k-btn-md`), también a 390 px.
 */
export function PatientsPagination({
  page,
  pageCount,
  total,
  pageSize = PATIENTS_PAGE_SIZE,
  hrefFor,
}: {
  /** Ya recortada por el server a `[1, pageCount]`. */
  page: number;
  pageCount: number;
  /** Filas visibles con estos filtros (el `total` del h1). */
  total: number;
  pageSize?: number;
  hrefFor: (p: number) => string;
}) {
  if (pageCount <= 1) return null;
  const prev = page > 1 ? page - 1 : null;
  const next = page < pageCount ? page + 1 : null;
  const disabled = buttonClassName({ variant: "ghost", size: "md" });
  return (
    <nav
      aria-label="Paginación"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: 13, color: "var(--navy-500)" }}>{pageRangeLabel(page, total, pageSize)}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {prev ? (
          <ButtonLink href={hrefFor(prev)} variant="ghost" size="md" rel="prev" style={{ textDecoration: "none" }}>
            ← Anterior
          </ButtonLink>
        ) : (
          <span aria-disabled="true" className={disabled} style={{ opacity: 0.45, cursor: "default" }}>
            ← Anterior
          </span>
        )}
        {/* PV ZF2 (B16): sin `aria-current`: va en el link de la página actual, y esto es un texto, no un link. */}
        <span
          style={{ minHeight: 44, display: "inline-flex", alignItems: "center", fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}
        >
          Página {page} de {pageCount}
        </span>
        {next ? (
          <ButtonLink href={hrefFor(next)} variant="ghost" size="md" rel="next" style={{ textDecoration: "none" }}>
            Siguiente →
          </ButtonLink>
        ) : (
          <span aria-disabled="true" className={disabled} style={{ opacity: 0.45, cursor: "default" }}>
            Siguiente →
          </span>
        )}
      </span>
    </nav>
  );
}

/**
 * PV ZF2 (M6): indicador compacto arriba de la lista («Página 2 de 25 ‹ ›»), en la fila de los chips de orden. Con 50
 * filas por página la paginación de abajo quedaba a varios scrolls: quien buscaba la página siguiente no sabía que
 * había. Mismos `href` que la de abajo (`hrefFor`). `k-btn-sm` = 40 px en escritorio (la densidad de la fila) y 44 px
 * debajo de 768 (globals.css). Con una sola página no se muestra, igual que la de abajo.
 */
export function PatientsPageIndicator({
  page,
  pageCount,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  hrefFor: (p: number) => string;
}) {
  if (pageCount <= 1) return null;
  const prev = page > 1 ? page - 1 : null;
  const next = page < pageCount ? page + 1 : null;
  const look = buttonClassName({ variant: "ghost", size: "sm" });
  const arrow = { minWidth: 40, padding: 0, fontSize: 18, lineHeight: 1, textDecoration: "none" } as const;
  return (
    <nav
      aria-label="Páginas del directorio"
      data-testid="patients-page-indicator"
      style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-700)", marginRight: 4, whiteSpace: "nowrap" }}>
        Página {page} de {pageCount}
      </span>
      {prev ? (
        <ButtonLink href={hrefFor(prev)} variant="ghost" size="sm" rel="prev" aria-label="Página anterior" style={arrow}>
          <span aria-hidden="true">‹</span>
        </ButtonLink>
      ) : (
        <span aria-disabled="true" className={look} style={{ ...arrow, opacity: 0.45, cursor: "default" }}>
          <span aria-hidden="true">‹</span>
          <span className="k-sr-only">Página anterior</span>
        </span>
      )}
      {next ? (
        <ButtonLink href={hrefFor(next)} variant="ghost" size="sm" rel="next" aria-label="Página siguiente" style={arrow}>
          <span aria-hidden="true">›</span>
        </ButtonLink>
      ) : (
        <span aria-disabled="true" className={look} style={{ ...arrow, opacity: 0.45, cursor: "default" }}>
          <span aria-hidden="true">›</span>
          <span className="k-sr-only">Página siguiente</span>
        </span>
      )}
    </nav>
  );
}

const COUNT = new Intl.NumberFormat("es-AR");

/** «Mostrando 51–100 de 1.234» (separador de miles AR). Puro: lo usa la paginación y su test. */
export function pageRangeLabel(page: number, total: number, pageSize: number = PATIENTS_PAGE_SIZE): string {
  if (total <= 0) return "Sin pacientes";
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return `Mostrando ${COUNT.format(from)}–${COUNT.format(to)} de ${COUNT.format(total)}`;
}
