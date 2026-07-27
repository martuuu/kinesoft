import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { PhotoSlot } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconArrow, IconCheck } from "@/components/ui/icons";

export function LoginScreen({ error }: { error?: string } = {}) {
  return (
    <div
      className="k-app"
      data-screen-label="Login"
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

      {/* Brand panel */}
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
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--navy-900)",
              }}
            />
            Plataforma para kinesiólogos
          </Tag>
          <h1
            className="k-display"
            style={{ fontSize: 56, lineHeight: 1.02, margin: "0 0 18px" }}
          >
            Acompañá la
            <br />
            recuperación de tus
            <br />
            pacientes, sesión
            <br />a sesión.
          </h1>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.55,
              color: "var(--navy-500)",
              margin: 0,
              maxWidth: 420,
            }}
          >
            Agenda, historia clínica, planes de ejercicios y seguimiento — todo en
            un mismo lugar, pensado para la práctica kinésica.
          </p>
        </div>

        <div
          className="k-glass"
          style={{
            marginTop: 56,
            padding: 16,
            borderRadius: 20,
            maxWidth: 380,
            display: "flex",
            alignItems: "center",
            gap: 14,
          }}
        >
          <PhotoSlot
            label="kine + paciente"
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                lineHeight: 1.4,
                color: "var(--navy-700)",
                fontWeight: 500,
              }}
            >
              “Bajamos el tiempo administrativo a la mitad. Tengo todas las
              sesiones de mis pacientes a mano.”
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--navy-300)",
                marginTop: 4,
              }}
            >
              Lic. Camila Rossi · Centro Movare, Rosario
            </div>
          </div>
        </div>

        <div style={{ marginTop: 28, fontSize: 12, color: "var(--navy-300)" }}>
          © 2026 KineSoft · Buenos Aires, Argentina
        </div>
      </div>

      {/* Form card */}
      <div
        className="login-form-wrap"
        style={{
          width: 540,
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
            maxWidth: 460,
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
            Bienvenido de vuelta
          </div>
          <h2 className="k-display" style={{ fontSize: 32, margin: "0 0 28px", lineHeight: 1.1 }}>
            Ingresá a tu consultorio
          </h2>

          {error && (
            <div
              role="alert"
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(228,70,70,0.1)",
                color: "#9F1F1F",
                fontSize: 12,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <form action="/api/auth/sign-in" method="post" autoComplete="on">
            <Field label="Email profesional">
              <input
                type="email"
                name="email"
                required
                defaultValue=""
                placeholder="camila.rossi@movare.com.ar"
                style={inputStyle}
              />
            </Field>

            <Field label="Contraseña">
              <input
                type="password"
                name="password"
                required
                placeholder="••••••••••"
                style={inputStyle}
              />
            </Field>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 24,
                marginTop: 12,
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "var(--navy-500)",
                }}
              >
                <input type="checkbox" name="remember" defaultChecked style={{ display: "none" }} />
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 5,
                    background: "var(--sky-700)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                  }}
                >
                  <IconCheck size={11} stroke={3} />
                </span>
                Mantenerme conectada
              </label>
              <Link href="/forgot" style={{ fontSize: 13, color: "var(--sky-700)", fontWeight: 600 }}>
                ¿Olvidaste tu clave?
              </Link>
            </div>

            <Button
              variant="primary"
              type="submit"
              style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
            >
              Ingresar a KineSoft <IconArrow size={16} />
            </Button>
          </form>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "22px 0",
              color: "var(--navy-200)",
              fontSize: 11,
            }}
          >
            <span style={{ flex: 1, height: 1, background: "rgba(15,30,51,0.08)" }} />
            o continuá con
            <span style={{ flex: 1, height: 1, background: "rgba(15,30,51,0.08)" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <form action="/api/auth/google" method="post">
              <Button variant="ghost" type="submit" style={{ justifyContent: "center", fontSize: 13, width: "100%" }}>
                <span style={{ fontWeight: 700, color: "#4285F4" }}>G</span> Google
              </Button>
            </form>
            <Button variant="ghost" style={{ justifyContent: "center", fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>⏵</span> Matrícula
            </Button>
          </div>

          <div style={{ marginTop: 28, fontSize: 13, color: "var(--navy-500)", textAlign: "center" }}>
            ¿Sos nuevo acá?{" "}
            <Link href="/signup" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              Creá tu consultorio →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 8,
  padding: "14px 16px",
  borderRadius: 14,
  background: "rgba(255,255,255,0.6)",
  border: "1px solid rgba(15,30,51,0.08)",
  display: "block",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 18 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>{label}</span>
      {children}
    </label>
  );
}
