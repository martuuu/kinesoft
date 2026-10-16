import type { PublicPlan } from "@/lib/saas-plans-public";
import { ButtonLink, buttonClassName } from "@/components/ui/button";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import styles from "./pricing.module.css";

/**
 * Precios de la landing (VX2-c2, contrato C-VX-L). Server component, sin JS: recibe el catálogo que `app/page.tsx`
 * (VX2-c1) lee con `getPublicPlanCatalog()` y lo pinta tal cual. Todo lo que dice sale de ahí (precio, cupos,
 * bullets por vertical): no hay una lista de marketing aparte que se desincronice con lo que la app habilita.
 *
 * - Individual, Consultorio y Clínica (los de CTA `signup`) van como tarjetas; Libre NO es tarjeta sino la banda
 *   «¿Hospital o clínica grande? Hablemos» → `#contacto` (D-VX9 / D-VX18), y la banda está siempre, aunque el catálogo
 *   venga sin Libre o vacío.
 * - Precio `null` → «Consultá» sin «por mes» (PL-D19: los precios nacen NULL hasta que Martin los cargue). Nada de
 *   «Precio de ejemplo» (era de la maqueta; lo prohíbe el guard de claims).
 * - `[]` (la base no respondió en el build ISR, riesgo 5 del brief): sin tarjetas, la banda y «Escribinos y te pasamos
 *   los precios.». No rompe ni muestra tarjetas vacías.
 * - Sin switch de vertical (D-VX15): se listan los bullets de General y, aparte, lo que Kinesiología suma en ese plan.
 *   Así un consultorio General no lee como incluido algo que su vertical no tiene.
 * - CTA → `/signup` en todos (D-VX18: el alta no elige plan; nace Individual —o Consultorio si el Titular no atiende,
 *   decisión 24 de VX-Z— y cambia de plan desde Configuración, PL-D10);
 *   por eso el botón no dice «Elegir Clínica» como la maqueta, y la nota lo aclara.
 */

/** Tarjeta destacada (la del medio en la maqueta). */
const FEATURED: PublicPlan["plan"] = "CONSULTORIO";

/** Bullets de General y lo que Kinesiología suma encima (sin repetir). Exportado para el test. */
export function splitBullets(p: PublicPlan): { common: string[]; kineExtra: string[] } {
  const general = p.features.find((f) => f.vertical === "GENERAL")?.bullets ?? [];
  const kine = p.features.find((f) => f.vertical === "KINESIOLOGY")?.bullets ?? [];
  const seen = new Set(general);
  return { common: general, kineExtra: kine.filter((b) => !seen.has(b)) };
}

function PriceCard({ plan, featured }: { plan: PublicPlan; featured: boolean }) {
  const titleId = `plan-${plan.plan.toLowerCase()}`;
  const { common, kineExtra } = splitBullets(plan);
  return (
    <article className={`${styles.card} ${featured ? styles.featured : ""}`} aria-labelledby={titleId}>
      <div className={styles.head}>
        <h3 className={styles.name} id={titleId}>
          {plan.label}
        </h3>
        <p className={styles.for}>{plan.limitsLabel}</p>
      </div>
      <div className={styles.priceBlock}>
        <p className={styles.amount}>
          <strong>{plan.priceLabel}</strong>
          {plan.period === "mes" && <span>por mes</span>}
        </p>
        {plan.trialDays > 0 && (
          <p className={styles.trial}>
            {plan.trialDays} días gratis, sin medio de pago
          </p>
        )}
      </div>
      {/* VX-Z: el CTA va pegado al precio y no al pie. Con Individual cargando 8 bullets y Consultorio/Clínica 2-3, al
          pie quedaba un hueco grande arriba del botón en las dos de la derecha (capturas de VX2.1 a 1366). Así los
          tres botones quedan a la misma altura y el aire sobrante cae al final de la lista, donde no se lee como
          «falta algo». aria-describedby: los tres botones dicen lo mismo; el lector los distingue por el plan. */}
      <ButtonLink
        href="/signup"
        variant={featured ? "primary" : "ghost"}
        size="lg"
        block
        className={styles.cta}
        aria-describedby={titleId}
      >
        {plan.trialDays > 0 ? "Empezá gratis" : "Crear cuenta"}
      </ButtonLink>
      <div className={styles.sep} />
      <ul className={styles.list} role="list">
        {common.map((b) => (
          <li key={b}>
            <span aria-hidden="true" className={styles.check}>
              <IconCheck size={20} stroke={1.8} />
            </span>
            <span>{b}</span>
          </li>
        ))}
      </ul>
      {kineExtra.length > 0 && (
        <div className={styles.extra}>
          <p className={styles.extraTitle}>Con Kinesiología, además:</p>
          <ul className={styles.list} role="list">
            {kineExtra.map((b) => (
              <li key={b}>
                <span aria-hidden="true" className={styles.check}>
                  <IconCheck size={20} stroke={1.8} />
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export function LandingPricing({ plans }: { plans: PublicPlan[] }) {
  const cards = plans.filter((p) => p.cta === "signup");
  const trialDays = plans.find((p) => p.trialDays > 0)?.trialDays ?? 0;
  // El tope de la banda sale del plan Clínica si está; 10 es el de §20.17 si el catálogo no lo trae.
  const clinicaMax = plans.find((p) => p.plan === "CLINICA")?.limits.maxUsers ?? 10;

  const lead =
    cards.length === 0
      ? "Escribinos y te pasamos los precios."
      : trialDays > 0
        ? `Empezás con ${trialDays} días gratis. Cambiás de plan cuando lo necesites.`
        : "Cambiás de plan cuando lo necesites.";

  return (
    <section id="precios" aria-labelledby="precios-title" className={styles.section}>
      <div className="k-container">
        <div className={styles.sectionHead}>
          <span className={styles.eyebrow}>
            <span className={styles.eyebrowDot} aria-hidden="true" />
            Precios
          </span>
          <h2 className={styles.h2} id="precios-title">
            Un plan para cada tamaño de consultorio
          </h2>
          <p className={styles.lead}>{lead}</p>
        </div>

        {cards.length > 0 && (
          <div className={styles.grid} data-count={Math.min(cards.length, 3)}>
            {cards.map((p) => (
              <PriceCard key={p.plan} plan={p} featured={p.plan === FEATURED && cards.length > 1} />
            ))}
          </div>
        )}

        <div className={styles.band}>
          <div>
            <h3 className={styles.bandTitle}>¿Hospital o clínica grande? Hablemos.</h3>
            <p>Si necesitás más de {clinicaMax} usuarios, armamos el plan Libre a la medida de tu equipo.</p>
          </div>
          <a className={buttonClassName({ variant: "lime", size: "lg" })} href="#contacto">
            Escribinos
            <span aria-hidden="true" className={styles.arrow}>
              <IconArrow size={18} stroke={1.8} />
            </span>
          </a>
        </div>

        {cards.length > 0 && (
          <p className={styles.note}>
            {/* VX-Z: decía «Toda cuenta arranca en el plan Individual»; desde la decisión 24 un Titular que no atiende
                arranca en prueba Consultorio (lib/onboarding.ts), así que la nota ya no promete el plan de arranque. */}
            Precios en pesos argentinos. Cambiás de plan cuando quieras desde Configuración.
          </p>
        )}
      </div>
    </section>
  );
}
