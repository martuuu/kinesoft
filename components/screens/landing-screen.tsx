import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import {
  IconArrow,
  IconCal,
  IconActivity,
  IconHeart,
  IconHome,
  IconUsers,
  IconDumbbell,
  IconFile,
  IconCheck,
  IconPlay,
} from "@/components/ui/icons";
import type { CSSProperties, ReactNode } from "react";

export function LandingScreen() {
  return (
    <div
      className="k-app landing-root"
      style={{
        background: "var(--bg-app)",
        overflow: "hidden",
        position: "relative",
        minHeight: "100vh",
      }}
    >
      <LandingNav />
      <LandingHero />
      <LandingStats />
      <LandingFeatures />
      <LandingHow />
      <LandingPricing />
      <LandingTestimonials />
      <LandingCTA />
      <LandingFooter />
    </div>
  );
}

function LandingNav() {
  return (
    <header
      className="k-glass landing-nav"
      style={{
        position: "absolute",
        top: 20,
        left: 60,
        right: 60,
        zIndex: 10,
        padding: "12px 16px 12px 24px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        gap: 28,
      }}
    >
      <KineLogo size={28} />
      <nav className="landing-nav-links" style={{ display: "flex", gap: 4, marginLeft: 12 }}>
        {["Producto", "Funciones", "Precios", "Para clínicas", "Recursos"].map((x) => (
          <span
            key={x}
            style={{ padding: "8px 14px", fontSize: 13.5, color: "var(--navy-700)", fontWeight: 500 }}
          >
            {x}
          </span>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      <Link href="/login" style={{ fontSize: 13.5, color: "var(--navy-700)", fontWeight: 600 }}>
        Ingresar
      </Link>
      <Button variant="primary" style={{ fontSize: 13, padding: "9px 18px" }}>
        Probar gratis <IconArrow size={14} />
      </Button>
    </header>
  );
}

function LandingHero() {
  return (
    <section className="landing-hero" style={{ position: "relative", padding: "140px 60px 60px", minHeight: 760 }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "clamp(96px, 18vw, 280px)",
          fontWeight: 800,
          letterSpacing: "-0.06em",
          color: "rgba(31, 79, 190, 0.06)",
          lineHeight: 0.85,
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        KINESOFT
      </div>

      <div
        className="landing-hero-grid"
        style={{
          position: "relative",
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 60,
          alignItems: "center",
          maxWidth: 1320,
          margin: "0 auto",
        }}
      >
        <div>
          <Tag tone="lime" className="mb-6">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
            Diseñado por y para kinesiólogos
          </Tag>
          <h1
            className="k-display landing-hero-title"
            style={{ fontSize: 72, lineHeight: 0.98, margin: "0 0 22px", letterSpacing: "-0.035em" }}
          >
            Tu consultorio,
            <br />
            <span style={{ color: "var(--sky-700)" }}>simple</span> y
            <br />
            <span style={{ position: "relative" }}>
              en un solo lugar
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  bottom: 4,
                  left: 0,
                  right: 0,
                  height: 14,
                  background: "var(--lime-300)",
                  zIndex: -1,
                  borderRadius: 4,
                }}
              />
            </span>
            .
          </h1>
          <p
            style={{
              fontSize: 18,
              lineHeight: 1.55,
              color: "var(--navy-500)",
              margin: "0 0 30px",
              maxWidth: 460,
            }}
          >
            Agenda, historia clínica, planes de ejercicios y seguimiento por sesión. KineSoft acompaña la
            recuperación de tus pacientes desde la primera consulta hasta el alta.
          </p>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="primary" style={{ padding: "14px 22px", fontSize: 14 }}>
              Empezar gratis 14 días <IconArrow size={15} />
            </Button>
            <Button variant="ghost" style={{ padding: "14px 22px", fontSize: 14 }}>
              <IconPlay size={12} /> Ver demo (2 min)
            </Button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 36 }}>
            <div style={{ display: "flex" }}>
              {["LR", "MC", "EP", "LB"].map((n, i) => (
                <Avatar
                  key={n}
                  name={n}
                  size={36}
                  tone={i % 2 ? "lime" : "sky"}
                  style={{
                    marginLeft: i === 0 ? 0 : -10,
                    border: "2px solid #fff",
                  }}
                />
              ))}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>+1.200 kinesiólogos</div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>ya están usando KineSoft en Argentina</div>
            </div>
          </div>
        </div>

        <div className="landing-hero-preview" style={{ position: "relative", height: 520 }}>
          <MiniDashCard />
          <FloatingChip top={-12} right={20} icon={<IconCal size={14} />}>
            <b>7 sesiones hoy</b>
            <br />
            <span style={{ opacity: 0.6 }}>2 nuevos pacientes</span>
          </FloatingChip>
          <FloatingChip bottom={20} left={-30} icon={<IconActivity size={14} />} accent="lime">
            <b>92% adherencia</b>
            <br />
            <span style={{ opacity: 0.6 }}>este mes</span>
          </FloatingChip>
          <FloatingChip bottom={120} right={-20} icon={<IconHeart size={14} />}>
            <b>+ 142 HC activas</b>
          </FloatingChip>
        </div>
      </div>
    </section>
  );
}

function FloatingChip({
  children,
  icon,
  top,
  left,
  right,
  bottom,
  accent,
}: {
  children: ReactNode;
  icon: ReactNode;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  accent?: "lime";
}) {
  return (
    <div
      className="k-glass-strong"
      style={{
        position: "absolute",
        top,
        left,
        right,
        bottom,
        padding: "10px 14px",
        borderRadius: 14,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 11.5,
        color: "var(--navy-700)",
        lineHeight: 1.35,
        boxShadow: "0 12px 30px rgba(31,79,190,0.18)",
      }}
    >
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background:
            accent === "lime"
              ? "var(--lime-300)"
              : "linear-gradient(135deg, var(--sky-700), var(--sky-500))",
          color: accent === "lime" ? "var(--navy-900)" : "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

function MiniDashCard() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 24,
        overflow: "hidden",
        background: "#fff",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.8) inset, 0 30px 60px rgba(31,79,190,0.25), 0 12px 24px rgba(15,30,51,0.08)",
        border: "1px solid rgba(255,255,255,0.7)",
        transform: "rotate(2deg)",
      }}
    >
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 16px",
          borderBottom: "1px solid rgba(15,30,51,0.05)",
          background: "rgba(246,249,253,0.7)",
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: 5, background: "#FF5F57" }} />
        <span style={{ width: 9, height: 9, borderRadius: 5, background: "#FEBC2E" }} />
        <span style={{ width: 9, height: 9, borderRadius: 5, background: "#28C840" }} />
        <span
          className="k-mono"
          style={{ marginLeft: 14, fontSize: 10, color: "var(--navy-300)" }}
        >
          app.kinesoft.com.ar/agenda
        </span>
      </div>
      <div style={{ display: "flex", height: "calc(100% - 36px)" }}>
        <div
          style={{
            width: 56,
            background: "var(--bg-panel)",
            borderRight: "1px solid rgba(15,30,51,0.04)",
            padding: "14px 0",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            alignItems: "center",
          }}
        >
          {[IconHome, IconCal, IconUsers, IconActivity, IconDumbbell].map((I, i) => (
            <span
              key={i}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: i === 1 ? "var(--sky-700)" : "transparent",
                color: i === 1 ? "#fff" : "var(--navy-300)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <I size={15} />
            </span>
          ))}
        </div>
        <div style={{ flex: 1, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--navy-300)" }}>Agenda · Hoy</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Jueves 14 · 7 turnos</div>
            </div>
            <Tag tone="lime" className="text-[9px]">
              EN VIVO
            </Tag>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { n: 6, d: "L", on: false },
              { n: 5, d: "M", on: false },
              { n: 7, d: "M", on: false },
              { n: 7, d: "J", on: true },
              { n: 8, d: "V", on: false },
              { n: 3, d: "S", on: false },
            ].map((d, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  padding: "6px 4px",
                  borderRadius: 8,
                  textAlign: "center",
                  background: d.on ? "var(--sky-700)" : "rgba(246,249,253,0.7)",
                  color: d.on ? "#fff" : "var(--navy-700)",
                }}
              >
                <div style={{ fontSize: 9, opacity: 0.7 }}>{d.d}</div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{d.n}</div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minHeight: 0 }}>
            {[
              { t: "09:30", n: "Martín Aguirre", c: "Lumbar", tone: "sky" as const },
              { t: "10:15", n: "Sofía Linares", c: "Rodilla", tone: "lime" as const, now: true },
              { t: "11:00", n: "Marta Costa", c: "Tobillo", tone: "sky" as const },
              { t: "12:30", n: "Eugenio Paz", c: "Post-LCA", tone: "navy" as const },
              { t: "14:00", n: "Laura Báez", c: "Cervical", tone: "sky" as const },
            ].map((a, i) => (
              <div
                key={i}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: a.now
                    ? "linear-gradient(90deg, rgba(200,245,100,0.25), transparent 60%)"
                    : "rgba(246,249,253,0.7)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span
                  className="k-mono"
                  style={{ fontSize: 10, fontWeight: 600, color: "var(--sky-700)", width: 38 }}
                >
                  {a.t}
                </span>
                <Avatar name={a.n} size={22} tone={a.tone} />
                <span style={{ fontSize: 11, fontWeight: 600, flex: 1 }}>{a.n}</span>
                <span style={{ fontSize: 9, color: "var(--navy-300)" }}>{a.c}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LandingStats() {
  const stats: [string, string][] = [
    ["+1.200", "Kinesiólogos activos"],
    ["+38.000", "Sesiones registradas/mes"],
    ["92%", "Adherencia promedio"],
    ["324", "Ejercicios pre-cargados"],
  ];
  return (
    <section style={{ padding: "0 60px" }}>
      <div
        className="k-glass-strong landing-stats"
        style={{
          margin: "0 auto",
          maxWidth: 1320,
          padding: "32px 48px",
          borderRadius: "var(--r-xl)",
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
        }}
      >
        {stats.map((s, i) => (
          <div
            key={s[0]}
            style={{
              textAlign: "center",
              padding: "0 20px",
              borderRight: i < stats.length - 1 ? "1px solid rgba(15,30,51,0.08)" : "none",
            }}
          >
            <div
              className="k-display"
              style={{
                fontSize: 40,
                fontWeight: 700,
                letterSpacing: "-0.03em",
                color: "var(--sky-700)",
              }}
            >
              {s[0]}
            </div>
            <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 4 }}>{s[1]}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingFeatures() {
  const feats: {
    icon: typeof IconCal;
    title: string;
    desc: string;
    tags: string[];
    tone: "sky" | "lime";
  }[] = [
    {
      icon: IconCal,
      title: "Agenda inteligente",
      desc: "Turnos, recordatorios automáticos por WhatsApp, vista timeline / semana / lista.",
      tags: ["Recordatorios", "Multi-consultorio", "Sincroniza Google Cal"],
      tone: "sky",
    },
    {
      icon: IconFile,
      title: "Historia clínica completa",
      desc: "Antecedentes, derivaciones, archivos, evolución por sesión. Todo encriptado.",
      tags: ["Encriptado AES-256", "Compatible AFIP", "PDF firmado"],
      tone: "lime",
    },
    {
      icon: IconDumbbell,
      title: "Biblioteca + planes",
      desc: "324 ejercicios con video, etiquetas y filtros. Armá planes en segundos.",
      tags: ["Video HD", "Búsqueda por tags", "Planes en PDF para el paciente"],
      tone: "sky",
    },
    {
      icon: IconActivity,
      title: "Seguimiento por sesión",
      desc: "Anotá lo realizado en cada sesión, progresá cargas y comparálas en el tiempo.",
      tags: ["Anotaciones rápidas", "Comparación entre sesiones", "Dictado por voz"],
      tone: "lime",
    },
  ];
  return (
    <section style={{ padding: "90px 60px 40px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div
          className="landing-feat-header"
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginBottom: 32,
            gap: 24,
          }}
        >
          <div>
            <Tag tone="lime" className="mb-3">
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
              Funciones
            </Tag>
            <h2
              className="k-display"
              style={{
                fontSize: 48,
                lineHeight: 1.02,
                letterSpacing: "-0.03em",
                margin: 0,
                maxWidth: 700,
              }}
            >
              Todo lo que necesitás para
              <br />
              tu día a día, en un solo lugar.
            </h2>
          </div>
          <p style={{ fontSize: 14, color: "var(--navy-500)", maxWidth: 320, lineHeight: 1.6, margin: 0 }}>
            Olvidate de planillas, cuadernos y apps sueltas. KineSoft junta agenda, historia clínica y planes de
            ejercicios en un flujo natural.
          </p>
        </div>
        <div className="landing-feat-grid" style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }}>
          {feats.map((f) => {
            const I = f.icon;
            return (
              <div
                key={f.title}
                className="k-glass-strong"
                style={{
                  padding: 28,
                  borderRadius: "var(--r-xl)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  minHeight: 220,
                }}
              >
                <span
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 14,
                    background:
                      f.tone === "lime"
                        ? "var(--lime-300)"
                        : "linear-gradient(135deg, var(--sky-700), var(--sky-500))",
                    color: f.tone === "lime" ? "var(--navy-900)" : "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow:
                      f.tone === "lime"
                        ? "0 6px 16px rgba(200,245,100,0.4)"
                        : "0 6px 16px rgba(31,79,190,0.3)",
                  }}
                >
                  <I size={22} />
                </span>
                <div>
                  <h3
                    className="k-display"
                    style={{ fontSize: 22, margin: "0 0 8px", fontWeight: 600, letterSpacing: "-0.02em" }}
                  >
                    {f.title}
                  </h3>
                  <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, lineHeight: 1.55 }}>{f.desc}</p>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "auto" }}>
                  {f.tags.map((t) => (
                    <Tag key={t} tone="soft">
                      {t}
                    </Tag>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function LandingHow() {
  const steps = [
    {
      n: "01",
      title: "Cargá tu agenda",
      desc: "Importá tus pacientes y horarios. Configurá tus consultorios y obras sociales.",
    },
    {
      n: "02",
      title: "Atendé como siempre",
      desc: "Durante la sesión, anotás lo realizado en 30 segundos. KineSoft arma la HC sola.",
    },
    {
      n: "03",
      title: "Asigná y compartí",
      desc: "Buscá ejercicios por tag, armá el plan y mandáselo al paciente en PDF.",
    },
  ];
  return (
    <section style={{ padding: "60px 60px 80px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div
          className="landing-how-header"
          style={{ display: "flex", alignItems: "baseline", gap: 24, marginBottom: 32, flexWrap: "wrap" }}
        >
          <Tag tone="lime">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
            Cómo funciona
          </Tag>
          <h2 className="k-display" style={{ fontSize: 36, margin: 0, letterSpacing: "-0.03em" }}>
            En tres pasos estás trabajando.
          </h2>
        </div>
        <div
          className="landing-how-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 20,
            position: "relative",
          }}
        >
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 36,
              left: "20%",
              right: "20%",
              height: 2,
              backgroundImage: "linear-gradient(90deg, var(--sky-400) 50%, transparent 50%)",
              backgroundSize: "12px 2px",
              zIndex: 0,
            }}
          />
          {steps.map((s, i) => (
            <div key={s.n} style={{ position: "relative", zIndex: 1 }}>
              <div
                className="k-mono"
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: "50%",
                  background: "#fff",
                  border: "6px solid var(--sky-100)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                  fontWeight: 700,
                  color: "var(--sky-700)",
                  marginBottom: 18,
                  position: "relative",
                }}
              >
                {s.n}
                {i === 0 && (
                  <span
                    style={{
                      position: "absolute",
                      top: -6,
                      right: -10,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "var(--lime-300)",
                      fontSize: 9,
                      fontWeight: 700,
                      color: "var(--navy-900)",
                      fontFamily: "Onest, system-ui, sans-serif",
                    }}
                  >
                    EMPEZÁS
                  </span>
                )}
              </div>
              <h3 className="k-display" style={{ fontSize: 22, margin: "0 0 8px", letterSpacing: "-0.02em" }}>
                {s.title}
              </h3>
              <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, lineHeight: 1.55, maxWidth: 320 }}>
                {s.desc}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LandingPricing() {
  const plans: {
    name: string;
    price: string;
    sub: string;
    desc: string;
    feats: string[];
    cta: string;
    tone: "ghost" | "primary" | "dark";
    featured?: boolean;
  }[] = [
    {
      name: "Solo",
      price: "$ 12.900",
      sub: "por mes",
      desc: "Para kinesiólogos independientes.",
      feats: ["1 profesional", "Agenda + HC completa", "324 ejercicios", "WhatsApp recordatorios"],
      cta: "Empezar gratis",
      tone: "ghost",
    },
    {
      name: "Estudio",
      price: "$ 19.900",
      sub: "por mes / profesional",
      desc: "Para consultorios con 2-5 profesionales.",
      feats: ["Hasta 5 profesionales", "Multi-consultorio", "Reportes consolidados", "Soporte prioritario"],
      cta: "Probar Estudio",
      tone: "primary",
      featured: true,
    },
    {
      name: "Clínica",
      price: "A medida",
      sub: "según equipo",
      desc: "Para centros con +5 profesionales.",
      feats: ["Profesionales ilimitados", "Onboarding asistido", "Integración con HIS", "SSO + auditoría"],
      cta: "Hablar con ventas",
      tone: "dark",
    },
  ];

  const ctaStyle = (tone: "ghost" | "primary" | "dark"): CSSProperties =>
    tone === "primary"
      ? {}
      : tone === "dark"
        ? { background: "var(--navy-900)", color: "#fff" }
        : {};

  return (
    <section style={{ padding: "60px 60px 80px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <Tag tone="lime" className="mb-3">
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--navy-900)" }} />
            Precios
          </Tag>
          <h2 className="k-display" style={{ fontSize: 44, margin: "0 0 10px", letterSpacing: "-0.03em" }}>
            Planes simples, sin sorpresas.
          </h2>
          <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0 }}>
            14 días gratis · sin tarjeta · cancelás cuando quieras
          </p>
        </div>
        <div className="landing-pricing-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {plans.map((p) => (
            <div
              key={p.name}
              className={p.featured ? "k-glass-strong" : ""}
              style={{
                padding: 28,
                borderRadius: "var(--r-xl)",
                position: "relative",
                background: p.featured ? undefined : "#fff",
                boxShadow: p.featured ? "0 24px 50px rgba(31,79,190,0.22)" : "var(--shadow-card)",
                transform: p.featured ? "translateY(-12px)" : "none",
                border: p.featured ? "1px solid rgba(255,255,255,0.85)" : "1px solid rgba(15,30,51,0.06)",
              }}
            >
              {p.featured && (
                <span
                  style={{
                    position: "absolute",
                    top: -12,
                    left: 28,
                    padding: "4px 10px",
                    borderRadius: 999,
                    background: "var(--lime-300)",
                    color: "var(--navy-900)",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                  }}
                >
                  MÁS ELEGIDO
                </span>
              )}
              <div className="k-display" style={{ fontSize: 22, fontWeight: 600, marginBottom: 6 }}>
                {p.name}
              </div>
              <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 22px" }}>{p.desc}</p>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 22 }}>
                <span
                  className="k-display"
                  style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em" }}
                >
                  {p.price}
                </span>
                <span style={{ fontSize: 12, color: "var(--navy-300)" }}>{p.sub}</span>
              </div>
              <Button
                variant={p.tone === "primary" ? "primary" : "ghost"}
                style={{
                  width: "100%",
                  justifyContent: "center",
                  padding: "12px",
                  fontSize: 13,
                  marginBottom: 22,
                  ...ctaStyle(p.tone),
                }}
              >
                {p.cta} <IconArrow size={13} />
              </Button>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {p.feats.map((f) => (
                  <div
                    key={f}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      fontSize: 13,
                      color: "var(--navy-700)",
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        background: "var(--sky-100)",
                        color: "var(--sky-700)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <IconCheck size={11} stroke={3} />
                    </span>
                    {f}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LandingTestimonials() {
  const tests: { name: string; role: string; t: "lime" | "sky" | "navy"; quote: string }[] = [
    {
      name: "Lic. Camila Rossi",
      role: "Centro Movare · Rosario",
      t: "lime",
      quote:
        "Bajamos el tiempo administrativo a la mitad. Tengo todas las sesiones de mis pacientes a mano y los planes salen en PDF en minutos.",
    },
    {
      name: "Lic. Federico Quiroga",
      role: "Consultorio propio · CABA",
      t: "sky",
      quote:
        "Lo que más me sirvió fue la biblioteca de ejercicios. Búsqueda por tag y listo, no pierdo tiempo escribiendo planes desde cero.",
    },
    {
      name: "Lic. Mariana Soler",
      role: "Kineflex · Mendoza",
      t: "navy",
      quote:
        "El seguimiento por sesión me cambió la forma de trabajar. Veo la evolución del paciente de una sola mirada.",
    },
  ];
  return (
    <section style={{ padding: "40px 60px 80px" }}>
      <div style={{ maxWidth: 1320, margin: "0 auto" }}>
        <h2
          className="k-display"
          style={{
            fontSize: 36,
            margin: "0 0 32px",
            letterSpacing: "-0.03em",
            textAlign: "center",
          }}
        >
          Lo que dicen los kinesiólogos que ya lo usan.
        </h2>
        <div className="landing-testimonials" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
          {tests.map((t) => (
            <div
              key={t.name}
              className="k-glass"
              style={{
                padding: 24,
                borderRadius: "var(--r-xl)",
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}
            >
              <div style={{ fontSize: 56, color: "var(--sky-400)", lineHeight: 0.5, fontFamily: "serif" }}>“</div>
              <p
                style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--navy-700)", margin: 0, flex: 1 }}
              >
                {t.quote}
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  paddingTop: 12,
                  borderTop: "1px solid rgba(15,30,51,0.06)",
                }}
              >
                <Avatar name={t.name} size={40} tone={t.t} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{t.name}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{t.role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LandingCTA() {
  return (
    <section style={{ padding: "0 60px 60px" }}>
      <div
        className="landing-cta"
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          padding: "60px",
          borderRadius: "var(--r-2xl)",
          position: "relative",
          overflow: "hidden",
          background:
            "linear-gradient(135deg, var(--navy-900) 0%, var(--sky-800) 60%, var(--sky-700) 100%)",
          color: "#fff",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: -100,
            right: -100,
            width: 400,
            height: 400,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(200,245,100,0.3), transparent 60%)",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            bottom: -120,
            left: 120,
            width: 320,
            height: 320,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(31,79,190,0.4), transparent 60%)",
          }}
        />
        <div
          className="landing-cta-grid"
          style={{
            position: "relative",
            zIndex: 2,
            display: "grid",
            gridTemplateColumns: "1.4fr 1fr",
            alignItems: "center",
            gap: 40,
          }}
        >
          <div>
            <span
              className="k-tag"
              style={{
                background: "rgba(255,255,255,0.15)",
                color: "#fff",
                marginBottom: 18,
                display: "inline-flex",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--lime-300)" }} />
              Empezá hoy mismo
            </span>
            <h2
              className="k-display"
              style={{ fontSize: 56, lineHeight: 1, margin: "0 0 14px", letterSpacing: "-0.035em" }}
            >
              Probá KineSoft
              <br />
              14 días gratis.
            </h2>
            <p
              style={{
                fontSize: 16,
                color: "rgba(255,255,255,0.75)",
                maxWidth: 500,
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              Sin tarjeta. Configurás tu consultorio en 10 minutos. Después decidís si te quedás.
            </p>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Button variant="lime" style={{ padding: "16px 22px", fontSize: 15, justifyContent: "center" }}>
              Crear mi consultorio gratis <IconArrow size={15} />
            </Button>
            <button
              className="k-btn"
              style={{
                background: "rgba(255,255,255,0.1)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.2)",
                padding: "16px 22px",
                fontSize: 14,
                justifyContent: "center",
              }}
            >
              Agendar demo de 20 min
            </button>
            <div
              style={{
                fontSize: 12,
                color: "rgba(255,255,255,0.6)",
                textAlign: "center",
                marginTop: 4,
              }}
            >
              ✓ Soporte en español · ✓ Servidores en Argentina · ✓ Datos encriptados
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LandingFooter() {
  const cols: [string, string[]][] = [
    ["Producto", ["Funciones", "Precios", "Cambios", "Roadmap"]],
    ["Recursos", ["Centro de ayuda", "Guías", "Blog", "Academia"]],
    ["Empresa", ["Sobre nosotros", "Trabajá con nosotros", "Prensa"]],
    ["Legal", ["Términos", "Privacidad", "HIPAA / Ley 25.326"]],
  ];
  return (
    <footer style={{ padding: "40px 60px 50px", borderTop: "1px solid rgba(15,30,51,0.06)" }}>
      <div
        className="landing-footer-grid"
        style={{
          maxWidth: 1320,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
          gap: 40,
        }}
      >
        <div>
          <KineLogo size={26} />
          <p
            style={{
              fontSize: 13,
              color: "var(--navy-500)",
              maxWidth: 280,
              marginTop: 14,
              lineHeight: 1.55,
            }}
          >
            La plataforma de gestión integral para kinesiólogos en Argentina.
          </p>
        </div>
        {cols.map((col) => (
          <div key={col[0]}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--navy-900)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginBottom: 14,
              }}
            >
              {col[0]}
            </div>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              {col[1].map((it) => (
                <li key={it} style={{ fontSize: 13, color: "var(--navy-500)" }}>
                  {it}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div
        style={{
          maxWidth: 1320,
          margin: "40px auto 0",
          paddingTop: 24,
          borderTop: "1px solid rgba(15,30,51,0.06)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 12,
          color: "var(--navy-300)",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <span>© 2026 KineSoft S.A. · Buenos Aires, Argentina · CUIT 30-71…</span>
        <span>Hecho con 💚 para kinesiólogos.</span>
      </div>
    </footer>
  );
}
