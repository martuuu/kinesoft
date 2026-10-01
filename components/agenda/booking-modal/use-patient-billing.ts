"use client";

/**
 * Estado de cobro del paciente elegido en el modal de turno nuevo: obra
 * social + copago pre-establecido, el monto editable y el prompt "actualizar
 * el copago del paciente". Extraído tal cual de `booking-modal.tsx` (B1.5a);
 * lo consume `index.tsx` y lo pinta `billing-section.tsx`.
 */
import { useEffect, useRef, useState } from "react";
import { getPatientBillingPreview } from "@/lib/patients";
import type { BillingPreview, PatientOption, PatientRef } from "./types";

export function usePatientBilling({
  defaultPatientId,
  patients,
  isGuest,
  serviceId,
}: {
  defaultPatientId?: string | null;
  patients: PatientOption[];
  /** «Nuevo paciente» activo: no hay ficha que consultar. */
  isGuest: boolean;
  /** Servicio elegido: el precio particular depende de él. */
  serviceId: string;
}) {
  // Existing-patient billing: when a registered patient is picked we load
  // their obra social + pre-established copago and show an editable row.
  // Se inicializa sincrónico con el paciente del deep-link para que la foto
  // del dirty-guard ya lo incluya (si no, abrir y cerrar preguntaría).
  const [selectedPatient, setSelectedPatient] = useState<PatientRef | null>(
    () => (defaultPatientId ? patients.find((x) => x.id === defaultPatientId) ?? null : null)
  );
  const [billing, setBilling] = useState<BillingPreview | null>(null);
  const [copagoInput, setCopagoInput] = useState(0); // cents
  // ¿El usuario tocó el copago a mano? Si no, cambiar de servicio re-carga el
  // monto sugerido; si sí, se respeta lo que escribió.
  const [copagoEdited, setCopagoEdited] = useState(false);
  const copagoEditedRef = useRef(false);
  const [copagoLoading, setCopagoLoading] = useState(false);
  const [updateDefaultCopago, setUpdateDefaultCopago] = useState(false);
  const billingSeq = useRef(0);

  const onCopagoInput = (cents: number) => {
    copagoEditedRef.current = true;
    setCopagoEdited(true);
    setCopagoInput(cents);
  };

  /**
   * Preview de cobro del paciente PARA el servicio elegido (handoff de
   * A2a-S08): el precio particular depende del servicio. Guard de secuencia:
   * solo aplica la última respuesta (cambiar rápido de paciente o de
   * servicio no deja un monto viejo).
   */
  const fetchBilling = (patientId: string, svcId: string) => {
    const seq = ++billingSeq.current;
    setCopagoLoading(true);
    getPatientBillingPreview(patientId, svcId || undefined)
      .then((res) => {
        if (seq !== billingSeq.current) return; // stale-response guard
        setBilling(res);
        if (res && !copagoEditedRef.current) setCopagoInput(res.copagoCents);
      })
      .catch(() => {
        if (seq === billingSeq.current) setBilling(null);
      })
      .finally(() => {
        if (seq === billingSeq.current) setCopagoLoading(false);
      });
  };

  const loadPatientBilling = (p: PatientRef | null) => {
    setSelectedPatient(p);
    setBilling(null);
    setUpdateDefaultCopago(false);
    copagoEditedRef.current = false;
    setCopagoEdited(false);
    if (!p) {
      billingSeq.current++; // invalida una respuesta en vuelo
      setCopagoLoading(false);
      return;
    }
    fetchBilling(p.id, serviceId);
  };

  // Deep-link / pre-selected patient: load their billing on mount.
  useEffect(() => {
    if (isGuest || !selectedPatient) return;
    fetchBilling(selectedPatient.id, serviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    selectedPatient,
    billing,
    copagoInput,
    copagoEdited,
    copagoLoading,
    updateDefaultCopago,
    setUpdateDefaultCopago,
    onCopagoInput,
    fetchBilling,
    loadPatientBilling,
  };
}
