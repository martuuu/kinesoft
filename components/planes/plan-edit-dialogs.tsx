"use client";

/**
 * Diálogos de edición del plan (S22e, ES3 P3.2): cantidad, precio, sesión a
 * medida y renovación de la autorización de la OS. Las props son las
 * congeladas de P3-C (`plan-editor-types.ts`); acá solo se agregan helpers
 * puros exportados (testeables sin DOM) y el shell común.
 *
 * Reglas que mandan (C5 plata, C13 copy, P2-C2):
 *   - La UI NO recalcula reglas del server: el reprecio muestra lo que
 *     devuelve `previewRepricePlan` (cuántos turnos se re-estampan, cuántos
 *     quedan) y "agregar sesiones" muestra el preview del motor
 *     (`previewAddPlanSessions`) con la tabla de S18p. La cuota de una sesión
 *     nueva la decide el plan (D5), nunca este form.
 *   - Plata en centavos con `MoneyInput` / `formatARS`.
 *   - Dos familias de CAS: el reprecio, reducir la cantidad y la autorización
 *     van con `expectedUpdatedAt` / `expectedCurrentId` → `kind:'stale'`
 *     (copy del server + `onStale()` para que el caller recargue y el diálogo
 *     re-previsualice con el `updatedAt` nuevo); agregar sesiones va por el
 *     motor con `stateToken` → `kind:'stale-preview'` (banner C13 en la tabla
 *     y filas marcadas).
 *   - `needs-confirmation` (agregar a un plan COMPLETED lo reabre) →
 *     `useConfirm` y reenvío con `confirmReopen`.
 *   - Éxito: el diálogo muestra el toast de éxito ("Precio actualizado · 4
 *     turnos"); el `notice` del server NO, viaja en `onChanged({notice})` y lo
 *     muestra el caller (contrato `PlanEditDone`; la PlanCard de S22a ya lo
 *     hace con `toast.info`). Así no sale dos veces.
 *
 * Por qué Modal + portal y no Drawer: el diálogo de renovación también se abre
 * desde el drawer del turno (S19c). El `Drawer`/`Modal` del design system no
 * usan portal y el panel del drawer tiene `transform` (framer-motion): un
 * `position: fixed` adentro queda atado al panel y no a la ventana. Además el
 * `Modal` (z 40) quedaba DEBAJO del drawer (z 46). El shell lo porta a
 * `document.body` dentro de un contenedor con z 60 (debajo del ConfirmDialog,
 * z 80) y frena el Esc en captura para que el drawer de abajo no se cierre con
 * el mismo Esc (`Drawer` respeta `defaultPrevented`). El dirty-guard es el
 * mismo texto que el del `Drawer`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import {
  PlanPreviewTable,
  planPreviewOrdinalOf,
  previewTableCounts,
  type PreviewOrdinalSession,
} from "@/components/planes/plan-preview-table";
import type {
  CustomSessionDialogProps,
  PlanAuthorizationDTO,
  PlanCountDialogProps,
  PlanPreview,
  PlanPriceDialogProps,
  PlanPricingInput,
  PlanRowResolution,
  RenewAuthorizationDialogProps,
  RepricePlanPreview,
  PackageCountPricing,
} from "./plan-editor-types";
import { addPlanSessions, archivePlanSessions, previewAddPlanSessions, previewRepricePlan, renewPlanAuthorization, repricePlan } from "@/lib/plans-edit";
import { getPatientPlans, getPlanDetail } from "@/lib/plans-read";
import {
  RenewAuthorizationSchema,
  type AddPlanSessionsPreviewInput,
  type RenewAuthorizationInput,
} from "@/lib/plans-edit-types";
import {
  PLAN_EDITOR_COPY,
  PREVIEW_DEBOUNCE_MS,
  canonicalKey,
  chosenRows,
  commitResolutions,
  createPreviewSequencer,
  planEditorToday,
  previewRequestKey,
  pruneResolutions,
  reconcileStalePreview,
  type PlanPriceMode,
} from "@/lib/plan-editor-state";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import { localToARIso } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";

export type {
  CustomSessionDialogProps,
  PlanCountDialogProps,
  PlanPriceDialogProps,
  RenewAuthorizationDialogProps,
};

// ─── Copy (C13 literal donde C13 lo fija) ────────────────────────────────────

export const PLAN_EDIT_COPY = {
  countTitle: "Cambiar la cantidad de sesiones",
  priceTitle: "Cambiar el precio",
  customTitle: "Agregar sesión a medida",
  renewTitle: "Renovar autorización",
  dirty: "Tenés cambios sin guardar. Si cerrás, se pierden.",
  keepTotal: "Mantener el total",
  keepPerSession: "Mantener el precio por sesión",
  sameCount: "Es la misma cantidad que tiene el plan.",
  samePrice: "Elegí un precio distinto al actual.",
  noPrice: PLAN_EDITOR_COPY.noPrice,
  reduceHint:
    "Se archivan las últimas sesiones sin cobro ni realizar. Si alguna tiene un turno impago, se cancela; las cobradas o realizadas no se tocan.",
  customHint: "Sin fecha, la sesión queda «sin turno» para agendarla después.",
  noAuthorization: "No hay una autorización vigente.",
  authForbidden: "No tenés acceso a la autorización de la obra social de este plan.",
  loadError: "No pudimos cargar los datos del plan. Cerrá y probá de nuevo.",
  network: "No pudimos guardar. Revisá la conexión y probá de nuevo.",
} as const;

// ─── Helpers puros (exportados para los tests) ───────────────────────────────

/** Lo que el plan cobra, en palabras: "sin precio", "$15.000 por sesión", "paquete $120.000". */
export function planPricingLabel(p: PlanPricingInput): string {
  if (!p) return "sin precio";
  return p.mode === "PACKAGE" ? `paquete ${formatARS(p.totalPriceCents)}` : `${formatARS(p.pricePerSessionCents)} por sesión`;
}

const nTurnos = (n: number) => `${n} ${n === 1 ? "turno" : "turnos"}`;

/**
 * C13 literal: "Cambiar precio: de $X a $Y en N turnos · M quedan como están
 * (cobrados o pasados)". Sale TAL CUAL del preview del server (no se cuenta
 * nada acá). Sin turnos que quedan, el segundo tramo no se muestra.
 */
export function repriceSummaryLine(p: Pick<RepricePlanPreview, "current" | "next" | "bookingsToStamp" | "bookingsKept">): string {
  const head = `Cambiar precio: de ${planPricingLabel(p.current)} a ${planPricingLabel(p.next)} en ${nTurnos(p.bookingsToStamp)}`;
  return p.bookingsKept > 0 ? `${head} · ${p.bookingsKept} quedan como están (cobrados o pasados)` : head;
}

/** C13 literal: "¿Mantenemos el total ($120.000) o el precio por sesión?" (sin el monto si no se pudo cargar). */
export function packageChoiceQuestion(totalCents: number | null | undefined): string {
  return totalCents == null
    ? "¿Mantenemos el total o el precio por sesión?"
    : `¿Mantenemos el total (${formatARS(totalCents)}) o el precio por sesión?`;
}

export type CountChange =
  | { kind: "invalid"; error: string }
  | { kind: "same" }
  | { kind: "add"; count: number }
  | { kind: "reduce"; totalSessions: number };

/** Cantidad nueva → qué action corre (agregar al final por el motor / archivar las últimas). */
export function countChangeOf(currentLive: number, target: number | null): CountChange {
  if (target == null || !Number.isInteger(target) || target < 1 || target > PLAN_MAX_SESSIONS) {
    return { kind: "invalid", error: PLAN_EDITOR_COPY.sessionsRange };
  }
  if (target === currentLive) return { kind: "same" };
  return target > currentLive ? { kind: "add", count: target - currentLive } : { kind: "reduce", totalSessions: target };
}

export type PriceDraft = { mode: PlanPriceMode; cents: number | null };

/** El precio actual del plan (de `getPlanDetail`) como borrador del form. */
export function priceDraftOf(d: {
  pricingMode: "PER_SESSION" | "PACKAGE" | null;
  pricePerSessionCents: number | null;
  totalPriceCents: number | null;
}): PriceDraft {
  if (d.pricingMode === "PER_SESSION") return { mode: "PER_SESSION", cents: d.pricePerSessionCents };
  if (d.pricingMode === "PACKAGE") return { mode: "PACKAGE", cents: d.totalPriceCents };
  return { mode: "NONE", cents: null };
}

/** Borrador → `pricing` del zod del server (null = "sin precio · sigue la cobertura"). */
export function pricingFromPriceDraft(d: PriceDraft): { ok: true; pricing: PlanPricingInput } | { ok: false; error: string } {
  if (d.mode === "NONE") return { ok: true, pricing: null };
  if (d.cents == null || !Number.isInteger(d.cents) || d.cents < 0) return { ok: false, error: PLAN_EDIT_COPY.noPrice };
  return d.mode === "PER_SESSION"
    ? { ok: true, pricing: { mode: "PER_SESSION", pricePerSessionCents: d.cents } }
    : { ok: true, pricing: { mode: "PACKAGE", totalPriceCents: d.cents } };
}

/** "2026-11-30" → "30/11" (string puro: un dayKey ya es día AR). */
const ddmm = (dayKey: string) => `${dayKey.slice(8, 10)}/${dayKey.slice(5, 7)}`;

/** C13 literal: "Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11" (+ "orden X" si hay, como la card). */
export function authorizationSummaryLine(a: Pick<PlanAuthorizationDTO, "code" | "authorizedSessions" | "startsOn" | "expiresOn" | "used" | "scheduled">): string {
  const parts: string[] = [];
  parts.push(a.authorizedSessions != null ? `Autorizadas ${a.authorizedSessions}` : "Sin tope de sesiones");
  parts.push(`usadas ${a.used}`, `agendadas ${a.scheduled}`);
  parts.push(a.expiresOn ? `vence ${ddmm(a.expiresOn)}` : `desde ${ddmm(a.startsOn)}`);
  if (a.code) parts.push(`orden ${a.code}`);
  return parts.join(" · ");
}

/** Lo que el usuario tipea en la renovación (como lo devuelven los inputs). */
export type RenewDraft = { code: string; authorizedSessions: string; startsOnDayKey: string; expiresOnDayKey: string };

export function emptyRenewDraft(today: string): RenewDraft {
  return { code: "", authorizedSessions: "", startsOnDayKey: today, expiresOnDayKey: "" };
}

export type RenewErrors = Partial<Record<"code" | "authorizedSessions" | "startsOnDayKey" | "expiresOnDayKey" | "form", string>>;

/**
 * Borrador → input de `renewPlanAuthorization`, validado con el MISMO zod del
 * server (`RenewAuthorizationSchema`). Las fechas son el value de
 * `<input type="date">` (ya es un dayKey AR: nada de `toISOString` del host).
 */
export function renewInputOf(
  programId: string,
  expectedCurrentId: string | null,
  d: RenewDraft
): { ok: true; input: RenewAuthorizationInput } | { ok: false; errors: RenewErrors } {
  const sessionsText = d.authorizedSessions.trim();
  const sessions = sessionsText === "" ? undefined : Number(sessionsText);
  if (sessions !== undefined && !Number.isInteger(sessions)) {
    return { ok: false, errors: { authorizedSessions: PLAN_EDITOR_COPY.authSessions } };
  }
  if (!d.startsOnDayKey) return { ok: false, errors: { startsOnDayKey: PLAN_EDITOR_COPY.authStart } };
  const input: RenewAuthorizationInput = {
    programId,
    expectedCurrentId,
    startsOnDayKey: d.startsOnDayKey,
    ...(d.code.trim() ? { code: d.code.trim() } : {}),
    ...(sessions !== undefined ? { authorizedSessions: sessions } : {}),
    ...(d.expiresOnDayKey ? { expiresOnDayKey: d.expiresOnDayKey } : {}),
  };
  const parsed = RenewAuthorizationSchema.safeParse(input);
  if (parsed.success) return { ok: true, input };
  const errors: RenewErrors = {};
  for (const issue of parsed.error.issues) {
    const k = issue.path[0];
    const key = k === "code" || k === "authorizedSessions" || k === "startsOnDayKey" || k === "expiresOnDayKey" ? k : "form";
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

/** Botón del commit de "agregar": "Agregar 2 sesiones y 2 turnos" / "Agregar sesión". */
export function addCommitLabel(sessions: number, bookings: number): string {
  const s = sessions === 1 ? "sesión" : `${sessions} sesiones`;
  return bookings > 0 ? `Agregar ${s} y ${nTurnos(bookings)}` : `Agregar ${s}`;
}

/** Texto del toast de reducir la cantidad. */
export function reduceDoneMessage(d: { totalSessions: number; archivedSessionIds: string[]; cancelledBookings: number }): string {
  const a = d.archivedSessionIds.length;
  const head = `${a === 1 ? "Se archivó 1 sesión" : `Se archivaron ${a} sesiones`}: el plan queda con ${d.totalSessions}`;
  return d.cancelledBookings > 0 ? `${head} · ${d.cancelledBookings === 1 ? "1 turno cancelado" : `${d.cancelledBookings} turnos cancelados`}` : head;
}

// ─── Estilos chicos ──────────────────────────────────────────────────────────

const col: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, minWidth: 0 };
const errorText: CSSProperties = { margin: 0, fontSize: 13, color: "var(--danger-fg)" };
const hintText: CSSProperties = { margin: 0, fontSize: 12, color: "var(--navy-500)" };
const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };
const footer: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" };
const summaryBox: CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(15,30,51,0.04)",
  fontSize: 13,
  color: "var(--navy-900)",
};

// ─── Shell común ─────────────────────────────────────────────────────────────

/**
 * Modal del design system portado a `body` (ver la cabecera: el drawer del
 * turno tiene `transform` y z 46) con dirty-guard y Esc que no se escapa al
 * drawer de abajo. En el render del server (tests) se pinta en línea.
 */
export function PlanDialogShell({
  open,
  onClose,
  title,
  description,
  dirty = false,
  width = 560,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  dirty?: boolean;
  width?: number;
  children: ReactNode;
}) {
  const confirm = useConfirm();
  const asking = useRef(false);
  const requestClose = useCallback(async () => {
    if (!dirty) return onClose();
    if (asking.current) return;
    asking.current = true;
    try {
      const ok = await confirm({
        title: "¿Descartar los cambios?",
        message: PLAN_EDIT_COPY.dirty,
        confirmLabel: "Descartar",
        cancelLabel: "Seguir editando",
        tone: "danger",
      });
      if (ok) onClose();
    } finally {
      asking.current = false;
    }
  }, [dirty, onClose, confirm]);

  useEffect(() => {
    if (!open) return;
    // Captura en window: corre antes que el listener del Modal (document) y
    // que el del Drawer de abajo (window, burbuja), que ignora un Esc con
    // `defaultPrevented`. El cierre lo sigue haciendo el Modal (→ requestClose).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // Cerrado no se pinta nada (ni el portal): la PlanCard monta los cuatro
  // diálogos siempre y cada instancia se descarta al cerrar (`freshOnClose`).
  if (!open) return null;
  const node = (
    <div style={{ position: "relative", zIndex: 60 }}>
      <Modal open={open} onClose={() => void requestClose()} title={title} description={description} width={width} lockBackdrop={dirty}>
        {children}
      </Modal>
    </div>
  );
  return typeof document === "undefined" ? node : createPortal(node, document.body);
}

/** Segmentado accesible (radiogroup de radios nativos: flechas del teclado gratis). */
function Choice<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  name: string;
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
      <legend style={{ ...sectionLabel, padding: 0, marginBottom: 6 }}>{label}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 3, borderRadius: 14, background: "rgba(15,30,51,0.04)" }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={o.value}
              style={{
                position: "relative",
                flex: "1 1 auto",
                textAlign: "center",
                padding: "7px 12px",
                borderRadius: 11,
                fontSize: 13,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
                background: on ? "#fff" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                boxShadow: on ? "0 1px 3px rgba(15,30,51,0.12)" : undefined,
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

const PACKAGE_OPTIONS: ReadonlyArray<{ value: PackageCountPricing; label: string }> = [
  { value: "keep-total", label: PLAN_EDIT_COPY.keepTotal },
  { value: "keep-per-session", label: PLAN_EDIT_COPY.keepPerSession },
];

/** PACKAGE: "¿Mantenemos el total ($120.000) o el precio por sesión?" (default: mantener el total). */
export function PackageChoice({
  totalCents,
  value,
  onChange,
  disabled,
  name,
}: {
  totalCents: number | null | undefined;
  value: PackageCountPricing;
  onChange: (v: PackageCountPricing) => void;
  disabled?: boolean;
  name: string;
}) {
  return <Choice<PackageCountPricing> name={name} label={packageChoiceQuestion(totalCents)} value={value} options={PACKAGE_OPTIONS} onChange={onChange} disabled={disabled} />;
}

// ─── Detalle del plan (precio actual / total del paquete) ────────────────────

type PlanMoney = {
  pricingMode: "PER_SESSION" | "PACKAGE" | null;
  pricePerSessionCents: number | null;
  totalPriceCents: number | null;
  /** Para el ordinal (M13) de las filas nuevas en "Revisá los turnos" (P3.Z F2). */
  sessions: PreviewOrdinalSession[];
};

/**
 * `getPlanDetail` al abrir (solo `full`: quien edita plata tiene `plans.manage`
 * = full). `needed=false` no pide nada (cantidad en un plan que no es paquete).
 * Se recarga cuando cambia `updatedAt` (después de un stale el caller recarga).
 */
function usePlanMoney(open: boolean, programId: string, updatedAt: string, needed: boolean) {
  const [money, setMoney] = useState<PlanMoney | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !needed) return;
    let alive = true;
    getPlanDetail({ programId })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) return setError(r.error);
        setError(null);
        setMoney({
          pricingMode: r.data.pricingMode,
          pricePerSessionCents: r.data.pricePerSessionCents,
          totalPriceCents: r.data.totalPriceCents,
          sessions: r.data.sessions,
        });
      })
      .catch(() => alive && setError(PLAN_EDIT_COPY.loadError));
    return () => {
      alive = false;
    };
  }, [open, programId, updatedAt, needed]);
  return { money, error };
}

const pricingOfMoney = (m: PlanMoney | null): PlanPricingInput =>
  m?.pricingMode === "PER_SESSION" && m.pricePerSessionCents != null
    ? { mode: "PER_SESSION", pricePerSessionCents: m.pricePerSessionCents }
    : m?.pricingMode === "PACKAGE" && m.totalPriceCents != null
      ? { mode: "PACKAGE", totalPriceCents: m.totalPriceCents }
      : null;

// ─── "Agregar sesiones" por el motor (cantidad ↑ y sesión a medida) ──────────

type AddBase = Omit<AddPlanSessionsPreviewInput, "rows" | "stateToken">;

/**
 * Preview → "Revisá los turnos" → commit de `addPlanSessions`, con la misma
 * mecánica que el editor (S18): secuencia "gana el último", re-preview con
 * debounce al cambiar una resolución, `stale-preview` → filas marcadas y
 * banner C13, `needs-confirmation` → `useConfirm` y reenvío con
 * `confirmReopen`.
 */
function useAddSessionsFlow(opts: {
  base: AddBase | null;
  onDone: (notice: string | undefined, data: { sessionIds: string[]; createdBookings: number; reopened: boolean }) => void;
  onStale?: () => void;
}) {
  const { base, onDone, onStale } = opts;
  const confirm = useConfirm();
  const sequencer = useRef(createPreviewSequencer());
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewBase, setPreviewBase] = useState<AddBase | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, PlanRowResolution>>({});
  const [staleIndexes, setStaleIndexes] = useState<Set<number> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentKey = useMemo(() => (base ? previewRequestKey(base, resolutions) : null), [base, resolutions]);
  const fresh = !!preview && previewKey !== null && previewKey === currentKey && !previewing;

  const runPreview = useCallback(async (b: AddBase, chosen: Record<number, PlanRowResolution>) => {
    const seq = sequencer.current.next();
    setPreviewing(true);
    try {
      const r = await previewAddPlanSessions({ ...b, rows: chosenRows(chosen) });
      if (!sequencer.current.isLatest(seq)) return;
      if (!r.ok) {
        setError(r.error);
        setPreview(null);
        return;
      }
      const kept = pruneResolutions(r.preview, chosen);
      setError(null);
      setPreview(r.preview);
      setPreviewBase(b);
      setResolutions(kept);
      setPreviewKey(previewRequestKey(b, kept));
    } catch {
      if (sequencer.current.isLatest(seq)) setError(PLAN_EDIT_COPY.network);
    } finally {
      if (sequencer.current.isLatest(seq)) setPreviewing(false);
    }
  }, []);

  // Cambió el pedido (cantidad, paquete, fecha…) con un preview a la vista: se
  // re-pide solo, con debounce (como el editor). Antes del primer preview,
  // lo pide el botón "Ver turnos".
  useEffect(() => {
    if (!preview || !base || !currentKey || currentKey === previewKey || committing) return;
    const t = setTimeout(() => void runPreview(base, resolutions), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [preview, base, currentKey, previewKey, resolutions, committing, runPreview]);

  // Las marcas de stale valen para el pedido en el que salieron.
  const baseKey = base ? canonicalKey(base) : null;
  const lastBaseKey = useRef<string | null>(baseKey);
  useEffect(() => {
    if (lastBaseKey.current !== baseKey) setStaleIndexes(null);
    lastBaseKey.current = baseKey;
  }, [baseKey]);

  useEffect(() => () => sequencer.current.cancel(), []);

  const applyStale = (next: PlanPreview) => {
    const r = reconcileStalePreview(preview, next, resolutions);
    sequencer.current.cancel();
    setPreviewing(false);
    setPreview(next);
    setResolutions(r.resolutions);
    setStaleIndexes(r.staleIndexes.size > 0 ? r.staleIndexes : new Set(next.rows.map((x) => x.index)));
    if (previewBase) setPreviewKey(previewRequestKey(previewBase, r.resolutions));
  };

  const commit = async (confirmReopen = false): Promise<void> => {
    if (!preview || !previewBase || !fresh || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const r = await addPlanSessions({
        ...previewBase,
        rows: commitResolutions(preview, resolutions),
        stateToken: preview.stateToken,
        ...(confirmReopen ? { confirmReopen: true as const } : {}),
      });
      if (r.ok) {
        onDone(r.notice, r.data);
        return;
      }
      if ("kind" in r && r.kind === "stale-preview") return applyStale(r.preview);
      if ("kind" in r && r.kind === "needs-confirmation") {
        setCommitting(false);
        const ok = await confirm({ title: r.error, message: "El plan vuelve a quedar activo con las sesiones nuevas.", confirmLabel: "Reactivar y agregar" });
        if (ok) return commit(true);
        return;
      }
      setError(r.error);
      if ("kind" in r && r.kind === "stale") {
        onStale?.();
        void runPreview(previewBase, resolutions);
      }
    } catch {
      setError(PLAN_EDIT_COPY.network);
    } finally {
      setCommitting(false);
    }
  };

  return {
    preview,
    resolutions,
    staleIndexes,
    previewing,
    committing,
    error,
    setError,
    fresh,
    askPreview: () => (base ? void runPreview(base, resolutions) : undefined),
    onResolutionChange: (res: PlanRowResolution) => setResolutions((prev) => ({ ...prev, [res.index]: res })),
    commit: () => void commit(),
    dirtyResolutions: Object.keys(resolutions).length > 0,
  };
}

function AddPreviewSection({
  flow,
  pricing,
  sessions,
  totalLive,
}: {
  flow: ReturnType<typeof useAddSessionsFlow>;
  pricing: PlanPricingInput;
  /** Sesiones del detalle (si se cargó): ordinal por fecha. Sin ellas, `totalLive` + posición (agregar al final). */
  sessions: PreviewOrdinalSession[] | null;
  totalLive: number;
}) {
  if (!flow.preview) return null;
  const ordinalOf = planPreviewOrdinalOf(flow.preview, { sessions, totalLive });
  return (
    <section aria-label={PLAN_EDITOR_COPY.reviewTitle} aria-busy={flow.previewing || undefined} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <h3 className="k-display" style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>
        {PLAN_EDITOR_COPY.reviewTitle}
      </h3>
      {!flow.fresh && !flow.committing && (
        <p aria-live="polite" style={hintText}>
          Actualizando los turnos…
        </p>
      )}
      <PlanPreviewTable
        preview={flow.preview}
        resolutions={flow.resolutions}
        onResolutionChange={flow.onResolutionChange}
        staleIndexes={flow.staleIndexes}
        schedule={null}
        pricing={pricing}
        disabled={flow.committing}
        ordinalOf={ordinalOf}
      />
    </section>
  );
}

// ─── Cantidad ────────────────────────────────────────────────────────────────

/**
 * Cantidad de sesiones. Más = `addPlanSessions` `append` por el motor (preview
 * + "Revisá los turnos"); menos = `archivePlanSessions({totalSessions})` (CAS
 * con `plan.updatedAt`, confirma con `useConfirm`). En paquete pregunta C13
 * "¿Mantenemos el total ($X) o el precio por sesión?" (default: el total).
 */
function PlanCountDialogBody({ open, onClose, onChanged, onStale, plan }: PlanCountDialogProps): JSX.Element | null {
  const toast = useToast();
  const confirm = useConfirm();
  const isPackage = plan.pricingMode === "PACKAGE";
  const { money } = usePlanMoney(open, plan.programId, plan.updatedAt, isPackage);
  const [targetText, setTargetText] = useState(String(plan.totalLive));
  const [choice, setChoice] = useState<PackageCountPricing>("keep-total");
  const [reducing, setReducing] = useState(false);
  const [reduceError, setReduceError] = useState<string | null>(null);

  const target = targetText.trim() === "" ? null : Number(targetText);
  const change = countChangeOf(plan.totalLive, target);
  const base = useMemo<AddBase | null>(
    () =>
      change.kind === "add"
        ? { programId: plan.programId, kind: "append", count: change.count, ...(isPackage ? { packagePricing: choice } : {}) }
        : null,
    // `change` se deriva de targetText; la clave estable es el conteo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.programId, change.kind, change.kind === "add" ? change.count : 0, isPackage, choice]
  );
  const flow = useAddSessionsFlow({
    base,
    onStale,
    onDone: (notice, data) => {
      toast.success(
        data.reopened ? "Plan reactivado con las sesiones nuevas" : `Sesiones agregadas${data.createdBookings ? ` · ${nTurnos(data.createdBookings)}` : ""}`
      );
      onChanged({ notice });
      onClose();
    },
  });

  const reduce = async () => {
    if (change.kind !== "reduce" || reducing) return;
    const n = plan.totalLive - change.totalSessions;
    const ok = await confirm({
      title: `¿Dejamos el plan en ${change.totalSessions} ${change.totalSessions === 1 ? "sesión" : "sesiones"}?`,
      message: `${n === 1 ? "Se archiva 1 sesión" : `Se archivan ${n} sesiones`}. ${PLAN_EDIT_COPY.reduceHint}`,
      confirmLabel: "Reducir",
      tone: "danger",
    });
    if (!ok) return;
    setReducing(true);
    setReduceError(null);
    try {
      const r = await archivePlanSessions({
        programId: plan.programId,
        expectedUpdatedAt: plan.updatedAt,
        totalSessions: change.totalSessions,
        ...(isPackage ? { packagePricing: choice } : {}),
      });
      if (r.ok) {
        toast.success(reduceDoneMessage(r.data));
        onChanged({ notice: r.notice });
        onClose();
        return;
      }
      setReduceError(r.error);
      if ("kind" in r && r.kind === "stale") onStale?.();
    } catch {
      setReduceError(PLAN_EDIT_COPY.network);
    } finally {
      setReducing(false);
    }
  };

  const dirty = targetText !== String(plan.totalLive) || flow.dirtyResolutions;
  const busy = flow.previewing || flow.committing || reducing;
  const counts = flow.preview ? previewTableCounts(flow.preview, flow.resolutions) : null;
  const error = change.kind === "invalid" ? null : change.kind === "add" ? flow.error : reduceError;

  return (
    <PlanDialogShell open={open} onClose={onClose} title={PLAN_EDIT_COPY.countTitle} dirty={dirty} width={change.kind === "add" && flow.preview ? 640 : 520}>
      <div style={col}>
        <p style={hintText}>
          El plan tiene {plan.totalLive} {plan.totalLive === 1 ? "sesión" : "sesiones"} ({plan.done} {plan.done === 1 ? "realizada" : "realizadas"}).
        </p>
        <FormField
          label="Cantidad de sesiones"
          type="number"
          min={1}
          max={PLAN_MAX_SESSIONS}
          step={1}
          value={targetText}
          onChange={(v) => setTargetText(v)}
          disabled={busy}
          error={change.kind === "invalid" ? change.error : change.kind === "same" && dirty ? PLAN_EDIT_COPY.sameCount : undefined}
        />
        {isPackage && change.kind !== "same" && change.kind !== "invalid" && (
          <PackageChoice name={`count-pkg-${plan.programId}`} totalCents={money?.totalPriceCents} value={choice} onChange={setChoice} disabled={busy} />
        )}
        {change.kind === "reduce" && <p style={hintText}>{PLAN_EDIT_COPY.reduceHint}</p>}
        {change.kind === "add" && !flow.preview && (
          <div>
            <Button type="button" variant="ghost" onClick={flow.askPreview} disabled={busy}>
              {flow.previewing ? "Buscando turnos…" : PLAN_EDITOR_COPY.preview}
            </Button>
          </div>
        )}
        {change.kind === "add" && <AddPreviewSection flow={flow} pricing={pricingOfMoney(money)} sessions={money?.sessions ?? null} totalLive={plan.totalLive} />}
        {error && (
          <p role="alert" style={errorText}>
            {error}
          </p>
        )}
        <footer style={footer}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={flow.committing || reducing}>
            Cancelar
          </Button>
          {change.kind === "reduce" ? (
            <Button type="button" variant="primary" onClick={() => void reduce()} disabled={busy}>
              {reducing ? "Guardando…" : `Reducir a ${change.totalSessions}`}
            </Button>
          ) : (
            <Button type="button" variant="primary" onClick={flow.commit} disabled={change.kind !== "add" || !flow.fresh || flow.committing}>
              {flow.committing ? "Guardando…" : change.kind === "add" ? addCommitLabel(change.count, counts?.bookings ?? 0) : "Guardar"}
            </Button>
          )}
        </footer>
      </div>
    </PlanDialogShell>
  );
}

// ─── Precio ──────────────────────────────────────────────────────────────────

const PRICE_OPTIONS: ReadonlyArray<{ value: PlanPriceMode; label: string }> = [
  { value: "NONE", label: PLAN_EDITOR_COPY.priceNone },
  { value: "PER_SESSION", label: PLAN_EDITOR_COPY.pricePerSession },
  { value: "PACKAGE", label: PLAN_EDITOR_COPY.pricePackage },
];

/**
 * Precio (C5): `previewRepricePlan` con debounce → copy C13 "Cambiar precio:
 * de $X a $Y en N turnos · M quedan como están (cobrados o pasados)" →
 * `repricePlan` con el MISMO input (CAS `expectedUpdatedAt`). El server solo
 * toca turnos futuros impagos; si el preview trae `error` (C5: no quedan
 * sesiones sin cobrar / total menor que lo cobrado) no se puede confirmar.
 * `stale` → copy del server + `onStale()` (el caller recarga, cambia
 * `plan.updatedAt` y el preview se vuelve a pedir solo).
 */
function PlanPriceDialogBody({ open, onClose, onChanged, onStale, plan }: PlanPriceDialogProps): JSX.Element | null {
  const toast = useToast();
  const { money, error: loadError } = usePlanMoney(open, plan.programId, plan.updatedAt, true);
  const [baseline, setBaseline] = useState<PriceDraft | null>(null);
  const [draft, setDraft] = useState<PriceDraft | null>(null);
  const [moneyInvalid, setMoneyInvalid] = useState(false);
  const [preview, setPreview] = useState<RepricePlanPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequencer = useRef(createPreviewSequencer());

  // El precio actual llega con el detalle; el borrador arranca ahí una vez
  // (una recarga por stale no pisa lo que el usuario está tipeando).
  useEffect(() => {
    if (!money) return;
    const d = priceDraftOf(money);
    setBaseline(d);
    setDraft((cur) => cur ?? d);
  }, [money]);

  const parsed = draft ? pricingFromPriceDraft(draft) : null;
  const changed = !!draft && !!baseline && canonicalKey(draft) !== canonicalKey(baseline);
  const input = useMemo(
    () => (parsed?.ok && changed && !moneyInvalid ? { programId: plan.programId, expectedUpdatedAt: plan.updatedAt, pricing: parsed.pricing } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan.programId, plan.updatedAt, canonicalKey(parsed), changed, moneyInvalid]
  );
  const inputKey = input ? canonicalKey(input) : null;
  const fresh = !!preview && previewKey === inputKey && !previewing;

  useEffect(() => {
    if (!input || inputKey === previewKey) return;
    const t = setTimeout(async () => {
      const seq = sequencer.current.next();
      setPreviewing(true);
      try {
        const r = await previewRepricePlan(input);
        if (!sequencer.current.isLatest(seq)) return;
        if (!r.ok) {
          setPreview(null);
          setPreviewKey(null);
          setError(r.error);
          return;
        }
        setError(null);
        setPreview(r.preview);
        setPreviewKey(inputKey);
      } catch {
        if (sequencer.current.isLatest(seq)) setError(PLAN_EDIT_COPY.network);
      } finally {
        if (sequencer.current.isLatest(seq)) setPreviewing(false);
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input, inputKey, previewKey]);

  useEffect(() => () => sequencer.current.cancel(), []);

  const commit = async () => {
    if (!input || !preview || !fresh || preview.error || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const r = await repricePlan(input);
      if (r.ok) {
        toast.success(
          r.data.stampedBookings > 0 ? `Precio actualizado · ${nTurnos(r.data.stampedBookings)}` : "Precio actualizado"
        );
        onChanged({ notice: r.notice });
        onClose();
        return;
      }
      setError(r.error);
      if ("kind" in r && r.kind === "stale") {
        // El preview que se ve ya no vale: se vuelve a pedir con el `updatedAt`
        // nuevo cuando el caller recargue (y, si no recarga, con el actual).
        setPreview(null);
        setPreviewKey(null);
        onStale?.();
      }
    } catch {
      setError(PLAN_EDIT_COPY.network);
    } finally {
      setCommitting(false);
    }
  };

  const busy = previewing || committing;
  const draftError = draft && parsed && !parsed.ok && draft.mode !== "NONE" && changed ? parsed.error : undefined;

  return (
    <PlanDialogShell open={open} onClose={onClose} title={PLAN_EDIT_COPY.priceTitle} dirty={changed}>
      <div style={col}>
        {!draft ? (
          loadError ? (
            <p role="alert" style={errorText}>
              {loadError}
            </p>
          ) : (
            <p aria-busy="true" style={hintText}>
              Cargando…
            </p>
          )
        ) : (
          <>
            <p style={hintText}>Hoy: {planPricingLabel(pricingOfMoney(money))}.</p>
            <Choice<PlanPriceMode>
              name={`price-mode-${plan.programId}`}
              label="Precio"
              value={draft.mode}
              options={PRICE_OPTIONS}
              onChange={(mode) => setDraft({ mode, cents: mode === "NONE" ? null : draft.cents })}
              disabled={committing}
            />
            {draft.mode !== "NONE" && (
              <MoneyInput
                label={draft.mode === "PER_SESSION" ? "Precio por sesión" : "Precio total del paquete"}
                value={draft.cents}
                onChange={(cents) => setDraft({ ...draft, cents })}
                onInvalidChange={setMoneyInvalid}
                error={draftError}
                disabled={committing}
              />
            )}
            {changed ? (
              preview && fresh ? (
                <p aria-live="polite" style={summaryBox}>
                  {repriceSummaryLine(preview)}
                </p>
              ) : input ? (
                <p aria-live="polite" aria-busy="true" style={hintText}>
                  Calculando a qué turnos afecta…
                </p>
              ) : null
            ) : (
              <p style={hintText}>{PLAN_EDIT_COPY.samePrice}</p>
            )}
            {preview?.error && fresh && (
              <p role="alert" style={errorText}>
                {preview.error}
              </p>
            )}
            {error && (
              <p role="alert" style={errorText}>
                {error}
              </p>
            )}
          </>
        )}
        <footer style={footer}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={committing}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" onClick={() => void commit()} disabled={!fresh || !!preview?.error || busy}>
            {committing ? "Guardando…" : "Cambiar precio"}
          </Button>
        </footer>
      </div>
    </PlanDialogShell>
  );
}

// ─── Sesión a medida ─────────────────────────────────────────────────────────

/**
 * Sesión a medida (decisión de Martin del 08-oct: exige `plans.manage`; el
 * server la gatea igual): `addPlanSessions` `custom` con título y fecha
 * opcionales. Sin fecha el server fuerza "sin turno"; con fecha pasa por el
 * motor (preview + "Revisá los turnos"). La cuota la decide el plan.
 */
function CustomSessionDialogBody({ open, onClose, onChanged, onStale, plan }: CustomSessionDialogProps): JSX.Element | null {
  const toast = useToast();
  const isPackage = plan.pricingMode === "PACKAGE";
  const { money } = usePlanMoney(open, plan.programId, plan.updatedAt, true);
  const [title, setTitle] = useState("");
  const [when, setWhen] = useState("");
  const [choice, setChoice] = useState<PackageCountPricing>("keep-total");

  const at = when ? localToARIso(when) : "";
  const base = useMemo<AddBase>(
    () => ({
      programId: plan.programId,
      kind: "custom",
      ...(title.trim() ? { title: title.trim() } : {}),
      // `localToARIso` ya da un instante con offset AR ("…T09:00:00-03:00"),
      // que es lo que pide el zod (`datetime({offset:true})`).
      ...(at ? { at } : {}),
      ...(isPackage ? { packagePricing: choice } : {}),
    }),
    [plan.programId, title, at, isPackage, choice]
  );
  const flow = useAddSessionsFlow({
    base,
    onStale,
    onDone: (notice, data) => {
      toast.success(data.createdBookings > 0 ? "Sesión agregada con su turno" : "Sesión agregada sin turno");
      onChanged({ notice });
      onClose();
    },
  });
  const counts = flow.preview ? previewTableCounts(flow.preview, flow.resolutions) : null;
  const dirty = title !== "" || when !== "" || flow.dirtyResolutions;
  const busy = flow.previewing || flow.committing;

  return (
    <PlanDialogShell open={open} onClose={onClose} title={PLAN_EDIT_COPY.customTitle} dirty={dirty} width={flow.preview ? 640 : 520}>
      <div style={col}>
        <FormField label="Título (opcional)" value={title} onChange={setTitle} placeholder="Ej.: control post-alta" disabled={flow.committing} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={sectionLabel}>Fecha y hora (opcional)</span>
          <DateTime24Picker value={when} onChange={setWhen} disabled={flow.committing} />
          <p style={hintText}>{PLAN_EDIT_COPY.customHint}</p>
        </div>
        {isPackage && <PackageChoice name={`custom-pkg-${plan.programId}`} totalCents={money?.totalPriceCents} value={choice} onChange={setChoice} disabled={busy} />}
        {!flow.preview && (
          <div>
            <Button type="button" variant="ghost" onClick={flow.askPreview} disabled={busy}>
              {flow.previewing ? "Buscando turno…" : PLAN_EDITOR_COPY.preview}
            </Button>
          </div>
        )}
        <AddPreviewSection flow={flow} pricing={pricingOfMoney(money)} sessions={money?.sessions ?? null} totalLive={plan.totalLive} />
        {flow.error && (
          <p role="alert" style={errorText}>
            {flow.error}
          </p>
        )}
        <footer style={footer}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={flow.committing}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" onClick={flow.commit} disabled={!flow.fresh || flow.committing}>
            {flow.committing ? "Guardando…" : addCommitLabel(1, counts?.bookings ?? 0)}
          </Button>
        </footer>
      </div>
    </PlanDialogShell>
  );
}

// ─── Renovar la autorización de la OS ────────────────────────────────────────

type CurrentAuth = { state: "loading" } | { state: "forbidden" } | { state: "error"; error: string } | { state: "ready"; current: PlanAuthorizationDTO | null };

/**
 * "Renovar autorización" (E2, `plans.authorize`: también la Secretaria desde
 * el drawer). `current` presente = la vigente que ya mostró el caller; ausente
 * = se carga con `getPatientPlans` (el drawer no la tiene: nunca viaja en C9).
 * Si el DTO del plan NO trae la clave `authorization`, el actor no la puede
 * ver (§2.6): no se muestra el form (falla cerrado; el server igual rechaza).
 * CAS: `expectedCurrentId` = id de la vigente mostrada; `stale` → copy del
 * server, se recarga la vigente (si la cargó el diálogo) y `onStale()`.
 */
function RenewAuthorizationDialogBody({ open, onClose, onChanged, onStale, programId, patientId, current }: RenewAuthorizationDialogProps): JSX.Element | null {
  const toast = useToast();
  const [today] = useState(() => planEditorToday());
  const [draft, setDraft] = useState<RenewDraft>(() => emptyRenewDraft(today));
  const [errors, setErrors] = useState<RenewErrors>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState<CurrentAuth>(current === undefined ? { state: "loading" } : { state: "ready", current });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (current !== undefined) {
      setLoaded({ state: "ready", current });
      return;
    }
    if (!open) return;
    let alive = true;
    setLoaded({ state: "loading" });
    getPatientPlans({ patientId })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) return setLoaded({ state: "error", error: r.error });
        const plan = r.data.find((p) => p.id === programId);
        if (!plan) return setLoaded({ state: "error", error: PLAN_EDIT_COPY.loadError });
        setLoaded(authStateOf(plan));
      })
      .catch(() => alive && setLoaded({ state: "error", error: PLAN_EDIT_COPY.loadError }));
    return () => {
      alive = false;
    };
  }, [open, current, patientId, programId, reload]);

  const submit = async () => {
    if (loaded.state !== "ready" || saving) return;
    const r0 = renewInputOf(programId, loaded.current?.id ?? null, draft);
    if (!r0.ok) return setErrors(r0.errors);
    setErrors({});
    setSaving(true);
    try {
      const r = await renewPlanAuthorization(r0.input);
      if (r.ok) {
        toast.success(loaded.current ? "Autorización renovada" : "Autorización cargada");
        onChanged({ notice: r.notice });
        onClose();
        return;
      }
      if ("kind" in r && r.kind === "stale") {
        setErrors({ form: r.error });
        if (current === undefined) setReload((n) => n + 1);
        onStale?.();
        return;
      }
      const fe = "fieldErrors" in r && r.fieldErrors ? r.fieldErrors : {};
      const pick = (k: keyof RenewErrors) => (fe[k as string]?.[0] ? { [k]: fe[k as string]![0] } : {});
      setErrors({ form: r.error, ...pick("code"), ...pick("authorizedSessions"), ...pick("startsOnDayKey"), ...pick("expiresOnDayKey") });
    } catch {
      setErrors({ form: PLAN_EDIT_COPY.network });
    } finally {
      setSaving(false);
    }
  };

  const dirty = canonicalKey(draft) !== canonicalKey(emptyRenewDraft(today));
  const set = (patch: Partial<RenewDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <PlanDialogShell open={open} onClose={onClose} title={PLAN_EDIT_COPY.renewTitle} dirty={dirty} width={480}>
      <div style={col}>
        {loaded.state === "loading" ? (
          <p aria-busy="true" style={hintText}>
            Cargando…
          </p>
        ) : loaded.state === "forbidden" ? (
          <p role="alert" style={errorText}>
            {PLAN_EDIT_COPY.authForbidden}
          </p>
        ) : loaded.state === "error" ? (
          <p role="alert" style={errorText}>
            {loaded.error}
          </p>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={sectionLabel}>Vigente</span>
              <p style={summaryBox}>{loaded.current ? authorizationSummaryLine(loaded.current) : PLAN_EDIT_COPY.noAuthorization}</p>
              {loaded.current && <p style={hintText}>La vigente pasa al historial cuando guardes la nueva.</p>}
            </div>
            <FormField label="Código de la orden (opcional)" value={draft.code} onChange={(v) => set({ code: v })} error={errors.code} disabled={saving} />
            <FormField
              label="Sesiones autorizadas (opcional)"
              type="number"
              min={1}
              max={200}
              step={1}
              value={draft.authorizedSessions}
              onChange={(v) => set({ authorizedSessions: v })}
              error={errors.authorizedSessions}
              disabled={saving}
            />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
              <FormField
                label="Desde"
                type="date"
                value={draft.startsOnDayKey}
                onChange={(v) => set({ startsOnDayKey: v })}
                error={errors.startsOnDayKey}
                required
                disabled={saving}
              />
              <FormField
                label="Vence (opcional)"
                type="date"
                value={draft.expiresOnDayKey}
                onChange={(v) => set({ expiresOnDayKey: v })}
                error={errors.expiresOnDayKey}
                disabled={saving}
              />
            </div>
            {errors.form && (
              <p role="alert" style={errorText}>
                {errors.form}
              </p>
            )}
          </>
        )}
        <footer style={footer}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          {loaded.state === "ready" && (
            <Button type="button" variant="primary" onClick={() => void submit()} disabled={saving}>
              {saving ? "Guardando…" : loaded.current ? "Renovar" : "Cargar autorización"}
            </Button>
          )}
        </footer>
      </div>
    </PlanDialogShell>
  );
}

/**
 * E2: el DTO del plan trae la clave `authorization` SOLO si el actor la puede
 * ver (`canSeePlanAuthorization`). Clave ausente → forbidden (no "no hay").
 */
export function authStateOf(plan: { authorization?: PlanAuthorizationDTO | null }): CurrentAuth {
  return "authorization" in plan ? { state: "ready", current: plan.authorization ?? null } : { state: "forbidden" };
}

// ─── Instancia nueva por apertura ────────────────────────────────────────────

/**
 * La PlanCard (S22a) monta los diálogos siempre y solo cambia `open`: sin
 * esto, el borrador de una apertura (la cantidad tipeada, el precio, el CAS
 * viejo) sobrevivía a la siguiente, ya con otro `plan.totalLive` /
 * `updatedAt`. La key cambia al CERRAR (no al abrir, como el editor) para que
 * la apertura siguiente arranque limpia sin un frame con el estado viejo.
 */
function useInstanceKey(open: boolean): number {
  const [key, setKey] = useState(0);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (!open && wasOpen.current) setKey((k) => k + 1);
    wasOpen.current = open;
  }, [open]);
  return key;
}

export function PlanCountDialog(props: PlanCountDialogProps): JSX.Element | null {
  const key = useInstanceKey(props.open);
  return <PlanCountDialogBody key={key} {...props} />;
}

export function PlanPriceDialog(props: PlanPriceDialogProps): JSX.Element | null {
  const key = useInstanceKey(props.open);
  return <PlanPriceDialogBody key={key} {...props} />;
}

export function CustomSessionDialog(props: CustomSessionDialogProps): JSX.Element | null {
  const key = useInstanceKey(props.open);
  return <CustomSessionDialogBody key={key} {...props} />;
}

export function RenewAuthorizationDialog(props: RenewAuthorizationDialogProps): JSX.Element | null {
  const key = useInstanceKey(props.open);
  return <RenewAuthorizationDialogBody key={key} {...props} />;
}
