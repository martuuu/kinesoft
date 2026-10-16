"use client";

/**
 * Paso "Fecha y hora" en modo "Primer turno disponible (cualquier
 * profesional)" (B5.6). Llama a `findFirstPublicSlot` (B3.2: mismo motor que
 * la grilla y el submit, no puede salir "off-grid") y muestra profesional +
 * fecha/hora + sede para confirmar. El resultado se vuelve una selección
 * concreta (`selectionFromFirstSlot`) y se reserva igual que eligiendo a mano.
 *
 * null = nadie tiene lugar en el horizonte → mensaje y volver a elegir
 * profesional. Rate-limit: la action tira (`RATE_LIMITED`); en prod Next
 * redacta el mensaje de los errores de server actions, así que cualquier
 * error se trata como "esperá un momento" (igual que la grilla).
 */
import { useEffect, useState } from "react";
import { findFirstPublicSlot } from "@/lib/public-booking";
import type { PublicClinic } from "@/lib/public-booking-types";
import {
  findLocation,
  firstSlotQuery,
  formatLocationAddress,
  nextDayKey,
  selectionFromFirstSlot,
  type WizardFilters,
  type WizardSelection,
} from "@/lib/public-wizard-state";
import { Button } from "@/components/ui/button";
import { IconChevR } from "@/components/ui/icons";
import { EmptyBox, StepHeader, formatWhenAR } from "./shared";
import st from "../public-booking.module.css";

type State =
  | { kind: "loading" }
  | { kind: "found"; selection: WizardSelection; durationMin: number }
  | { kind: "none" }
  | { kind: "rate" };

export function FirstSlotStep({
  clinic,
  serviceId,
  filters,
  onFound,
  onClear,
  onPickPractitioner,
  onMoreTimes,
}: {
  clinic: PublicClinic;
  serviceId: string;
  filters: WizardFilters;
  /** Selección resultante (profesional + día + horario + sede). */
  onFound: (sel: WizardSelection) => void;
  /** Se está buscando de nuevo o no hay resultado: la selección anterior no vale. */
  onClear: () => void;
  /** Volver al paso de profesionales (modo "elegir"). */
  onPickPractitioner: () => void;
  /** Ver la grilla de ese profesional en ese día (modo "elegir"). */
  onMoreTimes: () => void;
}) {
  const [fromDate, setFromDate] = useState<string | undefined>(undefined);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    onClear();
    findFirstPublicSlot(firstSlotQuery({ tenantSlug: clinic.slug, serviceId, filters, fromDate }))
      .then((first) => {
        if (cancelled) return;
        if (!first) {
          setState({ kind: "none" });
          return;
        }
        const selection = selectionFromFirstSlot(first);
        setState({ kind: "found", selection, durationMin: first.durationMin });
        onFound(selection);
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "rate" });
      });
    return () => {
      cancelled = true;
    };
    // onFound/onClear son callbacks del padre (identidad nueva por render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinic.slug, serviceId, filters.insurerId, filters.locationId, fromDate, retry]);

  return (
    <>
      <StepHeader
        title="Primer turno disponible"
        subtitle="Buscamos el horario libre más próximo entre todos los profesionales."
      />

      {state.kind === "loading" && <EmptyBox>Buscando el primer turno libre…</EmptyBox>}

      {state.kind === "rate" && (
        <EmptyBox>
          Demasiadas consultas seguidas. Esperá unos segundos y reintentá.
          <div className={st.emptyActions}>
            <Button variant="ghost" onClick={() => setRetry((n) => n + 1)}>
              Reintentar
            </Button>
          </div>
        </EmptyBox>
      )}

      {state.kind === "none" && (
        <EmptyBox>
          {fromDate
            ? "No encontramos más turnos libres en los próximos días."
            : "No encontramos turnos libres en los próximos días para este servicio."}{" "}
          Probá eligiendo un profesional.
          <div className={st.emptyActions}>
            <Button variant="primary" onClick={onPickPractitioner}>
              Elegir profesional
            </Button>
            {fromDate && (
              <Button variant="ghost" onClick={() => setFromDate(undefined)}>
                Volver al primero
              </Button>
            )}
          </div>
        </EmptyBox>
      )}

      {state.kind === "found" && (
        <FoundCard
          clinic={clinic}
          selection={state.selection}
          durationMin={state.durationMin}
          onLater={() => setFromDate(nextDayKey(state.selection.dateISO))}
          onMoreTimes={onMoreTimes}
          onPickPractitioner={onPickPractitioner}
        />
      )}
    </>
  );
}

function FoundCard({
  clinic,
  selection,
  durationMin,
  onLater,
  onMoreTimes,
  onPickPractitioner,
}: {
  clinic: PublicClinic;
  selection: WizardSelection;
  durationMin: number;
  onLater: () => void;
  onMoreTimes: () => void;
  onPickPractitioner: () => void;
}) {
  const pro = clinic.practitioners.find((p) => p.id === selection.practitionerId);
  const loc = findLocation(clinic, selection.slotLocationId);
  const addr = loc ? formatLocationAddress(loc) : "";
  return (
    <>
      <div className={st.found}>
        <p className={st.eyebrow}>Encontramos este turno</p>
        <div className={`k-display ${st.foundWhen}`}>{formatWhenAR(selection.slotISO)}</div>
        <div className={st.foundWho}>
          con {pro?.name ?? "un profesional del centro"}
          <span className={st.muted}> · {durationMin} min</span>
        </div>
        {loc && (
          <div className={st.choiceSub}>
            {loc.name}
            {addr ? ` · ${addr}` : ""}
          </div>
        )}
        <p className={st.help}>Si te sirve, tocá Continuar para completar tus datos.</p>
      </div>
      <div className={st.chips}>
        <Button variant="ghost" onClick={onLater}>
          Buscar otro día <IconChevR size={12} />
        </Button>
        {pro && (
          <Button variant="ghost" onClick={onMoreTimes}>
            Ver más horarios de {pro.name}
          </Button>
        )}
        <Button variant="ghost" onClick={onPickPractitioner}>
          Elegir otro profesional
        </Button>
      </div>
    </>
  );
}
