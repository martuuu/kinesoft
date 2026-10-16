"use client";

import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { BulkSelectCheckbox } from "@/components/patients/bulk-select";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { disciplineLabel } from "@/lib/plan-display";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { patientsGridColumns } from "@/components/patients/patients-grid";
import type { PatientListPlanChip, PatientRow } from "@/lib/patients-types";
import styles from "./patients-directory.module.css";

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
  // ES4-Z: navy-500 (navy-300 no llegaba a 4.5:1 sobre el fondo de la fila).
  if (plans.length === 0) return <span style={{ color: "var(--navy-500)" }}>Sin plan activo</span>;
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
 * Línea secundaria de la fila (D11 de VX0-b): DNI o teléfono, que sirven para distinguir homónimos al escanear. El
 * email ya no va en la fila (era la línea de todas las filas y no aporta para buscar a ojo); queda en el `title` del
 * nombre y en la ficha. Una fila `basic` muestra solo el DNI.
 */
export function patientRowSubline(p: Pick<PatientRow, "access" | "documentId" | "phone">): string {
  if (p.access === "basic") return p.documentId ? `DNI ${p.documentId}` : "Sin acceso";
  if (p.documentId) return `DNI ${p.documentId}`;
  return p.phone ?? "—";
}

/** Retardo de la entrada escalonada: 35 ms por fila, tope en la 12 (una lista de 200 no tarda 7 s en aparecer). */
export function rowEnterDelayMs(index: number): number {
  return Math.min(index, 12) * 35;
}

/**
 * Filas del directorio (client boundary: checkbox de selección y acciones por fila).
 *
 * PF1.1 (C-PF1.2): la entrada escalonada era framer (`staggerList`/`staggerItem`) y el SSR pintaba las filas con
 * `opacity: 0` hasta hidratar. Ahora es CSS (`.k-enter-fade` + `animation-delay` por fila): se ve sin JS y
 * `prefers-reduced-motion` la apaga. El `key` del contenedor (firma ordenada de ids) re-monta la lista al buscar,
 * filtrar u ordenar, así la entrada se repite como antes.
 *
 * D2 (VX0-b): la grilla y su versión card (< 768) viven en `patients-directory.module.css`; las columnas siguen
 * saliendo de `patientsGridColumns` (compartidas con el encabezado de la página), inline.
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
  const cols: React.CSSProperties = { gridTemplateColumns: patientsGridColumns(plansEnabled) };

  return (
    <div key={signature}>
      {rows.map((p, i) => {
        const fullName = `${p.firstName} ${p.lastName}`;
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
        const insurer = isBasic || !p.obraSocial || p.obraSocial.toLowerCase() === "particular" ? "—" : p.obraSocial;
        return (
          <div
            key={p.id}
            data-testid="patients-row"
            className={`${styles.row} ${isBasic ? styles.basic : ""} k-enter-fade`}
            style={{ ...cols, animationDelay: `${rowEnterDelayMs(i)}ms` }}
          >
            {/* MB-1d: el `display` va por clase (inline le ganaba al `display: none` de la card < 768). */}
            <span className={styles.cellCheck}>
              {isBasic ? <span /> : <BulkSelectCheckbox patientId={p.id} />}
            </span>
            <Link
              href={`/pacientes/${p.id}`}
              className={`${styles.nameLink} ${styles.cellName}`}
              title={!isBasic && p.email ? `${fullName} · ${p.email}` : fullName}
            >
              <Avatar name={fullName} size={36} tone={tone} />
              <div style={{ minWidth: 0 }}>
                <div className={styles.name}>
                  {p.lastName}, {p.firstName}
                </div>
                <div className={styles.sub}>{patientRowSubline(p)}</div>
              </div>
            </Link>
            {plansEnabled && (
            <div className={styles.cellPlan} style={{ minWidth: 0 }}>
              {isBasic ? (
                <Tag tone="soft">Sin acceso</Tag>
              ) : (
                <PlanCell plans={p.activePlans ?? []} title={p.activeProgramTitle} />
              )}
            </div>
            )}
            <div
              className={`${styles.cellInsurer} ${styles.ellipsis}`}
              title={insurer === "—" ? undefined : insurer}
              style={{ color: isBasic ? "var(--navy-500)" : "var(--navy-700)", fontSize: 12 }}
            >
              <span className={styles.cardLabel}>Cobertura:</span>
              {insurer}
            </div>
            <div className={`${styles.cellNext} ${styles.nowrap}`} style={{ color: "var(--navy-500)" }}>
              <span className={styles.cardLabel}>Próx. turno:</span>
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
            <div className={`${styles.cellLast} ${styles.nowrap} k-mono`} style={{ fontSize: 12, color: "var(--navy-500)" }}>
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
            <div className={styles.cellState} style={{ display: "flex", justifyContent: "flex-end" }}>
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
              <span className={styles.cellActions} />
            ) : (
              // S32a (handoff): el diálogo de archivar nombra al paciente. `livePlanCount`
              // queda en null (pregunta siempre): `activePlans` cuenta solo ACTIVE y
              // L9 también pausa/cancela planes PAUSED.
              <span className={styles.cellActions}>
                <PatientRowActions patientId={p.id} archived={archived} patientName={fullName} />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
