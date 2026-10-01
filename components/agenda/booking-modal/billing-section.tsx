"use client";

/**
 * Cobertura + copago del paciente seleccionado (editable), con la leyenda de
 * dónde sale el monto sugerido. Solo pinta: el estado vive en
 * `use-patient-billing.ts`. La precedencia del copago la decide el server
 * (`lib/copago.ts`, AUDIT §5.5); acá solo se muestra el preview.
 */
import { CopagoRow } from "../controls";
import type { BillingPreview } from "./types";

/** De dónde sale el copago que se pre-carga (se muestra junto al monto). */
const BILLING_SOURCE_LABEL: Record<BillingPreview["source"], string> = {
  OS: "copago de la obra social",
  "copago propio": "copago propio del paciente",
  Particular: "tarifa particular del consultorio",
  "precio del servicio": "precio del servicio",
};

export function BillingSection({
  isGuest,
  hasPatient,
  billing,
  copagoLoading,
  copagoInput,
  onCopagoInput,
  updateDefaultCopago,
  setUpdateDefaultCopago,
  serviceId,
}: {
  isGuest: boolean;
  /** Hay un paciente existente elegido en el picker. */
  hasPatient: boolean;
  billing: BillingPreview | null;
  copagoLoading: boolean;
  /** Monto en centavos. */
  copagoInput: number;
  onCopagoInput: (cents: number) => void;
  updateDefaultCopago: boolean;
  setUpdateDefaultCopago: (v: boolean) => void;
  /** Para la aclaración "elegí el servicio para ver su precio". */
  serviceId: string;
}) {
  if (!(!isGuest && hasPatient && (billing || copagoLoading))) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <CopagoRow
        obraSocial={billing?.obraSocial ?? "—"}
        original={billing?.copagoCents ?? 0}
        valueCents={copagoInput}
        onValueCents={onCopagoInput}
        updateDefault={updateDefaultCopago}
        setUpdateDefault={setUpdateDefaultCopago}
        loading={copagoLoading}
      />
      {billing && !copagoLoading && (
        <div style={{ fontSize: 11, color: "var(--navy-500)", paddingLeft: 4 }}>
          Monto sugerido según {BILLING_SOURCE_LABEL[billing.source]}
          {!serviceId && billing.source === "precio del servicio"
            ? " (elegí el servicio para ver su precio)"
            : ""}
          .
        </div>
      )}
    </div>
  );
}
