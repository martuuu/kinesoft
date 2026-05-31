import Link from "next/link";
import { listPatients } from "@/lib/patients";
import { loadFilterFacets } from "@/lib/exercises";
import type { PatientSort } from "@/lib/patients-types";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconUsers, IconPlus } from "@/components/ui/icons";
import { NewPatientButton } from "@/components/patients/new-patient-button";
import { PatientsSearchBar } from "@/components/patients/patients-search-bar";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { AdvancedPatientFilters } from "@/components/patients/advanced-filters";
import {
  BulkActionBar,
  BulkSelectCheckbox,
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
  const [patients, facets] = await Promise.all([
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
          <NewPatientButton />
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
          {patients.map((p) => {
            const initials = `${p.firstName} ${p.lastName}`;
            const isBasic = p.access === "basic";
            // Basic rows: muted styling, no plan info, no insurer line,
            // no archive action (the row's owner controls that), no
            // bulk-select (those mutate PHI).
            const tone: "sky" | "lime" | "navy" = isBasic
              ? "sky"
              : p.activeProgramTitle
                ? "lime"
                : "sky";
            return (
              <div
                key={p.id}
                style={{
                  padding: "14px 18px",
                  display: "grid",
                  gridTemplateColumns: "28px 1.6fr 1fr 1fr 1.2fr 100px 90px 40px",
                  gap: 14,
                  alignItems: "center",
                  fontSize: 13,
                  borderBottom: "1px solid rgba(15,30,51,0.04)",
                  opacity: isBasic ? 0.75 : 1,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {isBasic ? <span /> : <BulkSelectCheckbox patientId={p.id} />}
                </span>
                <Link
                  href={`/pacientes/${p.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textDecoration: "none",
                    color: "inherit",
                    minWidth: 0,
                  }}
                >
                  <Avatar name={initials} size={36} tone={tone} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>
                      {p.lastName}, {p.firstName}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
                      {isBasic
                        ? p.documentId ? `DNI ${p.documentId}` : "Sin acceso"
                        : (p.email ?? p.phone ?? p.documentId ?? "—")}
                    </div>
                  </div>
                </Link>
                <div style={{ color: isBasic ? "var(--navy-300)" : p.activeProgramTitle ? "var(--navy-700)" : "var(--navy-300)" }}>
                  {isBasic ? (
                    <Tag tone="soft">Sin acceso</Tag>
                  ) : (
                    <>
                      {p.activeProgramTitle ?? "Sin plan asignado"}
                      {p.sessionsTotal > 0 && (
                        <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
                          {p.sessionsDone} / {p.sessionsTotal}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div style={{ color: isBasic ? "var(--navy-300)" : "var(--navy-700)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {isBasic || !p.obraSocial || p.obraSocial.toLowerCase() === "particular"
                    ? "—"
                    : p.obraSocial}
                </div>
                <div style={{ color: "var(--navy-500)" }}>
                  {p.upcomingAt
                    ? p.upcomingAt.toLocaleString("es-AR", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                        timeZone: "America/Argentina/Buenos_Aires",
                      })
                    : "—"}
                </div>
                <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  {isBasic
                    ? "—"
                    : p.lastVisit
                      ? p.lastVisit.toLocaleDateString("es-AR", {
                          day: "2-digit",
                          month: "short",
                        })
                      : "—"}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {isBasic ? (
                    <Tag tone="soft">—</Tag>
                  ) : p.activeProgramTitle ? (
                    <Tag tone="lime">Activo</Tag>
                  ) : (
                    <Tag tone="soft">Inactivo</Tag>
                  )}
                </div>
                {isBasic ? (
                  <span />
                ) : (
                  <PatientRowActions patientId={p.id} archived={filter === "archived"} />
                )}
              </div>
            );
          })}
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
