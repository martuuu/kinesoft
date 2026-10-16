"use client";

/*
 * [VX F-Z · handoff F-d H1] Vive en su propio archivo (antes en components/plataforma/reauth-modal.tsx) para que
 * /verificar-acceso — superficie pública — no arrastre `Modal` ni framer-motion al importar solo el campo.
 * Lo guarda tests/unit/public-surface-imports.test.ts.
 */

/**
 * Campo del código TOTP. No es `FormField` porque el código necesita `inputMode="numeric"` (teclado numérico en el
 * teléfono) y `autoComplete="one-time-code"` (los gestores de contraseñas lo completan), que la primitiva no expone.
 * Mismo look que `FormField` (label 12px navy-500, input con los tokens del design system).
 */
export function TotpCodeInput({
  value,
  onChange,
  disabled,
  error,
  autoFocus,
  label = "Código de 6 números",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  label?: string;
}) {
  return (
    <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>{label}</span>
      <input
        name="code"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 \-]*"
        maxLength={9}
        placeholder="123 456"
        aria-invalid={error ? true : undefined}
        style={{
          display: "block",
          marginTop: 6,
          width: "100%",
          padding: "12px 14px",
          borderRadius: 12,
          border: `1px solid ${error ? "rgba(225,75,75,0.4)" : "rgba(15,30,51,0.08)"}`,
          background: "rgba(255,255,255,0.96)",
          fontSize: 22,
          letterSpacing: "0.3em",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "var(--navy-900)",
          outline: "none",
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {error && (
        <span role="alert" style={{ display: "block", marginTop: 6, color: "var(--danger-fg)", fontSize: 12.5 }}>
          {error}
        </span>
      )}
    </label>
  );
}
