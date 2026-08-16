import Link from "next/link";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { loadFilterFacets } from "@/lib/exercises";
import type { PatientSort } from "@/lib/patients-types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconUsers, IconPlus } from "@/components/ui/icons";
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
  const q = searchParams.q ?? "";
  const filter = (searchParams.filter ?? "all") as NonNullable<SP["filter"]>;
  const sort = (searchParams.sort ?? "lastName.asc") as PatientSort;
  const insurer = searchParams.insurer ?? "";
  const ageMin = searchParams.ageMin ? Number(searchParams.ageMin) : undefined;
  const ageMax = searchParams.ageMax ? Number(searchParams.ageMax) : undefined;
  const diagnosisSlug = searchParams.diagnosisSlug ?? "";
  const lastVisitFrom = searchParams.lastVisitFrom ?? "";
  const lastVisitTo = searchParams.lastVisitTo ?? "";

  // Conditions list — reusing `loadFilterFacets` keeps the catalog
  // cached (1h TTL) so the page renders without an extra DB roundtrip
  // on warm cache hits.
  const [patients, facets, insurers] = await Promise.all([
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
  ]);
  const totals = {
    all: patients.length,
    withProgram: patients.filter((p) => p.activeProgramTitle).length,
    withoutProgram: patients.filter((p) => !p.activeProgramTitle).length,
  };

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
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Pacientes</div>
          <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            Directorio · <span style={{ color: "var(--sky-700)" }}>{totals.all}</span> pacientes
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <a href="/api/pacientes/export" target="_blank" rel="noopener noreferrer">
            <Button variant="ghost">Exportar CSV</Button>
          </a>
          <NewPatientButton insurers={insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name }))} />
        </div>
      </header>

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
        <EmptyState />
      ) : (
        <BulkSelectProvider>
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 18px",
              display: "grid",
              gridTemplateColumns: "28px 1.6fr 1fr 1fr 1.2fr 100px 90px 40px",
              gap: 14,
              fontSize: 10,
              fontWeight: 700,
              color: "var(--navy-300)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              borderBottom: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <span />
            <span>Paciente</span>
            <span>Plan activo</span>
            <span>Obra social</span>
            <span>Próx. turno</span>
            <span>Última visita</span>
            <span style={{ textAlign: "right" }}>Estado</span>
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

function EmptyState() {
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
      <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
        Sin pacientes en esta vista
      </div>
      <p style={{ color: "var(--navy-500)", maxWidth: 360, margin: "8px auto 16px" }}>
        Probá quitar filtros o creá tu primer paciente.
      </p>
      <div style={{ display: "inline-flex", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--sky-700)",
            fontWeight: 600,
          }}
        >
          <IconPlus size={14} /> Usá el botón “Nuevo paciente”
        </span>
      </div>
    </Card>
  );
}
