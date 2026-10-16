import base from "./landing.module.css";
import s from "./steps.module.css";

/**
 * [VX2-c1] «Cómo empezás» (brief VX §3.1). El número lo pone CSS (`counter`), así el lector de pantalla lee la lista
 * ordenada sin un «1» suelto.
 *
 * Paso 1 nombra solo Google: la landing es estática (ISR, D-VX29) y no puede preguntarle a Supabase qué proveedores
 * están prendidos (`isProviderEnabled` hace un fetch `no-store`, que volvería dinámica la página). Facebook seguramente
 * arranca apagado (§20.13, D-VX16), así que no se promete; el login y el signup sí lo muestran cuando está prendido.
 */
export function Steps({ trialDays }: { trialDays: number | null }) {
  const trial =
    trialDays != null && trialDays > 0
      ? `El plan Individual tiene ${trialDays} días gratis y no te pide medio de pago.`
      : "No te pide medio de pago.";
  return (
    <section className={base.section} id="como-empezar" aria-labelledby="como-empezar-title">
      <div className="k-container">
        <div className={base.sectionHead}>
          <span className={base.eyebrow}>
            <span className={base.eyebrowDot} aria-hidden="true" />
            Cómo empezás
          </span>
          <h2 className={base.h2} id="como-empezar-title">
            En una tarde, tu consultorio queda andando
          </h2>
        </div>
        <ol className={s.steps} role="list">
          <li className={s.step}>
            <h3 className={base.h3}>Creá tu cuenta</h3>
            <p className={base.muted}>Con Google o tu email. {trial}</p>
          </li>
          <li className={s.step}>
            <h3 className={base.h3}>Cargá servicios y horarios</h3>
            <p className={base.muted}>
              Definís qué atendés, cuánto dura cada turno y qué días trabaja cada profesional.
            </p>
          </li>
          <li className={s.step}>
            <h3 className={base.h3}>Compartí tu turnero</h3>
            <p className={base.muted}>Tus pacientes reservan desde el link de tu consultorio. Vos lo ves en la agenda.</p>
          </li>
        </ol>
      </div>
    </section>
  );
}
