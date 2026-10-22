"use client";

/**
 * [TP-3d] `PaymentLinkDrawer` compartido (§25.10: drawer del turno, Facturación, /cobros, Sala), con las props
 * CONGELADAS de `payments-ui-types.ts` (TP-K4).
 *
 * Qué tiene (§25.10 / C-TP9):
 *   - **cuenta**: «Se acredita en Mercado Pago de Ana» / «del consultorio» (lo resuelve el server en
 *     `getPaymentLinkSuggestions`; sin turno, el profesional se elige y la cuenta se ve en «Link listo»);
 *   - **«¿Cuánto?»** deduplicado (`linkAmountOptions`): lo que falta / el total / otro monto (queda como seña). Sin
 *     turno es un link `FREE` y el monto es obligatorio;
 *   - **concepto** con el aviso «No pongas datos clínicos…» atado por `aria-describedby` (el lector lo lee al entrar al
 *     campo, que es cuando sirve). Por default «Turno del lun 19/10 a las 10:00», sin el servicio (TP-UI-D12);
 *   - **vencimiento** 1/3/7/15/30, 7 por default;
 *   - `createPaymentLink` con un `idempotencyKey` por instancia (AGENTS §4) y candado síncrono contra el doble click
 *     (`createSingleFlight`); los errores del server ya vienen en copy (`PAYMENT_LINK_COPY` / `PAYMENT_LINK_EXTRA_COPY`)
 *     y se muestran tal cual;
 *   - dirty-guard del Drawer (`isPaymentLinkFormDirty`);
 *   - paso **«Link listo»** con copiar, WhatsApp y email (`PaymentLinkShare`).
 *
 * Diferido (§25.11): nadie lo importa estático desde `/agenda`; lo baja la sección de plata por `import()` (lo fija
 * `tests/unit/online-payments-first-load-guard.test.ts`). La lógica pura vive en `lib/payment-link-form.ts` porque los
 * render tests no corren efectos.
 */
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Drawer, DRAWER_FOOTER_ATTR } from "@/components/ui/drawer";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import { formatArDateTime } from "@/lib/mp-receipt";
import { BOOKING_MONEY_COPY, PAYMENT_LINK_COPY, defaultLinkConcept } from "@/lib/online-payments-copy";
import { createPaymentLink, getPaymentLinkSuggestions } from "@/lib/payment-links";
import {
  PAYMENT_LINK_CONCEPT_MAX,
  PAYMENT_LINK_DEFAULT_EXPIRY_DAYS,
  PAYMENT_LINK_EXPIRY_DAYS,
  type CreatePaymentLinkResult,
  type PaymentLinkExpiryDays,
  type PaymentLinkSuggestions,
} from "@/lib/payment-links-types";
import {
  PAYMENT_LINK_FORM_COPY as C,
  buildPaymentLinkInput,
  createSingleFlight,
  expiryLabel,
  isPaymentLinkFormDirty,
  linkAccountLabel,
  linkAmountOptions,
  newIdempotencyKey,
  type LinkAmountOption,
  type PaymentLinkFormField,
  type PaymentLinkFormState,
} from "@/lib/payment-link-form";
import { PaymentLinkShare } from "./payment-link-share";
import type { PaymentLinkDrawerProps } from "./payments-ui-types";

/** Estado de `getPaymentLinkSuggestions` (solo con turno). */
type SuggestionsState =
  | { status: "loading" }
  | { status: "ready"; data: PaymentLinkSuggestions }
  | { status: "error"; error: string };

const chipStyle = (on: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  minHeight: 44,
  padding: "10px 14px",
  borderRadius: 12,
  border: `1px solid ${on ? "var(--sky-700)" : "rgba(15, 30, 51, 0.14)"}`,
  background: on ? "var(--sky-50, rgba(31, 79, 190, 0.06))" : "var(--card-bg)",
  color: "var(--navy-900)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
});

const noteStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--navy-500)" };

// ── Form (presentacional; exportado para el render test) ────────────────────────────────────────────────────────────

export type PaymentLinkFormProps = {
  /** Con turno: las opciones de «¿Cuánto?»; null = link sin turno (`FREE`). */
  options: LinkAmountOption[] | null;
  /** Línea de la cuenta («Se acredita en …»); null = la resuelve el server al generar. */
  accountLabel: string | null;
  /** Sin turno: los profesionales para elegir. */
  practitioners: { id: string; name: string }[];
  state: PaymentLinkFormState;
  onChange: (patch: Partial<PaymentLinkFormState>) => void;
  /** Motivo por el que no se puede generar (sin cuenta, sin delegación, turno cobrado, link vivo…). */
  blocked: string | null;
  error: { field: PaymentLinkFormField | null; message: string } | null;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

export function PaymentLinkForm(p: PaymentLinkFormProps) {
  const uid = useId();
  const warningId = `${uid}-concept-warning`;
  const conceptErrorId = `${uid}-concept-error`;
  const counterId = `${uid}-concept-count`;
  const { state, onChange, error } = p;
  const free = p.options == null;
  const chosen = p.options?.find((o) => o.key === state.optionKey) ?? null;
  const showAmount = free || chosen?.key === "OTHER";
  const fieldError = (f: PaymentLinkFormField) => (error?.field === f ? error.message : undefined);
  const canSubmit = !p.pending && !p.blocked && (free ? p.practitioners.length > 0 : (p.options?.length ?? 0) > 0);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
      style={{ display: "grid", gap: 18 }}
      data-testid="payment-link-form"
    >
      {p.blocked && (
        <p className="k-alert" role="alert" style={{ margin: 0 }} data-testid="payment-link-blocked">
          {p.blocked}
        </p>
      )}

      {free ? (
        <label className="k-field">
          <span className="k-label">{C.practitioner}</span>
          <select
            className="k-input"
            value={state.practitionerId}
            onChange={(e) => onChange({ practitionerId: e.target.value })}
            aria-invalid={fieldError("practitioner") ? true : undefined}
            disabled={p.pending}
          >
            {!state.practitionerId && <option value="">—</option>}
            {p.practitioners.map((pr) => (
              <option key={pr.id} value={pr.id}>
                {pr.name}
              </option>
            ))}
          </select>
          {fieldError("practitioner") && <span className="k-field-error">{fieldError("practitioner")}</span>}
        </label>
      ) : null}

      <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)" }} data-testid="payment-link-account">
        <span style={{ fontWeight: 600 }}>{C.account}:</span> {p.accountLabel ?? C.accountServer}
      </p>

      {!free && (p.options?.length ?? 0) > 0 && (
        <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: "grid", gap: 8 }} disabled={p.pending}>
          <legend className="k-label" style={{ padding: 0, marginBottom: 8 }}>
            {C.howMuch}
          </legend>
          {p.options!.map((o) => {
            const on = state.optionKey === o.key;
            return (
              <label key={o.key} style={chipStyle(on)} data-option={o.key}>
                <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    type="radio"
                    name={`${uid}-amount`}
                    value={o.key}
                    checked={on}
                    onChange={() => onChange({ optionKey: o.key })}
                    style={{ width: 18, height: 18, margin: 0, accentColor: "var(--sky-700)" }}
                  />
                  <span style={{ display: "grid", gap: 2 }}>
                    <span>{o.label}</span>
                    {o.hint && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--navy-500)" }}>{o.hint}</span>}
                  </span>
                </span>
                {o.amountCents != null && (
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatARS(o.amountCents)}</span>
                )}
              </label>
            );
          })}
        </fieldset>
      )}

      {showAmount && (
        <MoneyInput
          label={C.amount}
          value={state.amountCents}
          onChange={(cents) => onChange({ amountCents: cents })}
          required
          disabled={p.pending}
          error={fieldError("amount")}
        />
      )}

      <div className="k-field">
        <label className="k-label" htmlFor={`${uid}-concept`}>
          {C.concept}
        </label>
        <input
          id={`${uid}-concept`}
          className="k-input"
          value={state.concept}
          maxLength={PAYMENT_LINK_CONCEPT_MAX}
          onChange={(e) => onChange({ concept: e.target.value })}
          aria-describedby={[warningId, counterId, fieldError("concept") ? conceptErrorId : null].filter(Boolean).join(" ")}
          aria-invalid={fieldError("concept") ? true : undefined}
          disabled={p.pending}
          required
        />
        <div className="k-field-row">
          <p id={warningId} style={{ ...noteStyle, color: "var(--navy-700)" }} data-testid="concept-warning">
            {PAYMENT_LINK_COPY.conceptWarning}
          </p>
          <span id={counterId} style={{ ...noteStyle, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
            {state.concept.length}/{PAYMENT_LINK_CONCEPT_MAX}
          </span>
        </div>
        {fieldError("concept") && (
          <span id={conceptErrorId} className="k-field-error">
            {fieldError("concept")}
          </span>
        )}
      </div>

      <label className="k-field">
        <span className="k-label">{C.expiry}</span>
        <select
          className="k-input"
          value={state.expiresInDays}
          onChange={(e) => onChange({ expiresInDays: Number(e.target.value) as PaymentLinkExpiryDays })}
          disabled={p.pending}
          data-testid="payment-link-expiry"
        >
          {PAYMENT_LINK_EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {expiryLabel(d)}
            </option>
          ))}
        </select>
      </label>

      <div aria-live="polite">
        {error && error.field == null && (
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {error.message}
          </p>
        )}
      </div>

      <div
        {...{ [DRAWER_FOOTER_ATTR]: "" }}
        style={{
          position: "sticky",
          bottom: 0,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          paddingTop: 12,
          background: "var(--card-bg)",
        }}
      >
        <Button type="button" variant="ghost" onClick={p.onCancel} disabled={p.pending}>
          {C.cancel}
        </Button>
        <Button type="submit" disabled={!canSubmit} aria-busy={p.pending || undefined}>
          {p.pending ? C.submitting : C.submit}
        </Button>
      </div>
    </form>
  );
}

// ── Paso «Link listo» (exportado para el render test) ───────────────────────────────────────────────────────────────

export function PaymentLinkReady({
  created,
  practitionerName,
  patientName,
  onDone,
}: {
  created: CreatePaymentLinkResult;
  practitionerName: string;
  patientName: string;
  onDone: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }} data-testid="payment-link-ready">
      <div
        className="k-alert k-alert-success"
        role="status"
        style={{ margin: 0, display: "grid", gap: 4 }}
      >
        <strong>{BOOKING_MONEY_COPY.linkReady}</strong>
        <span>{C.readyFor(formatARS(created.amountCents), formatArDateTime(created.expiresAt))}</span>
      </div>
      <p style={{ margin: 0, fontSize: 14, color: "var(--navy-700)" }}>
        <span style={{ fontWeight: 600 }}>{C.account}:</span> {linkAccountLabel(created.accountKind, practitionerName)}
      </p>
      <input
        className="k-input"
        readOnly
        value={created.url}
        aria-label={BOOKING_MONEY_COPY.linkReady}
        onFocus={(e) => e.currentTarget.select()}
      />
      <PaymentLinkShare chargeId={created.chargeId} url={created.url} patientName={patientName} />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="button" onClick={onDone}>
          {C.close}
        </Button>
      </div>
    </div>
  );
}

// ── Drawer ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function PaymentLinkDrawer(props: PaymentLinkDrawerProps) {
  const { open, onClose, patient, booking, practitioners, defaultPractitionerId, onCreated } = props;
  // Una clave por instancia: un reintento tras un error de red manda la MISMA clave y el server devuelve el mismo
  // link en vez de crear dos (AGENTS §4). El caller monta una instancia nueva por cada apertura.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const flight = useRef(createSingleFlight());

  const initial = useMemo<PaymentLinkFormState>(
    () => ({
      optionKey: null,
      amountCents: null,
      concept: booking ? defaultLinkConcept(booking.startsAt) : "",
      expiresInDays: PAYMENT_LINK_DEFAULT_EXPIRY_DAYS,
      practitionerId:
        booking?.practitionerId ??
        (defaultPractitionerId && practitioners.some((p) => p.id === defaultPractitionerId)
          ? defaultPractitionerId
          : practitioners.length === 1
            ? practitioners[0].id
            : ""),
    }),
    // El estado inicial es el de la apertura: si el caller re-renderiza con un array nuevo de profesionales no se
    // pisa lo que la Secretaría ya eligió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [booking?.id],
  );
  const [state, setState] = useState<PaymentLinkFormState>(initial);
  const [baseline, setBaseline] = useState<PaymentLinkFormState>(initial);
  const [suggestions, setSuggestions] = useState<SuggestionsState>({ status: "loading" });
  const [error, setError] = useState<{ field: PaymentLinkFormField | null; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatePaymentLinkResult | null>(null);

  const bookingId = booking?.id ?? null;
  useEffect(() => {
    if (!open || !bookingId) return;
    let alive = true;
    setSuggestions({ status: "loading" });
    getPaymentLinkSuggestions({ bookingId })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) {
          setSuggestions({ status: "error", error: r.error });
          return;
        }
        setSuggestions({ status: "ready", data: r.data });
        // La primera opción queda elegida (lo más común: cobrar lo que falta). Es parte del estado inicial, no un
        // cambio de la Secretaría: por eso también mueve la base del dirty-guard.
        const first = linkAmountOptions(r.data)[0]?.key ?? null;
        setState((s) => (s.optionKey == null ? { ...s, optionKey: first } : s));
        setBaseline((b) => ({ ...b, optionKey: first }));
      })
      .catch(() => alive && setSuggestions({ status: "error", error: C.loadFailed }));
    return () => {
      alive = false;
    };
  }, [open, bookingId]);

  const options = booking
    ? suggestions.status === "ready"
      ? linkAmountOptions(suggestions.data)
      : []
    : null;
  const blocked = booking
    ? suggestions.status === "ready"
      ? suggestions.data.blocked
      : suggestions.status === "error"
        ? suggestions.error
        : null
    : null;
  const accountLabel =
    booking && suggestions.status === "ready" ? linkAccountLabel(suggestions.data.accountKind, booking.practitionerName) : null;
  const dirty = isPaymentLinkFormDirty(baseline, state, created != null);
  const practitionerName =
    booking?.practitionerName ?? practitioners.find((p) => p.id === state.practitionerId)?.name ?? "";

  async function submit() {
    const check = buildPaymentLinkInput(state, {
      patientId: patient.id,
      bookingId,
      options: options ?? [],
      remainingCents: suggestions.status === "ready" ? suggestions.data.remainingCents : null,
      idempotencyKey,
    });
    if (!check.ok) {
      setError({ field: check.field, message: check.error });
      return;
    }
    const out = await flight.current.run(async () => {
      setPending(true);
      setError(null);
      try {
        return await createPaymentLink(check.input);
      } catch {
        return { ok: false as const, error: C.unexpected };
      } finally {
        setPending(false);
      }
    });
    if (!out.ran) return;
    if (!out.value.ok) {
      setError({ field: null, message: out.value.error });
      return;
    }
    setCreated(out.value.data);
    onCreated?.(out.value.data);
  }

  return (
    <Drawer open={open} onClose={onClose} title={BOOKING_MONEY_COPY.generateLink} dirty={dirty} dirtyMessage={C.dirty}>
      {created ? (
        <PaymentLinkReady created={created} practitionerName={practitionerName} patientName={patient.name} onDone={onClose} />
      ) : booking && suggestions.status === "loading" ? (
        <p style={noteStyle} aria-live="polite">
          {C.loading}
        </p>
      ) : (
        <PaymentLinkForm
          options={options}
          accountLabel={accountLabel}
          practitioners={practitioners}
          state={state}
          onChange={(patch) => {
            setState((s) => ({ ...s, ...patch }));
            if (error && error.field != null && Object.keys(patch).length) setError(null);
          }}
          blocked={blocked}
          error={error}
          pending={pending}
          onSubmit={() => void submit()}
          onCancel={onClose}
        />
      )}
    </Drawer>
  );
}
