"use client";

/**
 * Collapsible "Filtros avanzados" panel for /pacientes. Submits via
 * URL query params (GET) so the result is SSR + shareable. Uses native
 * inputs (no dual-slider dependency) — two numeric fields for the age
 * range cover the use case with less surface area.
 */
import { useState } from "react";

type ConditionOption = { slug: string; name: string };

export function AdvancedPatientFilters({
  conditions,
  preservedParams,
  current,
}: {
  conditions: ConditionOption[];
  /** Hidden inputs to preserve (q, filter, sort, insurer). */
  preservedParams: Record<string, string | undefined>;
  current: {
    ageMin?: string;
    ageMax?: string;
    diagnosisSlug?: string;
    lastVisitFrom?: string;
    lastVisitTo?: string;
  };
}) {
  const initialOpen =
    !!(current.ageMin || current.ageMax || current.diagnosisSlug || current.lastVisitFrom || current.lastVisitTo);
  const [open, setOpen] = useState(initialOpen);
  const activeCount =
    (current.ageMin ? 1 : 0) +
    (current.ageMax ? 1 : 0) +
    (current.diagnosisSlug ? 1 : 0) +
    (current.lastVisitFrom ? 1 : 0) +
    (current.lastVisitTo ? 1 : 0);

  return (
    <div style={{ width: "100%" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          padding: "6px 12px",
          borderRadius: 999,
          fontSize: 11.5,
          fontWeight: 600,
          background: activeCount > 0 ? "var(--lime-300)" : "rgba(255,255,255,0.7)",
          color: "var(--navy-900)",
          border: "1px solid rgba(15,30,51,0.08)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transition: "transform 160ms ease",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          ›
        </span>
        Filtros avanzados
        {activeCount > 0 && (
          <span
            style={{
              padding: "1px 6px",
              borderRadius: 999,
              background: "var(--navy-900)",
              color: "#fff",
              fontSize: 10,
            }}
          >
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <form
          action="/pacientes"
          method="get"
          style={{
            marginTop: 10,
            padding: 14,
            borderRadius: 14,
            background: "rgba(255,255,255,0.7)",
            border: "1px solid rgba(15,30,51,0.08)",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            alignItems: "end",
          }}
        >
          {/* Preserve existing search/sort/etc. params */}
          {Object.entries(preservedParams).map(([k, v]) =>
            v ? <input key={k} type="hidden" name={k} value={v} /> : null
          )}

          <Field label="Edad mínima">
            <input
              type="number"
              name="ageMin"
              min={0}
              max={120}
              defaultValue={current.ageMin ?? ""}
              placeholder="—"
              style={inputStyle}
            />
          </Field>
          <Field label="Edad máxima">
            <input
              type="number"
              name="ageMax"
              min={0}
              max={120}
              defaultValue={current.ageMax ?? ""}
              placeholder="—"
              style={inputStyle}
            />
          </Field>

          <Field label="Último diagnóstico">
            <select name="diagnosisSlug" defaultValue={current.diagnosisSlug ?? ""} style={inputStyle}>
              <option value="">Cualquiera</option>
              {conditions.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Última visita desde">
            <input
              type="date"
              name="lastVisitFrom"
              defaultValue={current.lastVisitFrom ?? ""}
              style={inputStyle}
            />
          </Field>
          <Field label="Última visita hasta">
            <input
              type="date"
              name="lastVisitTo"
              defaultValue={current.lastVisitTo ?? ""}
              style={inputStyle}
            />
          </Field>

          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", gridColumn: "1 / -1" }}>
            <a
              href={`/pacientes${makeResetQs(preservedParams)}`}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "transparent",
                color: "var(--navy-500)",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Limpiar
            </a>
            <button
              type="submit"
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "var(--sky-700)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
              }}
            >
              Aplicar filtros
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", fontSize: 11 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(15,30,51,0.1)",
  background: "#fff",
  width: "100%",
  fontSize: 13,
  color: "var(--navy-900)",
  outline: "none",
  boxSizing: "border-box",
};

function makeResetQs(preserved: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(preserved)) {
    if (v) sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
