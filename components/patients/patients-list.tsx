"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { BulkSelectCheckbox } from "@/components/patients/bulk-select";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { staggerList, staggerItem } from "@/lib/motion";
import type { PatientRow } from "@/lib/patients-types";

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
        // Basic rows: muted styling, no plan info, no insurer line,
        // no archive action (the row's owner controls that), no
        // bulk-select (those mutate PHI).
        const tone: "sky" | "lime" | "navy" = isBasic
          ? "sky"
          : p.activeProgramTitle
            ? "lime"
            : "sky";
        return (
          <motion.div
            key={p.id}
            variants={staggerItem}
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
                      timeZone: "America/Argentina/Buenos_Aires",
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
              <PatientRowActions patientId={p.id} archived={archived} />
            )}
          </motion.div>
        );
      })}
    </motion.div>
  );
}
