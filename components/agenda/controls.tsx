"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { parseARS } from "@/lib/format";
import { fmtMoney } from "./agenda-utils";

const DOW_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

export function DayOfWeekPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const toggle = (d: number) => {
    if (value.includes(d)) onChange(value.filter((x) => x !== d));
    else onChange([...value, d].sort((a, b) => a - b));
  };
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {DOW_LABELS.map((label, i) => {
        const on = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 10,
              border: "1px solid " + (on ? "var(--sky-700)" : "rgba(15,30,51,0.1)"),
              background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
              color: on ? "#fff" : "var(--navy-700)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Editable copago row for the booking modal. Shows the selected (existing)
 * patient's obra social + pre-established copago; when the kine changes the
 * amount, the row expands into a "¿Actualizar el copago?" prompt so the new
 * value can become the patient's default ("ambas opciones") or stay scoped
 * to this turno.
 */
export function CopagoRow({
  obraSocial,
  original,
  valueCents,
  onValueCents,
  updateDefault,
  setUpdateDefault,
  loading,
}: {
  obraSocial: string;
  original: number;
  valueCents: number;
  onValueCents: (cents: number) => void;
  updateDefault: boolean;
  setUpdateDefault: (v: boolean) => void;
  loading: boolean;
}) {
  const changed = valueCents !== original;
  const [decided, setDecided] = useState(false);
  // Re-arm the prompt whenever the amount returns to (or leaves) the original.
  useEffect(() => {
    if (!changed) setDecided(false);
  }, [changed]);
  const showPrompt = changed && !decided;
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(31,79,190,0.05)",
        border: "1px solid rgba(31,79,190,0.16)",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--navy-300)" }}>
            Copago
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-700)" }}>{loading ? "Cargando…" : obraSocial}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, color: "var(--navy-500)" }}>$</span>
          <input
            type="number"
            min={0}
            step={100}
            inputMode="numeric"
            aria-label="Monto de copago"
            value={loading ? "" : Math.round(valueCents / 100)}
            disabled={loading}
            onChange={(e) => onValueCents(Math.max(0, parseARS(e.target.value) ?? 0))}
            style={{
              width: 110,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.12)",
              background: "#fff",
              fontSize: 14,
              fontWeight: 600,
              textAlign: "right",
              color: "var(--navy-900)",
            }}
          />
        </div>
      </div>

      <AnimatePresence initial={false}>
        {showPrompt && (
          <motion.div
            key="copago-prompt"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ display: "grid", gap: 8, paddingTop: 8, borderTop: "1px dashed rgba(31,79,190,0.25)" }}>
              <div style={{ fontSize: 12.5, color: "var(--navy-700)", lineHeight: 1.4 }}>
                ¿Actualizar el copago a <strong>{fmtMoney(valueCents)}</strong> de{" "}
                <strong>{obraSocial}</strong> para este paciente?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    setUpdateDefault(true);
                    setDecided(true);
                  }}
                  style={{ height: 32, padding: "0 12px", fontSize: 12.5 }}
                >
                  Sí, actualizar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setUpdateDefault(false);
                    setDecided(true);
                  }}
                  style={{ height: 32, padding: "0 12px", fontSize: 12.5 }}
                >
                  Sólo este turno
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {decided && changed && (
        <div style={{ fontSize: 11, fontWeight: 600, color: updateDefault ? "var(--sky-700)" : "var(--navy-400)" }}>
          {updateDefault
            ? `Se actualizará el copago de ${obraSocial} para este paciente`
            : "Sólo para este turno"}
        </div>
      )}
    </div>
  );
}

export function Select({
  label,
  name,
  required,
  defaultValue = "",
  value,
  onChange,
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: (v: string) => void;
  children: React.ReactNode;
}) {
  // Controlled when `value` is provided; otherwise stays uncontrolled
  // (defaultValue) so existing call sites keep working unchanged.
  const controlled = value !== undefined;
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
        {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
      </span>
      <select
        name={name}
        required={required}
        style={inputStyle}
        {...(controlled
          ? { value, onChange: (e) => onChange?.(e.target.value) }
          : { defaultValue })}
      >
        {children}
      </select>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};
