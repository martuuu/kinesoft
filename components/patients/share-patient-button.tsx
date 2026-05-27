"use client";

/**
 * Inline "Compartir" popover for the patient hero. Lists the
 * practitioners of the consultorio (except the current owner), with
 * checkboxes pre-checked for those already shared into the HC. Submits
 * the diff via `setPatientShares` server action.
 *
 * Visible to the patient's owner and to OWNER/ADMIN. PRACTITIONER who
 * is neither sees nothing (the basic view doesn't include this button).
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { IconCheck, IconX } from "@/components/ui/icons";
import {
  setPatientShares,
  getPatientShareList,
} from "@/lib/patients";

type PractitionerOption = { id: string; name: string };

export function SharePatientButton({
  patientId,
  ownerPractitionerId,
  practitioners,
}: {
  patientId: string;
  /** The patient's `assignedPractitionerId` — excluded from the picker. */
  ownerPractitionerId: string | null;
  /** Every practitioner in the tenant (the popover filters out the owner). */
  practitioners: PractitionerOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialised, setInitialised] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Lazy-load the current share set the first time the popover opens.
  useEffect(() => {
    if (open && !initialised) {
      getPatientShareList(patientId).then((ids) => {
        setSelected(new Set(ids));
        setInitialised(true);
      });
    }
  }, [open, initialised, patientId]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  };

  const save = () => {
    setError(null);
    setSaved(false);
    start(async () => {
      const r = await setPatientShares({
        patientId,
        practitionerIds: Array.from(selected),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSaved(true);
      // Auto-close after a moment so the user sees the confirmation.
      setTimeout(() => setOpen(false), 800);
    });
  };

  const shareablePractitioners = practitioners.filter(
    (p) => p.id !== ownerPractitionerId
  );

  if (shareablePractitioners.length === 0) {
    // Solo consultorio — no one else to share with.
    return null;
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ fontSize: 12.5 }}
      >
        Compartir
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Compartir paciente"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 280,
            background: "rgba(255,255,255,0.98)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(15,30,51,0.1)",
            borderRadius: 14,
            boxShadow: "0 20px 40px -12px rgba(15,30,51,0.18)",
            padding: 14,
            zIndex: 50,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-300)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
            Compartir con
          </div>
          <p style={{ fontSize: 11.5, color: "var(--navy-500)", margin: "0 0 12px", lineHeight: 1.4 }}>
            Los kinesiólogos marcados podrán ver la historia clínica completa
            mientras esté activo el permiso.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflow: "auto" }}>
            {!initialised ? (
              <div style={{ fontSize: 12, color: "var(--navy-300)", padding: "8px 4px" }}>Cargando…</div>
            ) : (
              shareablePractitioners.map((p) => {
                const on = selected.has(p.id);
                return (
                  <label
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 6px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background: on ? "rgba(200,245,100,0.15)" : "transparent",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 6,
                        border: on ? "none" : "1.5px solid rgba(15,30,51,0.2)",
                        background: on ? "var(--sky-700)" : "transparent",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        flexShrink: 0,
                      }}
                    >
                      {on && <IconCheck size={12} stroke={3} />}
                    </span>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(p.id)}
                      style={{ display: "none" }}
                    />
                    <span style={{ fontSize: 13, color: "var(--navy-900)" }}>{p.name}</span>
                  </label>
                );
              })
            )}
          </div>
          {error && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 11.5 }}>
              {error}
            </div>
          )}
          {saved && (
            <div style={{ marginTop: 10, padding: 8, borderRadius: 8, background: "rgba(200,245,100,0.2)", color: "var(--navy-900)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 6 }}>
              <IconCheck size={12} stroke={3} /> Permisos actualizados
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--navy-500)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                padding: "8px 4px",
              }}
            >
              <IconX size={11} /> Cancelar
            </button>
            <Button
              type="button"
              variant="primary"
              onClick={save}
              disabled={pending || !initialised}
              style={{ fontSize: 12, padding: "8px 14px" }}
            >
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
