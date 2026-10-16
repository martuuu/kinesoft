import { IconBuilding, IconHelp, IconTag } from "@/components/ui/icons";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import {
  LEAD_CLINIC_MAX,
  LEAD_EMAIL_MAX,
  LEAD_NAME_MAX,
  LEAD_PHONE_MAX,
  SUPPORT_BODY_MAX,
} from "@/lib/support-threads-types";
import { ContactForm, type ContactFormLimits, type PlanOption } from "./contact-form";
import styles from "./contact.module.css";

/**
 * Contacto de la landing (VX2-c2, contrato C-VX-L). Server component: arma el texto y monta el formulario cliente.
 *
 * `startedAt` lo pasa `app/page.tsx` (VX2-c1) con `Date.now()` del render ISR; el form lo pone en un hidden y lo
 * reemplaza al montar. Sin él `leadBotVerdict` descarta el lead como bot (PL-Z a4#2), así que es obligatorio.
 *
 * Las etiquetas de plan y los topes de largo se resuelven acá (server) y viajan como props: así el bundle público no
 * arrastra la matriz de módulos ni `lib/support-threads-types` (que importa formato de fechas), y los largos siguen
 * siendo el espejo de los CHECK de M8 en un solo lugar.
 *
 * Copy de §3.1. Sin «te llega un mail» (PL-D15: no hay respuesta automática al lead).
 */
const PLAN_OPTIONS: PlanOption[] = (["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const).map((value) => ({
  value,
  label: SAAS_PLAN_LABEL[value],
}));

const LIMITS: ContactFormLimits = {
  name: LEAD_NAME_MAX,
  email: LEAD_EMAIL_MAX,
  phone: LEAD_PHONE_MAX,
  clinicName: LEAD_CLINIC_MAX,
  message: SUPPORT_BODY_MAX,
};

export function LandingContact({ startedAt }: { startedAt: number }) {
  return (
    <section id="contacto" aria-labelledby="contacto-title" className={styles.section}>
      <div className="k-container">
        <div className={styles.grid}>
          <div className={styles.aside}>
            <span className={styles.eyebrow}>
              <span className={styles.eyebrowDot} aria-hidden="true" />
              Contacto
            </span>
            <h2 className={styles.h2} id="contacto-title">
              Hablemos
            </h2>
            <p className={styles.lead}>Contanos cómo trabaja tu consultorio. Te respondemos por email.</p>
            <ul className={styles.reasons} role="list">
              <li>
                <span aria-hidden="true" className={styles.reasonIcon}>
                  <IconTag size={22} />
                </span>
                <span>Dudas sobre planes y precios</span>
              </li>
              <li>
                <span aria-hidden="true" className={styles.reasonIcon}>
                  <IconBuilding size={22} />
                </span>
                <span>Equipos de más de 10 usuarios (plan Libre)</span>
              </li>
              <li>
                <span aria-hidden="true" className={styles.reasonIcon}>
                  <IconHelp size={22} />
                </span>
                <span>Ayuda para empezar</span>
              </li>
            </ul>
          </div>
          <div className={styles.card}>
            <ContactForm startedAt={startedAt} planOptions={PLAN_OPTIONS} limits={LIMITS} />
          </div>
        </div>
      </div>
    </section>
  );
}
