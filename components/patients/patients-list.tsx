"use client";

import Link from "next/link";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { BulkSelectCheckbox, BulkSelectPageCheckbox } from "@/components/patients/bulk-select";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import {
  patientsGridColumns,
  practitionerCellView,
  practitionerColumnLabel,
} from "@/components/patients/patients-grid";
import type { PatientRow } from "@/lib/patients-types";
import styles from "./patients-directory.module.css";

/**
 * Línea secundaria de la fila (D11 de VX0-b): DNI o teléfono, que sirven para distinguir homónimos al escanear. El
 * email ya no va en la fila (era la línea de todas las filas y no aporta para buscar a ojo); queda en el `title` del
 * nombre y en la ficha. Una fila `basic` muestra solo el DNI; `admin` (T3c-1b) trae contacto como `full`.
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
 * Encabezado del directorio (CF2). Vivía en `app/(app)/pacientes/page.tsx`; se mudó acá porque el rótulo de la columna
 * de profesionales depende de la vertical (`useTenantModules().vertical`) y así encabezado y filas leen la MISMA
 * grilla y el MISMO rótulo en el mismo archivo (si se desalinean, cada celda cae bajo el título equivocado).
 * `selectableIds` = filas `full` de la página (las únicas que el server deja archivar en lote).
 */
export function PatientsListHead({ selectableIds }: { selectableIds: string[] }) {
  const { vertical } = useTenantModules();
  return (
    <div className={styles.head} style={{ gridTemplateColumns: patientsGridColumns() }}>
      <span>
        <BulkSelectPageCheckbox ids={selectableIds} />
      </span>
      <span>Nombre y apellido</span>
      <span>Obra social</span>
      <span>Próx. turno</span>
      <span>Última visita</span>
      <span>{practitionerColumnLabel(vertical)}</span>
      <span className={styles.right}>Estado</span>
      <span />
    </div>
  );
}

/**
 * Celda «Kinesiólogo»/«Profesional» (CF2, decisión 2 de Martin). Dos líneas como mucho (a cargo primero con la marca
 * «a cargo», un segundo nombre) y «+N» para el resto. El `title` los dice todos (mouse) y el texto `k-sr-only` también
 * (lectores): un `aria-label` en un `div` genérico lo ignoran los lectores (ARIA lo prohíbe en `generic`), así que la
 * lista visible va `aria-hidden` y el nombre completo se lee una sola vez.
 */
function PractitionersCell({
  row,
  names,
  label,
}: {
  row: Pick<PatientRow, "practitionerIds" | "assignedPractitionerId">;
  names: Readonly<Record<string, string>>;
  label: string;
}) {
  const view = practitionerCellView(row.practitionerIds ?? [], row.assignedPractitionerId, names);
  return (
    <div className={styles.cellPros} title={view.empty ? undefined : view.full}>
      <span className={styles.cardLabel}>{label}:</span>
      {view.empty ? (
        <span className={styles.prosEmpty}>{view.full}</span>
      ) : (
        <>
          <span className="k-sr-only">{view.full}</span>
          <span aria-hidden className={styles.prosList}>
            {view.visible.map((v, i) => (
              <span key={`${v.name}-${i}`} className={styles.pro}>
                <span className={styles.ellipsis}>{v.name}</span>
                {v.assigned && <span className={styles.proAssigned}>a cargo</span>}
                {i === view.visible.length - 1 && view.extra > 0 && (
                  <span className={styles.proMore}>+{view.extra}</span>
                )}
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

/** Rótulo de «Estado» (D-CF2-14: sale de los turnos, no de la HC). Sin `activity` (fila vieja), la vista manda. */
function StateTag({ activity, archived }: { activity: PatientRow["activity"]; archived: boolean }) {
  const a = activity ?? (archived ? "archived" : null);
  if (a === "active") return <Tag tone="lime">Activo</Tag>;
  if (a === "inactive") return <Tag tone="soft">Inactivo</Tag>;
  if (a === "archived") return <Tag tone="soft">Archivado</Tag>;
  return <Tag tone="soft">—</Tag>;
}

/**
 * Filas del directorio (client boundary: checkbox de selección y acciones por fila).
 *
 * PF1.1 (C-PF1.2): la entrada escalonada es CSS (`.k-enter-fade` + `animation-delay` por fila): se ve sin JS y
 * `prefers-reduced-motion` la apaga. El `key` del contenedor (firma ordenada de ids) re-monta la lista al buscar,
 * filtrar u ordenar, así la entrada se repite.
 *
 * CF2 (§29): mismas columnas para todos los roles y verticales (`patientsGridColumns()`); «Plan activo» salió
 * (decisión 3 de Martin) y entró la columna de profesionales (decisión 2). «Estado» y «Última visita» salen de los
 * turnos (D-CF2-14/15): los ve también la Secretaria (fila `admin`); la fila `basic` muestra «—» en los dos.
 * `practitionerNames` = id → nombre de TODOS los profesionales del consultorio (`listPractitionerNames()` en la página).
 */
export function PatientsList({
  rows,
  archived,
  practitionerNames,
}: {
  rows: PatientRow[];
  archived: boolean;
  practitionerNames: Readonly<Record<string, string>>;
}) {
  const signature = rows.map((r) => r.id).join(",");
  const prosLabel = practitionerColumnLabel(useTenantModules().vertical);
  const cols: React.CSSProperties = { gridTemplateColumns: patientsGridColumns() };

  return (
    <div key={signature}>
      {rows.map((p, i) => {
        const fullName = `${p.firstName} ${p.lastName}`;
        const isBasic = p.access === "basic";
        // T3c-1b (§23.5): las acciones que mutan la ficha (selección masiva, archivar: exigen `full` en el server) van
        // con `=== "full"`. Una fila `admin` (Secretaria, Admin, Facturación) muestra contacto, obra social, estado y
        // última visita (CF2: datos de turnos, no HC), pero no archiva.
        const isFull = p.access === "full";
        // CF2: el tono lima del avatar acompaña a «Activo» (antes era «tiene plan»); el texto del estado es el canal
        // principal, el color solo lo refuerza (AGENTS §5).
        const tone: "sky" | "lime" = !isBasic && p.activity === "active" ? "lime" : "sky";
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
              {isFull ? <BulkSelectCheckbox patientId={p.id} /> : <span />}
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
              {/* D-CF2-15: con acceso básico «Última visita» va oculta. */}
              {!isBasic && p.lastVisit
                ? p.lastVisit.toLocaleDateString("es-AR", {
                    day: "2-digit",
                    month: "short",
                    timeZone: "America/Argentina/Buenos_Aires",
                  })
                : "—"}
            </div>
            <PractitionersCell row={p} names={practitionerNames} label={prosLabel} />
            <div className={styles.cellState} style={{ display: "flex", justifyContent: "flex-end" }}>
              {isBasic ? <Tag tone="soft">—</Tag> : <StateTag activity={p.activity} archived={archived} />}
            </div>
            {!isFull ? (
              <span className={styles.cellActions} />
            ) : (
              // S32a (handoff): el diálogo de archivar nombra al paciente.
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

