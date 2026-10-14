"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { AuthShell } from "@/components/screens/auth-shell";
import { sendPasswordReset } from "@/lib/auth";
import { FORGOT_SENT } from "@/components/screens/auth-feedback";
import { ResendButton } from "@/components/screens/resend-verification";

/**
 * /forgot. La respuesta es SIEMPRE la genérica (`FORGOT_SENT`): exista o no la cuenta, para no confirmar qué
 * emails están registrados. IAM-2d: tras el envío, «Reenviar el link» (con cooldown) y «¿Email equivocado?
 * Volver», que vuelve al form con el email cargado.
 */
export function ForgotScreen() {
  const [pending, start] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (formData: FormData) => {
    setError(null);
    const email = String(formData.get("email") ?? "").trim();
    setDraft(email);
    start(async () => {
      const r = await sendPasswordReset({ email });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSentTo(email);
    });
  };

  return (
    <AuthShell
      eyebrow="Recuperar acceso"
      heading="¿Olvidaste tu contraseña?"
      blurb="Te mandamos por email un link para crear una contraseña nueva. Vence en 1 hora."
      footerLinks={[{ label: "Volver al login", href: "/login" }]}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        Recuperar contraseña
      </div>
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 22px", lineHeight: 1.1 }}>
        Te mandamos un link
      </h2>

      {sentTo ? (
        <ForgotSent email={sentTo} onBack={() => setSentTo(null)} />
      ) : (
        <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "block" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Email</span>
            <input
              type="email"
              name="email"
              required
              defaultValue={draft}
              placeholder="camila@movare.com.ar"
              autoComplete="email"
              style={inputStyle}
            />
          </label>
          {error && (
            <div
              role="alert"
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
          >
            {pending ? "Enviando…" : "Enviar link de recuperación"}
          </Button>
          <div style={{ fontSize: 13, color: "var(--navy-500)", textAlign: "center", marginTop: 4 }}>
            <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              ← Volver al login
            </Link>
          </div>
        </form>
      )}
    </AuthShell>
  );
}

/** Estado «te mandamos un link» (exportado para el render test). El reenvío arranca con cooldown. */
export function ForgotSent({ email, onBack }: { email: string; onBack: () => void }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div
        role="status"
        style={{
          padding: 18,
          borderRadius: 14,
          background: "rgba(200,245,100,0.18)",
          color: "var(--navy-900)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          <span
            aria-hidden
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "var(--lime-300)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconCheck size={12} stroke={3} />
          </span>
          Revisá tu email
        </div>
        <p style={{ margin: 0, fontSize: 13 }}>{FORGOT_SENT}</p>
        <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
          Lo pediste para <strong>{email}</strong>. ¿No llega? Revisá spam o promociones.
        </p>
      </div>
      <ResendButton
        label="Reenviar el link"
        sentCopy={FORGOT_SENT}
        startCooling
        onSend={() => sendPasswordReset({ email })}
      />
      <div style={{ fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
        ¿Email equivocado?{" "}
        <button
          type="button"
          onClick={onBack}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--sky-700)", fontWeight: 600 }}
        >
          Volver
        </button>
        {" · "}
        <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
          Ir al login
        </Link>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "12px 14px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(15,30,51,0.08)",
  display: "block",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
  boxSizing: "border-box",
};
