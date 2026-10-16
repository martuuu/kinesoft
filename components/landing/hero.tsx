import { ButtonLink } from "@/components/ui/button";
import { ProductMock } from "./product-mock";
import base from "./landing.module.css";
import s from "./hero.module.css";

/**
 * [VX2-c1] Hero (brief VX §3.1). La única h1 de la página.
 *
 * `trialDays` sale del catálogo público (fila Individual de `SaasPlanConfig`, `lib/saas-plans-logic.ts:28`). Si es 0 o
 * no se pudo leer (`null`: catálogo vacío porque la base no respondió en el build) no se promete una prueba: el CTA
 * dice «Creá tu cuenta» y no va la nota. «Sin medio de pago» es cierto siempre (el alta no lo pide), pero el brief la
 * ata a la prueba para no sumar promesas a un CTA neutro.
 */
export function Hero({ trialDays }: { trialDays: number | null }) {
  const hasTrial = trialDays != null && trialDays > 0;
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className="k-container">
        <div className={s.copy}>
          <span className={`${s.pill} k-enter`}>
            <span className={s.pillDot} aria-hidden="true" />
            Para kinesiología y cualquier consultorio
          </span>
          <h1 className={`${s.h1} k-enter k-enter-d1`} id="hero-title">
            Tu consultorio, <em>ordenado</em> de punta a punta.
          </h1>
          <p className={`${base.lead} ${s.lead} k-enter k-enter-d2`}>
            Agenda, turnos online, historia clínica y cobros. Con herramientas propias para kinesiología.
          </p>
          <div className={`${s.ctas} k-enter k-enter-d2`}>
            <ButtonLink href="/signup" variant="primary" size="lg">
              {hasTrial ? `Probá ${trialDays} días gratis` : "Creá tu cuenta"}
            </ButtonLink>
            <ButtonLink href="#precios" variant="ghost" size="lg">
              Ver precios
            </ButtonLink>
          </div>
          {hasTrial && <p className={`${s.note} k-enter k-enter-d3`}>Sin medio de pago para empezar.</p>}
        </div>
        <div className={`${s.frameWrap} k-enter k-enter-d3`}>
          <ProductMock />
        </div>
      </div>
    </section>
  );
}
