"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setPatientArchived } from "@/lib/patients";
import { useToast } from "@/components/ui/toast";

/**
 * Per-row "⋯" menu for the Pacientes directory.
 * Archive / unarchive is the only action right now — other power
 * actions (export PDF, send portal invite) plug in here.
 */
export function PatientRowActions({
  patientId,
  archived,
}: {
  patientId: string;
  archived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
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
        style={{
          width: 28,
          height: 28,
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
    </div>
  );
}
