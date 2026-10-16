"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { SocialButtons } from "@/components/auth/social-buttons";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { IconAlert, IconArrow, IconCheckCircle } from "@/components/ui/icons";
import { signUpPractitioner } from "@/lib/auth";
import type { OAuthProvider } from "@/lib/oauth-start";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { signupTrialCopy } from "@/components/screens/auth-feedback";
import { ResendVerification } from "@/components/screens/resend-verification";
import st from "./auth-screens.module.css";

/**
 * Paso 1 del alta: la cuenta (A3c-S-signup). Solo nombre, email y contraseña: el consultorio se carga en
 * `/onboarding` DESPUÉS de verificar el email (antes se creaba todo acá, sin verificar nada — H5).
 *
 * IAM-2d: ya no hay modo «unión por invitación» (la page manda `?invite=` a `/invite/<token>`). Si igual la
 * action devuelve `redirectTo` (contrato de IAM-2c: solo con invitación), se sigue ese destino y NO se
 * muestra «te mandamos un email»: ese era el bug del QA del 14-oct (§19.1 #4), la pantalla prometía un mail
 * que nunca salía.
 *
 * VX2-a (`design_source/vx0/signup.html`): AuthShell `split` (intro + card + puntos). Sin el radio «Tu consultorio
 * es de» del prototipo (D-VX14): la vertical se elige en el paso 1 del onboarding y el alta con Google/Facebook no
 * pasaría por ese radio. Los días de prueba (`trialDays`) salen del catálogo público (los lee la page).
 */
export function SignupScreen({
  assisted,
  providers = [],
  trialDays = PLAN_DEFAULTS.INDIVIDUAL.trialDays,
}: {
  assisted?: { message: string; mailto: string | null };
  providers?: readonly OAuthProvider[];
  trialDays?: number;
} = {}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});
  const [sentTo, setSentTo] = useState<{ email: string; message: string } | null>(null);
  // Lo tipeado, para que «¿Email equivocado? Volver» no obligue a escribir todo de nuevo.
  const [draft, setDraft] = useState({ fullName: "", email: "" });

  if (assisted) {
    // BO-Z (BO-D11): sin form ni sociales (el server rechaza el alta igual): una card centrada con el canal.
    return (
      <AuthShell variant="centered" footerLinks={[{ label: "Ingresar", href: "/login" }]}>
        <SignupAssisted message={assisted.message} mailto={assisted.mailto} />
      </AuthShell>
    );
  }

  const copy = signupTrialCopy(trialDays);

  const onSubmit = (formData: FormData) => {
    if (pending) return;
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
    <AuthShell
      variant="split"
      introAs="p"
      eyebrow={copy.eyebrow}
      heading="Empezá hoy con tu consultorio."
      blurb="Agenda, turnos online, historia clínica y cobros, con las herramientas de kinesiología incluidas."
      aside={<SignupPoints firstPoint={copy.firstPoint} />}
    >
      <div className={st.stack} data-screen-label="Signup">
        {sentTo ? (
          <>
            <div className={st.head}>
              <h1 className={st.title}>Revisá tu email</h1>
              <p className={st.sub}>
                Abrí el link del email para confirmar tu cuenta. Después cargás los datos de tu consultorio.
              </p>
            </div>
            <SignupSent email={sentTo.email} message={sentTo.message} onBack={() => setSentTo(null)} />
          </>
        ) : (
          <>
            <div className={st.head}>
              <h1 className={st.title}>Creá tu consultorio</h1>
              <p className={st.sub}>{copy.cardSub}</p>
            </div>

            {providers.length > 0 && (
              <>
                {/* Alta con Google/Facebook: el callback crea la cuenta ya verificada y sigue al onboarding. */}
                <SocialButtons providers={providers} next="/onboarding" className={st.social} />
                <div className="k-divider">o con tu email</div>
              </>
            )}

            <form action={onSubmit} className={st.fields}>
              {error && (
                <div className="k-alert" role="alert">
                  <IconAlert size={18} />
                  <span>{error}</span>
                </div>
              )}
              <Field id="signup-name" label="Nombre y apellido" error={fieldErrors.fullName?.[0]}>
                <input
                  className="k-input k-input-lg"
                  type="text"
                  name="fullName"
                  autoComplete="name"
                  required
                  defaultValue={draft.fullName}
                />
              </Field>

              <Field id="signup-email" label="Email" error={fieldErrors.email?.[0]}>
                <input
                  className="k-input k-input-lg"
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  defaultValue={draft.email}
                  placeholder="nombre@ejemplo.com"
                />
              </Field>

              {/* El hint dice la regla entera de `NewPassword` (lib/validation.ts: 8+, una letra y un número): el
                  «Al menos 8 caracteres.» del prototipo dejaba pasar «12345678» y el error llegaba recién al enviar. */}
              <Field
                id="signup-password"
                label="Contraseña"
                hint="Al menos 8 caracteres, con una letra y un número."
                error={fieldErrors.password?.[0]}
              >
                <PasswordInput name="password" autoComplete="new-password" required minLength={8} large />
              </Field>

              <AuthSubmit label="Crear cuenta" busyLabel="Creando tu cuenta…" pending={pending} />
            </form>

            <p className={st.foot}>
              ¿Ya tenés cuenta?{" "}
              <Link href="/login" className="k-link">
                Ingresá
              </Link>
            </p>
          </>
        )}
      </div>
    </AuthShell>
  );
}

/** Los puntos del split (`signup.html`): qué implica la prueba, sin prometer nada que la app no haga. */
function SignupPoints({ firstPoint }: { firstPoint: string }) {
  const points = [
    firstPoint,
    // Es así: el que crea la cuenta queda como OWNER del consultorio (lib/team-internal.ts).
    "Quien crea la cuenta es titular del consultorio.",
    "Cuando sumes equipo, pasás a Consultorio o Clínica.",
  ];
  return (
    <section className={st.points} aria-label="Cómo funciona la prueba">
      <ul role="list">
        {points.map((p) => (
          <li key={p}>
            <IconCheckCircle size={24} />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      <p className={st.plans}>
        ¿Vas a trabajar con más de 10 personas?{" "}
        <Link href="/#contacto" className="k-link">
          Escribinos
        </Link>{" "}
        y armamos el plan Libre.
      </p>
    </section>
  );
}

/**
 * BO-Z (BO-D11): `SIGNUP_MODE=assisted`. Sin form: el consultorio lo damos de alta nosotros desde Plataforma. Quien
 * tiene una invitación entra por el link del mail (`/invite/<token>`, que no pasa por acá) y quien ya tiene cuenta,
 * por /login. Exportado para el render test.
 */
export function SignupAssisted({ message, mailto }: { message: string; mailto: string | null }) {
  return (
    <div className={st.stack}>
      <div className={st.head}>
        <h1 className={st.title}>Escribinos para sumar tu consultorio</h1>
        <p className={st.sub}>{message}</p>
      </div>
      {mailto && (
        <Button
          variant="primary"
          size="lg"
          block
          type="button"
          onClick={() => {
            window.location.href = mailto;
          }}
        >
          Escribinos <IconArrow size={16} />
        </Button>
      )}
      <p className={`k-hint ${st.small}`} style={{ margin: 0 }}>
        ¿Te invitaron a sumarte a un equipo? Abrí el link del mail de invitación: desde ahí creás tu cuenta.
      </p>
      <p className={st.foot}>
        ¿Ya tenés cuenta?{" "}
        <Link href="/login" className="k-link">
          Ingresar
        </Link>
      </p>
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
    <div className={st.stack}>
      <div className="k-alert k-alert-success" role="status">
        <IconCheckCircle size={18} />
        <div className={st.alertBody}>
          <strong>{message}</strong>
          <span>
            Lo enviamos a <strong>{email}</strong>. Abrí el link desde cualquier dispositivo para confirmar tu cuenta
            y seguir con el alta del consultorio.
          </span>
        </div>
      </div>
      <ResendVerification email={email} label="Reenviar el email" startCooling />
      <p className={`k-hint ${st.small}`} style={{ margin: 0 }}>
        ¿No llega? Revisá spam o promociones. Si ya tenías cuenta con ese email, no te llega un mail nuevo:{" "}
        <Link href="/login" className="k-link">
          ingresá
        </Link>{" "}
        o{" "}
        <Link href="/forgot" className="k-link">
          recuperá tu contraseña
        </Link>
        .
      </p>
      <p className={st.foot}>
        ¿Email equivocado?{" "}
        <button type="button" onClick={onBack} className={`k-link ${st.linkButton}`}>
          Volver
        </button>
      </p>
    </div>
  );
}
