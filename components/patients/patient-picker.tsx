"use client";

/**
 * Patient picker — debounced server-side search + dropdown.
 *
 * Search-and-select only. Creating a brand-new patient lives in the
 * booking modal's "Nuevo paciente" switch (firstName + lastName + DNI +
 * phone), not here — keeping this component a pure selector so the
 * BookingDrawer edit flow can reuse it to swap a booking's patient.
 *
 * P2-FX1: `source` elige la búsqueda. Antes era siempre
 * `searchPatientsForAssignment` (Plan Builder: solo `full` + módulo
 * `diagnostico`) y la Secretaria, un kine en básico o un consultorio GENERAL
 * no encontraban pacientes al dar un turno. El despacho vive en
 * `patient-picker-search.ts` (testeado contra la DB).
 *
 * S18s (ES3):
 *  - `requireFull` (C13: el editor de planes usa `PatientPicker requireFull`)
 *    es un alias de `source="assignment"`; default false, así el modal y el
 *    drawer de turnos siguen eligiendo pacientes básicos.
 *  - Teclado: ↑/↓ recorren la lista, Enter elige, Escape cierra
 *    (combobox + listbox con `aria-activedescendant`).
 *  - El `<label>` ya no envuelve el botón "Cambiar": un label con un botón
 *    adentro le reenvía cualquier click (tocar el nombre borraba la selección).
 */
import { useEffect, useId, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { searchForPicker, type PatientPickerSource } from "@/components/patients/patient-picker-search";
import pickerStyles from "./patients-directory.module.css";

export type PickedPatient = { id: string; name: string };

/** Búsqueda efectiva: `requireFull` fuerza la de asignación (solo `full`). */
export function patientPickerSourceOf(o: { source?: PatientPickerSource; requireFull?: boolean }): PatientPickerSource {
  return o.requireFull ? "assignment" : (o.source ?? "booking");
}

/** Índice activo tras una flecha (con vuelta). -1 = ninguno. */
export function nextPickerIndex(current: number, key: "ArrowDown" | "ArrowUp", length: number): number {
  if (length <= 0) return -1;
  if (key === "ArrowDown") return current < 0 || current >= length - 1 ? 0 : current + 1;
  return current <= 0 ? length - 1 : current - 1;
}

/** Texto cuando no hay resultados para un término (depende de la búsqueda). */
export function patientPickerEmptyHint(source: PatientPickerSource): string {
  return source === "assignment"
    ? "Para un plan solo aparecen pacientes con la historia clínica completa a tu alcance."
    : "Si es un paciente nuevo, activá el switch “Nuevo paciente” arriba para registrarlo.";
}

/**
 * PF1-Z-F1 (#7): ¿el blur del input cierra la lista? Sí si el foco se va a un elemento FUERA del combobox (salir
 * con Tab dejaba la lista abierta tapando el campo siguiente). Sin destino (`relatedTarget` null: click en la barra
 * de scroll de la lista, cambio de ventana) no: los clicks de afuera ya los cierra el `mousedown` global.
 */
export function pickerBlurCloses(wrap: Pick<Node, "contains"> | null, relatedTarget: Node | null): boolean {
  return !!relatedTarget && !wrap?.contains(relatedTarget);
}

export function PatientPicker({
  name,
  initialPatientId,
  initialPatients,
  onChange,
  /** Optional label override — defaults to "Paciente". */
  label,
  source,
  requireFull = false,
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
  /** "booking" (default, agenda): nombre + DNI, cualquier rol que opere
   *  turnos. "assignment" (Planes/Diagnóstico): solo pacientes con acceso
   *  `full` (`searchPatientsForAssignment({ requireFull: true })`). */
  source?: PatientPickerSource;
  /** C13 (editor de planes): solo pacientes con acceso `full`. Equivale a
   *  `source="assignment"`. Default false. */
  requireFull?: boolean;
}) {
  const effectiveSource = patientPickerSourceOf({ source, requireFull });
  const uid = useId().replace(/:/g, "");
  const inputId = `pp-${uid}-input`;
  const listId = `pp-${uid}-list`;
  const optionId = (i: number) => `pp-${uid}-opt-${i}`;
  const [active, setActive] = useState(-1);
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
      const r = await searchForPicker(effectiveSource, term);
      if (seq !== seqRef.current) return;
      setHits(r);
      setActive(-1);
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, effectiveSource]);

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
  const listOpen = open && !selected;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((i) => nextPickerIndex(i, e.key as "ArrowDown" | "ArrowUp", hits.length));
    } else if (e.key === "Enter") {
      // Dentro de un form, Enter sin opción activa no debe mandarlo.
      if (listOpen && active >= 0 && hits[active]) {
        e.preventDefault();
        pick(hits[active]);
      }
    } else if (e.key === "Escape" && open) {
      // Que el Escape cierre la lista y no el Drawer/Modal que la contiene.
      e.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ display: "block", fontSize: 12 }}>
        {showLabel && (
          <label htmlFor={selected ? undefined : inputId} style={{ fontWeight: 600, color: "var(--navy-500)" }}>
            {label ?? "Paciente"}
          </label>
        )}
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
              aria-label={`Cambiar paciente (${selected.name})`}
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
            id={inputId}
            type="text"
            // La búsqueda de la agenda no mira el email (P2-FX1: sería un
            // oráculo de un dato que el nivel basic no muestra).
            placeholder={effectiveSource === "booking" ? "Buscá por nombre o DNI…" : "Buscá por nombre, DNI o email…"}
            aria-label={showLabel ? undefined : "Buscar paciente"}
            value={q}
            // Kill the browser's own autofill so it doesn't cover our DB
            // typeahead. Chrome IGNORES autoComplete="off" on fields it heuristically
            // reads as name/email (the placeholder says "email"), so we mark it
            // "new-password" — the one token Chrome reliably won't autofill (and on a
            // text input it never triggers the save-password UI). ARIA combobox +
            // the password-manager opt-outs cover 1Password/LastPass/Dashlane too.
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listOpen}
            aria-controls={listId}
            aria-activedescendant={listOpen && active >= 0 && hits[active] ? optionId(active) : undefined}
            onKeyDown={onKeyDown}
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            // PF1.1 (C-PF5.4): foco visible por clase (antes se apagaba el contorno sin reemplazo).
            className={pickerStyles.field}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={(e) => {
              if (pickerBlurCloses(wrapRef.current, e.relatedTarget as Node | null)) {
                setOpen(false);
                setActive(-1);
              }
            }}
            style={{
              marginTop: 6,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.95)",
              border: "1px solid rgba(15,30,51,0.08)",
              width: "100%",
              fontSize: 14,
              color: "var(--navy-900)",
            }}
          />
        )}
      </div>

      {listOpen && (
        <div
          id={listId}
          role="listbox"
          aria-label="Pacientes encontrados"
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
              <div role="status" style={{ padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  No encontramos a <strong>{q.trim()}</strong>.
                </div>
                <div style={{ fontSize: 10.5, color: "var(--navy-300)", lineHeight: 1.4 }}>
                  {patientPickerEmptyHint(effectiveSource)}
                </div>
              </div>
            ) : (
              <div role="status" style={{ padding: 14, fontSize: 12.5, color: "var(--navy-500)", textAlign: "center" }}>
                Empezá a tipear el nombre del paciente.
              </div>
            )
          ) : (
            hits.map((p, i) => (
              <div
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                // El foco queda en el input (aria-activedescendant); el mouse
                // elige con mousedown para no perder el blur antes del click.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
                onMouseEnter={() => setActive(i)}
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
                  ...(i === active ? { background: "rgba(15,30,51,0.06)" } : null),
                }}
              >
                <Avatar name={p.name} size={28} tone="sky" />
                <span style={{ flex: 1, fontWeight: 600 }}>{p.name}</span>
                {p.hc && <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-300)" }}>{p.hc}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
