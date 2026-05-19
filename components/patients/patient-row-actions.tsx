"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setPatientArchived } from "@/lib/patients";

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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
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
      await setPatientArchived({ id: patientId, archived: !archived });
      router.refresh();
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
