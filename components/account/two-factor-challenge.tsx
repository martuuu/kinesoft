"use client";

/**
 * Segundo paso (PL-2a, C-PL6): el mismo formulario para entrar (`/verificar-acceso`) y para confirmar una acción
 * de riesgo (`StepUpModal`). Tres caminos, según lo que tenga prendido la persona:
 *  - app de autenticación (TOTP de Supabase): 6 números;
 *  - código por email: «Mandame un código» → 6 números (reenvío cada 60 s; el server lo vuelve a frenar);
 *  - código de recuperación (siempre, si tiene 2FA): para quien perdió el teléfono.
 *
 * Accesibilidad: cada camino es un grupo con su `<legend>`; los cambios de camino son botones (no tabs falsas); los
 * errores van en `role="alert"` y el «te mandamos el código» en `role="status"` (lo anuncia el lector de pantalla).
 */
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { TotpCodeInput } from "@/components/account/totp-code-input";
import {
  requestEmailCode,
  useRecoveryCode as redeemRecoveryCode,
  verifyEmailCode,
  verifyLoginTotp,
  verifyStepUpTotp,
} from "@/lib/two-factor";
import type { TwoFactorMethods } from "@/lib/two-factor-logic";

type Mode = "totp" | "email" | "recovery";
const NETWORK = "No se pudo completar. Revisá la conexión y probá de nuevo.";
const RESEND_S = 60;

export function TwoFactorChallenge({
  purpose,
  methods,
  emailMasked,
  submitLabel,
  onDone,
}: {
  purpose: "login" | "step_up";
  methods: TwoFactorMethods;
  emailMasked: string;
  submitLabel: string;
  /** El segundo paso salió bien (la cookie ya está puesta). `remaining` = códigos de recuperación que quedan. */
  onDone: (info: { recoveryRemaining?: number }) => void;
}) {
  const [mode, setMode] = useState<Mode>(methods.totp ? "totp" : methods.email ? "email" : "recovery");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const switchTo = (m: Mode) => {
    setMode(m);
    setCode("");
    setError(null);
  };

  const sendEmail = async () => {
    if (pending || cooldown > 0) return;
    setPending(true);
    setError(null);
    try {
      const r = await requestEmailCode(purpose);
      if (!r.ok) setError(r.error);
      else {
        setSentTo(r.data.sentTo);
        setCooldown(RESEND_S);
      }
    } catch {
      setError(NETWORK);
    } finally {
      setPending(false);
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (mode === "recovery") {
        const r = await redeemRecoveryCode(code);
        if (!r.ok) {
          setError(r.error);
          setPending(false);
          return;
        }
        onDone({ recoveryRemaining: r.data.remaining });
        return;
      }
      const r =
        mode === "totp"
          ? await (purpose === "login" ? verifyLoginTotp(code) : verifyStepUpTotp(code))
          : await verifyEmailCode(purpose, code);
      if (!r.ok) {
        setError(r.error);
        setPending(false);
        return;
      }
      // Sin setPending(false): quien llama navega o cierra; así no se manda dos veces.
      onDone({});
    } catch {
      setError(NETWORK);
      setPending(false);
    }
  };

  // PL-Z M6: era `all: unset`, que también borraba el outline de foco (teclado sin foco visible) y dejaba el
  // target en ~18 px. Se resetea solo lo visual y se deja el outline nativo del navegador.
  const linkStyle: React.CSSProperties = {
    border: "none",
    background: "none",
    font: "inherit",
    minHeight: 44,
    padding: "12px 8px",
    cursor: "pointer",
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--sky-700)",
    textAlign: "center",
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 12, minWidth: 0 }}>
          {mode === "totp" && (
            <>
              <legend style={{ fontSize: 14, color: "var(--navy-700)", marginBottom: 10, lineHeight: 1.5 }}>
                Abrí tu app de autenticación y escribí el código de 6 números de KineSoft.
              </legend>
              <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus />
            </>
          )}
          {mode === "email" && (
            <>
              <legend style={{ fontSize: 14, color: "var(--navy-700)", marginBottom: 10, lineHeight: 1.5 }}>
                {/* PL-Z M5: antes del envío decía «Te mandamos» (pasado) cuando todavía no se mandó nada. */}
                {sentTo
                  ? "Te mandamos un código de 6 números por email."
                  : `Te vamos a mandar un código de 6 números por email${emailMasked ? ` a ${emailMasked}` : ""}.`}
              </legend>
              {sentTo ? (
                <>
                  <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
                    Te lo mandamos a {sentTo}. Vence en 10 minutos.
                  </p>
                  <TotpCodeInput value={code} onChange={setCode} disabled={pending} error={error} autoFocus label="Código del email" />
                </>
              ) : (
                error && (
                  <p role="alert" style={{ margin: 0, color: "#9F1F1F", fontSize: 13 }}>
                    {error}
                  </p>
                )
              )}
            </>
          )}
          {mode === "recovery" && (
            <>
              <legend style={{ fontSize: 14, color: "var(--navy-700)", marginBottom: 10, lineHeight: 1.5 }}>
                Escribí uno de los códigos de recuperación que guardaste. Cada uno sirve una sola vez.
              </legend>
              <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Código de recuperación</span>
                <input
                  name="recovery"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={pending}
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={20}
                  placeholder="abcde-fghjk"
                  aria-invalid={error ? true : undefined}
                  style={{
                    display: "block",
                    marginTop: 6,
                    width: "100%",
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: `1px solid ${error ? "rgba(225,75,75,0.4)" : "rgba(15,30,51,0.08)"}`,
                    background: "rgba(255,255,255,0.96)",
                    fontSize: 18,
                    letterSpacing: "0.12em",
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    color: "var(--navy-900)",
                  }}
                />
                {error && (
                  <span role="alert" style={{ display: "block", marginTop: 6, color: "#9F1F1F", fontSize: 12.5 }}>
                    {error}
                  </span>
                )}
              </label>
            </>
          )}
        </fieldset>

        {mode === "email" && !sentTo ? (
          <Button
            type="button"
            variant="primary"
            onClick={sendEmail}
            disabled={pending}
            style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}
          >
            {pending ? "Mandando…" : "Mandame el código"}
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={pending} style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
            {pending ? "Verificando…" : submitLabel}
          </Button>
        )}
        {mode === "email" && sentTo && (
          <button type="button" onClick={sendEmail} disabled={pending || cooldown > 0} style={{ ...linkStyle, opacity: cooldown > 0 ? 0.6 : 1 }}>
            {cooldown > 0 ? `Podés pedir otro código en ${cooldown} s` : "Mandame otro código"}
          </button>
        )}
      </form>

      <div style={{ display: "grid", gap: 8, justifyItems: "center" }}>
        {mode !== "totp" && methods.totp && (
          <button type="button" onClick={() => switchTo("totp")} style={linkStyle}>
            Usar la app de autenticación
          </button>
        )}
        {mode !== "email" && methods.email && (
          <button type="button" onClick={() => switchTo("email")} style={linkStyle}>
            Usar un código por email
          </button>
        )}
        {mode !== "recovery" && (
          <button type="button" onClick={() => switchTo("recovery")} style={linkStyle}>
            Usar un código de recuperación
          </button>
        )}
      </div>
    </div>
  );
}
