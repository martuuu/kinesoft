"use client";

/**
 * [TP-3a] Configuración → «Cobros online» (§25.10; decisión 1 de Martin, 19-oct: la política la configura quien tiene
 * lo delicado, `tenant.sensitive`; la Secretaría y Facturación no ven la pestaña, ni con `?tab=`).
 *
 * Qué se configura (contrato C-TP5, `savePaymentPolicy` con `expectedUpdatedAt`):
 *   - «¿Cobrás el turno online?»: apagado = el turnero reserva sin cobro, como TP-0 (y el resto se esconde);
 *   - «Permitir reservar sin pagar»: prendido = OPTIONAL (el paciente elige, TP-UI-D5), apagado = REQUIRED. Pasar a
 *     REQUIRED confirma con `useConfirm`: el turnero deja de confirmar turnos sin pago (TP-D15, sin efectivo);
 *   - «¿Cuánto se cobra online?»: el valor del turno (mismo resolver que la agenda), una seña fija ($1..$1.000.000) o
 *     un porcentaje, con una vista previa sobre el precio del servicio más usado (`quoteOnlineCharge`, la MISMA
 *     función que cotiza el turnero: la vista previa no puede decir otra cosa que lo que va a ver el paciente);
 *   - «Usar la cuenta del consultorio para los profesionales sin Mercado Pago» (TP-D9; solo con esa cuenta conectada,
 *     la action lo exige igual);
 *   - nota de cancelación (≤280, la ve el paciente en texto plano).
 *
 * Formulario en línea con «Guardar cambios» / «Descartar» (useConfirm), `beforeunload` y `onDirtyChange` (el shell
 * frena el cambio de pestaña), como Directorio y Mis fichas. Un guardado concurrente vuelve como «otra persona
 * cambió la política» (optimistic lock) y no se pisa en silencio.
 *
 * Va en su propio chunk (`next/dynamic` desde `configuracion-client.tsx`, techo `/configuracion` +0,5 kB, §25.11).
 * La lógica del formulario es pura y exportada (el repo no tiene DOM en los tests de render).
 */
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { StepUpProvider } from "@/components/account/step-up-modal";
import { formatARS } from "@/lib/format";
import { quoteOnlineCharge, MAX_ONLINE_CHARGE_CENTS, MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";
import {
  MP_ACCOUNT_STATUS_LABEL,
  MP_CONNECT_COPY,
  PAYMENT_LINK_COPY,
  missingMpAccountsNotice,
} from "@/lib/online-payments-copy";
import {
  CANCELLATION_NOTE_MAX,
  PERCENT_BPS_MAX,
  PaymentPolicySchema,
  type BookingChargeKind,
  type BookingPaymentMode,
  type PaymentPolicyInput,
} from "@/lib/booking-payment-policy-types";
import { savePaymentPolicy } from "@/lib/booking-payment-policy";
import type { MyMpPanelProps, OnlinePaymentsPanelProps } from "@/components/payments/payments-ui-types";
import type { OnlinePaymentsPractitionerRow } from "@/lib/mp-connect-types";
import { ClinicMpAccountCard } from "./clinic-mp-account-card";
import { MyMpPanel, useDropMpReturnParam } from "./my-mp-panel";
import { ErrorBox, Switch } from "../controls";

// TP-3a: «Mi Mercado Pago» (TP-3b) viaja en este mismo chunk (ver `configuracion-client.tsx`: un chunk diferido menos).
export { MyMpPanel } from "./my-mp-panel";

// ── Lógica pura del formulario (exportada para el test) ─────────────────────────────────────────────────────────────

export const ONLINE_PAYMENTS_COPY = {
  intro:
    "El paciente paga con Mercado Pago al sacar turno en el turnero online. La plata entra a la cuenta de cada profesional (o a la del consultorio, si lo elegís abajo).",
  support: "Estás en una sesión de soporte: ves los cobros online en solo lectura.",
  allowHint: "Prendido, el paciente elige pagar ahora o en el consultorio. Apagado, el turno se confirma solo si paga.",
  kindCopago: "El valor del turno",
  kindCopagoHint: "El copago de la obra social o el precio particular, como lo calcula la agenda.",
  kindFixed: "Una seña fija",
  kindPercent: "Un porcentaje del valor del turno",
  fixedLabel: "Monto de la seña",
  percentLabel: "Porcentaje",
  percentRange: "Poné un porcentaje de 0,01 a 100.",
  fixedMissing: "Poné el monto de la seña.",
  useClinicNeedsAccount: "Para usarla, primero conectá el Mercado Pago del consultorio (abajo).",
  noteLabel: "Nota de cancelación (opcional)",
  noteHint: "La ve el paciente en el turnero antes de pagar. Ej.: «Si cancelás con menos de 24 h, la seña no se reintegra».",
  noteTooLong: `La nota puede tener hasta ${CANCELLATION_NOTE_MAX} caracteres.`,
  turneroOff: "El turnero online está apagado: los cobros se aplican cuando lo prendas en General.",
  withoutMpUsesClinic: "cobran con la cuenta del consultorio.",
  withoutMpNoCharge: "su turnero reserva sin cobro online.",
  previewNoPrice: "Cargá el precio de un servicio para ver un ejemplo.",
  previewIncomplete: "Completá el monto para ver un ejemplo.",
  requiredTitle: "¿Cobrar el turno antes de reservarlo?",
  requiredMessage:
    "El turnero va a confirmar el turno solo cuando el paciente pague con Mercado Pago: quien no pueda pagar online no va a poder reservar desde el turnero. Los profesionales sin Mercado Pago conectado siguen reservando sin cobro.",
  requiredConfirm: "Sí, cobrar antes",
  save: "Guardar cambios",
  discard: "Descartar",
  discardTitle: "¿Descartar los cambios?",
  discardMessage: "Los cobros online vuelven a como estaban guardados.",
  saved: "Guardamos los cobros online",
  unsaved: "Tenés cambios sin guardar.",
  practitionersEmpty: "Todavía no hay profesionales que atiendan.",
  linksAllowed: "Autorizó links de pago",
  particularZero:
    "Particular está en $ 0: el turnero no les cobra online a los pacientes particulares. Cargá su precio en Obras sociales.",
} as const;

/** Lo que edita el formulario. El porcentaje va como texto (lo que tipeó); la plata, en centavos. */
export type PolicyDraft = {
  on: boolean;
  allowWithoutPaying: boolean;
  chargeKind: BookingChargeKind;
  fixedCents: number | null;
  percentText: string;
  useClinicAccount: boolean;
  note: string;
};

/**
 * «30» → 3000 bps, «12,5» → 1250, «0,01» → 1. Aritmética de strings (nada de `Number()*100`): hasta 3 enteros y 2
 * decimales, coma o punto. null = no se entiende. El rango (0,01..100) lo valida `draftErrors`.
 */
export function parsePercentBps(raw: string): number | null {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(raw);
  if (!m) return null;
  const dec = (m[2] ?? "").padEnd(2, "0");
  return parseInt(m[1], 10) * 100 + parseInt(dec, 10);
}

/** 3000 → «30», 1250 → «12,5», 1 → «0,01». */
export function formatPercentBps(bps: number | null): string {
  if (bps == null || !Number.isInteger(bps)) return "";
  const int = Math.floor(bps / 100);
  const dec = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return dec ? `${int},${dec}` : String(int);
}

export function draftOf(p: PaymentPolicyInput): PolicyDraft {
  return {
    on: p.mode !== "OFF",
    // Sin política (OFF), prender arranca en OPTIONAL: el modo que no le corta la reserva a nadie.
    allowWithoutPaying: p.mode !== "REQUIRED",
    chargeKind: p.chargeKind,
    fixedCents: p.fixedCents,
    percentText: formatPercentBps(p.percentBps),
    useClinicAccount: p.useClinicAccount,
    note: p.cancellationNote ?? "",
  };
}

export function modeOf(d: Pick<PolicyDraft, "on" | "allowWithoutPaying">): BookingPaymentMode {
  if (!d.on) return "OFF";
  return d.allowWithoutPaying ? "OPTIONAL" : "REQUIRED";
}

/** Largo de la nota como lo mide el schema (recortada). */
export function noteLength(note: string): number {
  return note.trim().length;
}

export type DraftErrors = Partial<Record<"fixedCents" | "percentBps" | "cancellationNote" | "form", string>>;

/** Errores de forma del borrador (los mismos límites que la action y los CHECK de M18). Vacío = se puede guardar. */
export function draftErrors(d: PolicyDraft): DraftErrors {
  const e: DraftErrors = {};
  // Apagado no valida el monto: no se usa, y `policyOfDraft` lo normaliza.
  if (d.on && d.chargeKind === "FIXED") {
    if (d.fixedCents == null) e.fixedCents = ONLINE_PAYMENTS_COPY.fixedMissing;
    else if (d.fixedCents < MIN_ONLINE_CHARGE_CENTS || d.fixedCents > MAX_ONLINE_CHARGE_CENTS) e.fixedCents = PAYMENT_LINK_COPY.amountRange;
  }
  if (d.on && d.chargeKind === "PERCENT") {
    const bps = parsePercentBps(d.percentText);
    if (bps == null || bps < 1 || bps > PERCENT_BPS_MAX) e.percentBps = ONLINE_PAYMENTS_COPY.percentRange;
  }
  if (noteLength(d.note) > CANCELLATION_NOTE_MAX) e.cancellationNote = ONLINE_PAYMENTS_COPY.noteTooLong;
  return e;
}

/**
 * Borrador → input de `savePaymentPolicy` (C-TP5). Apagado conserva el monto si es válido (prender de nuevo no lo
 * pierde) y si no vuelve a «el valor del turno»: los CHECK piden el monto solo con su tipo.
 */
export function policyOfDraft(d: PolicyDraft): PaymentPolicyInput {
  const mode = modeOf(d);
  const bps = parsePercentBps(d.percentText);
  const fixedOk = d.fixedCents != null && d.fixedCents >= MIN_ONLINE_CHARGE_CENTS && d.fixedCents <= MAX_ONLINE_CHARGE_CENTS;
  const pctOk = bps != null && bps >= 1 && bps <= PERCENT_BPS_MAX;
  let chargeKind = d.chargeKind;
  if (mode === "OFF" && ((chargeKind === "FIXED" && !fixedOk) || (chargeKind === "PERCENT" && !pctOk))) chargeKind = "COPAGO";
  const note = d.note.trim();
  return {
    mode,
    chargeKind,
    fixedCents: chargeKind === "FIXED" ? d.fixedCents : null,
    percentBps: chargeKind === "PERCENT" ? bps : null,
    useClinicAccount: d.useClinicAccount,
    cancellationNote: note === "" ? null : note,
  };
}

export function samePolicyInput(a: PaymentPolicyInput, b: PaymentPolicyInput): boolean {
  return (
    a.mode === b.mode &&
    a.chargeKind === b.chargeKind &&
    a.fixedCents === b.fixedCents &&
    a.percentBps === b.percentBps &&
    a.useClinicAccount === b.useClinicAccount &&
    (a.cancellationNote ?? null) === (b.cancellationNote ?? null)
  );
}

/** Pasar a REQUIRED pide confirmación (salvo que ya estuviera guardado así: no se pregunta lo ya decidido). */
export function needsRequiredConfirm(savedMode: BookingPaymentMode, nextMode: BookingPaymentMode): boolean {
  return nextMode === "REQUIRED" && savedMode !== "REQUIRED";
}

/**
 * Aplica un cambio del modo (switch principal o «Permitir reservar sin pagar») con la confirmación de REQUIRED.
 * Devuelve el borrador nuevo, o null si canceló (el switch queda como estaba).
 */
export async function applyModeChange(
  draft: PolicyDraft,
  patch: Partial<Pick<PolicyDraft, "on" | "allowWithoutPaying">>,
  savedMode: BookingPaymentMode,
  confirm: (o: ConfirmOptions) => Promise<boolean>
): Promise<PolicyDraft | null> {
  const next = { ...draft, ...patch };
  if (needsRequiredConfirm(savedMode, modeOf(next))) {
    const ok = await confirm({
      title: ONLINE_PAYMENTS_COPY.requiredTitle,
      message: ONLINE_PAYMENTS_COPY.requiredMessage,
      confirmLabel: ONLINE_PAYMENTS_COPY.requiredConfirm,
      cancelLabel: "Cancelar",
    });
    if (!ok) return null;
  }
  return next;
}

/** Vista previa de «¿Cuánto se cobra online?» con la MISMA cotización que el turnero (`quoteOnlineCharge`). */
export function previewLine(policy: PaymentPolicyInput, priceCents: number | null): string {
  if (priceCents == null) return ONLINE_PAYMENTS_COPY.previewNoPrice;
  const price = formatARS(priceCents);
  const q = quoteOnlineCharge({ policy: policy.mode === "OFF" ? { ...policy, mode: "OPTIONAL" } : policy, servicePriceCents: priceCents });
  if (!q) return `Con un turno de ${price} no se cobra nada online: el monto queda por debajo de ${formatARS(MIN_ONLINE_CHARGE_CENTS)}.`;
  if (q.chargeKind === "FULL") return `Con un turno de ${price}, el paciente paga ${formatARS(q.amountCents)} online.`;
  return `Con un turno de ${price}, el paciente paga ${formatARS(q.amountCents)} de seña online y ${formatARS(priceCents - q.amountCents)} en el consultorio.`;
}

/**
 * TP-ZF3 (hallazgo A1): con los cobros prendidos y Particular en $ 0 (o sin la fila), el valor del turno de un
 * particular es 0 y el turnero no tiene qué cobrarle: lo reserva sin cobro. Sin este aviso el consultorio prendía los
 * cobros, veía la vista previa con el precio del servicio y no entendía por qué los particulares no pagaban.
 */
export function particularZeroNotice(on: boolean, particularCopagoCents: number | null): string | null {
  if (!on) return null;
  return particularCopagoCents == null || particularCopagoCents <= 0 ? ONLINE_PAYMENTS_COPY.particularZero : null;
}

/** Aviso de profesionales sin cuenta, con lo que pasa con su turnero. */
export function withoutMpNotice(n: number, usesClinic: boolean): string | null {
  if (n <= 0) return null;
  return `${missingMpAccountsNotice(n)}: ${usesClinic ? ONLINE_PAYMENTS_COPY.withoutMpUsesClinic : ONLINE_PAYMENTS_COPY.withoutMpNoCharge}`;
}

// ── UI ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const noteBox = {
  padding: "10px 12px",
  borderRadius: "var(--r-sm)",
  fontSize: 12.5,
  lineHeight: 1.45,
} as const;
const warnBox = { ...noteBox, background: "var(--warn-bg)", border: "1px solid var(--warn-border)", color: "var(--warn-fg)" };
const infoBox = { ...noteBox, background: "var(--sky-50)", border: "1px solid var(--sky-200)", color: "var(--navy-700)" };
const rowLabel = { fontSize: 14, fontWeight: 700, color: "var(--navy-900)" } as const;
const hint = { fontSize: 12, color: "var(--navy-500)", margin: "2px 0 0", lineHeight: 1.45 } as const;

/**
 * TP-ZF3: la ÚNICA entrada diferida de las dos pestañas de Mercado Pago (`configuracion-client.tsx` hace un solo
 * `dynamic()` sobre esto). Con dos `dynamic()` del mismo módulo, el JS inicial de /configuracion llevaba dos wrappers
 * de carga para el mismo chunk. La pestaña sigue siendo el estado del shell (`?tab=`): los deep links no cambian.
 */
export function MercadoPagoTab(p: ({ tab: "cobros-online" } & OnlinePaymentsPanelProps) | ({ tab: "mercado-pago" } & MyMpPanelProps)) {
  if (p.tab === "mercado-pago") {
    const { tab: _tab, ...rest } = p;
    return <MyMpPanel {...rest} />;
  }
  const { tab: _tab, ...rest } = p;
  return <OnlinePaymentsPanel {...rest} />;
}

export function OnlinePaymentsPanel(props: OnlinePaymentsPanelProps) {
  // Conectar y desconectar la cuenta del consultorio piden la verificación en dos pasos (decisión 1).
  return (
    <StepUpProvider>
      <OnlinePaymentsPanelBody {...props} />
    </StepUpProvider>
  );
}

// TP-ZF3: sin rama «modo apagado»: con `MP_CONNECT_MODE=off` esta pestaña no existe (`configuracion-page-loader.ts`,
// gate `onlinePayments`), así que ese aviso y los controles deshabilitados eran código muerto.
function OnlinePaymentsPanelBody({ settings, previewServicePriceCents, mpReturn, support = false, onDirtyChange }: OnlinePaymentsPanelProps) {
  useDropMpReturnParam(mpReturn);
  return (
    <div style={{ display: "grid", gap: 14 }} data-online-payments-panel="">
      {support && (
        <div role="note" style={warnBox}>
          {ONLINE_PAYMENTS_COPY.support}
        </div>
      )}
      <PolicyCard
        settings={settings}
        previewServicePriceCents={previewServicePriceCents}
        readOnly={support}
        onDirtyChange={onDirtyChange}
      />
      <ClinicMpAccountCard
        account={settings.clinicAccount}
        canManage={settings.canManageClinicAccount}
        mpReturn={mpReturn}
        support={support}
      />
      <PractitionersCard rows={settings.practitioners} />
    </div>
  );
}

function PolicyCard({
  settings,
  previewServicePriceCents,
  readOnly,
  onDirtyChange,
}: {
  settings: OnlinePaymentsPanelProps["settings"];
  previewServicePriceCents: number | null;
  readOnly: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const ids = useId();
  const [saved, setSaved] = useState<PaymentPolicyInput>(settings.policy);
  const [expected, setExpected] = useState<string | null>(settings.policyUpdatedAt);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftOf(settings.policy));
  const [error, setError] = useState<string | null>(null);
  const [moneyInvalid, setMoneyInvalid] = useState(false);
  const [pending, start] = useTransition();

  const next = policyOfDraft(draft);
  const dirty = !samePolicyInput(next, saved);
  const errors = draftErrors(draft);
  const hasErrors = moneyInvalid || Object.keys(errors).length > 0;

  // Cuando llega el árbol nuevo (otro guardado, revalidatePath) manda el server, salvo que haya algo sin guardar.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setSaved(settings.policy);
    setExpected(settings.policyUpdatedAt);
    setDraft(draftOf(settings.policy));
  }, [settings.policy, settings.policyUpdatedAt]);

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = (patch: Partial<PolicyDraft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const changeMode = async (patch: Partial<Pick<PolicyDraft, "on" | "allowWithoutPaying">>) => {
    if (readOnly) return;
    const r = await applyModeChange(draft, patch, saved.mode, confirm);
    if (r) set({ on: r.on, allowWithoutPaying: r.allowWithoutPaying });
  };

  const save = () => {
    if (readOnly || !dirty || hasErrors || pending) return;
    // Red final: el mismo schema que la action (y que los CHECK de M18).
    const parsed = PaymentPolicySchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisá los datos.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await savePaymentPolicy(next, expected);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSaved(next);
      setExpected(r.data.updatedAt);
      setDraft(draftOf(next));
      toast.success(ONLINE_PAYMENTS_COPY.saved);
    });
  };

  const discard = async () => {
    const ok = await confirm({
      title: ONLINE_PAYMENTS_COPY.discardTitle,
      message: ONLINE_PAYMENTS_COPY.discardMessage,
      confirmLabel: ONLINE_PAYMENTS_COPY.discard,
      cancelLabel: "Seguir editando",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setMoneyInvalid(false);
    setDraft(draftOf(saved));
  };

  const clinicActive = settings.clinicAccount.status === "ACTIVE";
  const usesClinic = draft.useClinicAccount && clinicActive;
  const missing = withoutMpNotice(settings.withoutMpCount, usesClinic);
  const particularZero = particularZeroNotice(draft.on, settings.particularCopagoCents);
  const noteLen = noteLength(draft.note);
  const kinds: { value: BookingChargeKind; label: string }[] = [
    { value: "COPAGO", label: ONLINE_PAYMENTS_COPY.kindCopago },
    { value: "FIXED", label: ONLINE_PAYMENTS_COPY.kindFixed },
    { value: "PERCENT", label: ONLINE_PAYMENTS_COPY.kindPercent },
  ];

  return (
    <Card style={{ padding: 18, display: "grid", gap: 16 }}>
      <div>
        <EyebrowLabel>{MP_CONNECT_COPY.onlinePaymentsTab}</EyebrowLabel>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "4px 0 0", lineHeight: 1.5 }}>{ONLINE_PAYMENTS_COPY.intro}</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Switch
          on={draft.on}
          onChange={() => void changeMode({ on: !draft.on })}
          disabled={readOnly || pending}
          aria-label={MP_CONNECT_COPY.chargeOnlineSwitch}
        />
        <span style={rowLabel}>{MP_CONNECT_COPY.chargeOnlineSwitch}</span>
      </div>

      {draft.on && (
        <>
          {!settings.publicBookingEnabled && (
            <div role="note" style={warnBox}>
              {ONLINE_PAYMENTS_COPY.turneroOff}
            </div>
          )}
          {particularZero && (
            <div role="note" style={warnBox} data-particular-zero="">
              {particularZero}
            </div>
          )}
          {missing && (
            <div role="note" style={warnBox} data-without-mp={settings.withoutMpCount}>
              {missing}
            </div>
          )}

          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <Switch
              on={draft.allowWithoutPaying}
              onChange={() => void changeMode({ allowWithoutPaying: !draft.allowWithoutPaying })}
              disabled={readOnly || pending}
              aria-label={MP_CONNECT_COPY.allowBookWithoutPaying}
            />
            <div style={{ minWidth: 0 }}>
              <div style={rowLabel}>{MP_CONNECT_COPY.allowBookWithoutPaying}</div>
              <p style={hint}>{ONLINE_PAYMENTS_COPY.allowHint}</p>
            </div>
          </div>

          <fieldset style={{ border: 0, margin: 0, padding: 0, display: "grid", gap: 8, minWidth: 0 }}>
            <legend style={{ ...rowLabel, padding: 0, marginBottom: 6 }}>{MP_CONNECT_COPY.howMuch}</legend>
            {kinds.map((k) => (
              <div key={k.value} style={{ display: "grid", gap: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44, fontSize: 14, color: "var(--navy-900)" }}>
                  <input
                    type="radio"
                    name={`${ids}-kind`}
                    value={k.value}
                    checked={draft.chargeKind === k.value}
                    disabled={readOnly || pending}
                    onChange={() => set({ chargeKind: k.value })}
                  />
                  {k.label}
                </label>
                {k.value === "COPAGO" && draft.chargeKind === "COPAGO" && (
                  <p style={{ ...hint, marginLeft: 26 }}>{ONLINE_PAYMENTS_COPY.kindCopagoHint}</p>
                )}
                {k.value === "FIXED" && draft.chargeKind === "FIXED" && (
                  <div style={{ marginLeft: 26, maxWidth: 240 }}>
                    <MoneyInput
                      label={ONLINE_PAYMENTS_COPY.fixedLabel}
                      value={draft.fixedCents}
                      onChange={(c) => set({ fixedCents: c })}
                      onInvalidChange={setMoneyInvalid}
                      error={errors.fixedCents}
                      disabled={readOnly || pending}
                    />
                  </div>
                )}
                {k.value === "PERCENT" && draft.chargeKind === "PERCENT" && (
                  <div className="k-field" style={{ marginLeft: 26, maxWidth: 160 }}>
                    <label className="k-label" htmlFor={`${ids}-pct`}>
                      {ONLINE_PAYMENTS_COPY.percentLabel}
                    </label>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        id={`${ids}-pct`}
                        className="k-input"
                        inputMode="decimal"
                        autoComplete="off"
                        value={draft.percentText}
                        disabled={readOnly || pending}
                        aria-invalid={errors.percentBps ? true : undefined}
                        aria-describedby={errors.percentBps ? `${ids}-pct-err` : undefined}
                        onChange={(e) => set({ percentText: e.target.value })}
                      />
                      <span aria-hidden="true">%</span>
                    </div>
                    {errors.percentBps && (
                      <span id={`${ids}-pct-err`} className="k-field-error">
                        {errors.percentBps}
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
            <p aria-live="polite" style={{ ...infoBox, margin: "4px 0 0" }} data-preview="">
              {Object.keys(errors).some((k) => k === "fixedCents" || k === "percentBps")
                ? ONLINE_PAYMENTS_COPY.previewIncomplete
                : previewLine(next, previewServicePriceCents)}
            </p>
          </fieldset>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <Switch
              on={draft.useClinicAccount}
              onChange={() => set({ useClinicAccount: !draft.useClinicAccount })}
              // Sin la cuenta del consultorio conectada no se puede prender (la action lo rechaza); apagar, siempre.
              disabled={readOnly || pending || (!draft.useClinicAccount && !clinicActive)}
              aria-label={MP_CONNECT_COPY.useClinicAccount}
            />
            <div style={{ minWidth: 0 }}>
              <div style={rowLabel}>{MP_CONNECT_COPY.useClinicAccount}</div>
              {!clinicActive && <p style={hint}>{ONLINE_PAYMENTS_COPY.useClinicNeedsAccount}</p>}
            </div>
          </div>

          <div className="k-field">
            <label className="k-label" htmlFor={`${ids}-note`}>
              {ONLINE_PAYMENTS_COPY.noteLabel}
            </label>
            <textarea
              id={`${ids}-note`}
              className="k-input"
              rows={3}
              value={draft.note}
              disabled={readOnly || pending}
              aria-invalid={errors.cancellationNote ? true : undefined}
              aria-describedby={`${ids}-note-hint ${ids}-note-count`}
              onChange={(e) => set({ note: e.target.value })}
              style={{ resize: "vertical", minHeight: 72 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span id={`${ids}-note-hint`} className="k-hint">
                {ONLINE_PAYMENTS_COPY.noteHint}
              </span>
              <span
                id={`${ids}-note-count`}
                className="k-hint"
                style={{ flexShrink: 0, color: noteLen > CANCELLATION_NOTE_MAX ? "var(--danger-fg)" : undefined }}
                data-note-count=""
              >
                {noteLen}/{CANCELLATION_NOTE_MAX}
              </span>
            </div>
            {errors.cancellationNote && <span className="k-field-error">{errors.cancellationNote}</span>}
          </div>
        </>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {!readOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" size="sm" disabled={!dirty || hasErrors || pending} onClick={save}>
            {ONLINE_PAYMENTS_COPY.save}
          </Button>
          {dirty && (
            <>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void discard()}>
                {ONLINE_PAYMENTS_COPY.discard}
              </Button>
              <span role="status" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                {ONLINE_PAYMENTS_COPY.unsaved}
              </span>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function PractitionersCard({ rows }: { rows: OnlinePaymentsPractitionerRow[] }) {
  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }}>
      <EyebrowLabel>{MP_CONNECT_COPY.practitionersCard}</EyebrowLabel>
      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>{ONLINE_PAYMENTS_COPY.practitionersEmpty}</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {rows.map((p) => (
            <li
              key={p.practitionerId}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", fontSize: 13 }}
            >
              <span style={{ fontWeight: 600, color: "var(--navy-900)", minWidth: 0, overflowWrap: "anywhere" }}>{p.name}</span>
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                <Tag tone={p.status === "ACTIVE" ? "lime" : "soft"}>{MP_ACCOUNT_STATUS_LABEL[p.status]}</Tag>
                {p.status === "ACTIVE" && p.linksDelegated && (
                  <Tag tone="soft" variant="outline">
                    {ONLINE_PAYMENTS_COPY.linksAllowed}
                  </Tag>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
