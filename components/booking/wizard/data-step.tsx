"use client";

/**
 * Paso «Tus datos» del turnero (último paso) + el cobro online de T5 (`./payment-choice`). TP-3h: vive en su propio
 * módulo y el wizard lo baja con `next/dynamic` (precargado al llegar a «Fecha y hora»), así el first load del turnero
 * no carga el formulario ni el cobro hasta que hacen falta: con el cobro adentro, el turnero medía 115,9 kB gz contra un
 * techo de 115 (§25.11, `perf:bundle --explain`). Exportado también para el render test (VX2-d1): el paso 4 no se
 * alcanza con un render estático del wizard.
 */
import { Field } from "@/components/ui/field";
import { GoogleIcon } from "@/components/ui/brand-icons";
import { IconAlert } from "@/components/ui/icons";
import type { PublicClinic } from "@/lib/public-booking-types";
import type { TenantVertical } from "@prisma/client";
import type { PatientHC } from "../public-booking-wizard";
import { StepHeader } from "./shared";
import s from "../public-booking.module.css";

export { PaymentChoice, PaymentInterstitial } from "./payment-choice";

type WizardClinic = PublicClinic & { vertical?: TenantVertical | null };

/**
 * BORRADOR (C-WA9): el texto legal lo revisa Martin antes de pasar WhatsApp a live (igual que `WA_CONSENT_TEXT`).
 *
 * WA-U4 (§26.5, C-WA9): copia literal de `WA_CONSENT_TEXT` (`lib/whatsapp/copy.ts`), con paridad fijada por
 * `tests/unit/render/wa-u4-turnero.test.tsx`. No se importa: el módulo de copy trae todas las etiquetas de la UI de
 * WhatsApp y el turnero mide 114,3 de 115 kB (TV-I). Si Martin cambia el texto legal, cambia acá también (el test
 * falla hasta que coincidan) y sube `WA_CONSENT_VERSION`.
 */
export const TURNERO_WA_CONSENT_TEXT = // claim-ok: lib/public-booking-types.ts:92
  "Vas a recibir por WhatsApp avisos de tus turnos (cuando se agendan, se reprograman y el día anterior) desde el número del consultorio. Los mensajes no incluyen datos de salud. Podés darte de baja cuando quieras respondiendo BAJA.";
export const TURNERO_WA_CONSENT_LABEL = "Quiero recibir avisos de mis turnos por WhatsApp"; // claim-ok: lib/public-booking-types.ts:92

/**
 * OAuth de Google del turnero (paso «Tus datos»): form POST a la ruta canónica `/api/auth/oauth/google` (PL-2e; el
 * alias viejo `/api/auth/google` sigue vivo para otros llamadores). POST porque un `<Link>` GET daba 405 (A3b-S-auth).
 */
function googleAction(slug: string) {
  return `/api/auth/oauth/google?next=${encodeURIComponent(`/c/${slug}/booking`)}`;
}

export function DataStep({
  clinic,
  session,
  googleEnabled = true,
  hc,
  setHc,
  error,
  payment,
  waConsent = false,
  onWaConsentChange,
}: {
  clinic: WizardClinic;
  session: { email: string; fullName: string | null } | null;
  googleEnabled?: boolean;
  hc: PatientHC;
  setHc: (next: PatientHC) => void;
  error: string | null;
  /** TP-3h: elección/aviso de pago (`PaymentChoice`), arriba del error para que el error de MP quede cerca. */
  payment?: React.ReactNode;
  /** WA-U4: la casilla de WhatsApp (estado en el wizard, que lo manda en el submit). Arranca destildada. */
  waConsent?: boolean;
  onWaConsentChange?: (next: boolean) => void;
}) {
  const upd = <K extends keyof PatientHC>(k: K, v: PatientHC[K]) => setHc({ ...hc, [k]: v });
  const isGeneral = clinic.vertical === "GENERAL";
  // VX2-d1: `Field` del design system (label real + ids estables) y `autoComplete` en lo que el navegador sabe
  // completar del propio paciente. El contacto de emergencia es OTRA persona: `off`, para que no se autocomplete
  // con el nombre y el teléfono del paciente.
  const text = (k: keyof PatientHC, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      className="k-input"
      type="text"
      name={k}
      value={hc[k]}
      onChange={(e) => upd(k, e.target.value)}
      {...extra}
    />
  );
  return (
    <>
      <StepHeader
        title="Completá tus datos"
        subtitle="Los necesitamos para tu historia clínica y para el pago del turno."
      />

      {!session && googleEnabled && (
        <div className={s.signIn}>
          <div className={s.signInText}>
            <p className={s.signInTitle}>¿Ya sos paciente?</p>
            <p className={s.help}>Iniciá sesión con Google y precargamos tus datos.</p>
          </div>
          {/* A3b-S-auth: form POST (el GET daba 405). */}
          <form action={googleAction(clinic.slug)} method="post" className={s.navForm}>
            <button type="submit" className={s.pillButton}>
              <GoogleIcon size={18} /> Ingresar con Google
            </button>
          </form>
        </div>
      )}

      <div className={s.grid2}>
        <Field id="booking-firstName" label="Nombre">
          {text("firstName", { autoComplete: "given-name", required: true })}
        </Field>
        <Field id="booking-lastName" label="Apellido">
          {text("lastName", { autoComplete: "family-name", required: true })}
        </Field>
        <Field id="booking-email" label="Email">
          {text("email", { type: "email", autoComplete: "email", inputMode: "email", required: true })}
        </Field>
        <Field id="booking-phone" label="Teléfono">
          {text("phone", { type: "tel", autoComplete: "tel", inputMode: "tel", required: true })}
        </Field>
        <Field id="booking-documentId" label="DNI">
          {text("documentId", { inputMode: "numeric", autoComplete: "off", required: true })}
        </Field>
        <Field id="booking-dateOfBirth" label="Fecha de nacimiento">
          {text("dateOfBirth", { type: "date", autoComplete: "bday", required: true })}
        </Field>
        <Field id="booking-coverageInsurer" label="Obra social" optional>
          {text("coverageInsurer", { placeholder: "OSDE, Swiss…", autoComplete: "off" })}
        </Field>
        <Field id="booking-coveragePlan" label="Plan / N° de afiliado" optional>
          {text("coveragePlan", { autoComplete: "off" })}
        </Field>
        <Field id="booking-emergencyName" label="Contacto de emergencia" optional>
          {text("emergencyName", { placeholder: "Nombre y vínculo", autoComplete: "off" })}
        </Field>
        <Field id="booking-emergencyPhone" label="Teléfono de emergencia" optional>
          {text("emergencyPhone", { type: "tel", inputMode: "tel", autoComplete: "off" })}
        </Field>
      </div>

      <Field id="booking-notes" label="Motivo de consulta" optional>
        <textarea
          className="k-input"
          name="notes"
          rows={3}
          value={hc.notes}
          onChange={(e) => upd("notes", e.target.value)}
          placeholder={
            isGeneral
              ? "Contanos brevemente qué te trae y desde cuándo."
              : "Contanos brevemente qué te trae (zona, desde cuándo, qué actividad sentís limitada)."
          }
        />
      </Field>

      {/* EV1-C2: en Clínica general no hay diagnóstico de kinesiología, y «Motivo de consulta» ya es el campo
          de arriba: el título (`hc.title` → `diagnosisTitle`) no se pide. La descripción queda: es texto libre. */}
      {!isGeneral && (
        <Field id="booking-title" label="Diagnóstico" optional>
          {text("title", { placeholder: "Ej. Lumbalgia, esguince de tobillo…", autoComplete: "off" })}
        </Field>
      )}

      <Field id="booking-description" label="Descripción" optional>
        <textarea
          className="k-input"
          name="description"
          rows={3}
          value={hc.description}
          onChange={(e) => upd("description", e.target.value)}
          placeholder="Detalles que quieras que el profesional conozca."
        />
      </Field>

      {/* WA-U4 (§26.5): solo si el consultorio avisa por WhatsApp (`whatsappNotices`, cuenta ACTIVE en el modo del env).
          Destildada: el consentimiento tiene que ser un acto del paciente (Ley 25.326). Label real envolviendo el input
          y 44 px de alto (tap target a 390); el texto legal en un `<details>` (anda sin JS) y referido por
          `aria-describedby`, así el lector de pantalla lo lee aunque esté plegado. */}
      {/* // claim-ok: lib/public-booking-types.ts:92 */}
      {clinic.whatsappNotices === true && onWaConsentChange && (
        <div style={{ display: "grid", gap: 2 }}>
          <label
            htmlFor="booking-waConsent"
            style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, cursor: "pointer", fontSize: 14 }}
          >
            <input
              id="booking-waConsent"
              type="checkbox"
              name="waConsent"
              checked={waConsent}
              onChange={(e) => onWaConsentChange(e.target.checked)}
              aria-describedby="booking-waConsent-legal"
              style={{ width: 20, height: 20, flex: "none", margin: 0, accentColor: "var(--sky-600)" }}
            />
            <span>{TURNERO_WA_CONSENT_LABEL}</span>
          </label>
          <details>
            <summary
              style={{ minHeight: 44, display: "flex", alignItems: "center", cursor: "pointer", fontSize: 13, color: "var(--sky-700)" }}
            >
              Qué significa
            </summary>
            <p id="booking-waConsent-legal" className={s.consent} style={{ lineHeight: 1.5 }}>
              {TURNERO_WA_CONSENT_TEXT}
            </p>
          </details>
        </div>
      )}

      {payment}
      {error && (
        <div className="k-alert" role="alert">
          <IconAlert size={18} />
          <span>{error}</span>
        </div>
      )}
      <p className={s.consent}>
        {/* PL-F1c: sin «Cancelás gratis hasta 6 hs antes»: el paciente no tiene cómo cancelar y no hay regla de
            6 hs. VX2-d1 lo mantiene afuera. */}
        Al continuar aceptás que el consultorio use estos datos para tu atención.
      </p>
    </>
  );
}

