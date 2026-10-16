"use client";

/**
 * [PF1.2-planes-bib] Shell de los diálogos de edición del plan (S22e), separado de `plan-edit-dialogs.tsx`.
 *
 * Por qué un módulo aparte: `plan-session-actions.tsx` (estático en cada PlanCard) solo necesita el shell y el
 * segmentado del paquete, pero importarlos de `plan-edit-dialogs.tsx` arrastraba la tabla de preview del motor y el
 * zod de la renovación a la carga inicial de la pestaña Planes. Así la card baja esos diálogos con `next/dynamic`
 * recién al abrirlos (C-PF2). `plan-edit-dialogs.tsx` re-exporta lo de acá: los llamadores no cambian.
 */
import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatARS } from "@/lib/format";
import type { PackageCountPricing } from "./plan-editor-types";
import styles from "./plan-dialogs.module.css";

export const PLAN_DIALOG_COPY = {
  dirty: "Tenés cambios sin guardar. Si cerrás, se pierden.",
  keepTotal: "Mantener el total",
  keepPerSession: "Mantener el precio por sesión",
} as const;

const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };

/** C13 literal: "¿Mantenemos el total ($120.000) o el precio por sesión?" (sin el monto si no se pudo cargar). */
export function packageChoiceQuestion(totalCents: number | null | undefined): string {
  return totalCents == null
    ? "¿Mantenemos el total o el precio por sesión?"
    : `¿Mantenemos el total (${formatARS(totalCents)}) o el precio por sesión?`;
}

/**
 * Modal del design system (ya portado a `body` y dueño del Esc, ver la
 * cabecera) con dirty-guard. En el render del server (tests) se pinta en línea.
 */
export function PlanDialogShell({
  open,
  onClose,
  title,
  description,
  dirty = false,
  width = 560,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  dirty?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const confirm = useConfirm();
  const asking = useRef(false);
  const requestClose = useCallback(async () => {
    if (!dirty) return onClose();
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirm({
        title: "¿Descartar los cambios?",
        message: PLAN_DIALOG_COPY.dirty,
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  }, [dirty, onClose, confirm]);

  // Cerrado no se pinta nada: la PlanCard monta los cuatro
  // diálogos siempre y cada instancia se descarta al cerrar (`freshOnClose`).
  if (!open) return null;
  return (
    <Modal open={open} onClose={() => void requestClose()} title={title} description={description} width={width} lockBackdrop={dirty}>
      {children}
    </Modal>
  );
}

/** Segmentado accesible (radiogroup de radios nativos: flechas del teclado gratis). */
export function Choice<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
      <legend style={{ ...sectionLabel, padding: 0, marginBottom: 6 }}>{label}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 3, borderRadius: 14, background: "rgba(15,30,51,0.04)" }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={o.value}
              className={styles.choice}
              style={{
                position: "relative",
                flex: "1 1 auto",
                textAlign: "center",
                padding: "7px 12px",
                borderRadius: 11,
                fontSize: 13,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
                background: on ? "#fff" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                boxShadow: on ? "0 1px 3px rgba(15,30,51,0.12)" : undefined,
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const PACKAGE_OPTIONS: ReadonlyArray<{ value: PackageCountPricing; label: string }> = [
  { value: "keep-total", label: PLAN_DIALOG_COPY.keepTotal },
  { value: "keep-per-session", label: PLAN_DIALOG_COPY.keepPerSession },
];

/** PACKAGE: "¿Mantenemos el total ($120.000) o el precio por sesión?" (default: mantener el total). */
export function PackageChoice({
  totalCents,
  value,
  onChange,
  disabled,
  name,
}: {
  totalCents: number | null | undefined;
  value: PackageCountPricing;
  onChange: (v: PackageCountPricing) => void;
  disabled?: boolean;
  name: string;
}) {
  return <Choice<PackageCountPricing> name={name} label={packageChoiceQuestion(totalCents)} value={value} options={PACKAGE_OPTIONS} onChange={onChange} disabled={disabled} />;
}
