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
import { EmptyBox, FieldLabel, StepHeader } from "./shared";
import s from "../public-booking.module.css";

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
        <div role="group" aria-labelledby="booking-location-label">
          <FieldLabel>
            <span id="booking-location-label">¿En qué sede?</span>
          </FieldLabel>
          <div className={s.grid2}>
            <button
              type="button"
              aria-pressed={filters.locationId === null}
              onClick={() => onFiltersChange({ ...filters, locationId: null })}
              className={s.choice}
            >
              <div className={s.choiceTitle}>Me da igual</div>
              <div className={s.choiceSub}>Cualquier sede</div>
            </button>
            {clinicLocations(clinic).map((l) => {
              const addr = formatLocationAddress(l);
              return (
                <button
                  key={l.id}
                  type="button"
                  aria-pressed={filters.locationId === l.id}
                  onClick={() => onFiltersChange({ ...filters, locationId: l.id })}
                  className={s.choice}
                >
                  <div className={s.choiceTitle}>{l.name}</div>
                  {addr && <div className={s.choiceSub}>{addr}</div>}
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
            className={`k-input ${s.select}`}
            aria-describedby="booking-coverage-help"
            value={filters.insurerId ?? ""}
            onChange={(e) => onFiltersChange({ ...filters, insurerId: e.target.value || null })}
          >
            <option value="">Prefiero no decirlo</option>
            {coverages.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
          <p id="booking-coverage-help" className={s.help}>
            Te mostramos solo los profesionales que la aceptan.
          </p>
        </div>
      )}

      {pros.length === 0 ? (
        <EmptyBox>
          {filtered
            ? "Ningún profesional coincide con esa sede o cobertura. Probá con otra opción."
            : "Por ahora no hay profesionales con turnos online."}
        </EmptyBox>
      ) : (
        <div className={s.grid2}>
          {pros.length > 1 && (
            <button
              type="button"
              aria-pressed={mode === "any"}
              onClick={onAny}
              className={`${s.choice} ${s.wide}`}
            >
              <div className={s.choiceTitle}>
                <IconClock size={14} /> Primer turno disponible
              </div>
              <div className={s.choiceSub}>Con cualquier profesional. Te mostramos con quién antes de confirmar.</div>
            </button>
          )}
          {pros.map((p) => {
            const line = [p.specialty ?? specialtyFallback, p.licenseNumber ? `MN ${p.licenseNumber}` : null]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={mode === "pick" && p.id === value}
                onClick={() => onPick(p.id)}
                className={s.choice}
              >
                <div className={s.choiceTitle}>{p.name}</div>
                {line && <div className={s.choiceSub}>{line}</div>}
                {p.yearsExp != null && <div className={s.choiceMeta}>{p.yearsExp} años de experiencia</div>}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
