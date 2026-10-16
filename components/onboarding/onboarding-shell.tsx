/**
 * Marco del stepper de alta (A3c-S-signup): logo, riel de pasos y la tarjeta
 * del paso. Mismo fondo que las pantallas de auth (gradientes sky/lime sobre
 * `--bg-app`) para que el alta se sienta continuación del signup.
 *
 * Mobile (< 768): el riel vertical pasa a una barra de progreso + "Paso N de M"
 * arriba de la tarjeta. VX2-e: estilos en `onboarding.module.css` (antes un
 * `<style>` inline con clases `onb-*` globales) y el riel sale de
 * `onboardingStepsFor`: un Titular que no atiende no ve «Tu horario» y su
 * cuenta es «de 8», no «de 9».
 */
import Link from "next/link";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconCheck } from "@/components/ui/icons";
import { onboardingStepsFor } from "@/lib/onboarding-logic";
import { OnboardingFlowProvider } from "./step-nav";
import s from "./onboarding.module.css";

export function OnboardingShell({
  current,
  maxReachable,
  ownerClinical = true,
  children,
}: {
  /** Paso actual (`STEP`, la clave de `?step=`). null = pantallas previas al stepper (invitaciones, sin verificar). */
  current: number | null;
  /** Último paso al que se puede saltar desde el riel (los anteriores ya tienen datos). */
  maxReachable?: number;
  /** VX2-e: el Titular atiende pacientes (tiene Practitioner). false = alta sin «Tu horario». */
  ownerClinical?: boolean;
  children: React.ReactNode;
}) {
  const steps = onboardingStepsFor({ ownerClinical });
  const total = steps.length;
  const position = current == null ? -1 : steps.findIndex((st) => st.n === current);
  return (
    <div className={`k-app ${s.root}`}>
      <div aria-hidden className={s.haloSky} />
      <div aria-hidden className={s.haloLime} />
      <div className={s.grid}>
        <div className={s.brand}>
          <KineLogo size={28} />
        </div>

        {current != null && (
          <>
            <nav className={s.rail} aria-label="Pasos del alta">
              {steps.map((st, i) => {
                const done = st.n < current;
                const active = st.n === current;
                const reachable = st.n >= 2 && st.n <= (maxReachable ?? current) && !active;
                const body = (
                  <>
                    <span className={`${s.dot} ${active ? s.dotActive : done ? s.dotDone : ""}`}>
                      {done ? <IconCheck size={12} stroke={3} /> : i + 1}
                    </span>
                    <span>{st.label}</span>
                  </>
                );
                const cls = `${s.railItem} ${active ? s.railItemActive : ""}`;
                return reachable ? (
                  <Link key={st.n} href={`/onboarding?step=${st.n}`} className={cls}>
                    {body}
                  </Link>
                ) : (
                  <div key={st.n} className={cls} aria-current={active ? "step" : undefined}>
                    {body}
                  </div>
                );
              })}
            </nav>
            {position >= 0 && (
              <div className={s.mobileProgress}>
                <div className={s.mobileLabel}>
                  Paso {position + 1} de {total} · {steps[position].label}
                </div>
                <div className={s.bar}>
                  <div className={s.barFill} style={{ width: `${((position + 1) / total) * 100}%` }} />
                </div>
              </div>
            )}
          </>
        )}

        <main className={`k-glass-strong ${s.card} ${current == null ? s.cardSolo : ""}`}>
          <OnboardingFlowProvider ownerClinical={ownerClinical}>{children}</OnboardingFlowProvider>
        </main>
      </div>
    </div>
  );
}

/** Encabezado estándar de cada paso. */
export function StepHeader({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb?: React.ReactNode }) {
  return (
    <header className={s.header}>
      <div className={s.eyebrow}>{eyebrow}</div>
      <h1 className={`k-display ${s.title}`}>{title}</h1>
      {blurb && <p className={s.blurb}>{blurb}</p>}
    </header>
  );
}
