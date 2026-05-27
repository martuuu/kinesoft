"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import { AuthShell } from "@/components/screens/auth-shell";
import { sendPasswordReset } from "@/lib/auth";

export function ForgotScreen() {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await sendPasswordReset({ email: String(formData.get("email") ?? "") });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Always show success — never confirm whether the email is registered.
      setSent(true);
    });
  };

  return (
    <AuthShell
      eyebrow="Recuperar acceso"
      heading="¿Olvidaste tu contraseña?"
      blurb="Te mandamos un link para resetearla por email. El link es válido por 1 hora."
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

      {sent ? (
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
            Email enviado
          </div>
          <p style={{ margin: 0, fontSize: 13 }}>
            Si la cuenta existe, vas a recibir un link de recuperación. Revisá la
            bandeja de entrada (y la carpeta de spam por las dudas).
          </p>
          <Link
            href="/login"
            style={{ marginTop: 8, fontSize: 13, color: "var(--sky-700)", fontWeight: 600 }}
          >
            Volver al login →
          </Link>
        </div>
      ) : (
        <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "block" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Email</span>
            <input
              type="email"
              name="email"
              required
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
