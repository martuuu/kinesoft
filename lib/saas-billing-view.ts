/**
 * Configuración → «Plan y uso» y «Facturación» (PL-3a): lógica PURA de las pantallas de la cuenta (plan SaaS,
 * cambio de plan, cargos, pagos y comprobantes). Client-safe (solo `import type` de Prisma y módulos puros): la usan
 * `components/configuracion/panels/{plan-usage-panel,plan-change-drawer,billing-panel,receipt-upload-drawer}.tsx` y
 * se testea sin DOM ni base en TZ=UTC y TZ=AR (`tests/unit/saas-billing-view.test.ts`).
 *
 * Por qué acá y no en los componentes: lo que decide si el botón «Cambiar de plan» se habilita (elegir EXACTAMENTE lo
 * que sobra) y si un comprobante se puede mandar tiene que poder testearse con números, no mirando HTML. La barrera
 * real sigue en el server (`applyPlanChangeInTx` recuenta y devuelve `does_not_fit`; `readReceiptFile` mira tamaño y
 * magic bytes): esto solo evita mandar algo que va a rebotar.
 */
import type { SaasChargeStatus, SaasPaymentStatus, SaasPlan } from "@prisma/client";
import { mustDisableFor, seatKindOf, type SeatKind, type SeatTally, type SeatUsageByKind } from "@/lib/plan-catalog";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";
import type { TenantModule } from "@/lib/tenant-modules";
import { RECEIPT_MAX_BYTES, RECEIPT_MIME_TYPES, addDaysKey, cancelEffectiveOnFor, stubFor } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import type { BillingOverview, PlanChangeBilling, SaasCollectionMethod } from "@/lib/saas-billing-types";

// ── Cupos y estado del plan ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Cupos como los nombra el plan (Martin, §20.17): Individual «1 de 1»; Consultorio y Clínica «Total 4 de 5» (desde
 * M8b no hay tope por tipo: 5 / 10 de cualquier tipo); Libre o cupo sin tope «a medida». El desglose por tipo sigue
 * en el hint del panel (quién ocupa qué).
 */
export function planSeatsLabel(plan: SaasPlan, total: { used: number; limit: number | null }): string {
  if (total.limit == null) return `${total.used} ${total.used === 1 ? "usuario" : "usuarios"} · cupo a medida`;
  if (plan === "INDIVIDUAL") return `${total.used} de ${total.limit}`;
  return `Total ${total.used} de ${total.limit}`;
}

/**
 * Nombre visible de cada módulo en «Plan y uso» y en el drawer (lo que ganás / perdés). `null` = no se lista:
 * `evoluciones` y `reportes` todavía no son pantallas reales (mismo criterio que el catálogo público,
 * `lib/saas-plans-public.ts`: no se promete lo que la app no hace) y `turneroPublico` es un switch de todos los planes.
 */
export const MODULE_UI_LABEL: Record<TenantModule, string | null> = {
  agenda: "Agenda",
  pacientes: "Pacientes",
  facturacion: "Cobros y copagos",
  obrasSociales: "Obras sociales",
  evoluciones: null,
  salaEspera: "Sala de espera",
  salas: "Salas",
  turneroPublico: null,
  reportes: null,
  planes: "Planes de tratamiento",
  sesiones: "Seguimiento de sesiones",
  diagnostico: "Diagnóstico",
  evaluaciones: "Evaluaciones",
  ejercicios: "Biblioteca de ejercicios",
  plantillas: "Plantillas de plan",
  favoritos: "Ejercicios favoritos",
  ejerciciosGlobales: "Catálogo de ejercicios de KineSoft",
};

/** Etiquetas de módulos, sin repetidos ni los que no se listan, en el orden recibido. */
export function moduleLabels(mods: readonly TenantModule[]): string[] {
  const out: string[] = [];
  for (const m of mods) {
    const l = MODULE_UI_LABEL[m];
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

export type PlanStatusTone = "ok" | "info" | "warn";

export type PlanStatusView = { label: string; tone: PlanStatusTone; detail: string | null; cta: string | null; readOnly: boolean };

/**
 * Estado del plan para «Plan y uso». Parte del resumen de la suscripción que ya arma el server
 * (`subscriptionSummary`, lib/tenant-plan-usage-logic.ts: días de prueba en AR, gracia, vencido) y cambia dos cosas:
 * «Activa» se dice «Al día» (lo que le importa al que paga) y el llamado ya no es «escribinos»: desde PL-3a el plan se
 * elige y el pago se informa desde acá. `readOnly` = el modo efectivo del consultorio (`actor.access` + enforcement).
 */
export function planStatusView(
  sub: { label: string; tone: PlanStatusTone; detail: string | null; contact: string | null },
  readOnly: boolean
): PlanStatusView {
  const label = sub.label === "Activa" ? "Al día" : sub.label;
  let cta: string | null = null;
  if (sub.contact === "para elegir un plan") cta = "Elegí un plan con «Cambiar de plan».";
  else if (sub.contact === "para regularizarlo") cta = "Informá el pago desde Facturación.";
  else if (sub.contact) cta = "Escribinos desde Soporte y lo resolvemos.";
  return { label, tone: readOnly ? "warn" : sub.tone, detail: sub.detail, cta, readOnly };
}

export const READ_ONLY_PLAN_COPY =
  "El consultorio está en modo lectura: se puede ver todo, pero no cargar ni modificar turnos ni pacientes. Igual podés cambiar de plan e informar pagos.";

// ── Cambio de plan: elegir exactamente quiénes pierden el acceso ─────────────────────────────────────────────────

export type PlanChangeSelectionState = {
  /** Cuántas personas hay que deshabilitar en total con lo que se reactiva (el mínimo; también el máximo). */
  required: number;
  /** Cuántas eligió. */
  selected: number;
  /** Lo que todavía no entra con la selección actual (0 en todo = entra). */
  short: SeatTally;
  /** Elegidas de más: deshabilitaría gente que entra. */
  extra: number;
  /** Entra y la cantidad es exacta. */
  fits: boolean;
  /** Algo para confirmar (cambia de plan; Libre lo arma Plataforma). */
  canConfirm: boolean;
};

function tallyOf(kinds: readonly SeatKind[]): { professional: number; staff: number } {
  const t = { professional: 0, staff: 0 };
  for (const k of kinds) t[k]++;
  return t;
}

function reactivatableKind(r: PlanChangePreview["reactivatable"][number]): SeatKind {
  return seatKindOf({ role: r.role, clinical: r.clinical });
}

/**
 * Estado de la selección del drawer. Regla (C-PL4, Martin 15-oct: «quien cambia el plan elige quiénes pierden el
 * acceso»): se elige EXACTAMENTE lo que sobra. Menos → no entra (el server devolvería `does_not_fit`); más → se le
 * sacaría el acceso a alguien que entra, que es justo lo que no tiene que pasar sin querer. El Titular y quien hace el
 * cambio no se pueden elegir (`selectableForDisable`); si vienen en `disable` igual, no cuentan como válidos.
 */
export function planChangeSelectionState(
  preview: Pick<PlanChangePreview, "from" | "to" | "limits" | "candidates" | "reactivatable">,
  disable: ReadonlySet<string>,
  reactivate: ReadonlySet<string>
): PlanChangeSelectionState {
  const active = preview.candidates;
  const react = preview.reactivatable.filter((r) => reactivate.has(r.membershipId));
  const withReact = tallyOf([...active.map((c) => c.kind), ...react.map(reactivatableKind)]);
  const required = mustDisableFor(withReact, preview.limits).total;
  const chosen = active.filter((c) => disable.has(c.membershipId) && selectableForDisable(c));
  const invalid = [...disable].some((id) => !chosen.some((c) => c.membershipId === id));
  const remaining = tallyOf([
    ...active.filter((c) => !chosen.includes(c)).map((c) => c.kind),
    ...react.map(reactivatableKind),
  ]);
  const short = mustDisableFor(remaining, preview.limits);
  const extra = Math.max(0, chosen.length - required);
  const fits = !invalid && short.total === 0 && extra === 0;
  return {
    required,
    selected: chosen.length,
    short,
    extra,
    fits,
    canConfirm: fits && preview.to !== preview.from && preview.to !== "LIBRE",
  };
}

/** El Titular nunca pierde el acceso y uno no se lo saca a sí mismo (C-PL4; el server lo rechaza igual). */
export function selectableForDisable(c: { isOwner: boolean; isSelf: boolean }): boolean {
  return !c.isOwner && !c.isSelf;
}

/**
 * ¿Se puede tildar «reactivar» a esta persona? Solo si entra sin obligar a deshabilitar a otro (si ya está tildada,
 * siempre se puede destildar).
 */
export function canReactivate(
  preview: Pick<PlanChangePreview, "limits" | "candidates" | "reactivatable">,
  disable: ReadonlySet<string>,
  reactivate: ReadonlySet<string>,
  membershipId: string
): boolean {
  if (reactivate.has(membershipId)) return true;
  const r = preview.reactivatable.find((x) => x.membershipId === membershipId);
  if (!r) return false;
  const kinds = [
    ...preview.candidates.filter((c) => !disable.has(c.membershipId)).map((c) => c.kind),
    ...preview.reactivatable.filter((x) => reactivate.has(x.membershipId)).map(reactivatableKind),
    reactivatableKind(r),
  ];
  return mustDisableFor(tallyOf(kinds), preview.limits).total === 0;
}

const people = (n: number) => (n === 1 ? "1 persona" : `${n} personas`);

/** Qué le falta a la selección, en una frase (o null si está lista). */
export function selectionHint(s: PlanChangeSelectionState): string | null {
  if (s.extra > 0) {
    return `Elegiste de más: con este plan alcanza con sacarle el acceso a ${people(s.required)}. Destildá ${people(s.extra)}.`;
  }
  if (s.short.total > 0) {
    if (s.short.professional > 0 && s.short.staff === 0 && s.short.professional === s.short.total) {
      return s.short.professional === 1
        ? "Falta elegir 1 profesional más."
        : `Faltan elegir ${s.short.professional} profesionales más.`;
    }
    if (s.short.staff > 0 && s.short.professional === 0 && s.short.staff === s.short.total) {
      return s.short.staff === 1
        ? "Falta elegir 1 persona de recepción o administración más."
        : `Faltan elegir ${s.short.staff} personas de recepción o administración más.`;
    }
    return s.short.total === 1 ? "Falta elegir 1 persona más." : `Faltan elegir ${s.short.total} personas más.`;
  }
  return null;
}

/** Lo que ocupa el miembro que se iría (solo conteos, sin PHI): «3 turnos próximos · 12 pacientes · 1 plan activo». */
export function candidateLoadLabel(c: { futureBookings: number; assignedPatients: number; activePlans: number }): string {
  const parts: string[] = [];
  parts.push(c.futureBookings === 1 ? "1 turno próximo" : `${c.futureBookings} turnos próximos`);
  parts.push(c.assignedPatients === 1 ? "1 paciente" : `${c.assignedPatients} pacientes`);
  if (c.activePlans > 0) parts.push(c.activePlans === 1 ? "1 plan activo" : `${c.activePlans} planes activos`);
  return parts.join(" · ");
}

/** Uso del plan destino en una frase («Con Consultorio entran 5 usuarios; hoy son 6, contando 1 invitación»). */
export function targetUsageLabel(planLabel: string, usage: SeatUsageByKind, pendingInvites: number): string {
  const lim = usage.total.limit;
  const head = lim == null ? `Con ${planLabel} el cupo es a medida` : `Con ${planLabel} entran ${lim === 1 ? "1 usuario" : `${lim} usuarios`}`;
  const now = usage.total.used;
  const inv = pendingInvites === 0 ? "" : pendingInvites === 1 ? ", contando 1 invitación pendiente" : `, contando ${pendingInvites} invitaciones pendientes`;
  return `${head}; hoy son ${now}${inv}.`;
}

// ── Facturación: cargos, pagos, fechas ───────────────────────────────────────────────────────────────────────────

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/**
 * «14 oct 2026» desde una clave civil «YYYY-MM-DD» (períodos y vencimientos): se arma a mano, sin `Date` ni el TZ del
 * host ni del navegador. Pasarla por `new Date(key)` la lee como medianoche UTC y en AR mostraba el día anterior.
 */
export function formatDateKey(key: string | null | undefined): string {
  if (!key) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return "";
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
}

/** Período de un cargo: «5 oct – 4 nov 2026» (el año solo al final si es el mismo). */
export function periodLabel(start: string, end: string): string {
  const a = formatDateKey(start);
  const b = formatDateKey(end);
  if (!a || !b) return a || b;
  if (start.slice(0, 4) === end.slice(0, 4)) return `${a.replace(/ \d{4}$/, "")} – ${b}`;
  return `${a} – ${b}`;
}

/** Un instante (ISO) como día AR «14 oct 2026» (pago, revisión). */
export function formatInstantAR(iso: string | null | undefined): string {
  if (!iso) return "";
  return formatDateKey(toARDateKey(iso));
}

export type TagTone = "lime" | "sky" | "soft";

export function chargeStatusView(c: { status: SaasChargeStatus; overdue: boolean; paidCents: number }): { label: string; tone: TagTone } {
  switch (c.status) {
    case "PAID":
      return { label: "Pagado", tone: "lime" };
    case "VOID":
      return { label: "Anulado", tone: "soft" };
    case "WAIVED":
      return { label: "Bonificado", tone: "soft" };
    case "OPEN":
      if (c.overdue) return { label: "Vencido", tone: "sky" };
      return { label: c.paidCents > 0 ? "Pago parcial" : "Pendiente", tone: "sky" };
  }
}

export function paymentStatusView(s: SaasPaymentStatus): { label: string; tone: TagTone } {
  switch (s) {
    case "PENDING_REVIEW":
      return { label: "En revisión", tone: "sky" };
    case "APPROVED":
      return { label: "Aprobado", tone: "lime" };
    case "REJECTED":
      return { label: "Rechazado", tone: "soft" };
    case "REFUNDED":
      return { label: "Devuelto", tone: "soft" };
  }
}

/** Saldo en una frase: >0 debe, <0 a favor (centavos). `fmt` = `formatARS` (inyectado para no formatear acá). */
export function balanceView(balanceCents: number, fmt: (cents: number) => string): { label: string; tone: "ok" | "warn" } {
  if (balanceCents > 0) return { label: `Debés ${fmt(balanceCents)}`, tone: "warn" };
  if (balanceCents < 0) return { label: `Saldo a favor ${fmt(-balanceCents)}`, tone: "ok" };
  return { label: "Al día", tone: "ok" };
}

// ── Comprobante: validación en el cliente ────────────────────────────────────────────────────────────────────────

/** Tope de la nota en el server (`parsePaymentForm`). PL-F1a: entera para la persona (el medio ya no ocupa lugar). */
export const RECEIPT_NOTE_MAX = 500;

/** Tamaño desde el que una foto se achica en el navegador antes de mandarla (una foto de celular pesa 3-8 MB). */
export const RECEIPT_COMPRESS_FROM_BYTES = 1.5 * 1024 * 1024;

/** Imagen JPG/PNG/WEBP pesada: se intenta achicar (canvas → JPEG). Un PDF nunca (no se puede sin una librería). */
export function shouldCompressReceipt(f: { type: string; size: number }): boolean {
  return f.type.startsWith("image/") && f.size > RECEIPT_COMPRESS_FROM_BYTES;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export type ReceiptFormInput = {
  file: { type: string; size: number } | null;
  amountCents: number | null;
  amountInvalid: boolean;
  /** «YYYY-MM-DD» del `<input type="date">` (puede venir vacío). */
  paidOn: string;
  note: string;
};

/** `method` solo lo devuelve el server (en el cliente el select siempre tiene un valor). */
export type ReceiptFormErrors = Partial<Record<"file" | "amount" | "paidOn" | "note" | "method", string>>;

/**
 * Lo mismo que rechaza el server (`parsePaymentForm` + `readReceiptFile`), antes de subir 4 MB para nada. Los magic
 * bytes no se miran acá: el server es la barrera. Fecha futura = la de HOY en AR (no la del navegador).
 */
export function validateReceiptForm(i: ReceiptFormInput, now: Date): ReceiptFormErrors {
  const e: ReceiptFormErrors = {};
  if (!i.file || i.file.size <= 0) e.file = "Adjuntá el comprobante (PDF, JPG, PNG o WEBP de hasta 4 MB).";
  else if (!(RECEIPT_MIME_TYPES as readonly string[]).includes(i.file.type.toLowerCase())) e.file = "Subí el comprobante en PDF, JPG, PNG o WEBP.";
  else if (i.file.size > RECEIPT_MAX_BYTES) e.file = `El archivo pesa ${formatBytes(i.file.size)} y el máximo es 4 MB. Probá con una foto más liviana o un PDF.`;
  if (i.amountInvalid) e.amount = "Revisá el monto (por ejemplo, 15.000 o 15.000,50).";
  else if (i.amountCents === null || i.amountCents <= 0) e.amount = "Ingresá el monto que pagaste.";
  if (i.paidOn) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(i.paidOn)) e.paidOn = "Revisá la fecha del pago.";
    else if (i.paidOn > toARDateKey(now)) e.paidOn = "La fecha del pago no puede ser futura.";
  } else {
    e.paidOn = "Indicá la fecha del pago.";
  }
  if (i.note.trim().length > RECEIPT_NOTE_MAX) e.note = `La nota puede tener hasta ${RECEIPT_NOTE_MAX} caracteres.`;
  return e;
}

// ── MPS-4a (§26.6 UI, C-MPS10): suscripción con Mercado Pago ──────────────────────────────────────────────────────
/*
 * Todo lo que decide QUÉ se muestra en «Cómo pagás», el débito, la baja, el desglose del próximo cargo y el copy del
 * cambio de plan vive acá, puro: la regla de Martin es «oculto si no tiene función» (con `manual` solo lo que aplica a
 * transferencia y baja; con `off`, nada) y eso se prueba con números, no mirando HTML. Las barreras reales siguen en
 * el server (`lib/saas-billing-mp.ts`: modo, step-up, `autoDebitAllowed`); esto solo evita ofrecer lo que va a rebotar.
 * Fechas: claves civiles AR («YYYY-MM-DD») partidas a mano; nunca `new Date(key)` (en AR mostraba el día anterior).
 */

/** «4/12» desde una clave civil (el formato del brief para los días de cobro). */
export function dayMonthKey(key: string | null | undefined): string {
  if (!key) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${Number(m[3])}/${Number(m[2])}` : "";
}

/** Copy de la suscripción (voseo; «Mercado Pago» completo). Los errores de las actions ya vienen en `error`. */
export const SUBSCRIPTION_COPY = {
  methodTitle: "Cómo pagás",
  method: {
    AUTO_DEBIT: { label: "Débito automático con Mercado Pago", hint: "Se debita el 4 de cada mes. Tu tarjeta la cargás en Mercado Pago, no acá." },
    MP_CHECKOUT: { label: "Mercado Pago cada mes", hint: "Te avisamos el 4 y pagás hasta el 9." },
    TRANSFER: { label: "Transferencia", hint: "Transferís y nos mandás el comprobante desde acá con «Informar pago»." },
  } satisfies Record<SaasCollectionMethod, { label: string; hint: string }>,
  pendingDebit: "Falta autorizar el débito en Mercado Pago",
  continueMp: "Continuar en Mercado Pago",
  cancel: "Cancelar",
  changeCard: "Cambiar tarjeta",
  stopDebit: "Dejar de usar el débito",
  pausedDebit: "El débito está en pausa: este mes no se debita nada.",
  noPrice: "Tu plan todavía no tiene precio: el débito se activa cuando lo carguemos.",
  payMp: "Pagar con Mercado Pago",
  paymentReceived: "Recibimos tu pago. Puede tardar unos minutos en verse acá.",
  paymentRejected: "Mercado Pago no aprobó el pago. Probá de nuevo o elegí otra forma de pago.",
  debitAuthorized: "Listo: el débito automático quedó activo.",
  debitNotYet: "Mercado Pago todavía no nos confirmó la autorización. Si ya autorizaste, en unos minutos se ve acá.",
  emailLabel: "Email de tu cuenta de Mercado Pago",
  emailHint: "Es el email con el que entrás a Mercado Pago. Ahí cargás la tarjeta y autorizás el débito.",
  debitDrawerTitle: "Débito automático con Mercado Pago",
  cancelButton: "Dar de baja la suscripción",
  cancelTitle: "¿Dar de baja la suscripción?",
  undoCancel: "Deshacer baja",
  reactivate: "Reactivar suscripción",
  cancelledBand: "Tu suscripción está dada de baja: el consultorio quedó en solo lectura.",
  cancelPendingPlan: "Anular el cambio de plan",
} as const;

/** Formas de pago que se ofrecen, en el orden del selector. Vacío = no se muestra «Cómo pagás». */
export function collectionChoices(o: Pick<BillingOverview, "mode" | "subscriptionStatus" | "autoDebit">): SaasCollectionMethod[] {
  // `manual`: la única forma es la transferencia y ya está explicada debajo del saldo; un selector de una opción no
  // tiene función. Dada de baja: primero se reactiva (las actions de MP igual lo permitirían, pero no cobran nada).
  if (o.mode !== "mp" || o.subscriptionStatus === "CANCELLED") return [];
  // MPS-D24: sin suscripción creada (`autoDebit` null) el débito está permitido; Plataforma lo puede bloquear.
  const allowed = o.autoDebit ? o.autoDebit.allowed : true;
  return allowed ? ["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"] : ["MP_CHECKOUT", "TRANSFER"];
}

export type AutoDebitBand = { kind: "pending" | "active" | "failed" | "paused"; text: string };

/** Último cargo con saldo (el período más reciente): el que el débito rechazado dejó sin pagar. */
function lastOpenCharge(o: Pick<BillingOverview, "charges">) {
  return [...o.charges].filter((c) => c.status === "OPEN" && c.remainingCents > 0).sort((a, b) => (a.periodStart < b.periodStart ? 1 : -1))[0] ?? null;
}

/**
 * Estado del débito en una frase (§26.6): «Falta autorizar…», «Débito activo · m***@… · próximo débito 4/12 por $X»,
 * «No pudimos debitar $X. Pagalo antes del 9/12…» o la pausa. null = no hay débito en juego (o el modo no es `mp`).
 * El monto del activo es la PROYECCIÓN del próximo cargo (base + ajustes − saldo, lo mismo que el reconcile pone en el
 * preapproval los días 3-4) y, si no la hay, lo que tiene hoy el preapproval.
 */
export function autoDebitBand(
  o: Pick<BillingOverview, "mode" | "autoDebit" | "charges" | "nextCharge" | "subscriptionStatus">
): AutoDebitBand | null {
  const d = o.autoDebit;
  if (o.mode !== "mp" || !d || o.subscriptionStatus === "CANCELLED") return null;
  switch (d.status) {
    case "pending_authorization":
      return { kind: "pending", text: SUBSCRIPTION_COPY.pendingDebit };
    case "active": {
      const amount = o.nextCharge?.breakdown?.amountCents ?? d.amountCents;
      const on = d.nextDebitOn ?? o.nextCharge?.periodStart ?? null;
      const parts = ["Débito activo"];
      if (d.payerEmailMasked) parts.push(d.payerEmailMasked);
      if (on && amount != null) parts.push(`próximo débito ${dayMonthKey(on)} por ${formatARS(amount)}`);
      else if (on) parts.push(`próximo débito ${dayMonthKey(on)}`);
      return { kind: "active", text: parts.join(" · ") };
    }
    case "failed": {
      const c = lastOpenCharge(o);
      if (c) return { kind: "failed", text: `No pudimos debitar ${formatARS(c.remainingCents)}. Pagalo antes del ${dayMonthKey(c.dueDate)} para no perder el acceso.` };
      // Sin cargo abierto (se pagó por otro lado después del rechazo): ya no hay nada que pagar.
      return null;
    }
    case "paused":
      return { kind: "paused", text: SUBSCRIPTION_COPY.pausedDebit };
    default:
      // none / cancelled / blocked: no hay débito vivo (el selector ofrece activarlo, si se puede).
      return null;
  }
}

/**
 * MPS-2b1: con el plan en «Consultá» y sin precio a medida el débito queda pausado (`no_price`). Se avisa solo si hay
 * un débito en juego (elegido, pendiente o pausado): a quien paga por transferencia no le dice nada.
 */
export function noPriceNotice(o: Pick<BillingOverview, "mode" | "effectivePriceCents" | "collectionMethod" | "autoDebit">): string | null {
  if (o.mode !== "mp" || o.effectivePriceCents != null) return null;
  const st = o.autoDebit?.status;
  const inPlay = o.collectionMethod === "AUTO_DEBIT" || st === "pending_authorization" || st === "paused" || st === "active";
  return inPlay ? SUBSCRIPTION_COPY.noPrice : null;
}

export type ChargeLine = { label: string; amount: string; tone?: "total" };

/**
 * Desglose del próximo cargo (C-MPS5 `nextCharge.breakdown`): base + ajustes − saldo a favor = total. null si no hay
 * nada que desglosar (sin ajustes ni saldo el total es la base, que ya se ve en «Próximo cargo»).
 */
export function nextChargeLines(o: Pick<BillingOverview, "planLabel" | "nextCharge" | "pendingPlan">): ChargeLine[] | null {
  const n = o.nextCharge;
  const b = n?.breakdown;
  if (!n || !b || b.baseCents == null || b.amountCents == null) return null;
  if (b.adjustmentsCents === 0 && b.creditCents === 0) return null;
  // El plan que rige ese día: la bajada programada si vence ese día o antes (la misma cuenta de `readLedger`).
  const planLabel = o.pendingPlan && o.pendingPlan.effectiveOn <= n.periodStart ? o.pendingPlan.planLabel : o.planLabel;
  const lines: ChargeLine[] = [{ label: `Plan ${planLabel}`, amount: formatARS(b.baseCents) }];
  if (b.adjustmentsCents !== 0) {
    lines.push({ label: "Ajustes", amount: `${b.adjustmentsCents > 0 ? "+" : "−"} ${formatARS(Math.abs(b.adjustmentsCents))}` });
  }
  if (b.creditCents !== 0) lines.push({ label: "Saldo a favor", amount: `− ${formatARS(Math.abs(b.creditCents))}` });
  lines.push({ label: `Total del ${dayMonthKey(n.periodStart)}`, amount: formatARS(b.amountCents), tone: "total" });
  return lines;
}

/**
 * Primer período (MPS-D13): el alta (o el fin de la prueba) cae a mitad de mes y el primer cargo del 4 suma el tramo
 * `[billableFrom, 4)` como proporcional. Misma cuenta que el escritor (`stubFor`); null si no hay tramo, si ya hay
 * cargos (el stub ya entró) o si el plan no tiene precio.
 */
export function firstPeriodNotice(p: { billableFrom: string | null | undefined; nextChargeOn: string | null | undefined; priceCents: number | null; hasCharges: boolean }): string | null {
  if (p.hasCharges || !p.billableFrom || !p.nextChargeOn || p.priceCents == null) return null;
  if (p.billableFrom >= p.nextChargeOn) return null;
  const stub = stubFor({ billableFrom: p.billableFrom, periodStart: p.nextChargeOn, priceCents: p.priceCents });
  if (!stub) return null;
  return `El ${dayMonthKey(p.nextChargeOn)} se cobra el mes completo más ${formatARS(stub.amountCents)} por los días del ${dayMonthKey(p.billableFrom)} al ${dayMonthKey(addDaysKey(p.nextChargeOn, -1))}.`;
}

/**
 * Qué pasa con la plata al cambiar de plan (C-MPS10 `billing`). Subida: el proporcional entra en el cargo que cierra el
 * período (= hoy + los días cobrados, el `periodEnd` del cargo: `prorate` cuenta de hoy a ese día). Bajada: rige el día
 * del próximo cobro y hasta entonces nadie pierde el acceso (MPS-D12: si no entra ese día, se anula). null = el copy
 * de siempre (cambio inmediato).
 */
export function planChangeBillingCopy(b: PlanChangeBilling, l: { toLabel: string; fromLabel: string; trialing: boolean }): string | null {
  switch (b.kind) {
    case "upgrade_prorated": {
      const on = dayMonthKey(addDaysKey(b.effectiveOn, b.days));
      const days = b.days === 1 ? "por el día que queda" : `por los ${b.days} días que quedan`;
      return `Pasás a ${l.toLabel} hoy. En el cargo del ${on} se suman ${formatARS(b.prorationCents)} ${days}.`;
    }
    case "scheduled_downgrade":
      return (
        `Tu plan pasa a ${l.toLabel} el ${dayMonthKey(b.effectiveOn)}. Hasta ese día seguís con ${l.fromLabel} y nadie pierde el acceso. ` +
        "Si sumás usuarios antes, la bajada no se aplica y te avisamos."
      );
    case "blocked_cancel_pending":
      return "Tenés una baja programada: deshacela para cambiar de plan.";
    default:
      return null;
  }
}

/** Día en que regiría una baja pedida hoy: la MISMA cuenta que `scheduleCancelInTx` (para el texto del confirm). */
export function cancelEffectiveOnPreview(o: Pick<BillingOverview, "subscriptionStatus" | "trialEndsAt" | "nextCharge">, now: Date): string {
  return cancelEffectiveOnFor({
    today: toARDateKey(now),
    subscriptionStatus: o.subscriptionStatus,
    trialEndsAt: o.trialEndsAt ? new Date(o.trialEndsAt) : null,
    nextChargeKey: o.nextCharge?.periodStart ?? null,
  });
}

/** Texto del confirm de la baja. «El débito se pausa ahora» solo si hay un débito que pausar. */
export function cancelConfirmMessage(effectiveOn: string, hasDebit: boolean): string {
  const base = `Vas a tener acceso completo hasta el ${dayMonthKey(effectiveOn)}. Después el consultorio queda en solo lectura.`;
  return hasDebit ? `${base} El débito se pausa ahora.` : base;
}

/**
 * Parámetros con los que vuelve Mercado Pago a Configuración: los nuestros (`cargo`, `debito`) y los que MP agrega al
 * back_url del checkout y del preapproval. Se borran todos después de leerlos: un refresh no tiene que volver a
 * confirmar el pago ni el link copiado llevar el id del pago.
 */
export const BILLING_RETURN_PARAMS = [
  "cargo",
  "debito",
  "payment_id",
  "collection_id",
  "collection_status",
  "status",
  "external_reference",
  "payment_type",
  "merchant_order_id",
  "preference_id",
  "site_id",
  "processing_mode",
  "merchant_account_id",
  "preapproval_id",
] as const;

export type BillingReturn = { kind: "checkout"; chargeId?: string; paymentId: string } | { kind: "debit" } | { kind: "none" };

/**
 * Qué trae la URL: vuelta del checkout de un cargo (`cargo` + `payment_id` numérico → `confirmCheckoutReturn`), del
 * débito (`debito=1` → `refreshAutoDebit`), o una vuelta sin nada que confirmar (cancelaron en MP: `none`, solo se
 * limpia). null = no es una vuelta de MP. El server vuelve a validar todo (no confía en la query).
 */
export function parseBillingReturn(search: string): BillingReturn | null {
  const q = new URLSearchParams(search);
  if (q.get("debito") === "1") return { kind: "debit" };
  if (!BILLING_RETURN_PARAMS.some((k) => q.has(k))) return null;
  const paymentId = q.get("payment_id") ?? q.get("collection_id");
  if (q.has("cargo") && paymentId && /^\d{1,20}$/.test(paymentId)) {
    const chargeId = q.get("cargo") || undefined;
    return chargeId ? { kind: "checkout", chargeId, paymentId } : { kind: "checkout", paymentId };
  }
  return { kind: "none" };
}

/** La misma URL sin los parámetros de la vuelta (se conserva `tab` y lo demás). */
export function stripBillingReturn(href: string): string {
  const url = new URL(href);
  for (const k of BILLING_RETURN_PARAMS) url.searchParams.delete(k);
  return url.toString();
}

/**
 * UUID v4 por instancia del drawer de cambio de plan (`applyPlanChange` lo exige `.uuid()`: la clave del proporcional
 * es `upgrade:<uuid>` y un reintento tiene que dar el mismo ajuste). Sin `randomUUID` (contexto no seguro) se arma con
 * `getRandomValues`; el fallback de otros drawers (`pl-<ts>`) no sirve acá porque el zod lo rechazaría.
 */
export function newPlanChangeKey(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
