"use client";

/**
 * Patient picker — debounced server-side search + dropdown + inline
 * create.
 *
 * The inline-create flow expands into a small two-field form (nombre /
 * apellido) instead of guessing from a single string. Schema already
 * separates the fields, and "García López, Juan" / "Juan García López"
 * are ambiguous to a naive split — explicit fields let the kine fix it.
 *
 * Extracted from agenda-client.tsx in Sprint 18 so the BookingDrawer
 * edit flow can reuse it (swap patient on an existing booking).
 */
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { searchPatientsForAssignment } from "@/lib/diagnosis";
import { createPatient } from "@/lib/patients";

export type PickedPatient = { id: string; name: string };

/**
 * Smart guess from a free-text query. Disambiguates two common
 * patterns:
 *
 *   - "Apellido, Nombre"     → lastName = "Apellido", firstName = "Nombre"
 *   - "Nombre Apellido(s)"   → firstName = first word, lastName = rest
 *   - "SoloNombre"           → firstName = it, lastName = ""
 *
 * Used to pre-populate the inline-create mini-form. The kine can edit
 * before submitting — the function is a best-effort guess, not the
 * source of truth.
 */
export function parseNameQuery(raw: string): { firstName: string; lastName: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  // "Apellido, Nombre" pattern — explicit separator wins.
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx > 0) {
    return {
      firstName: trimmed.slice(commaIdx + 1).trim(),
      lastName: trimmed.slice(0, commaIdx).trim(),
    };
  }
  // Fall back to "first token is given name, rest is surname".
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

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
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<{ id: string; name: string; hc: string }[]>([]);
  const [selected, setSelected] = useState<PickedPatient | null>(() => {
    if (!initialPatientId) return null;
    const found = initialPatients?.find((p) => p.id === initialPatientId);
    return found ? { id: found.id, name: found.name } : null;
  });
  // Inline-create state: when `creating` is true the dropdown shows
  // the two-field mini-form instead of the search hits.
  const [creating, setCreating] = useState(false);
  const [cFirst, setCFirst] = useState("");
  const [cLast, setCLast] = useState("");
  const [cPending, setCPending] = useState(false);
  const [cErr, setCErr] = useState<string | null>(null);

  const seqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open || creating) return;
    const term = q.trim();
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      const r = await searchPatientsForAssignment(term);
      if (seq !== seqRef.current) return;
      setHits(r.map((p) => ({ id: p.id, name: p.name, hc: p.hc ?? "" })));
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, creating]);

  const pick = (p: PickedPatient) => {
    setSelected(p);
    setOpen(false);
    setCreating(false);
    setQ("");
    onChange?.(p);
  };

  const clear = () => {
    setSelected(null);
    setOpen(true);
    setQ("");
    onChange?.(null);
  };

  const startCreate = () => {
    const guess = parseNameQuery(q);
    setCFirst(guess.firstName);
    setCLast(guess.lastName);
    setCErr(null);
    setCreating(true);
  };

  const cancelCreate = () => {
    setCreating(false);
    setCErr(null);
  };

  const submitCreate = async () => {
    const first = cFirst.trim();
    const last = cLast.trim();
    if (first.length < 2) {
      setCErr("El nombre debe tener al menos 2 caracteres.");
      return;
    }
    if (last.length < 1) {
      setCErr("Cargá el apellido.");
      return;
    }
    setCErr(null);
    setCPending(true);
    const r = await createPatient({ firstName: first, lastName: last });
    setCPending(false);
    if (!r.ok) {
      setCErr(r.error);
      return;
    }
    pick({ id: r.data.id, name: `${first} ${last}` });
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <label style={{ display: "block", fontSize: 12 }}>
        <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>{label ?? "Paciente"}</span>
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
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setCreating(false);
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
          {creating ? (
            <InlineCreateForm
              firstName={cFirst}
              lastName={cLast}
              onFirstNameChange={setCFirst}
              onLastNameChange={setCLast}
              onSubmit={submitCreate}
              onCancel={cancelCreate}
              pending={cPending}
              error={cErr}
            />
          ) : hits.length === 0 ? (
            q.trim() ? (
              <div style={{ padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  No encontramos a <strong>{q.trim()}</strong>.
                </div>
                <button
                  type="button"
                  onClick={startCreate}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid var(--sky-700)",
                    background: "var(--sky-700)",
                    color: "#fff",
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  + Crear paciente nuevo
                </button>
                <div style={{ fontSize: 10.5, color: "var(--navy-300)", lineHeight: 1.4 }}>
                  Si es una reserva externa (sin historia clínica),
                  completá los campos de guest abajo en el formulario
                  principal.
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

function InlineCreateForm({
  firstName,
  lastName,
  onFirstNameChange,
  onLastNameChange,
  onSubmit,
  onCancel,
  pending,
  error,
}: {
  firstName: string;
  lastName: string;
  onFirstNameChange: (v: string) => void;
  onLastNameChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  return (
    <div
      style={{
        padding: 12,
        display: "grid",
        gap: 10,
        background: "rgba(31,79,190,0.04)",
        borderRadius: 10,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
        Crear paciente nuevo
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <label style={{ display: "block", fontSize: 11 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Nombre</span>
          <input
            type="text"
            value={firstName}
            onChange={(e) => onFirstNameChange(e.target.value)}
            placeholder="Lucas"
            autoFocus
            style={fieldStyle}
          />
        </label>
        <label style={{ display: "block", fontSize: 11 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Apellido</span>
          <input
            type="text"
            value={lastName}
            onChange={(e) => onLastNameChange(e.target.value)}
            placeholder="Mertian"
            style={fieldStyle}
          />
        </label>
      </div>
      {error && (
        <div style={{ fontSize: 11, color: "#9F1F1F" }}>{error}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: "transparent",
            color: "var(--navy-500)",
            border: "1px solid rgba(15,30,51,0.1)",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending}
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            background: "var(--sky-700)",
            color: "#fff",
            border: "none",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {pending ? "Creando…" : "Crear y seleccionar"}
        </button>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--navy-300)", lineHeight: 1.4 }}>
        Más datos (DNI, email, etc.) los podés cargar después desde la
        historia clínica.
      </div>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 8,
  background: "#fff",
  border: "1px solid rgba(15,30,51,0.12)",
  fontSize: 13,
  width: "100%",
  boxSizing: "border-box",
  outline: "none",
};
