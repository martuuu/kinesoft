"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AuthShell } from "@/components/screens/auth-shell";
import { updatePasswordWithRecoverySession } from "@/lib/auth";

/**
 * /reset (A3c-S-signup). `mode` lo decide el server (ver app/(auth)/reset):
 *   - "recovery": llegó por el link del mail (cookie `ks_recovery`) → solo la
 *     clave nueva;
 *   - "change": sesión común → además la contraseña actual;
 *   - "expired": sin sesión → link vencido, pedir otro.
 */
export function ResetScreen({ mode }: { mode: "recovery" | "change" | "expired" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});

  const onSubmit = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    start(async () => {
      const r = await updatePasswordWithRecoverySession({
        password,
        currentPassword: mode === "change" ? String(formData.get("currentPassword") ?? "") : "",
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
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

      {mode === "expired" ? (
        <div style={{ display: "grid", gap: 14 }}>
          <div
            role="alert"
            style={{ padding: 14, borderRadius: 12, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 13, lineHeight: 1.5 }}
          >
            El link venció o ya se usó. Pedí uno nuevo: te llega por email y vence en 1 hora.
          </div>
          {/* IAM-2d: la salida es un botón, no un link al pie. Mismas clases que `Button` (y que
              /auth/confirm/continuar) porque es navegación, no una acción. */}
          <Link href="/forgot" className="k-btn k-btn-primary" style={{ width: "100%", justifyContent: "center" }}>
            Pedir un link nuevo
          </Link>
          <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600, fontSize: 13, textAlign: "center" }}>
            Volver al login
          </Link>
        </div>
      ) : done ? (
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
          {mode === "change" && (
            <label style={{ display: "block" }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
                Contraseña actual
              </span>
              <input
                type="password"
                name="currentPassword"
                required
                placeholder="La que usás hoy"
                autoComplete="current-password"
                style={inputStyle}
              />
              <span style={{ fontSize: 11, color: fieldErrors.currentPassword ? "var(--danger-fg)" : "var(--navy-300)", marginTop: 4, display: "block" }}>
                {fieldErrors.currentPassword?.[0] ?? "¿No la recordás? Pedí un link desde “Olvidé mi contraseña”."}
              </span>
            </label>
          )}
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
                background: "var(--danger-bg)",
                color: "var(--danger-fg)",
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
