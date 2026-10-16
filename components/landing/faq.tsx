import base from "./landing.module.css";
import s from "./faq.module.css";

/**
 * [VX2-c1] Preguntas frecuentes (brief VX §3.1). `<details>` nativo: abre y cierra sin JS y con teclado.
 *
 * «¿Cómo pago?» solo con `SAAS_BILLING_MODE=manual` (D-VX17): con `off` (default en prod) no se cobra todavía y la
 * pregunta no aplica; el débito automático de Mercado Pago para la suscripción quedó fuera (§20.18), así que la
 * respuesta habla solo del pago manual (PL-F, M8c: comprobante desde Configuración → Facturación).
 *
 * «¿Cómo reservan turno mis pacientes?» no nombra Mercado Pago (VX-Z, decisión de Martin): el cobro del turnero entra
 * a la cuenta MP de la plataforma (`MP_ACCESS_TOKEN`), no a la del consultorio. Vuelve cuando el bloque D lo resuelva.
 */
export type FaqItem = { q: string; a: string };

export function faqItems({ trialDays, showBilling }: { trialDays: number | null; showBilling: boolean }): FaqItem[] {
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
  if (showBilling) {
    items.push({
      q: "¿Cómo pago?",
      a: "Con un pago manual: pagás por transferencia u otro medio e informás el pago con su comprobante desde Configuración → Facturación.",
    });
  }
  return items;
}

export function Faq({ trialDays, showBilling }: { trialDays: number | null; showBilling: boolean }) {
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
          {faqItems({ trialDays, showBilling }).map((it, i) => (
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
