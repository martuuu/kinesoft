"use client";

/**
 * CF2 (§29, T-U1; brief T.C «Pestaña Mi agenda») — Configuración › «Mi agenda»: lo PERSONAL de cada profesional. Mismo
 * gate que «Mis fichas» (lo decide el loader: `miAgenda` null = sin pestaña). Todo es del profesional del actor: las
 * actions toman el profesional de la sesión, nunca de un id del input (salvo el turnero, la anticipación, los servicios,
 * la semana y las excepciones, que también edita Configuración › Profesionales con su permiso; AU-S decide «propio o
 * permiso» en el server con `assertSelfOrScheduleConfigure`).
 *
 * CF3 (§30, D-CF3-13): pasa a ser la configuración COMPLETA del profesional y su pestaña inicial sin «Configuración»
 * (`initialConfigTab`). Siete secciones (las dos de la persona, de CF3b, arriba), en este orden:
 *   0. CF3b PH-U1 (M24): «Tu foto» (`PhotoSection`) y, al lado, «Matrícula» (ver 6): lo que se ve de VOS (avatar,
 *      turnero, sede) va primero, antes de cómo atendés. CT-L había dejado la matrícula al final; PH-U1 la sube junto a
 *      la foto (pedido del orquestador: «arriba, junto a la matrícula»): son los dos datos de la persona de la pestaña.
 *   1. «Servicios y precios»: `ServicesEditor` con `scope="self"` (AU-U1: precio propio, «Nuevo servicio»).
 *   2. «Días y horarios»: `ScheduleEditor` (el mismo de Profesionales, sin tocarlo).
 *   3. «Vacaciones y días especiales»: `ExceptionsEditor` (ídem).
 *      Los dos necesitan sedes y salas: con «Configuración» llegan del loader (`agendaCatalog`); sin ella el loader
 *      no las lee (`g.tenantAdmin`) y se piden acá al montar (`listLocations` = `agenda.viewAll`, que el Profesional
 *      tiene; `listRooms` sin archivadas = cualquier miembro). Así el loader no suma sentencias (pf2-config-budget).
 *   4. «Turnero online»: switch propio, link propio (D-CF3-12: «Copiar» y «Compartir por WhatsApp», deshabilitado con
 *      el motivo si falta el turnero del consultorio o el propio), «Mostrar mi precio» (D-CF3-3), anticipación, el
 *      contacto «Si te piden un turno antes» (D-CF2-9) y el WhatsApp para pacientes con obra social (D-CF3-5). Este
 *      último va DESPUÉS del contacto y no antes (el orden del brief) porque usa el MISMO número guardado ahí: prenderlo
 *      sin número es un error que el usuario no puede resolver sin bajar.
 *   5. «Avisos de turnos online» (D-CF2-11/12): mail y notificación; «Este dispositivo» en `PushDeviceCard`.
 *   6. CF3b CT-L (M23): «Matrícula» de la PERSONA (`LicenseSection`), opcional; la ve el Titular en Usuarios antes de
 *      dar «Co-titular». Es un dato de la cuenta, no de cómo se atiende: por eso va con la foto (0) y no entre las
 *      secciones de la agenda. Va también con el consultorio en modo lectura (no es un dato del consultorio; ver la
 *      cabecera de `license-section.tsx`).
 *
 * Bundle (techo de `/configuracion`): el panel ya es un chunk diferido; los tres editores pesados son además
 * `next/dynamic` propios (los mismos chunks que usa Profesionales: no se duplica código).
 */
import { useCallback, useEffect, useId, useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { Card } from "@/components/ui/card";
import { Button, buttonClassName } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { SkelForm } from "@/components/ui/skeleton";
import { WhatsAppIcon } from "@/components/ui/brand-icons";
import {
  setOwnBookingNotifications,
  setOwnInsuredContact,
  setOwnLeadContact,
  setOwnShowPublicPrice,
} from "@/lib/practitioner-self-settings";
import { listLocations } from "@/lib/locations";
import { listRooms } from "@/lib/rooms";
import { LEAD_CONTACT_CONSENT_COPY } from "@/lib/public-lead-contact";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";
import type { LocationRow } from "@/lib/locations-schemas";
import type { RoomCatalogEntry } from "@/lib/schedule-editor-state";
import { OWN_TURNERO_OFF_HINT, PublicBookingSwitch } from "./practitioners/public-booking-switch";
import { PractitionerLeadEditor } from "./practitioners/lead-editor";
import { PushDeviceCard } from "./push-device-card";
import { LicenseSection } from "./license-section";
import { PhotoSection } from "./photo-section";
import { USER_LICENSE_COPY as LICENSE_COPY } from "@/lib/user-license-logic";
import {
  MI_AGENDA_COPY as COPY,
  PHOTO_COPY,
  insuredContactUiOf,
  insuredErrorOf,
  leadContactDirty,
  leadContactDraftOf,
  leadContactNeedsConsent,
  leadContactSavedOf,
  leadFieldErrorsOf,
  ownBookingLinkOf,
  ownBookingWhatsAppHref,
  validateLeadContactDraft,
  type LeadContactDraft,
  type LeadContactErrors,
  type LeadContactSaved,
} from "./mi-agenda-logic";
import { ErrorBox } from "../controls";

function SectionSkeleton() {
  return (
    <div aria-busy="true" style={{ minHeight: 160 }}>
      <SkelForm fields={2} />
    </div>
  );
}
// Opciones como literal en cada llamada (el transform de Next lo pide). Los mismos módulos que importa Profesionales.
const ServicesEditor = dynamic(() => import("./practitioners/services-editor").then((m) => m.ServicesEditor), {
  loading: SectionSkeleton,
});
const ScheduleEditor = dynamic(() => import("./practitioners/schedule-editor").then((m) => m.ScheduleEditor), {
  loading: SectionSkeleton,
});
const ExceptionsEditor = dynamic(() => import("./practitioners/exceptions-editor").then((m) => m.ExceptionsEditor), {
  loading: SectionSkeleton,
});

const intro: React.CSSProperties = { fontSize: 13, color: "var(--navy-500)", margin: "6px 0 0", lineHeight: 1.45, maxWidth: 640 };
const hintStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4 };
const rowLabel: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "var(--navy-900)" };
const subTitle: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--navy-900)", margin: 0 };
const divider: React.CSSProperties = { borderTop: "1px solid rgba(15,30,51,0.08)", paddingTop: 14, display: "grid", gap: 4 };
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

const personRow: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
  gap: 14,
  minWidth: 0,
};

/** Sedes y salas para los editores de semana y excepciones. */
export type MiAgendaCatalog = { locations: LocationRow[]; rooms: ReadonlyArray<RoomCatalogEntry> };

function Section({ id, title, introText, children }: { id: string; title: string; introText: string; children: React.ReactNode }) {
  return (
    <Card style={{ padding: 20, display: "grid", gap: 14, minWidth: 0 }} data-mi-agenda-section={id}>
      <div>
        <EyebrowLabel as="h2">{title}</EyebrowLabel>
        <p style={intro}>{introText}</p>
      </div>
      {children}
    </Card>
  );
}

export function MiAgendaPanel({
  data,
  vapidPublicKey,
  readOnly = false,
  onDirtyChange,
  clinicName = "",
  agendaCatalog = null,
}: {
  data: ConfiguracionMiAgendaData;
  /** Clave PÚBLICA VAPID (`webPushVapid()?.publicKey`); null = push sin configurar en el server. */
  vapidPublicKey: string | null;
  /** Consultorio en modo lectura: se ve todo, no se guarda (las actions lo rechazan igual). */
  readOnly?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  /** CF3 (D-CF3-12): para el texto de «Compartir por WhatsApp» («… en {consultorio}: link»). */
  clinicName?: string;
  /** CF3: sedes y salas del loader (quien tiene «Configuración»); null = se piden al montar. */
  agendaCatalog?: MiAgendaCatalog | null;
}) {
  // Formularios en línea con dirty propio (servicios, anticipación, contacto): al padre sube el OR.
  const [servicesDirty, setServicesDirty] = useState(false);
  const [leadDirty, setLeadDirty] = useState(false);
  const [contactDirty, setContactDirty] = useState(false);
  const [licenseDirty, setLicenseDirty] = useState(false);
  const dirty = servicesDirty || leadDirty || contactDirty || licenseDirty;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const catalog = useAgendaCatalog(agendaCatalog);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14 }}>
      {/* PH-U1: foto y matrícula lado a lado desde ~900 px; abajo de eso (mobile 390) una sobre otra. `min(100%, …)`
          evita que la columna mínima desborde a 320. */}
      <div style={personRow}>
        <Section id="foto" title={PHOTO_COPY.section} introText={PHOTO_COPY.intro}>
          <PhotoSection initial={data.photo} name={data.name} readOnly={readOnly} />
        </Section>
        <Section id="matricula" title={LICENSE_COPY.section} introText={LICENSE_COPY.intro}>
          <LicenseSection initial={data.license} onDirtyChange={setLicenseDirty} />
        </Section>
      </div>

      <Section id="servicios" title={COPY.sectionServices} introText={COPY.servicesIntro}>
        <ServicesEditor
          practitionerId={data.practitionerId}
          practitionerName={data.name}
          scope="self"
          onDirtyChange={setServicesDirty}
        />
      </Section>

      <Section id="horarios" title={COPY.sectionWeek} introText={COPY.weekIntro}>
        <CatalogGate catalog={catalog}>
          {(c) => (
            <ScheduleEditor
              practitionerId={data.practitionerId}
              practitionerName={data.name}
              locations={c.locations}
              rooms={c.rooms}
            />
          )}
        </CatalogGate>
      </Section>

      <Section id="excepciones" title={COPY.sectionExceptions} introText={COPY.exceptionsIntro}>
        <CatalogGate catalog={catalog}>
          {(c) => (
            <ExceptionsEditor
              practitionerId={data.practitionerId}
              practitionerName={data.name}
              locations={c.locations}
              rooms={c.rooms}
            />
          )}
        </CatalogGate>
      </Section>

      <Section id="turnero" title={COPY.cardTurnero} introText={COPY.turneroIntro}>
        <PublicBookingSwitch
          practitionerId={data.practitionerId}
          name={data.name}
          enabled={data.publicBookingEnabled}
          tenantOpen={data.tenantPublicBookingEnabled}
          offHint={OWN_TURNERO_OFF_HINT}
        />
        <OwnBookingLink data={data} clinicName={clinicName} />
        <ShowPriceSwitch data={data} readOnly={readOnly} />
        <PractitionerLeadEditor
          practitionerId={data.practitionerId}
          practitionerName={data.name}
          own={data.publicMinLeadMinutes}
          tenant={data.tenantPublicMinLeadMinutes}
          self
          onDirtyChange={setLeadDirty}
        />
        <div style={divider}>
          <h3 style={subTitle}>{COPY.cardLeadContact}</h3>
          <p style={{ ...intro, margin: 0 }}>{COPY.leadContactIntro}</p>
          <LeadContactForm data={data} readOnly={readOnly} onDirtyChange={setContactDirty} />
        </div>
        <InsuredContactSwitch data={data} readOnly={readOnly} />
      </Section>

      <Section id="avisos" title={COPY.cardNotifications} introText={COPY.notificationsIntro}>
        <NotificationsSection data={data} vapidPublicKey={vapidPublicKey} readOnly={readOnly} />
      </Section>
    </div>
  );
}

type CatalogState = { catalog: MiAgendaCatalog | null; error: string | null; retry: () => void };

/** Sedes y salas: las del loader si llegaron; si no, una lectura al montar (compartida por semana y excepciones). */
function useAgendaCatalog(initial: MiAgendaCatalog | null): CatalogState {
  const [catalog, setCatalog] = useState<MiAgendaCatalog | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fromLoader = initial !== null;
  // Con «Configuración», el árbol nuevo (una sede creada en otra pestaña) manda.
  useEffect(() => {
    if (initial) setCatalog(initial);
  }, [initial]);
  useEffect(() => {
    if (fromLoader) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        // Archivadas incluidas: una franja vieja en una sede archivada se sigue rotulando. Salas solo activas (las
        // archivadas piden `schedule.configure`): una franja con sala archivada se ve sin el nombre de la sala.
        const [locations, rooms] = await Promise.all([listLocations({ includeArchived: true }), listRooms({})]);
        if (!cancelled) setCatalog({ locations, rooms });
      } catch {
        if (!cancelled) setError(COPY.catalogError);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromLoader, attempt]);
  return { catalog, error, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

function CatalogGate({ catalog, children }: { catalog: CatalogState; children: (c: MiAgendaCatalog) => React.ReactNode }) {
  if (catalog.catalog) return <>{children(catalog.catalog)}</>;
  if (catalog.error) {
    return (
      <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
        <ErrorBox>{catalog.error}</ErrorBox>
        <Button type="button" variant="ghost" size="sm" onClick={catalog.retry}>
          {COPY.retry}
        </Button>
      </div>
    );
  }
  return (
    <div aria-busy="true" style={hintStyle}>
      {COPY.catalogLoading}
    </div>
  );
}

/**
 * D-CF3-12: «Tu link para sacar turno». El origin solo existe en el browser: el SSR pinta la ruta relativa y se
 * completa al montar (mismo criterio que el link del consultorio en General). Estado honesto: si el link llevaría a un
 * turnero que no lo muestra, se ve deshabilitado y dice qué falta. Sin QR (sería una librería nueva).
 */
function OwnBookingLink({ data, clinicName }: { data: ConfiguracionMiAgendaData; clinicName: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const reasonId = useId();
  useEffect(() => setOrigin(window.location.origin), []);
  const link = ownBookingLinkOf(data, origin);
  const waHref = ownBookingWhatsAppHref(clinicName, data.name, link.url);

  const copy = () => {
    if (!link.enabled) return;
    const done = (r: "ok" | "fail") => {
      setCopied(r);
      if (r === "ok") window.setTimeout(() => setCopied(null), 2000);
    };
    try {
      navigator.clipboard.writeText(link.url).then(
        () => done("ok"),
        () => done("fail")
      );
    } catch {
      done("fail");
    }
  };

  return (
    <div style={divider} data-own-booking-link={link.enabled ? "on" : "off"}>
      <span style={rowLabel}>{COPY.linkTitle}</span>
      <div style={hintStyle}>{COPY.linkHint}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 4, minWidth: 0 }}>
        <input
          className="k-input"
          readOnly
          value={link.url}
          aria-label={COPY.linkTitle}
          aria-describedby={link.reason ? reasonId : undefined}
          disabled={!link.enabled}
          onFocus={(e) => e.currentTarget.select()}
          style={{ flex: "1 1 220px", minWidth: 0, fontSize: 13 }}
        />
        <Button type="button" variant="ghost" size="sm" onClick={copy} disabled={!link.enabled}>
          {copied === "ok" ? COPY.copied : COPY.copy}
        </Button>
        {link.enabled ? (
          <a
            className={buttonClassName({ variant: "ghost", size: "sm" })}
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <WhatsAppIcon size={16} brand />
            {COPY.shareWhatsApp}
          </a>
        ) : (
          <Button type="button" variant="ghost" size="sm" disabled style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <WhatsAppIcon size={16} />
            {COPY.shareWhatsApp}
          </Button>
        )}
      </div>
      {link.reason && (
        <div id={reasonId} data-own-booking-link-reason style={{ ...hintStyle, color: "var(--navy-700)", fontWeight: 600 }}>
          {link.reason}
        </div>
      )}
      {copied === "fail" && (
        <div role="alert" style={{ ...hintStyle, color: "var(--danger-fg)" }}>
          {COPY.copyFailed}
        </div>
      )}
    </div>
  );
}

/** D-CF3-3: se guarda al tocar (como el switch del turnero); optimista con vuelta atrás si el server lo rechaza. */
function ShowPriceSwitch({ data, readOnly }: { data: ConfiguracionMiAgendaData; readOnly: boolean }) {
  const [on, setOn] = useState(data.showPublicPrice);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hintId = useId();
  useEffect(() => setOn(data.showPublicPrice), [data.showPublicPrice]);
  const toggle = () => {
    const prev = on;
    const next = !on;
    setOn(next);
    setError(null);
    start(async () => {
      try {
        const r = await setOwnShowPublicPrice(next);
        if (!r.ok) {
          setOn(prev);
          setError(r.error);
        }
      } catch {
        setOn(prev);
        setError(COPY.network);
      }
    });
  };
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <label style={switchRow(readOnly || pending)}>
        <Switch on={on} onChange={toggle} disabled={readOnly || pending} aria-label={COPY.priceLabel} aria-describedby={hintId} />
        <span style={rowLabel}>{COPY.priceLabel}</span>
      </label>
      <div id={hintId} style={hintStyle}>
        {on ? COPY.priceHintOn : COPY.priceHintOff}
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

/**
 * D-CF3-5: «Mostrar mi WhatsApp a pacientes con obra social». Usa el número GUARDADO en «Si te piden un turno antes»
 * (el server lo lee de la base). Prenderlo pide el consentimiento v2 (cubre los dos usos): sin ninguno sellado, la
 * casilla aparece antes de llamar; con uno v1 (CF2, solo hablaba del contacto en la anticipación) lo pide el server y
 * recién ahí aparece. Apagar es directo.
 */
function InsuredContactSwitch({ data, readOnly }: { data: ConfiguracionMiAgendaData; readOnly: boolean }) {
  const ui = insuredContactUiOf(data);
  const [on, setOn] = useState(data.showContactForInsured);
  const [askConsent, setAskConsent] = useState(false);
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hintId = useId();
  const consentId = useId();
  // El server manda (p. ej. borrar el número apaga este switch, AU-C).
  useEffect(() => setOn(data.showContactForInsured), [data.showContactForInsured]);

  const write = (show: boolean, acceptConsent: boolean) => {
    const prev = on;
    setError(null);
    start(async () => {
      try {
        const r = await setOwnInsuredContact(show, acceptConsent ? { acceptConsent: true } : {});
        if (!r.ok) {
          setOn(prev);
          const e = insuredErrorOf(r);
          if (e.needsConsent) setAskConsent(true);
          setError(e.error);
          return;
        }
        setOn(r.data.showContactForInsured);
        setAskConsent(false);
        setAccept(false);
      } catch {
        setOn(prev);
        setError(COPY.network);
      }
    });
  };

  const toggle = () => {
    if (on) {
      setOn(false);
      write(false, false);
      return;
    }
    if (!ui.canEnable) {
      setError(COPY.insuredNeedsPhone);
      return;
    }
    if (ui.needsConsentUpfront) {
      setAskConsent(true);
      return;
    }
    setOn(true);
    write(true, false);
  };

  const disabled = readOnly || pending;
  return (
    <div style={divider}>
      <label style={switchRow(disabled)}>
        <Switch
          on={on}
          onChange={toggle}
          disabled={disabled}
          aria-label={COPY.insuredLabel}
          aria-describedby={hintId}
        />
        <span style={rowLabel}>{COPY.insuredLabel}</span>
      </label>
      <div id={hintId} style={hintStyle}>
        {on ? COPY.insuredHintOn : ui.canEnable ? COPY.insuredHintOff : COPY.insuredNeedsPhone}
      </div>
      {askConsent && !on && (
        <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
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
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <input
              id={consentId}
              type="checkbox"
              name="acceptInsuredConsent"
              checked={accept}
              onChange={(e) => setAccept(e.target.checked)}
              disabled={disabled}
              style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
            />
            <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, lineHeight: 1.45, color: "var(--navy-900)" }}>{LEAD_CONTACT_CONSENT_COPY}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy-700)" }}>{COPY.consentLabel}</span>
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setAskConsent(false);
                setAccept(false);
                setError(null);
              }}
            >
              {COPY.cancel}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={!accept || disabled}
              onClick={() => {
                setOn(true);
                write(true, true);
              }}
            >
              {pending ? COPY.saving : COPY.insuredAccept}
            </Button>
          </div>
        </div>
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
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
