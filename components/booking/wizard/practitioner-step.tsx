/**
 * Paso "Profesional" del turnero público (B5.6): filtros opcionales de sede
 * y cobertura arriba, "Primer turno disponible" y la lista de profesionales
 * que pasan los filtros. La lógica de filtrado vive en
 * `lib/public-wizard-state.ts` (testeada); acá solo se pinta.
 *
 * Cobertura: solo filtra profesionales (`acceptedInsurerIds`). NUNCA muestra
 * montos de copago: en el turnero público no hay contexto para explicarlos.
 */
import type { PublicClinic } from "@/lib/public-booking-types";
import type { TenantVertical } from "@prisma/client";
import {
  coverageOptions,
  filterPractitioners,
  formatLocationAddress,
  hasMultipleLocations,
  clinicLocations,
  type WizardFilters,
} from "@/lib/public-wizard-state";
import { IconClock } from "@/components/ui/icons";
import { EmptyBox, FieldLabel, StepHeader, choiceStyle } from "./shared";

export function PractitionerStep({
  clinic,
  filters,
  onFiltersChange,
  mode,
  value,
  onPick,
  onAny,
}: {
  /** `vertical` opcional (EV1-C2): sin ella, el copy de Kinesiología de siempre. */
  clinic: PublicClinic & { vertical?: TenantVertical | null };
  filters: WizardFilters;
  onFiltersChange: (next: WizardFilters) => void;
  mode: "pick" | "any";
  value: string | null;
  onPick: (id: string) => void;
  onAny: () => void;
}) {
  const multiLoc = hasMultipleLocations(clinic);
  const coverages = coverageOptions(clinic);
  const pros = filterPractitioners(clinic, filters);
  const filtered = filters.insurerId !== null || filters.locationId !== null;
  // EV1-C2: sin especialidad cargada, Kine mostraba «Kinesiología»; en Clínica
  // general eso es falso, así que ahí no se muestra nada (solo la matrícula, si hay).
  const specialtyFallback = clinic.vertical === "GENERAL" ? null : "Kinesiología";

  return (
    <>
      <StepHeader title="¿Con quién querés atenderte?" subtitle="Elegí un profesional o el primer turno libre." />

      {multiLoc && (
        <div role="group" aria-label="Sede">
          <FieldLabel>¿En qué sede?</FieldLabel>
          <div className="booking-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button
              type="button"
              aria-pressed={filters.locationId === null}
              onClick={() => onFiltersChange({ ...filters, locationId: null })}
              style={choiceStyle(filters.locationId === null)}
            >
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>Me da igual</div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>Cualquier sede</div>
            </button>
            {clinicLocations(clinic).map((l) => {
              const on = filters.locationId === l.id;
              const addr = formatLocationAddress(l);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onFiltersChange({ ...filters, locationId: l.id })}
                  style={choiceStyle(on)}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 700 }}>{l.name}</div>
                  {addr && <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{addr}</div>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {coverages.length > 0 && (
        <div>
          <FieldLabel htmlFor="booking-coverage">¿Con qué cobertura venís? (opcional)</FieldLabel>
          <select
            id="booking-coverage"
            value={filters.insurerId ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, insurerId: e.target.value || null })}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(15,30,51,0.08)",
              width: "100%",
              fontSize: 14,
              color: "var(--navy-900)",
              fontFamily: "inherit",
              minHeight: 44,
            }}
          >
            <option value="">Prefiero no decirlo</option>
            {coverages.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 4 }}>
            Te mostramos solo los profesionales que la aceptan.
          </div>
        </div>
      )}

      {pros.length === 0 ? (
        <EmptyBox>
          {filtered
            ? "Ningún profesional coincide con esa sede o cobertura. Probá con otra opción."
            : "Por ahora no hay profesionales con turnos online."}
        </EmptyBox>
      ) : (
        <div className="booking-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {pros.length > 1 && (
            <button
              type="button"
              aria-pressed={mode === "any"}
              onClick={onAny}
              style={{ ...choiceStyle(mode === "any"), gridColumn: "1 / -1" }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                <IconClock size={14} /> Primer turno disponible
              </div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                Con cualquier profesional. Te mostramos con quién antes de confirmar.
              </div>
            </button>
          )}
          {pros.map((p) => {
            const on = mode === "pick" && p.id === value;
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => onPick(p.id)}
                style={choiceStyle(on)}
              >
                <div style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</div>
                {(() => {
                  const line = [p.specialty ?? specialtyFallback, p.licenseNumber ? `MN ${p.licenseNumber}` : null]
                    .filter(Boolean)
                    .join(" · ");
                  return line ? <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{line}</div> : null;
                })()}
                {p.yearsExp != null && (
                  <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}>
                    {p.yearsExp} años de experiencia
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
