"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { BulkSelectCheckbox } from "@/components/patients/bulk-select";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { disciplineLabel } from "@/lib/plan-display";
import { staggerList, staggerItem } from "@/lib/motion";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { patientsGridColumns } from "@/components/patients/patients-grid";
import type { PatientListPlanChip, PatientRow } from "@/lib/patients-types";

/**
 * Texto de un chip de plan del directorio (S32, puro). Mismo formato que el
 * hero del perfil (`heroPlanChipText`): "3/10" = realizadas / sesiones vivas,
 * y el aria lo dice entero con la disciplina, porque el color no puede ser el
 * único canal (AGENTS §5). Sin título (PHI, PD-11).
 */
export function patientListPlanChipText(chip: PatientListPlanChip): { progress: string; ariaLabel: string } {
  const disc = chip.discipline ? `Plan de ${disciplineLabel(chip.discipline)}` : "Plan";
  return {
    progress: `${chip.done}/${chip.totalLive}`,
    ariaLabel: `${disc}: ${chip.done} de ${chip.totalLive} ${chip.totalLive === 1 ? "sesión realizada" : "sesiones realizadas"}`,
  };
}

/**
 * Columna «Plan activo» (S32): un chip por plan ACTIVE y vivo (Kine y Osteo
 * pueden convivir). Con un solo plan, debajo va su título; con dos o más, solo
 * los chips (un título suelto no diría de cuál es).
 */
function PlanCell({ plans, title }: { plans: PatientListPlanChip[]; title: string | null }) {
  if (plans.length === 0) return <span style={{ color: "var(--navy-300)" }}>Sin plan activo</span>;
  return (
    <div style={{ minWidth: 0 }}>
      <ul
        aria-label="Planes en curso"
        style={{ display: "flex", gap: 4, flexWrap: "wrap", listStyle: "none", margin: 0, padding: 0 }}
      >
        {plans.map((c, i) => {
          const { progress, ariaLabel } = patientListPlanChipText(c);
          return (
            <li
              key={`${c.discipline ?? "NONE"}-${i}`}
              data-testid="patients-plan-chip"
              aria-label={ariaLabel}
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <DisciplineChip discipline={c.discipline} size="xs" />
              <span className="k-mono" aria-hidden style={{ fontSize: 11, fontWeight: 700, color: "var(--sky-700)" }}>
                {progress}
              </span>
            </li>
          );
        })}
      </ul>
      {plans.length === 1 && title && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--navy-700)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
      )}
    </div>
  );
}

/**
 * Client boundary for the patient directory rows.
 *
 * Renders the exact same grid rows as before, but wrapped in a
 * `staggerList` container so each row fades/rises in on a subtle,
 * sequenced delay. The container `key` is a signature of the current
 * row set (order-sensitive) so the reveal re-fires whenever the list
 * changes via search / filter / sort — the wrapper remounts and the
 * `initial → animate` transition runs again.
 *
 * Zero visual change beyond the staggered entrance: the column grid,
 * spacing, colors, links and row actions are identical to the previous
 * inline `patients.map(...)`.
 */
export function PatientsList({
  rows,
  archived,
}: {
  rows: PatientRow[];
  archived: boolean;
}) {
  const signature = rows.map((r) => r.id).join(",");
  // EV1-B: sin `planes` (General) no hay columna de plan y el «Estado» deja de
  // ser "tiene plan activo" (que ahí sería siempre «Inactivo") para ser el del
  // paciente: Activo o Archivado según la vista.
  const plansEnabled = useTenantModules().has("planes");

  return (
    <motion.div
      key={signature}
      variants={staggerList}
      initial="initial"
      animate="animate"
    >
      {rows.map((p) => {
        const initials = `${p.firstName} ${p.lastName}`;
        const isBasic = p.access === "basic";
        // S32: "tiene plan" = al menos un chip (plan ACTIVE y vivo); avatar,
        // celda y «Estado» leen lo mismo.
        const hasPlan = (p.activePlans?.length ?? 0) > 0;
        // Basic rows: muted styling, no plan info, no insurer line,
        // no archive action (the row's owner controls that), no
        // bulk-select (those mutate PHI).
        const tone: "sky" | "lime" | "navy" = isBasic || !plansEnabled
          ? "sky"
          : hasPlan
            ? "lime"
            : "sky";
        return (
          <motion.div
            key={p.id}
            variants={staggerItem}
            style={{
              padding: "14px 18px",
              display: "grid",
              gridTemplateColumns: patientsGridColumns(plansEnabled),
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
            {plansEnabled && (
            <div style={{ minWidth: 0 }}>
              {isBasic ? (
                <Tag tone="soft">Sin acceso</Tag>
              ) : (
                <PlanCell plans={p.activePlans ?? []} title={p.activeProgramTitle} />
              )}
            </div>
            )}
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
                    hourCycle: "h23",
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
                      timeZone: "America/Argentina/Buenos_Aires",
                    })
                  : "—"}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              {isBasic ? (
                <Tag tone="soft">—</Tag>
              ) : !plansEnabled ? (
                archived ? <Tag tone="soft">Archivado</Tag> : <Tag tone="lime">Activo</Tag>
              ) : hasPlan ? (
                <Tag tone="lime">Activo</Tag>
              ) : (
                <Tag tone="soft">Inactivo</Tag>
              )}
            </div>
            {isBasic ? (
              <span />
            ) : (
              // S32a (handoff): el diálogo de archivar nombra al paciente. `livePlanCount`
              // queda en null (pregunta siempre): `activePlans` cuenta solo ACTIVE y
              // L9 también pausa/cancela planes PAUSED.
              <PatientRowActions patientId={p.id} archived={archived} patientName={`${p.firstName} ${p.lastName}`} />
            )}
          </motion.div>
        );
      })}
    </motion.div>
  );
}
