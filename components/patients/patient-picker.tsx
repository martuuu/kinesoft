"use client";

/**
 * Patient picker — debounced server-side search + dropdown.
 *
 * Search-and-select only. Creating a brand-new patient lives in the
 * booking modal's "Nuevo paciente" switch (firstName + lastName + DNI +
 * phone), not here — keeping this component a pure selector so the
 * BookingDrawer edit flow can reuse it to swap a booking's patient.
 */
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { searchPatientsForAssignment } from "@/lib/diagnosis";

export type PickedPatient = { id: string; name: string };

export function PatientPicker({
  name,
  initialPatientId,
  initialPatients,
  onChange,
  /** Optional label override — defaults to "Paciente". */
  label,
}: {
  /** Hidden input name used when the picker lives inside a form. */
  name?: string;
  initialPatientId?: string | null;
  initialPatients?: PickedPatient[];
  /** Notification on selection change. Use this when consuming the
   *  selected id without a surrounding form (BookingDrawer edit). */
  onChange?: (patient: PickedPatient | null) => void;
  /** Pass null to suppress the label entirely (when the parent renders its own). */
  label?: string | null;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<{ id: string; name: string; hc: string }[]>([]);
  const [selected, setSelected] = useState<PickedPatient | null>(() => {
    if (!initialPatientId) return null;
    const found = initialPatients?.find((p) => p.id === initialPatientId);
    return found ? { id: found.id, name: found.name } : null;
  });

  const seqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      const r = await searchPatientsForAssignment(term);
      if (seq !== seqRef.current) return;
      setHits(r.map((p) => ({ id: p.id, name: p.name, hc: p.hc ?? "" })));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open]);

  const pick = (p: PickedPatient) => {
    setSelected(p);
    setOpen(false);
    setQ("");
    onChange?.(p);
  };

  const clear = () => {
    setSelected(null);
    setOpen(true);
    setQ("");
    onChange?.(null);
  };

  const showLabel = label !== null;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <label style={{ display: "block", fontSize: 12 }}>
        {showLabel && <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>{label ?? "Paciente"}</span>}
        {name && <input type="hidden" name={name} value={selected?.id ?? ""} />}
        {selected ? (
          <div
            style={{
              marginTop: 6,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(15,30,51,0.08)",
              background: "rgba(255,255,255,0.9)",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <Avatar name={selected.name} size={28} tone="sky" />
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{selected.name}</span>
            <button
              type="button"
              onClick={clear}
              aria-label="Cambiar paciente"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--navy-500)",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Cambiar
            </button>
          </div>
        ) : (
          <input
            type="text"
            placeholder="Buscá por nombre, DNI o email…"
            value={q}
            // Kill the browser's own autofill so it doesn't cover our DB
            // typeahead. Chrome IGNORES autoComplete="off" on fields it heuristically
            // reads as name/email (the placeholder says "email"), so we mark it
            // "new-password" — the one token Chrome reliably won't autofill (and on a
            // text input it never triggers the save-password UI). ARIA combobox +
            // the password-manager opt-outs cover 1Password/LastPass/Dashlane too.
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            style={{
              marginTop: 6,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.95)",
              border: "1px solid rgba(15,30,51,0.08)",
              width: "100%",
              fontSize: 14,
              color: "var(--navy-900)",
              outline: "none",
            }}
          />
        )}
      </label>

      {open && !selected && (
        <div
          className="k-glass-strong k-scroll"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: 12,
            padding: 4,
            zIndex: 30,
            boxShadow: "0 10px 32px rgba(15,30,51,0.18)",
            background: "rgba(255,255,255,0.98)",
          }}
        >
          {hits.length === 0 ? (
            q.trim() ? (
              <div style={{ padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  No encontramos a <strong>{q.trim()}</strong>.
                </div>
                <div style={{ fontSize: 10.5, color: "var(--navy-300)", lineHeight: 1.4 }}>
                  Si es un paciente nuevo, activá el switch
                  <strong> “Nuevo paciente”</strong> arriba para registrarlo.
                </div>
              </div>
            ) : (
              <div style={{ padding: 14, fontSize: 12.5, color: "var(--navy-500)", textAlign: "center" }}>
                Empezá a tipear el nombre del paciente.
              </div>
            )
          ) : (
            hits.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => pick(p)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "8px 10px",
                  background: "transparent",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 13,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(15,30,51,0.04)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Avatar name={p.name} size={28} tone="sky" />
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                {p.hc && <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>{p.hc}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
