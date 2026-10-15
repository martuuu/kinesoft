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
import { RECEIPT_MAX_BYTES, RECEIPT_MIME_TYPES } from "@/lib/saas-billing-logic";
import { toARDateKey } from "@/lib/datetime-ar";

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
