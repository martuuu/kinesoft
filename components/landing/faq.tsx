import base from "./landing.module.css";
import s from "./faq.module.css";
import type { SaasBillingMode } from "@/lib/env";

/**
 * [VX2-c1] Preguntas frecuentes (brief VX §3.1). `<details>` nativo: abre y cierra sin JS y con teclado.
 *
 * «¿Cómo pago?» solo con `SAAS_BILLING_MODE` ≠ `off` (D-VX17): con `off` (default en prod) no se cobra todavía y la
 * pregunta no aplica. La respuesta sigue al modo: con `manual` habla solo del pago manual (PL-F, M8c: comprobante desde
 * Configuración → Facturación); con `mp` (T6, MPS-4a) suma el débito automático y el pago con Mercado Pago de cada mes,
 * que viven en la misma pestaña. Antes `mp` mostraba la pregunta con la respuesta de `manual` (handoff de MPS-4a).
 *
 * «¿Cómo reservan turno mis pacientes?» no nombra Mercado Pago (VX-Z, decisión de Martin): el cobro del turnero entra
 * a la cuenta MP de la plataforma (`MP_ACCESS_TOKEN`), no a la del consultorio. Vuelve cuando el bloque D lo resuelva.
 */
export type FaqItem = { q: string; a: string };

export function faqItems({ trialDays, billingMode }: { trialDays: number | null; billingMode: SaasBillingMode }): FaqItem[] {
  const hasTrial = trialDays != null && trialDays > 0;
  const items: FaqItem[] = [
    {
      q: "¿Necesito tarjeta para probar?",
      a: hasTrial
        ? `No. El plan Individual tiene ${trialDays} días gratis y no te pedimos medio de pago.`
        : "No. Para crear tu cuenta no te pedimos medio de pago.",
    },
    {
      q: "¿Sirve si mi consultorio no es de kinesiología?",
      a: "Sí. Con Clínica general tenés pacientes, turnos e historia clínica. Kinesiología suma planes de tratamiento, ejercicios, terapia manual y seguimiento.",
    },
    {
      q: "¿Cómo reservan turno mis pacientes?",
      a: "Desde el link de tu consultorio: eligen profesional, servicio y horario.",
    },
    {
      q: "¿Quién ve la historia clínica?",
      a: "Quien atiende. La secretaría y la administración manejan la agenda y los datos de contacto, sin entrar a la historia clínica.",
    },
    {
      q: "¿Puedo cambiar de plan?",
      a: "Sí. Si pasás a un plan con menos usuarios, elegís quiénes dejan de tener acceso. Nadie se borra.",
    },
    {
      q: "¿Puedo llevarme mis datos?",
      a: "Sí. Desde Configuración exportás los datos de tu consultorio.",
    },
  ];
  if (billingMode === "manual") {
    items.push({
      q: "¿Cómo pago?",
      a: "Con un pago manual: pagás por transferencia u otro medio e informás el pago con su comprobante desde Configuración → Facturación.",
    });
  } else if (billingMode === "mp") {
    items.push({
      q: "¿Cómo pago?",
      // Es la suscripción del consultorio (T6), no el cobro del turnero de VX-Z. // claim-ok: lib/saas-billing-mp.ts:185
      a: "Desde Configuración → Facturación elegís cómo pagás: débito automático o Mercado Pago cada mes, o transferencia informando el comprobante.",
    });
  }
  return items;
}

export function Faq({ trialDays, billingMode }: { trialDays: number | null; billingMode: SaasBillingMode }) {
  return (
    <section className={base.section} id="preguntas" aria-labelledby="preguntas-title">
      <div className="k-container">
        <div className={`${base.sectionHead} ${base.center}`}>
          <span className={base.eyebrow}>
            <span className={base.eyebrowDot} aria-hidden="true" />
            Preguntas
          </span>
          <h2 className={base.h2} id="preguntas-title">
            Lo que más nos preguntan
          </h2>
        </div>
        <div className={s.faq}>
          {faqItems({ trialDays, billingMode }).map((it, i) => (
            <details key={it.q} className={s.item} open={i === 0}>
              <summary>
                {it.q}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <div className={s.answer}>{it.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
