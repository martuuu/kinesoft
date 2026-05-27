"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/screens/auth-shell";
import { updatePasswordWithRecoverySession } from "@/lib/auth";

/**
 * Landed-on after the user clicks the recovery link from their email.
 * Supabase has already set a `recovery`-type session cookie via the
 * /auth/callback route. We just collect the new password and submit.
 */
export function ResetScreen() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = (formData: FormData) => {
    setError(null);
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    start(async () => {
      const r = await updatePasswordWithRecoverySession({ password });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setDone(true);
      // Brief pause so the user sees the confirmation, then redirect.
      setTimeout(() => router.replace("/dashboard"), 1200);
    });
  };

  return (
    <AuthShell
      eyebrow="Nueva contraseña"
      heading="Definí tu nueva clave"
      blurb="Una vez actualizada, te llevamos directo a tu panel. Vas a poder usar la nueva contraseña en todos los dispositivos."
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
        Reset de contraseña
      </div>
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 22px", lineHeight: 1.1 }}>
        Nueva contraseña
      </h2>

      {done ? (
        <div
          role="status"
          style={{
            padding: 18,
            borderRadius: 14,
            background: "rgba(200,245,100,0.18)",
            color: "var(--navy-900)",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          ✓ Contraseña actualizada — redirigiendo al dashboard…
        </div>
      ) : (
        <form action={onSubmit} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "block" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
              Nueva contraseña
            </span>
            <input
              type="password"
              name="password"
              required
              minLength={8}
              placeholder="Mínimo 8 caracteres"
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "block" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
              Confirmar contraseña
            </span>
            <input
              type="password"
              name="confirm"
              required
              minLength={8}
              placeholder="Repetí la nueva clave"
              autoComplete="new-password"
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
            {pending ? "Guardando…" : "Guardar nueva contraseña"}
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
