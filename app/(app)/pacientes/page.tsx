import Link from "next/link";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { loadFilterFacets } from "@/lib/exercises";
import { getCapabilities, getTenantModules } from "@/lib/authz";
import { getActor } from "@/lib/session";
import { listPractitioners } from "@/lib/bookings";
import { tenantWhatsAppActive } from "@/lib/whatsapp-patient-ui-internal";
import { displayMemberName } from "@/lib/display-name";
import { newPatientMode } from "@/components/patients/patient-form-payload";
import { patientsGridColumns } from "@/components/patients/patients-grid";
import type { PatientSort } from "@/lib/patients-types";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import directory from "@/components/patients/patients-directory.module.css";
import { ButtonLink, buttonClassName } from "@/components/ui/button";
import { IconUsers } from "@/components/ui/icons";
import { NewPatientButton } from "@/components/patients/new-patient-button";
import { PatientsSearchBar } from "@/components/patients/patients-search-bar";
import { PatientsList } from "@/components/patients/patients-list";
import { AdvancedPatientFilters } from "@/components/patients/advanced-filters";
import { InsurerFilterSelect } from "@/components/patients/insurer-filter-select";
import {
  BulkActionBar,
  BulkSelectPageCheckbox,
  BulkSelectProvider,
} from "@/components/patients/bulk-select";
import { PatientsPagination } from "@/components/patients/patients-pagination";

/** Separador de miles AR en el conteo del h1 («1.234 pacientes»). */
const COUNT = new Intl.NumberFormat("es-AR");

export const metadata = { title: "Pacientes" };
export const dynamic = "force-dynamic";

type SP = {
  q?: string;
  filter?: "all" | "active" | "no-program" | "archived";
  sort?: PatientSort;
  /** T3e-2p: id del catálogo o `particular` (antes `?insurer=` de texto, que ya no se lee). */
  os?: string;
  ageMin?: string;
  ageMax?: string;
  diagnosisSlug?: string;
  lastVisitFrom?: string;
  lastVisitTo?: string;
  /** HD-10: página del directorio (1-based); el server la recorta a `[1, pageCount]`. */
  page?: string;
};

const SORT_OPTIONS: { value: PatientSort; label: string }[] = [
  { value: "lastName.asc", label: "Apellido A→Z" },
  { value: "lastName.desc", label: "Apellido Z→A" },
  { value: "createdAt.desc", label: "Más recientes" },
  { value: "upcoming.asc", label: "Próximo turno" },
  { value: "lastVisit.desc", label: "Última visita" },
];

export default async function PacientesPage({ searchParams }: { searchParams: SP }) {
  // EV1-B: el directorio se arma por módulos. Sin `planes` (General) no hay
  // columna de plan, ni pills «Con plan/Sin plan», ni totales por plan; sin
  // `diagnostico`, no hay filtro por diagnóstico. Un `?filter=active` o
  // `?diagnosisSlug=` que llegue por URL se normaliza acá para la UI (el pill
  // y los links no lo arrastran) y `listPatients` también lo ignora: esconder
  // es UX, la barrera es el server.
  const modules = await getTenantModules();
  const plansEnabled = modules.has("planes");
  const diagnosisEnabled = modules.has("diagnostico");
  const q = searchParams.q ?? "";
  const rawFilter = (searchParams.filter ?? "all") as NonNullable<SP["filter"]>;
  const filter: NonNullable<SP["filter"]> =
    !plansEnabled && (rawFilter === "active" || rawFilter === "no-program") ? "all" : rawFilter;
  const sort = (searchParams.sort ?? "lastName.asc") as PatientSort;
  const os = searchParams.os?.trim() ?? "";
  const ageMin = searchParams.ageMin ? Number(searchParams.ageMin) : undefined;
  const ageMax = searchParams.ageMax ? Number(searchParams.ageMax) : undefined;
  const diagnosisSlug = diagnosisEnabled ? (searchParams.diagnosisSlug ?? "") : "";
  const lastVisitFrom = searchParams.lastVisitFrom ?? "";
  const lastVisitTo = searchParams.lastVisitTo ?? "";

  // Conditions list — reusing `loadFilterFacets` keeps the catalog
  // cached (1h TTL) so the page renders without an extra DB roundtrip
  // on warm cache hits.
  // T3d-1u: la lista de profesionales del alta de la recepción sale de `listPractitioners` (cacheada por tag
  // `practitioners`, reservables y sin suspender: el mismo filtro que valida `createPatient`). Solo se pide en ese modo,
  // y en paralelo con el resto (encadenada a las capabilities, que ya están en el cache del request).
  const capsP = getCapabilities();
  // WA-U3: casilla de WhatsApp del alta. Con `WHATSAPP_MODE=off`, 0 sentencias; con cuenta, cacheada por tag.
  // HD-10: `listPatients` devuelve UNA página (50) con `total` y `totals` calculados sobre todas las filas visibles.
  const [patientsPage, facets, insurers, caps, actor, assigneeRows, whatsappActive] = await Promise.all([
    listPatients({
      q,
      filter,
      sort,
      insurerKey: os || undefined,
      ageMin: Number.isFinite(ageMin) ? ageMin : undefined,
      ageMax: Number.isFinite(ageMax) ? ageMax : undefined,
      diagnosisSlug: diagnosisSlug || undefined,
      lastVisitFrom: lastVisitFrom || undefined,
      lastVisitTo: lastVisitTo || undefined,
      page: searchParams.page ? Number(searchParams.page) : undefined,
    }),
    loadFilterFacets(),
    listInsurers({ onlyActive: true }),
    capsP,
    getActor(),
    Promise.all([capsP, getActor()]).then(([c, a]) =>
      newPatientMode(c, { support: !!a.support }) === "admin" ? listPractitioners() : null
    ),
    getActor().then((a) => tenantWhatsAppActive(a.tenantId)),
  ]);
  // T3d-1u (plan §23.5): sin clinical.read, `createPatient` exige `assignTo` (el profesional a cargo). Antes (P0-S07sp)
  // el botón se escondía para la Secretaria y ella daba de alta solo desde el modal del turno; ahora el alta de la
  // recepción pide «Profesional a cargo» obligatorio y no tiene notas ni diagnóstico. Facturación sigue sin alta.
  const createMode = newPatientMode(caps, { support: !!actor.support });
  const canCreateHere = createMode !== null;
  const assignees =
    createMode === "admin"
      ? (assigneeRows ?? []).map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) }))
      : undefined;
  // S32 / ES4-Z: «Con plan» / «Sin plan» cuentan solo filas `full` con el mismo predicado que el filtro. HD-10: los
  // calcula el server sobre TODAS las filas visibles (`directoryTotals`), no sobre la página.
  const osOptions = insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name }));
  const patients = patientsPage.rows;
  const totals = patientsPage.totals;

  // HD-10: `page` NO es parte del estado que se arrastra. Solo la paginación la pone (`baseQS({ page })`); cualquier otro
  // link (orden, archivados) y los forms GET (`preserved` de la OS, `preservedParams` de los avanzados) salen sin ella:
  // la página 3 de «Apellido A→Z» no es la 3 de «Próximo turno», y un filtro que deja 12 filas caería recortado a la
  // última página en vez de mostrarse desde arriba.
  const filterParams: Record<string, string | undefined> = {
    q,
    filter,
    sort,
    os,
    ageMin: ageMin?.toString(),
    ageMax: ageMax?.toString(),
    diagnosisSlug,
    lastVisitFrom,
    lastVisitTo,
  };
  const baseQS = (override: Record<string, string | undefined> & { page?: string }) => {
    const sp = new URLSearchParams();
    const merged: Record<string, string | undefined> = { ...filterParams, page: undefined, ...override };
    // La 1 es la URL sin `page` (una sola URL canónica por vista).
    if (merged.page === "1") merged.page = undefined;
    for (const [k, v] of Object.entries(merged)) {
      if (v) sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  };

  // T3-Z M8: misma regla que PatientsList (sin filas full, la columna Plan no se muestra y el encabezado no se corre).
  const showPlanColumn = plansEnabled && patients.some((p) => p.access === "full");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* PF1.1 (C-PF5.3): `PageHeader` (eyebrow + h1 + acciones). El conteo queda en el h1 con el color de marca. */}
      <PageHeader
        eyebrow="Pacientes"
        title={
          <>
            Directorio · <span style={{ color: "var(--sky-700)" }}>{COUNT.format(patientsPage.total)}</span>{" "}
            {patientsPage.total === 1 ? "paciente" : "pacientes"}
          </>
        }
        actions={
          <>
            {/* En "Archivados" exporta los archivados (la ruta excluye por default). */}
            {/* PF1.1: un solo `<a>` con look de botón (antes `<a><Button/></a>`: botón anidado en un link). `<a>` y no
                `ButtonLink`: es una descarga de un route handler, no una navegación del router. */}
            <a
              href={`/api/pacientes/export${filter === "archived" ? "?archived=only" : ""}`}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName({ variant: "ghost" })}
              style={{ textDecoration: "none" }}
            >
              Exportar CSV
            </a>
            {canCreateHere && (
              <NewPatientButton
                insurers={osOptions}
                assignees={assignees}
                whatsappActive={whatsappActive}
              />
            )}
          </>
        }
      />

      <PatientsSearchBar filter={filter} totals={totals} />

      {/* Sort + advanced filters row */}
      <div
        className={directory.sortRow}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          fontSize: 12,
          color: "var(--navy-500)",
        }}
      >
        <span style={{ fontWeight: 600 }}>Ordenar:</span>
        {SORT_OPTIONS.map((s) => {
          const on = sort === s.value;
          return (
            <Link
              key={s.value}
              href={`/pacientes${baseQS({ sort: s.value })}`}
              scroll={false}
              style={{
                padding: "5px 10px",
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 600,
                background: on ? "var(--sky-700)" : "rgba(255,255,255,0.6)",
                color: on ? "#fff" : "var(--navy-700)",
                textDecoration: "none",
                border: on ? "none" : "1px solid rgba(15,30,51,0.06)",
              }}
            >
              {s.label}
            </Link>
          );
        })}
        <span style={{ marginLeft: 12, fontWeight: 600 }}>Cobertura:</span>
        {/* T3e-2p (§23.9): `<select>` nativo con el catálogo activo (sin la fila Particular, que es su propia opción). */}
        <InsurerFilterSelect
          value={os}
          insurers={osOptions}
          preserved={{ ...filterParams, os: undefined }}
        />
        <Link
          href={`/pacientes${baseQS({ filter: filter === "archived" ? "all" : "archived" })}`}
          scroll={false}
          style={{
            marginLeft: "auto",
            padding: "5px 10px",
            borderRadius: 999,
            fontSize: 11.5,
            fontWeight: 600,
            background: filter === "archived" ? "var(--navy-900)" : "rgba(255,255,255,0.6)",
            color: filter === "archived" ? "#fff" : "var(--navy-500)",
            textDecoration: "none",
            border: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          {filter === "archived" ? "Volver a activos" : "Ver archivados"}
        </Link>
      </div>

      <AdvancedPatientFilters
        conditions={facets.conditions}
        preservedParams={{ q, filter, sort, os }}
        current={{
          ageMin: searchParams.ageMin,
          ageMax: searchParams.ageMax,
          diagnosisSlug,
          lastVisitFrom,
          lastVisitTo,
        }}
      />

      {patients.length === 0 ? (
        <EmptyState
          filtered={Boolean(q || os || ageMin != null || ageMax != null || diagnosisSlug || lastVisitFrom || lastVisitTo || filter !== "all")}
          canCreate={canCreateHere}
        />
      ) : (
        // HD-10: `key` por URL = la selección es de ESTA página/vista; cambiar de página o de filtro la vacía (si no, el
        // provider sobrevive a la navegación suave y «Archivar» se llevaría filas que ya no se ven).
        <BulkSelectProvider key={baseQS({ page: String(patientsPage.page) })}>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            className={directory.head}
            style={{ gridTemplateColumns: patientsGridColumns(showPlanColumn) }}
          >
            <span>
              <BulkSelectPageCheckbox ids={patients.filter((p) => p.access === "full").map((p) => p.id)} />
            </span>
            <span>Paciente</span>
            {showPlanColumn && <span>Plan activo</span>}
            <span>Obra social</span>
            <span>Próx. turno</span>
            <span>Última visita</span>
            <span className={directory.right}>Estado</span>
            <span />
          </div>
          <PatientsList rows={patients} archived={filter === "archived"} />
        </Card>
        <BulkActionBar archivedView={filter === "archived"} />
        </BulkSelectProvider>
      )}

      {/* HD-10: debajo de la lista; con una sola página no se muestra (el total ya está en el h1). */}
      {patients.length > 0 && (
        <PatientsPagination
          page={patientsPage.page}
          pageCount={patientsPage.pageCount}
          total={patientsPage.total}
          hrefFor={(p) => `/pacientes${baseQS({ page: String(p) })}`}
        />
      )}
    </div>
  );
}

/**
 * Vacío del directorio (C-PF5.5). Antes decía «Usá el botón “Nuevo paciente”» en un `<span>` con ícono que parecía
 * un botón y no hacía nada. Con filtros: «Quitar filtros» (link real a la vista sin filtros). Sin filtros: el
 * texto apunta al botón del encabezado, que solo existe si el rol puede crear (desde T3d-1u también la Secretaria;
 * Facturación no da de alta).
 */
function EmptyState({ filtered, canCreate }: { filtered: boolean; canCreate: boolean }) {
  return (
    <Card style={{ padding: 40, textAlign: "center" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--sky-100)",
          color: "var(--sky-700)",
          margin: "0 auto 12px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconUsers size={26} />
      </div>
      <h2 className="k-display" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
        {filtered ? "Ningún paciente coincide con la búsqueda" : "Todavía no hay pacientes"}
      </h2>
      <p style={{ color: "var(--navy-500)", maxWidth: 380, margin: "8px auto 16px" }}>
        {filtered
          ? "Probá con otro nombre o DNI, o quitá los filtros."
          : canCreate
            ? "Creá el primero con «Nuevo paciente», arriba a la derecha."
            : "Los pacientes se dan de alta al agendar su primer turno."}
      </p>
      {filtered && (
        <ButtonLink href="/pacientes" variant="ghost" style={{ textDecoration: "none" }}>
          Quitar filtros
        </ButtonLink>
      )}
    </Card>
  );
}
