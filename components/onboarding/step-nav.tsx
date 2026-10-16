"use client";

import { createContext, useContext } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { IconArrow, IconChevL } from "@/components/ui/icons";
import { nextStep, prevStep, stepPosition } from "@/lib/onboarding-logic";

/**
 * VX2-e: datos del alta que cambian el recorrido. Hoy solo `ownerClinical` (¿el Titular atiende?): sin Practitioner
 * no hay «Tu horario», así que «Seguir», «Volver» y el «Paso N» de cada encabezado lo saltean. Lo monta
 * `OnboardingShell`; sin provider (render tests de un paso suelto) rige el default de PL-1a: atiende.
 */
const OnboardingFlowContext = createContext<{ ownerClinical: boolean }>({ ownerClinical: true });

export function OnboardingFlowProvider({ ownerClinical, children }: { ownerClinical: boolean; children: React.ReactNode }) {
  return <OnboardingFlowContext.Provider value={{ ownerClinical }}>{children}</OnboardingFlowContext.Provider>;
}

export function useOnboardingFlow() {
  return useContext(OnboardingFlowContext);
}

/** Navegación entre pasos: el paso vive en `?step=` (el estado se deriva de la DB). */
export function useStepNav() {
  const router = useRouter();
  const flow = useContext(OnboardingFlowContext);
  return {
    go: (n: number) => router.push(`/onboarding?step=${n}`),
    refresh: () => router.refresh(),
    /** Paso siguiente / anterior de ESTE alta (saltea «Tu horario» si el Titular no atiende). */
    next: (from: number) => nextStep(from, flow),
    prev: (from: number) => prevStep(from, flow),
    /** Número que se muestra en «Paso N · …» (posición en el riel de este alta, no la clave de `?step=`). */
    label: (n: number) => stepPosition(n, flow).index,
  };
}

/**
 * Pie de cada paso: "Volver" + acción principal (+ "Saltear" opcional).
 * `onBack` reemplaza a `back` cuando "Volver" tiene que pasar por el
 * dirty-guard del paso (formularios con cambios sin guardar).
 */
export function StepFooter({
  back,
  onBack,
  primaryLabel,
  onPrimary,
  primaryType = "button",
  pending,
  disabled,
  skip,
}: {
  back?: number;
  onBack?: () => void;
  primaryLabel: string;
  onPrimary?: () => void;
  primaryType?: "button" | "submit";
  pending?: boolean;
  disabled?: boolean;
  skip?: { label: string; onClick: () => void };
}) {
  const { go } = useStepNav();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginTop: 26,
        paddingTop: 18,
        borderTop: "1px solid rgba(15,30,51,0.06)",
        flexWrap: "wrap",
      }}
    >
      {(back != null || onBack) && (
        <Button type="button" variant="ghost" onClick={onBack ?? (() => go(back!))} disabled={pending}>
          <IconChevL size={14} /> Volver
        </Button>
      )}
      <div style={{ flex: 1 }} />
      {skip && (
        <Button type="button" variant="ghost" onClick={skip.onClick} disabled={pending}>
          {skip.label}
        </Button>
      )}
      <Button
        type={primaryType}
        variant="primary"
        onClick={onPrimary}
        disabled={pending || disabled}
        style={{ padding: "12px 18px" }}
      >
        {pending ? "Guardando…" : primaryLabel} <IconArrow size={14} />
      </Button>
    </div>
  );
}

export function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--danger-bg)",
        color: "var(--danger-fg)",
        fontSize: 13,
        marginTop: 14,
      }}
    >
      {children}
    </div>
  );
}

/** Fila de lista (servicio, obra social, invitación) con acción a la derecha. */
export function ItemRow({ title, meta, action }: { title: React.ReactNode; meta?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 14,
        background: "rgba(255,255,255,0.7)",
        border: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </div>
        {meta && <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>{meta}</div>}
      </div>
      {action}
    </div>
  );
}
