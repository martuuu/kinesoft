"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { signUpPractitioner } from "@/lib/auth";
import { ResendVerification } from "@/components/screens/resend-verification";

/**
 * Paso 1 del alta: la cuenta (A3c-S-signup). Solo nombre, email y
 * contraseña: el consultorio se carga en `/onboarding` DESPUÉS de verificar el
 * email (antes se creaba todo acá, sin verificar nada — H5).
 *
 * IAM-2d: ya no hay modo «unión por invitación» (la page manda `?invite=` a `/invite/<token>`). Si igual la
 * action devuelve `redirectTo` (contrato de IAM-2c: solo con invitación), se sigue ese destino y NO se
 * muestra «te mandamos un email»: ese era el bug del QA del 14-oct (§19.1 #4), la pantalla prometía un mail
 * que nunca salía.
 */
export function SignupScreen() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [sentTo, setSentTo] = useState<{ email: string; message: string } | null>(null);
  // Lo tipeado, para que «¿Email equivocado? Volver» no obligue a escribir todo de nuevo.
  const [draft, setDraft] = useState({ fullName: "", email: "" });

  const onSubmit = (formData: FormData) => {
    setError(null);
    setFieldErrors({});
    const fullName = String(formData.get("fullName") ?? "");
    const email = String(formData.get("email") ?? "");
    setDraft({ fullName, email });
    start(async () => {
      const r = await signUpPractitioner({
        fullName,
        email,
        password: String(formData.get("password") ?? ""),
        inviteToken: "",
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      if (r.data.redirectTo) {
        router.replace(r.data.redirectTo);
        return;
      }
      setSentTo({ email: r.data.email, message: r.data.message });
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
            Creá tu cuenta, confirmá tu email y configurá tu consultorio en pocos pasos: horario, servicios,
            obras sociales y equipo.
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
            Paso 1 de 7 · Tu cuenta
          </div>
          <h2 className="k-display" style={{ fontSize: 28, margin: "0 0 10px", lineHeight: 1.1 }}>
            {sentTo ? "Revisá tu email" : "Creá tu cuenta en KineSoft"}
          </h2>
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 22px", lineHeight: 1.5 }}>
            {sentTo
              ? "Abrí el link del email para confirmar tu cuenta. Después cargás los datos de tu consultorio."
              : "Te mandamos un email para confirmarla. Después cargás los datos de tu consultorio en pocos pasos."}
          </p>

          {sentTo ? (
            <SignupSent email={sentTo.email} message={sentTo.message} onBack={() => setSentTo(null)} />
          ) : (
          <form action={onSubmit} autoComplete="on" style={{ display: "grid", gap: 14 }}>
            <Field label="Tu nombre completo" error={fieldErrors.fullName?.[0]}>
              <input
                type="text"
                name="fullName"
                required
                defaultValue={draft.fullName}
                placeholder="Camila Rossi"
                style={inputStyle}
                autoComplete="name"
              />
            </Field>

            <Field label="Email profesional" error={fieldErrors.email?.[0]}>
              <input
                type="email"
                name="email"
                required
                defaultValue={draft.email}
                placeholder="camila@movare.com.ar"
                style={inputStyle}
                autoComplete="email"
              />
            </Field>

            <Field
              label="Contraseña"
              hint="Mínimo 8 caracteres, con al menos una letra y un número"
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

            {error && <Notice tone="error" role="alert">{error}</Notice>}

            <Button
              variant="primary"
              type="submit"
              disabled={pending}
              style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
            >
              {pending ? "Creando tu cuenta…" : "Crear mi cuenta"} <IconArrow size={16} />
            </Button>

            <div style={{ marginTop: 4, fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
              ¿Ya tenés cuenta?{" "}
              <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
                Ingresar
              </Link>
            </div>
          </form>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Estado «Revisá tu email» (IAM-2d). Exportado para el render test. El reenvío arranca con cooldown porque el
 * mail se acaba de mandar. «Reenviar» usa `resendVerification` (C-IAM6): si el email ya tenía cuenta
 * confirmada no manda nada y la respuesta es la misma; por eso queda el texto de «si ya tenías cuenta».
 */
export function SignupSent({ email, message, onBack }: { email: string; message: string; onBack: () => void }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div role="status">
        <Notice tone="success">
          <strong style={{ display: "block", marginBottom: 4 }}>{message}</strong>
          Lo enviamos a <strong>{email}</strong>. Abrí el link desde cualquier dispositivo para confirmar tu cuenta
          y seguir con el alta del consultorio.
        </Notice>
      </div>
      <ResendVerification email={email} label="Reenviar el email" startCooling />
      <p style={{ fontSize: 12, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>
        ¿No llega? Revisá spam o promociones. Si ya tenías cuenta con ese email, no te llega un mail nuevo:{" "}
        <Link href="/login" style={{ color: "var(--sky-700)", fontWeight: 600 }}>ingresá</Link> o{" "}
        <Link href="/forgot" style={{ color: "var(--sky-700)", fontWeight: 600 }}>recuperá tu contraseña</Link>.
      </p>
      <div style={{ fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
        ¿Email equivocado?{" "}
        <button
          type="button"
          onClick={onBack}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--sky-700)", fontWeight: 600 }}
        >
          Volver
        </button>
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

function Notice({
  tone,
  role,
  children,
}: {
  tone: "success" | "error";
  role?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role={role}
      style={{
        padding: 12,
        borderRadius: 12,
        background: tone === "success" ? "rgba(200,245,100,0.18)" : "rgba(228,70,70,0.1)",
        color: tone === "success" ? "var(--navy-900)" : "#9F1F1F",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
