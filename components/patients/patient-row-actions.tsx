"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setPatientArchived } from "@/lib/patients";
import { useToast } from "@/components/ui/toast";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import {
  ArchivePatientDialog,
  shouldAskArchivePlans,
  type ArchivePatientResult,
} from "@/components/patients/archive-patient-dialog";
import type { PatientArchivePlansAction } from "@/lib/plans-lifecycle-state";
import styles from "./patients-directory.module.css";

/**
 * S32a (ES4): ¿«Archivar paciente» desde la fila pasa por la pregunta L9?
 * Antes la fila llamaba a `setPatientArchived` sin `plansAction` y el server
 * pausaba los planes sin preguntar (AUDIT `archivar-paciente-lista-sin-L9`).
 * La fila no trae los planes vivos (`PatientRow.activeProgramTitle` solo ve el
 * ACTIVE, no los PAUSED), así que `livePlanCount` llega `null` y con el módulo
 * `planes` se pregunta siempre: es más barato preguntar de más.
 */
export function rowArchiveStep(input: {
  archived: boolean;
  plansEnabled: boolean;
  livePlanCount: number | null;
}): "ask-plans" | "direct" {
  if (input.archived) return "direct";
  return shouldAskArchivePlans(input) ? "ask-plans" : "direct";
}

/** La action que dispara el diálogo L9 de la fila (single, como el hero). */
export async function archiveRowWithPlans(
  patientId: string,
  plansAction: PatientArchivePlansAction,
): Promise<ArchivePatientResult> {
  const r = await setPatientArchived({ id: patientId, archived: true, plansAction });
  if (!r.ok) return { ok: false, error: r.error };
  // PF-0d: sin `router.refresh()`; la action revalida "/pacientes".
  return { ok: true };
}

/**
 * Per-row "⋯" menu for the Pacientes directory.
 * Archive / unarchive is the only action right now — other power
 * actions (export PDF, send portal invite) plug in here.
 */
export function PatientRowActions({
  patientId,
  archived,
  patientName,
  livePlanCount = null,
}: {
  patientId: string;
  archived: boolean;
  /** Para el título del diálogo L9; sin él dice «El paciente». */
  patientName?: string;
  /** Planes vivos si el caller los conoce; `null` = no se sabe → se pregunta. */
  livePlanCount?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [askPlans, setAskPlans] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  const plansEnabled = useTenantModules().has("planes");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen(false);
    if (rowArchiveStep({ archived, plansEnabled, livePlanCount }) === "ask-plans") {
      setAskPlans(true);
      return;
    }
    start(async () => {
      const r = await setPatientArchived({ id: patientId, archived: !archived });
      // Antes se ignoraba el resultado: un rechazo (acceso básico, paciente
      // ajeno) no mostraba nada. El menú ya no se renderiza para filas de
      // acceso básico (patients-list), esto cubre el resto.
      if (!r.ok) {
        toast.error(archived ? "No pudimos reactivar el paciente" : "No pudimos archivar el paciente", {
          description: r.error,
        });
        return;
      }
      toast.success(archived ? "Paciente reactivado" : "Paciente archivado");
      // PF-0d: sin `router.refresh()`. `setPatientArchived` hace
      // `revalidatePath("/pacientes")` en el OK y la respuesta de la action ya
      // trae la lista nueva (el refresh era un segundo render, +139 ms).
    });
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", justifyContent: "flex-end" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Acciones"
        // MB-1d: 28 px en la tabla, 44 en la card < 768: el tamaño va por clase (un `width` inline no se pisa).
        className={styles.rowMenuBtn}
        style={{
          borderRadius: 8,
          border: "none",
          background: open ? "rgba(31,79,190,0.1)" : "transparent",
          color: "var(--navy-500)",
          cursor: "pointer",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 30,
            right: 0,
            width: 200,
            borderRadius: 12,
            padding: 4,
            zIndex: 25,
          }}
        >
          <button
            type="button"
            onClick={toggle}
            disabled={pending}
            style={{
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 500,
              color: archived ? "var(--sky-700)" : "var(--navy-700)",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {archived ? "Reactivar paciente" : "Archivar paciente"}
          </button>
        </div>
      )}
      {/* Montado solo abierto: cada apertura arranca limpia (default pausar). PF1.1: sin `createPortal` propio; el
          `Modal` ya va por portal a body desde PF1.0-b (C-PF6) y la fila dejó de ser un `motion.div` con transform. */}
      {askPlans ? (
        <ArchivePatientDialog
          open
          onClose={() => setAskPlans(false)}
          patientName={patientName}
          livePlanCount={livePlanCount}
          onConfirm={async (plansAction) => {
            const r = await archiveRowWithPlans(patientId, plansAction);
            if (r.ok) toast.success("Paciente archivado");
            return r;
          }}
        />
      ) : null}
    </div>
  );
}
