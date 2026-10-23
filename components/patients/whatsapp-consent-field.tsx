"use client";

/**
 * WA-U3 (T6, brief §26.5 «Consentimiento en el paciente», C-WA9) · Consentimiento de avisos por WhatsApp en el alta y
 * en «Editar paciente».
 *
 * - La casilla arranca DESTILDADA (se consiente un texto, no se presume): el texto legal (`WA_CONSENT_TEXT`, borrador
 *   que revisa Martin) va en un `<details>` «Ver qué acepta» para que el staff se lo pueda leer al paciente sin que el
 *   formulario se haga eterno.
 * - Solo existe si el consultorio tiene WhatsApp activo (`active`, lo calcula el server de quien monta: con
 *   `WHATSAPP_MODE=off` no se lee nada). Sin cuenta, la casilla no promete avisos que no van a salir.
 * - La lógica (texto de la fila, precheck del celular) es pura y está exportada para el render test.
 *
 * Fechas en hora AR (`timeZone` explícito): en Vercel el host es UTC y un consentimiento de las 22:00 caería al día
 * siguiente.
 */
import { WA_CHANNEL_BLOCK_LABEL, WA_CONSENT_TEXT, WA_COPY } from "@/lib/whatsapp/copy";
import { normalizeArMobile } from "@/lib/phone-e164";
import type { PatientWaConsentState } from "@/lib/whatsapp-patient-ui-types";

export const WA_CONSENT_UI_COPY = {
  sectionTitle: "Avisos por WhatsApp",
  seeText: "Ver qué acepta",
  revoke: "Revocar",
  revoking: "Revocando…",
  loading: "Cargando el estado de WhatsApp…",
  loadFailed: "No pudimos leer el estado de WhatsApp del paciente. Probá de nuevo más tarde.",
  needsMobile: "Para los avisos por WhatsApp hace falta un celular válido en «Teléfono».",
  outdated: "El texto del consentimiento cambió desde que aceptó: leéselo de nuevo y volvé a registrarlo.",
  revokeConfirm: {
    title: "Revocar los avisos por WhatsApp",
    message:
      "El paciente deja de recibir avisos de sus turnos por WhatsApp y se cancelan los que estaban en cola. Lo puede volver a activar desde el portal, respondiendo ALTA o pidiéndoselo al consultorio.",
    confirmLabel: "Revocar",
    tone: "danger" as const,
  },
  revoked: "Listo: el paciente ya no recibe avisos por WhatsApp.",
  /** Alta: el paciente quedó creado, pero el consentimiento no (no se pierde el alta). */
  createdWithoutConsent: "El paciente quedó cargado, pero no se registró el consentimiento de WhatsApp",
  /** Edición: los datos se guardaron, el consentimiento no. */
  savedWithoutConsent: "Los datos se guardaron, pero no se registró el consentimiento de WhatsApp: ",
} as const;

/** «12/10» en hora AR. */
export function formatConsentDay(iso: string): string {
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

/**
 * Precheck del cliente antes de llamar a la action: con la casilla tildada, el teléfono del formulario tiene que ser un
 * celular (el server lo vuelve a chequear y ancla el consentimiento a ese número, WA-D17).
 */
export function consentPhoneError(checked: boolean, phone: string | null | undefined): string | null {
  if (!checked) return null;
  return normalizeArMobile(phone).ok ? null : WA_CONSENT_UI_COPY.needsMobile;
}

export type ConsentRowView = {
  /** La línea de estado («Aceptó avisos por WhatsApp el 12/10»); null = nunca se preguntó. */
  line: string | null;
  canRevoke: boolean;
  /** Se muestra la casilla para (volver a) registrar el consentimiento. */
  offerGrant: boolean;
  /** Aviso extra (número cambiado, texto viejo, sin celular). */
  note: string | null;
};

export function consentRowView(s: PatientWaConsentState): ConsentRowView {
  const day = s.at ? formatConsentDay(s.at) : null;
  if (s.status === "GRANTED") {
    const line = day ? `Aceptó avisos por WhatsApp el ${day}` : "Aceptó avisos por WhatsApp";
    if (s.phoneChanged) return { line, canRevoke: true, offerGrant: true, note: WA_CHANNEL_BLOCK_LABEL.phone_changed };
    if (s.versionOutdated) return { line, canRevoke: true, offerGrant: true, note: WA_CONSENT_UI_COPY.outdated };
    return { line, canRevoke: true, offerGrant: false, note: null };
  }
  const note = s.phoneValid ? null : WA_CONSENT_UI_COPY.needsMobile;
  if (s.status === "REVOKED") {
    // La BAJA por WhatsApp es la del paciente respondiendo BAJA; las otras (equipo, portal) se dicen distinto.
    const base = s.source === "WHATSAPP" ? "Se dio de baja por WhatsApp" : "Dejó de recibir avisos por WhatsApp";
    // El equipo puede volver a registrarlo si el paciente lo pide (H-1: el staff sí revierte un REVOKED).
    return { line: day ? `${base} el ${day}` : base, canRevoke: false, offerGrant: true, note };
  }
  return { line: null, canRevoke: false, offerGrant: true, note };
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
  fontSize: 13,
  lineHeight: 1.45,
  minHeight: 44,
  cursor: "pointer",
  color: "var(--navy-700)",
};

/**
 * La casilla de consentimiento + el texto legal. Controlada (el padre arranca en `false`) para que el dirty-guard y el
 * submit la lean sin tocar el DOM.
 */
export function WhatsAppConsentField({
  active,
  checked,
  onChange,
  disabled,
  label = WA_COPY.consentCheckbox,
}: {
  active: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  if (!active) return null;
  return (
    <div style={{ display: "grid", gap: 4 }} data-wa-consent="">
      <label style={labelStyle}>
        <input
          type="checkbox"
          name="waConsent"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          style={{ marginTop: 3 }}
        />
        <span>{label}</span>
      </label>
      <details style={{ fontSize: 12, color: "var(--navy-500)", paddingLeft: 24 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--sky-700)" }}>{WA_CONSENT_UI_COPY.seeText}</summary>
        <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{WA_CONSENT_TEXT}</p>
      </details>
    </div>
  );
}

/**
 * Fila de «Editar paciente»: estado + «Revocar» (inmediato, con `useConfirm` en el padre) o la casilla para otorgar
 * (se aplica al guardar, DESPUÉS de los datos: el consentimiento se ancla al teléfono que quede guardado).
 */
export function WhatsAppConsentRow({
  state,
  error,
  grantChecked,
  onGrantChange,
  onRevoke,
  revoking = false,
  disabled = false,
}: {
  /** undefined = cargando. */
  state: PatientWaConsentState | undefined;
  error?: string | null;
  grantChecked: boolean;
  onGrantChange: (v: boolean) => void;
  onRevoke: () => void;
  revoking?: boolean;
  disabled?: boolean;
}) {
  if (error) {
    return (
      <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--danger-fg)" }}>
        {error}
      </p>
    );
  }
  if (!state) {
    return (
      <p role="status" style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
        {WA_CONSENT_UI_COPY.loading}
      </p>
    );
  }
  const view = consentRowView(state);
  return (
    <div style={{ display: "grid", gap: 6 }} data-wa-consent-row={state.status ?? "none"}>
      {view.line && (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span>{view.line}</span>
          {view.canRevoke && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onRevoke}
                disabled={disabled || revoking}
                aria-busy={revoking || undefined}
                style={{
                  background: "none",
                  border: 0,
                  padding: "4px 2px",
                  minHeight: 32,
                  color: "var(--danger-fg)",
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                {revoking ? WA_CONSENT_UI_COPY.revoking : WA_CONSENT_UI_COPY.revoke}
              </button>
            </>
          )}
        </p>
      )}
      {view.note && <p style={{ margin: 0, fontSize: 12, color: "var(--warn-fg)" }}>{view.note}</p>}
      {view.offerGrant && (
        <WhatsAppConsentField active checked={grantChecked} onChange={onGrantChange} disabled={disabled || revoking} />
      )}
    </div>
  );
}
