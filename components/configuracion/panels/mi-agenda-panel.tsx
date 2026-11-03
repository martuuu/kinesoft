"use client";

/**
 * CF2 (§29, T-U1; brief T.C «Pestaña Mi agenda») — Configuración › «Mi agenda»: lo PERSONAL de cada profesional para
 * su turnero y sus avisos. Mismo gate que «Mis fichas» (lo decide el loader: `miAgenda` null = sin pestaña). Todo es
 * del profesional del actor: las actions toman el profesional de la sesión, nunca de un id del input (salvo el
 * turnero y la anticipación, que también los edita Configuración › Profesionales con su permiso).
 *
 * Tres tarjetas:
 *   1. «Turnero online»: el switch propio (`PublicBookingSwitch`, el mismo del menú de la cuenta) y la anticipación
 *      propia (`PractitionerLeadEditor` en modo `self`, de T-U2).
 *   2. «Si te piden un turno antes» (D-CF2-9, Ley 25.326): celular + switch + casilla de consentimiento con el texto
 *      versionado (`LEAD_CONTACT_CONSENT_COPY`). Formulario en línea con «Guardar» (dos campos y un switch: un Drawer
 *      escondería lo único que hay en la tarjeta); el dirty sube a `ConfiguracionClient` como en «Mis fichas».
 *   3. «Avisos de turnos online» (D-CF2-11/12): mail y notificación se guardan al tocar (como el switch del turnero);
 *      «Este dispositivo» y la lista en `PushDeviceCard`.
 */
import { useCallback, useEffect, useId, useMemo, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { setOwnBookingNotifications, setOwnLeadContact } from "@/lib/practitioner-self-settings";
import { LEAD_CONTACT_CONSENT_COPY } from "@/lib/public-lead-contact";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";
import { OWN_TURNERO_OFF_HINT, PublicBookingSwitch } from "./practitioners/public-booking-switch";
import { PractitionerLeadEditor } from "./practitioners/lead-editor";
import { PushDeviceCard } from "./push-device-card";
import {
  MI_AGENDA_COPY as COPY,
  leadContactDirty,
  leadContactDraftOf,
  leadContactNeedsConsent,
  leadContactSavedOf,
  leadFieldErrorsOf,
  validateLeadContactDraft,
  type LeadContactDraft,
  type LeadContactErrors,
  type LeadContactSaved,
} from "./mi-agenda-logic";
import { ErrorBox } from "../controls";

const intro: React.CSSProperties = { fontSize: 13, color: "var(--navy-500)", margin: "6px 0 0", lineHeight: 1.45, maxWidth: 640 };
const hintStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4 };
const rowLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--navy-900)" };
/**
 * ZB-11: la fila del Switch es un `<label>` que envuelve el botón y el texto (asociación implícita: el `<button>` es
 * etiquetable), así un clic en el texto lo cambia como en cualquier casilla. El `Switch` del design system no recibe
 * `id`, por eso no `htmlFor`. Deshabilitado, el clic en el texto no hace nada (el botón no recibe el click).
 */
const switchRow = (disabled: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  cursor: disabled ? "default" : "pointer",
});

export function MiAgendaPanel({
  data,
  vapidPublicKey,
  readOnly = false,
  onDirtyChange,
}: {
  data: ConfiguracionMiAgendaData;
  /** Clave PÚBLICA VAPID (`webPushVapid()?.publicKey`); null = push sin configurar en el server. */
  vapidPublicKey: string | null;
  /** Consultorio en modo lectura: se ve todo, no se guarda (las actions lo rechazan igual). */
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  // Dos formularios en línea con dirty propio (la anticipación y el contacto): al padre sube el OR.
  const [leadDirty, setLeadDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const dirty = leadDirty || contactDirty;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
      <Card style={{ padding: 20, display: "grid", gap: 14 }}>
        <div>
          <EyebrowLabel as="h2">{COPY.cardTurnero}</EyebrowLabel>
          <p style={intro}>{COPY.turneroIntro}</p>
        </div>
        <PublicBookingSwitch
          practitionerId={data.practitionerId}
          name={data.name}
          enabled={data.publicBookingEnabled}
          tenantOpen={data.tenantPublicBookingEnabled}
          offHint={OWN_TURNERO_OFF_HINT}
        />
        <PractitionerLeadEditor
          practitionerId={data.practitionerId}
          practitionerName={data.name}
          own={data.publicMinLeadMinutes}
          tenant={data.tenantPublicMinLeadMinutes}
          self
          onDirtyChange={setLeadDirty}
        />
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel as="h2">{COPY.cardLeadContact}</EyebrowLabel>
        <p style={intro}>{COPY.leadContactIntro}</p>
        <LeadContactForm data={data} readOnly={readOnly} onDirtyChange={setContactDirty} />
      </Card>

      <Card style={{ padding: 20, display: "grid", gap: 14 }}>
        <div>
          <EyebrowLabel as="h2">{COPY.cardNotifications}</EyebrowLabel>
          <p style={intro}>{COPY.notificationsIntro}</p>
        </div>
        <NotificationsSection data={data} vapidPublicKey={vapidPublicKey} readOnly={readOnly} />
      </Card>
    </div>
  );
}

function LeadContactForm({
  data,
  readOnly,
  onDirtyChange,
}: {
  data: ConfiguracionMiAgendaData;
  readOnly: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<LeadContactSaved>(() => leadContactSavedOf(data));
  const [draft, setDraft] = useState<LeadContactDraft>(() => leadContactDraftOf(leadContactSavedOf(data)));
  // El server pidió el consentimiento aunque la UI creía que no hacía falta (texto de versión vieja).
  const [forceConsent, setForceConsent] = useState(false);
  const [errors, setErrors] = useState<LeadContactErrors>({});
  const [ok, setOk] = useState(false);
  const [pending, start] = useTransition();
  const dirty = leadContactDirty(draft, saved);
  const needsConsent = leadContactNeedsConsent(draft, saved, forceConsent);
  const consentId = useId();
  const showHintId = useId();

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const edit = (patch: Partial<LeadContactDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors({});
    setOk(false);
  };

  const save = () => {
    const v = validateLeadContactDraft(draft, saved, forceConsent);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setOk(false);
    start(async () => {
      try {
        const r = await setOwnLeadContact(v.input);
        if (!r.ok) {
          const fe = leadFieldErrorsOf(r);
          if (fe.acceptConsent) setForceConsent(true);
          setErrors(fe);
          return;
        }
        const next: LeadContactSaved = {
          contactWhatsapp: r.data.contactWhatsapp,
          show: r.data.show,
          // Aceptado ahora: el sello lo puso el server (la fecha exacta no se muestra; alcanza con saber que hay).
          consentAt: v.input.acceptConsent ? new Date().toISOString() : saved.consentAt,
        };
        setSaved(next);
        setDraft(leadContactDraftOf(next));
        setForceConsent(false);
        setOk(true);
      } catch {
        setErrors({ form: COPY.network });
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !pending && !readOnly) save();
      }}
      style={{ display: "grid", gap: 12, marginTop: 12 }}
      noValidate
    >
      <div style={{ maxWidth: 360 }}>
        <FormField
          label={COPY.phoneLabel}
          name="contactWhatsapp"
          type="tel"
          value={draft.phone}
          onChange={(phone) => edit({ phone })}
          hint={COPY.phoneHint}
          error={errors.contactWhatsapp}
          autoComplete="tel"
          disabled={readOnly}
        />
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        <label style={switchRow(readOnly || pending)}>
          <Switch
            on={draft.show}
            onChange={() => edit({ show: !draft.show })}
            disabled={readOnly || pending}
            aria-label={COPY.showLabel}
            aria-describedby={showHintId}
          />
          <span style={rowLabel}>{COPY.showLabel}</span>
        </label>
        <div id={showHintId} style={hintStyle}>
          {draft.show ? COPY.showHintOn : COPY.showHintOff}
        </div>
      </div>
      {needsConsent && (
        <div style={{ display: "grid", gap: 4 }}>
          <label
            htmlFor={consentId}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(15,30,51,0.08)",
              background: "var(--card-bg)",
              cursor: readOnly ? "default" : "pointer",
            }}
          >
            <input
              id={consentId}
              type="checkbox"
              name="acceptConsent"
              checked={draft.accept}
              onChange={(e) => edit({ accept: e.target.checked })}
              disabled={readOnly || pending}
              aria-invalid={errors.acceptConsent ? true : undefined}
              style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, lineHeight: 1.45, color: "var(--navy-900)" }}>{LEAD_CONTACT_CONSENT_COPY}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)" }}>{COPY.consentLabel}</span>
            </span>
          </label>
          {errors.acceptConsent && (
            <div className="k-field-error" role="alert">
              {errors.acceptConsent}
            </div>
          )}
        </div>
      )}
      {errors.form && <ErrorBox>{errors.form}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {ok && !dirty && (
          <span role="status" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>
            {COPY.saved}
          </span>
        )}
        <Button type="submit" variant="primary" size="sm" disabled={!dirty || pending || readOnly}>
          {pending ? COPY.saving : COPY.save}
        </Button>
      </div>
    </form>
  );
}

function NotificationsSection({
  data,
  vapidPublicKey,
  readOnly,
}: {
  data: ConfiguracionMiAgendaData;
  vapidPublicKey: string | null;
  readOnly: boolean;
}) {
  const initial = useMemo(() => ({ email: data.notifyBookingEmail, push: data.notifyBookingPush }), [data]);
  const [prefs, setPrefs] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const emailHintId = useId();
  const pushHintId = useId();
  // Cuando llega el árbol nuevo (la action revalida /configuracion) manda el server.
  useEffect(() => setPrefs(initial), [initial]);

  const write = useCallback(
    (next: { email: boolean; push: boolean }) => {
      const prev = prefs;
      setPrefs(next);
      setError(null);
      start(async () => {
        try {
          const r = await setOwnBookingNotifications(next);
          if (!r.ok) {
            setPrefs(prev);
            setError(r.error);
          }
        } catch {
          setPrefs(prev);
          setError(COPY.network);
        }
      });
    },
    [prefs]
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <label style={switchRow(readOnly || pending)}>
          <Switch
            on={prefs.email}
            onChange={() => write({ ...prefs, email: !prefs.email })}
            disabled={readOnly || pending}
            aria-label={COPY.emailLabel}
            aria-describedby={emailHintId}
          />
          <span style={rowLabel}>{COPY.emailLabel}</span>
        </label>
        <div id={emailHintId} style={hintStyle}>
          {COPY.emailHint}
        </div>
      </div>
      {vapidPublicKey !== null && (
        <div style={{ display: "grid", gap: 4 }}>
          <label style={switchRow(readOnly || pending)}>
            <Switch
              on={prefs.push}
              onChange={() => write({ ...prefs, push: !prefs.push })}
              disabled={readOnly || pending}
              aria-label={COPY.pushLabel}
              aria-describedby={pushHintId}
            />
            <span style={rowLabel}>{COPY.pushLabel}</span>
          </label>
          <div id={pushHintId} style={hintStyle}>
            {COPY.pushHint}
          </div>
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <PushDeviceCard
        vapidPublicKey={vapidPublicKey}
        // Activar un dispositivo con la preferencia apagada no avisaría nunca: se prende sola (un toque, no dos).
        onActivated={() => {
          if (!prefs.push && !readOnly) write({ ...prefs, push: true });
        }}
      />
    </div>
  );
}
