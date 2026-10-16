import Link from "next/link";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { loadFilterFacets } from "@/lib/exercises";
import { getCapabilities, getTenantModules } from "@/lib/authz";
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
import {
  BulkActionBar,
  BulkSelectProvider,
} from "@/components/patients/bulk-select";

export const metadata = { title: "Pacientes · KineSoft" };
export const dynamic = "force-dynamic";

type SP = {
  q?: string;
  filter?: "all" | "active" | "no-program" | "archived";
  sort?: PatientSort;
  insurer?: string;
  ageMin?: string;
  ageMax?: string;
  diagnosisSlug?: string;
  lastVisitFrom?: string;
  lastVisitTo?: string;
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
  const insurer = searchParams.insurer ?? "";
  const ageMin = searchParams.ageMin ? Number(searchParams.ageMin) : undefined;
  const ageMax = searchParams.ageMax ? Number(searchParams.ageMax) : undefined;
  const diagnosisSlug = diagnosisEnabled ? (searchParams.diagnosisSlug ?? "") : "";
  const lastVisitFrom = searchParams.lastVisitFrom ?? "";
  const lastVisitTo = searchParams.lastVisitTo ?? "";

  // Conditions list — reusing `loadFilterFacets` keeps the catalog
  // cached (1h TTL) so the page renders without an extra DB roundtrip
  // on warm cache hits.
  const [patients, facets, insurers, caps] = await Promise.all([
    listPatients({
      q,
      filter,
      sort,
      insurer: insurer || undefined,
      ageMin: Number.isFinite(ageMin) ? ageMin : undefined,
      ageMax: Number.isFinite(ageMax) ? ageMax : undefined,
      diagnosisSlug: diagnosisSlug || undefined,
      lastVisitFrom: lastVisitFrom || undefined,
      lastVisitTo: lastVisitTo || undefined,
    }),
    loadFilterFacets(),
    listInsurers({ onlyActive: true }),
    getCapabilities(),
  ]);
  // P0-S07sp: sin clinical.read, `createPatient` exige `assignTo` (el
  // profesional a cargo) y este alta no lo pide → se oculta el botón para la
  // Secretaria/BILLING. Ella da de alta desde el modal del turno, que manda el
  // profesional del turno. Un selector "Profesional a cargo" acá queda para C0.
  const canCreateHere = caps.has("clinical.read");
  // S32: «Con plan» = al menos un plan ACTIVE y vivo (`activePlans`, mismo
  // predicado que el filtro `active`/`no-program` de `listPatients`), así el
  // número del pill coincide con la lista que abre. Una fila `basic` sale con
  // `activePlans: []` (no se le ve el plan) y al filtrar no aparece (H-b1: los
  // filtros clínicos solo dejan filas `full`), así que «Sin plan» cuenta solo
  // filas `full` (ES4-Z: antes las contaba y el pill no coincidía con la lista).
  const hasPlan = (p: (typeof patients)[number]) => (p.activePlans?.length ?? 0) > 0;
  const totals = plansEnabled
    ? {
        all: patients.length,
        withProgram: patients.filter(hasPlan).length,
        withoutProgram: patients.filter((p) => p.access === "full" && !hasPlan(p)).length,
      }
    : { all: patients.length };

  const baseQS = (override: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q,
      filter,
      sort,
      insurer,
      ageMin: ageMin?.toString(),
      ageMax: ageMax?.toString(),
      diagnosisSlug,
      lastVisitFrom,
      lastVisitTo,
      ...override,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v) sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* PF1.1 (C-PF5.3): `PageHeader` (eyebrow + h1 + acciones). El conteo queda en el h1 con el color de marca. */}
      <PageHeader
        eyebrow="Pacientes"
        title={
          <>
            Directorio · <span style={{ color: "var(--sky-700)" }}>{totals.all}</span>{" "}
            {totals.all === 1 ? "paciente" : "pacientes"}
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
              <NewPatientButton insurers={insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name }))} />
            )}
          </>
        }
      />

      <PatientsSearchBar filter={filter} totals={totals} />

      {/* Sort + advanced filters row */}
      <div
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
        <form action="/pacientes" method="get" style={{ display: "inline-flex", gap: 4 }}>
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="sort" value={sort} />
          {q && <input type="hidden" name="q" value={q} />}
          <input
            type="text"
            name="insurer"
            defaultValue={insurer}
            placeholder="OSDE, Swiss…"
            aria-label="Filtrar por cobertura"
            className={directory.field}
            style={{
              padding: "5px 10px",
              borderRadius: 999,
              fontSize: 11.5,
              border: "1px solid rgba(15,30,51,0.08)",
              background: "rgba(255,255,255,0.7)",
              width: 140,
            }}
          />
        </form>
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
        preservedParams={{ q, filter, sort, insurer }}
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
          filtered={Boolean(q || insurer || ageMin != null || ageMax != null || diagnosisSlug || lastVisitFrom || lastVisitTo || filter !== "all")}
          canCreate={canCreateHere}
        />
      ) : (
        <BulkSelectProvider>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            className={directory.head}
            style={{ gridTemplateColumns: patientsGridColumns(plansEnabled) }}
          >
            <span />
            <span>Paciente</span>
            {plansEnabled && <span>Plan activo</span>}
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
    </div>
  );
}

/**
 * Vacío del directorio (C-PF5.5). Antes decía «Usá el botón “Nuevo paciente”» en un `<span>` con ícono que parecía
 * un botón y no hacía nada. Con filtros: «Quitar filtros» (link real a la vista sin filtros). Sin filtros: el
 * texto apunta al botón del encabezado, que solo existe si el rol puede crear (la Secretaria da de alta desde el
 * turno).
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
