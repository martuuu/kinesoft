/**
 * [TP-3d] Lógica pura del `PaymentLinkDrawer` (§25.10 «PaymentLinkDrawer compartido», contrato C-TP9 de §25.7).
 *
 * Por qué vive fuera del componente: los render tests de `tests/unit/render` corren con `renderToStaticMarkup` (sin
 * jsdom, sin efectos), así que el drawer no puede probar ahí ni las opciones que arma con `getPaymentLinkSuggestions`
 * ni el doble click. Lo que decide algo (qué opciones de «¿Cuánto?» se ofrecen, qué se le manda a `createPaymentLink`,
 * cuándo el form está sucio, que un doble click sea UNA llamada) vive acá y lo fija `tests/unit/tp3d-payment-link-form.test.ts`
 * con el símbolo real.
 *
 * Client-safe: solo tipos, el schema zod de `lib/payment-links-types.ts` y el copy. Se carga diferido junto con el
 * drawer (§25.11: nunca estático en `/agenda`; lo fija `tests/unit/online-payments-first-load-guard.test.ts`).
 *
 * Plata 100 % en centavos `Int`. El server vuelve a validar todo (permisos, cuenta, delegación, lo que falta): esto solo
 * evita mandar algo que el server rechazaría por forma y le da a la Secretaría el error al lado del campo.
 */
import { formatARS } from "@/lib/format";
import { MAX_ONLINE_CHARGE_CENTS, MIN_ONLINE_CHARGE_CENTS } from "@/lib/online-charge-logic";
import { PAYMENT_LINK_COPY, RECEIPT_COPY } from "@/lib/online-payments-copy";
import { PAYMENT_LINK_EXTRA_COPY } from "@/lib/payment-links-logic";
import {
  CreatePaymentLinkSchema,
  PAYMENT_LINK_CONCEPT_MAX,
  PAYMENT_LINK_CONCEPT_MIN,
  type CreatePaymentLinkInput,
  type PaymentLinkExpiryDays,
  type PaymentLinkSuggestions,
} from "@/lib/payment-links-types";

/**
 * Copy del form que el contrato C-TP9 no fija (los literales están en `PAYMENT_LINK_COPY`). Defaults de TP-3d, en el
 * reporte de la sesión para que Martin los confirme.
 */
export const PAYMENT_LINK_FORM_COPY = {
  howMuch: "¿Cuánto?",
  rest: "Lo que falta",
  total: "El total",
  other: "Otro monto",
  otherHint: (remaining: string) => `Queda como seña: tiene que ser menor que lo que falta (${remaining}).`,
  depositPaidNote: (amount: string) => `Ya pagó una seña de ${amount}.`,
  amount: "Monto",
  practitioner: "Profesional",
  practitionerRequired: "Elegí el profesional.",
  account: "Se acredita en",
  accountServer: "La cuenta de Mercado Pago del profesional (o la del consultorio, si corresponde).",
  concept: "Concepto",
  conceptLength: `El concepto tiene que tener de ${PAYMENT_LINK_CONCEPT_MIN} a ${PAYMENT_LINK_CONCEPT_MAX} caracteres.`,
  expiry: "Vence en",
  loading: "Calculando lo que falta cobrar…",
  loadFailed: "No pudimos calcular lo que falta cobrar. Cerrá y probá de nuevo.",
  submit: "Generar link de pago",
  submitting: "Generando…",
  cancel: "Cancelar",
  dirty: "¿Descartar el link de pago sin generarlo?",
  readyFor: (amount: string, when: string) => `${amount} · vence el ${when}`,
  close: "Listo",
  unexpected: "No pudimos generar el link de pago. Probá de nuevo en unos minutos.",
} as const;

// ── ¿Cuánto? ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Una opción de «¿Cuánto?» con turno. `amountCents` null = la escribe el staff (`OTHER` → `DEPOSIT`). `key` es lo que
 * guarda el radio: no se usa el `purpose` porque dos opciones podrían compartirlo en el futuro.
 */
export type LinkAmountOption = {
  key: "REST" | "TOTAL" | "OTHER";
  purpose: "REST" | "TOTAL" | "DEPOSIT";
  label: string;
  amountCents: number | null;
  hint: string | null;
};

/**
 * Opciones de «¿Cuánto?» (lo que falta / el total / otro monto que queda como seña), **deduplicadas**:
 *   - sin seña pagada lo que falta ES el total: dos radios con el mismo monto obligarían a la Secretaría a adivinar
 *     la diferencia (no hay). Queda uno solo, «El total» (`TOTAL`, que el server acepta justo cuando no hay seña);
 *   - con seña pagada no hay «El total» (`canTotal` false: sería cobrar la seña dos veces) y queda «Lo que falta»;
 *   - «Otro monto» es un `DEPOSIT` y tiene que ser MENOR que lo que falta y ≥ $ 1: si lo que falta no deja lugar
 *     (≤ $ 1), no se ofrece.
 * `blocked` (cuenta, delegación, turno cobrado, link vivo…) → ninguna opción: el drawer muestra el motivo.
 */
export function linkAmountOptions(s: PaymentLinkSuggestions): LinkAmountOption[] {
  if (s.blocked || s.remainingCents <= 0) return [];
  const out: LinkAmountOption[] = [];
  const totalSameAsRest = s.canTotal && s.totalCents === s.remainingCents;
  if (s.canTotal) {
    out.push({ key: "TOTAL", purpose: "TOTAL", label: PAYMENT_LINK_FORM_COPY.total, amountCents: s.totalCents, hint: null });
  }
  if (!totalSameAsRest) {
    out.push({
      key: "REST",
      purpose: "REST",
      label: PAYMENT_LINK_FORM_COPY.rest,
      amountCents: s.remainingCents,
      hint: s.depositPaidCents > 0 ? PAYMENT_LINK_FORM_COPY.depositPaidNote(formatARS(s.depositPaidCents)) : null,
    });
  }
  if (s.remainingCents > MIN_ONLINE_CHARGE_CENTS) {
    out.push({
      key: "OTHER",
      purpose: "DEPOSIT",
      label: PAYMENT_LINK_FORM_COPY.other,
      amountCents: null,
      hint: PAYMENT_LINK_FORM_COPY.otherHint(formatARS(s.remainingCents)),
    });
  }
  return out;
}

/** «Se acredita en …» con el mismo texto que la fila «Acreditado en» del comprobante. */
export function linkAccountLabel(kind: "PRACTITIONER" | "CLINIC" | null, practitionerName: string): string | null {
  if (kind === "CLINIC") return RECEIPT_COPY.clinicAccount;
  if (kind === "PRACTITIONER") return RECEIPT_COPY.practitionerAccount(practitionerName);
  return null;
}

export function expiryLabel(d: PaymentLinkExpiryDays): string {
  return d === 1 ? "1 día" : `${d} días`;
}

// ── Validación ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type PaymentLinkFormState = {
  /** Con turno: la opción elegida de `linkAmountOptions`. Sin turno se ignora (es `FREE`). */
  optionKey: LinkAmountOption["key"] | null;
  /** Lo que escribió el staff (solo `OTHER` y sin turno). */
  amountCents: number | null;
  concept: string;
  expiresInDays: PaymentLinkExpiryDays;
  /** Sin turno: el profesional elegido. Con turno: el del turno. */
  practitionerId: string;
};

export type PaymentLinkFormContext = {
  patientId: string;
  /** null = link sin turno (`FREE`). */
  bookingId: string | null;
  /** Con turno: las opciones que se mostraron (sin ellas no hay qué mandar). */
  options: LinkAmountOption[];
  /** Con turno: lo que falta, para el tope de «Otro monto». */
  remainingCents: number | null;
  idempotencyKey: string;
};

export type PaymentLinkFormField = "amount" | "concept" | "practitioner" | "option";
export type PaymentLinkFormCheck =
  | { ok: true; input: CreatePaymentLinkInput }
  | { ok: false; field: PaymentLinkFormField | null; error: string };

const inRange = (c: number) => Number.isInteger(c) && c >= MIN_ONLINE_CHARGE_CENTS && c <= MAX_ONLINE_CHARGE_CENTS;

/**
 * Lo que el drawer le manda a `createPaymentLink` (C-TP9), o el error del primer campo mal. Mismas reglas de forma que
 * `CreatePaymentLinkSchema` (que se corre al final como red: si algo se escapa, «Revisá los datos del link de pago.»
 * en vez de un rechazo opaco del server). `amountCents` solo viaja con `DEPOSIT`/`FREE`: con `REST`/`TOTAL` lo calcula
 * el server, así un copago que cambió entre abrir el drawer y generar el link no se cobra con el número viejo.
 */
export function buildPaymentLinkInput(s: PaymentLinkFormState, ctx: PaymentLinkFormContext): PaymentLinkFormCheck {
  let purpose: CreatePaymentLinkInput["purpose"];
  let amountCents: number | undefined;
  if (ctx.bookingId == null) {
    if (!s.practitionerId) return { ok: false, field: "practitioner", error: PAYMENT_LINK_FORM_COPY.practitionerRequired };
    if (s.amountCents == null || !inRange(s.amountCents)) {
      return { ok: false, field: "amount", error: PAYMENT_LINK_COPY.amountRange };
    }
    purpose = "FREE";
    amountCents = s.amountCents;
  } else {
    const opt = ctx.options.find((o) => o.key === s.optionKey);
    if (!opt) return { ok: false, field: "option", error: PAYMENT_LINK_EXTRA_COPY.invalid };
    purpose = opt.purpose;
    if (opt.purpose === "DEPOSIT") {
      if (s.amountCents == null || !inRange(s.amountCents)) {
        return { ok: false, field: "amount", error: PAYMENT_LINK_COPY.amountRange };
      }
      if (ctx.remainingCents != null && s.amountCents >= ctx.remainingCents) {
        return { ok: false, field: "amount", error: PAYMENT_LINK_COPY.depositTooHigh };
      }
      amountCents = s.amountCents;
    }
  }
  const concept = s.concept.trim();
  if (concept.length < PAYMENT_LINK_CONCEPT_MIN || concept.length > PAYMENT_LINK_CONCEPT_MAX) {
    return { ok: false, field: "concept", error: PAYMENT_LINK_FORM_COPY.conceptLength };
  }
  const input: CreatePaymentLinkInput = {
    patientId: ctx.patientId,
    ...(ctx.bookingId != null ? { bookingId: ctx.bookingId } : {}),
    practitionerId: s.practitionerId,
    purpose,
    ...(amountCents !== undefined ? { amountCents } : {}),
    concept,
    expiresInDays: s.expiresInDays,
    idempotencyKey: ctx.idempotencyKey,
  };
  if (!CreatePaymentLinkSchema.safeParse(input).success) {
    return { ok: false, field: null, error: PAYMENT_LINK_EXTRA_COPY.invalid };
  }
  return { ok: true, input };
}

/**
 * Dirty-guard (AGENTS §5: los formularios de carga van en Drawer con dirty-guard): sucio = el staff cambió algo del
 * estado inicial. Una vez creado el link no hay nada que perder (el link ya existe): el caller pasa `created`.
 */
export function isPaymentLinkFormDirty(initial: PaymentLinkFormState, current: PaymentLinkFormState, created: boolean): boolean {
  if (created) return false;
  return (
    initial.optionKey !== current.optionKey ||
    initial.amountCents !== current.amountCents ||
    initial.concept !== current.concept ||
    initial.expiresInDays !== current.expiresInDays ||
    initial.practitionerId !== current.practitionerId
  );
}

// ── Una sola llamada ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Candado contra el doble click (test 3d «doble click = una llamada»). Un `useState` de `pending` no alcanza: dos
 * clicks en el mismo tick ven el mismo `pending=false` antes del re-render y salen dos `createPaymentLink`. El
 * `idempotencyKey` por instancia ya hace que el server devuelva el mismo link, pero la segunda llamada igual gasta un
 * round-trip y una preferencia de Mercado Pago en carrera; el candado es síncrono y la corta acá.
 */
export function createSingleFlight() {
  let busy = false;
  return {
    get busy() {
      return busy;
    },
    async run<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
      if (busy) return { ran: false };
      busy = true;
      try {
        return { ran: true, value: await fn() };
      } finally {
        busy = false;
      }
    },
  };
}

/** UUID por instancia del drawer (AGENTS §4: `idempotencyKey` por instancia de modal). */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pl-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Compartir ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const PAYMENT_LINK_SHARE_COPY = {
  copyLink: "Copiar link",
  copyMessage: "Copiar mensaje",
  copied: "Copiado",
  whatsapp: "WhatsApp",
  email: "Mandar por email",
  emailSending: "Mandando…",
  emailSent: (to: string) => `Mail enviado a ${to}.`,
  emailNote: "El mail no lleva el concepto: solo el consultorio, el monto y el link.",
  hiddenContact: "Vas a elegir el contacto en WhatsApp.",
  loading: "Preparando el mensaje…",
  loadFailed: "No pudimos preparar el mensaje: copiá el link.",
  copyFailed: "No pudimos copiar: seleccioná el link y copialo a mano.",
} as const;

/**
 * Botón de email: deshabilitado con MOTIVO visible (test 3d), nunca un botón muerto sin explicación. El paciente sin
 * email se sabe recién cuando el server contesta `noEmail` (el contrato `getPaymentLinkShare` no trae el email, a
 * propósito: no viaja al cliente); desde ahí el botón queda deshabilitado con ese texto.
 */
export function emailButtonState(o: {
  sending: boolean;
  sentToMasked: string | null;
  disabledReason: string | null;
}): { disabled: boolean; label: string; reason: string | null } {
  if (o.disabledReason) return { disabled: true, label: PAYMENT_LINK_SHARE_COPY.email, reason: o.disabledReason };
  if (o.sending) return { disabled: true, label: PAYMENT_LINK_SHARE_COPY.emailSending, reason: null };
  return { disabled: false, label: PAYMENT_LINK_SHARE_COPY.email, reason: null };
}

/** ¿Este error del server deshabilita el botón para siempre (sin email cargado) o se puede reintentar? */
export function isNoEmailError(error: string, patientName: string): boolean {
  return error === PAYMENT_LINK_COPY.noEmail(patientName) || /no tiene email cargado\.$/.test(error);
}
