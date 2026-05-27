"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { signUpPractitioner } from "@/lib/auth";

/**
 * Self-serve owner signup. Same brand panel as `/login` for visual
 * consistency, but the form is its own client component so we can keep
 * the slug + email field-level errors next to their inputs instead of
 * a top-level banner.
 */
export function SignupScreen() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  // Live slug preview as the user types the clinic name. Pure UX —
  // server still validates.
  const [clinicName, setClinicName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  const derivedSlug = clinicName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
  const effectiveSlug = slugTouched ? slug : derivedSlug;

  const onSubmit = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await signUpPractitioner({
        clinicName: String(formData.get("clinicName") ?? ""),
        slug: effectiveSlug,
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
        fullName: String(formData.get("fullName") ?? ""),
        licenseNumber: String(formData.get("licenseNumber") ?? ""),
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      router.replace(r.data.redirect);
    });
  };

  return (
    <div
      className="k-app"
      data-screen-label="Signup"
      style={{
        minHeight: "100vh",
        background: "var(--bg-app)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: -120,
          right: -80,
          width: 460,
          height: 460,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--sky-300), transparent 70%)",
          opacity: 0.7,
          filter: "blur(10px)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          bottom: -160,
          left: -120,
          width: 520,
          height: 520,
          borderRadius: "50%",
          background: "radial-gradient(circle, var(--lime-300), transparent 65%)",
          opacity: 0.45,
          filter: "blur(20px)",
        }}
      />

      <div
        className="login-brand"
        style={{
          flex: 1,
          padding: 56,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          zIndex: 2,
        }}
      >
        <KineLogo size={32} />
        <div style={{ marginTop: "auto", maxWidth: 460 }}>
          <Tag tone="lime" className="mb-6">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
            Crear consultorio
          </Tag>
          <h1 className="k-display" style={{ fontSize: 56, lineHeight: 1.02, margin: "0 0 18px" }}>
            Sumá tu
            <br />
            consultorio
            <br />a KineSoft.
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.55, color: "var(--navy-500)", margin: 0, maxWidth: 420 }}>
            Creá tu espacio en minutos. Vas a poder invitar a tu equipo, cargar
            obras sociales y comenzar a usar la agenda + historia clínica
            inmediatamente.
          </p>
          <ul style={{ marginTop: 20, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
            {[
              "Agenda + turnero online",
              "Historia clínica + diagnóstico interactivo",
              "Planes y seguimiento por sesión",
            ].map((b) => (
              <li key={b} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--navy-700)" }}>
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 6,
                    background: "var(--lime-300)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconCheck size={11} stroke={3} />
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>
        <div style={{ marginTop: 28, fontSize: 12, color: "var(--navy-300)" }}>
          © 2026 KineSoft · Buenos Aires, Argentina
        </div>
      </div>

      <div
        className="login-form-wrap"
        style={{
          width: 560,
          padding: "56px 56px 56px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div
          className="k-glass-strong"
          style={{
            padding: 40,
            borderRadius: "var(--r-2xl)",
            width: "100%",
            maxWidth: 480,
          }}
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
            Nuevo consultorio
          </div>
          <h2 className="k-display" style={{ fontSize: 28, margin: "0 0 22px", lineHeight: 1.1 }}>
            Creá tu cuenta en KineSoft
          </h2>

          <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 14 }}>
            <Field label="Nombre del consultorio" error={fieldErrors.clinicName?.[0]}>
              <input
                type="text"
                name="clinicName"
                required
                value={clinicName}
                onChange={(e) => setClinicName(e.target.value)}
                placeholder="Centro Kinésico Movare"
                style={inputStyle}
              />
            </Field>

            <Field
              label="Identificador (URL)"
              hint={effectiveSlug ? `Tu URL: kinesoft.app/c/${effectiveSlug}` : "Solo minúsculas, números y guiones"}
              error={fieldErrors.slug?.[0]}
            >
              <input
                type="text"
                name="slug"
                required
                value={effectiveSlug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
                placeholder="movare"
                style={inputStyle}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Tu nombre completo" error={fieldErrors.fullName?.[0]}>
                <input
                  type="text"
                  name="fullName"
                  required
                  placeholder="Camila Rossi"
                  style={inputStyle}
                  autoComplete="name"
                />
              </Field>
              <Field label="Matrícula (opcional)" error={fieldErrors.licenseNumber?.[0]}>
                <input type="text" name="licenseNumber" placeholder="MN 12345" style={inputStyle} />
              </Field>
            </div>

            <Field label="Email profesional" error={fieldErrors.email?.[0]}>
              <input
                type="email"
                name="email"
                required
                placeholder="camila@movare.com.ar"
                style={inputStyle}
                autoComplete="email"
              />
            </Field>

            <Field
              label="Contraseña"
              hint="Mínimo 8 caracteres"
              error={fieldErrors.password?.[0]}
            >
              <input
                type="password"
                name="password"
                required
                minLength={8}
                placeholder="••••••••"
                style={inputStyle}
                autoComplete="new-password"
              />
            </Field>

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
              variant="primary"
              type="submit"
              disabled={pending}
              style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
            >
              {pending ? "Creando…" : "Crear consultorio"} <IconArrow size={16} />
            </Button>

            <div style={{ marginTop: 4, fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
              ¿Ya tenés cuenta?{" "}
              <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
                Ingresar
              </Link>
            </div>
          </form>
        </div>
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

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>{label}</span>
      {children}
      {error ? (
        <span style={{ fontSize: 11, color: "#9F1F1F", marginTop: 4, display: "block" }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 4, display: "block" }}>{hint}</span>
      ) : null}
    </label>
  );
}
