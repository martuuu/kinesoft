/**
 * Marco del stepper de alta (A3c-S-signup): logo, riel de pasos y la tarjeta
 * del paso. Mismo fondo que las pantallas de auth (gradientes sky/lime sobre
 * `--bg-app`) para que el alta se sienta continuación del signup.
 *
 * Mobile: el riel vertical pasa a una barra de progreso + "Paso N de 9" arriba
 * de la tarjeta (clases `onb-*` abajo; sin CSS global nuevo).
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconCheck } from "@/components/ui/icons";
import { ONBOARDING_STEPS } from "@/lib/onboarding-logic";

export function OnboardingShell({
  current,
  maxReachable,
  children,
}: {
  /** Paso actual (1-9, `STEP`). null = pantallas previas al stepper (invitaciones, sin verificar). */
  current: number | null;
  /** Último paso al que se puede saltar desde el riel (los anteriores ya tienen datos). */
  maxReachable?: number;
  children: React.ReactNode;
}) {
  const total = ONBOARDING_STEPS.length;
  return (
    <div
      className="k-app"
      style={{ minHeight: "100vh", background: "var(--bg-app)", position: "relative", overflow: "hidden" }}
    >
      <style>{`
        .onb-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 32px; max-width: 1040px; margin: 0 auto; padding: 32px 24px 64px; position: relative; z-index: 2; }
        .onb-rail { display: flex; flex-direction: column; gap: 4px; position: sticky; top: 32px; align-self: start; }
        .onb-mobile-progress { display: none; }
        @media (max-width: 760px) {
          .onb-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 20px 16px 48px; }
          .onb-rail { display: none; }
          .onb-mobile-progress { display: block; }
          .onb-card { padding: 22px 18px !important; }
        }
      `}</style>
      <div
        aria-hidden
        style={{
          position: "absolute", top: -120, right: -80, width: 460, height: 460, borderRadius: "50%",
          background: "radial-gradient(circle, var(--sky-300), transparent 70%)", opacity: 0.55, filter: "blur(10px)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute", bottom: -160, left: -120, width: 520, height: 520, borderRadius: "50%",
          background: "radial-gradient(circle, var(--lime-300), transparent 65%)", opacity: 0.35, filter: "blur(20px)",
        }}
      />
      <div className="onb-grid">
        <div style={{ gridColumn: "1 / -1" }}>
          <KineLogo size={28} />
        </div>

        {current != null && (
          <>
            <nav className="onb-rail" aria-label="Pasos del alta">
              {ONBOARDING_STEPS.map((s) => {
                const done = s.n < current;
                const active = s.n === current;
                const reachable = s.n >= 2 && s.n <= (maxReachable ?? current) && !active;
                const dot = (
                  <span
                    style={{
                      width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                      display: "inline-flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700,
                      background: active ? "var(--sky-700)" : done ? "var(--lime-300)" : "rgba(15,30,51,0.06)",
                      color: active ? "#fff" : "var(--navy-900)",
                    }}
                  >
                    {done ? <IconCheck size={12} stroke={3} /> : s.n}
                  </span>
                );
                const body = (
                  <>
                    {dot}
                    <span style={{ fontSize: 13, fontWeight: active ? 700 : 500, color: active ? "var(--navy-900)" : "var(--navy-500)" }}>
                      {s.label}
                    </span>
                  </>
                );
                const style: React.CSSProperties = {
                  display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12,
                  background: active ? "rgba(255,255,255,0.7)" : "transparent", textDecoration: "none",
                };
                return reachable ? (
                  <Link key={s.n} href={`/onboarding?step=${s.n}`} style={style}>
                    {body}
                  </Link>
                ) : (
                  <div key={s.n} style={style} aria-current={active ? "step" : undefined}>
                    {body}
                  </div>
                );
              })}
            </nav>
            <div className="onb-mobile-progress">
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}>
                Paso {current} de {total} · {ONBOARDING_STEPS[current - 1]?.label}
              </div>
              <div style={{ height: 6, borderRadius: 999, background: "rgba(15,30,51,0.08)", overflow: "hidden" }}>
                <div style={{ width: `${(current / total) * 100}%`, height: "100%", background: "var(--sky-700)" }} />
              </div>
            </div>
          </>
        )}

        <main
          className="k-glass-strong onb-card"
          style={{
            gridColumn: current == null ? "1 / -1" : undefined,
            maxWidth: current == null ? 560 : undefined,
            width: "100%",
            margin: current == null ? "0 auto" : undefined,
            padding: 36,
            borderRadius: "var(--r-2xl)",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Encabezado estándar de cada paso. */
export function StepHeader({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb?: string }) {
  return (
    <header style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 12, fontWeight: 600, color: "var(--sky-700)", letterSpacing: "0.06em",
          textTransform: "uppercase", marginBottom: 8,
        }}
      >
        {eyebrow}
      </div>
      <h1 className="k-display" style={{ fontSize: 28, margin: 0, lineHeight: 1.1 }}>
        {title}
      </h1>
      {blurb && (
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: "10px 0 0", lineHeight: 1.55, maxWidth: 560 }}>
          {blurb}
        </p>
      )}
    </header>
  );
}
