"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { IconArrow, IconChevL } from "@/components/ui/icons";

/** Navegación entre pasos: el paso vive en `?step=` (el estado se deriva de la DB). */
export function useStepNav() {
  const router = useRouter();
  return {
    go: (n: number) => router.push(`/onboarding?step=${n}`),
    refresh: () => router.refresh(),
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
