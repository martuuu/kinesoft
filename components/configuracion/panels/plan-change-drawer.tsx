"use client";

/**
 * Configuración → Plan y uso → «Cambiar de plan» (PL-3a, contrato C-PL4, plan §20.5.3 y §20.5.6).
 *
 * Flujo: elegís el plan → `previewPlanChange(to)` (precio, módulos que ganás/perdés, cupos, quiénes sobran) → si
 * sobran usuarios, elegís EXACTAMENTE quiénes pierden el acceso (Martin, 15-oct: lo elige quien cambia el plan; el
 * Titular y uno mismo no se pueden elegir; quedan deshabilitados, nunca borrados, y sus turnos siguen en la agenda) y,
 * si sube, a quiénes reactivar → «Cambiar de plan» corre `applyPlanChange` dentro de `useStepUpAction()` (PL-D11: pide
 * el código de la 2FA; sin 2FA, el modal manda a activarla).
 *
 * - Libre no se elige acá (lo arma Plataforma, `libre_platform_only`): «Consultanos» abre un mensaje de Soporte
 *   prellenado.
 * - La cuenta de «cuántos faltan / cuántos sobran» es `planChangeSelectionState` (lib/saas-billing-view.ts, puro y
 *   testeado). El server recuenta igual (`does_not_fit`) y el CAS contra `tenantUpdatedAt` corta si alguien cambió el
 *   consultorio mientras tanto (`stale`): los dos errores ofrecen «Actualizar» (vuelve a pedir la vista previa).
 * - `PlanChangeReview` es la parte sin estado (se renderiza en el test SSR con una vista previa fija).
 *
 * MPS-4a (C-MPS10, MPS-D10/D11/D12/D18): la vista previa trae `billing` y el drawer dice qué pasa con la plata. Subida
 * con el período ya cobrado: rige hoy y el proporcional entra en el próximo cargo. Bajada con el período cobrado: queda
 * PROGRAMADA para el próximo cobro (nadie pierde el acceso hasta ese día; si para entonces no entra, se anula). Con la
 * baja programada no hay cambio de plan. «No hay prorrateo ni reintegros» dejó de ser cierto y se fue. Cada apertura
 * lleva su `idempotencyKey` (UUID): un reintento después de un error de red da el MISMO proporcional, no dos.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useStepUpAction } from "@/components/account/step-up-modal";
import { applyPlanChange, previewPlanChange } from "@/lib/saas-billing";
import { cancelScheduledPlanChange } from "@/lib/saas-billing-mp";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";
import type { BillingPendingPlan, PlanChangeBilling, PlanChangePreviewWithBilling } from "@/lib/saas-billing-types";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { roleLabel } from "@/lib/roles";
import { formatARS } from "@/lib/format";
import {
  SUBSCRIPTION_COPY,
  canReactivate,
  candidateLoadLabel,
  dayMonthKey,
  firstPeriodNotice,
  moduleLabels,
  newPlanChangeKey,
  planChangeBillingCopy,
  planChangeSelectionState,
  selectableForDisable,
  selectionHint,
  targetUsageLabel,
  type PlanChangeSelectionState,
} from "@/lib/saas-billing-view";
import type { SupportDraft } from "./support-messages-panel";

/** Lo que el drawer muestra de cada plan (sale del catálogo público C-PL2; sin base, de `PLAN_DEFAULTS`). */
export type PlanChoice = {
  plan: SaasPlan;
  label: string;
  priceLabel: string;
  period: "mes" | null;
  limitsLabel: string;
};

const DEFAULT_LIMITS_LABEL: Record<SaasPlan, string> = {
  INDIVIDUAL: "Para vos solo: 1 usuario",
  CONSULTORIO: "Hasta 5 usuarios, profesionales o no",
  CLINICA: "Hasta 10 usuarios, profesionales o no",
  LIBRE: "Usuarios a medida",
};

/** Los cuatro planes en orden, con lo que venga del catálogo y el default para lo que falte. */
export function planChoicesWithDefaults(choices: readonly PlanChoice[]): PlanChoice[] {
  return SAAS_PLANS.map((plan) => {
    const c = choices.find((x) => x.plan === plan);
    if (c) return c;
    return {
      plan,
      label: PLAN_DEFAULTS[plan].label ?? SAAS_PLAN_LABEL[plan],
      priceLabel: plan === "LIBRE" ? "A medida" : "Consultá",
      period: null,
      limitsLabel: DEFAULT_LIMITS_LABEL[plan],
    };
  });
}

const NETWORK_ERROR = "No pudimos conectarnos. Revisá la conexión y probá de nuevo.";

export function libreDraft(currentLabel: string, usersNow: number | null): SupportDraft {
  return {
    subject: "Quiero consultar por el plan Libre",
    body:
      `Hola, quiero consultar por el plan Libre para nuestro consultorio (hoy tenemos el plan ${currentLabel}` +
      (usersNow != null ? ` y somos ${usersNow} ${usersNow === 1 ? "usuario" : "usuarios"}` : "") +
      ").\n\nLo que necesitaríamos: ",
    // TK-U3: entra a /plataforma → Tickets como «Elegir plan» (PLAN_CHANGE), no como soporte genérico.
    source: "PLAN_CHANGE",
  };
}

export function PlanChangeDrawer({
  open,
  onClose,
  currentPlan,
  choices,
  vertical,
  trialing,
  usersNow,
  onContactSales,
  onChanged,
  pendingPlan,
  firstPeriod,
}: {
  open: boolean;
  onClose: () => void;
  currentPlan: SaasPlan;
  choices: readonly PlanChoice[];
  vertical: TenantVertical;
  /** En prueba: el cambio conserva el fin de la prueba (PL-D10). */
  trialing: boolean;
  usersNow: number | null;
  onContactSales: (draft: SupportDraft) => void;
  onChanged: () => void;
  /** MPS-4a: bajada ya programada (`overview.pendingPlan`): el drawer la muestra con «Anular el cambio de plan». */
  pendingPlan?: BillingPendingPlan | null;
  /** MPS-4a: primer período sin cargos (`overview.billableFrom` + `nextCharge.periodStart`) para el proporcional del alta. */
  firstPeriod?: FirstPeriod | null;
}) {
  const runStepUp = useStepUpAction();
  const confirm = useConfirm();
  const toast = useToast();
  const all = useMemo(() => planChoicesWithDefaults(choices), [choices]);
  const [to, setTo] = useState<SaasPlan | null>(null);
  const [preview, setPreview] = useState<PlanChangePreviewWithBilling | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRefresh, setCanRefresh] = useState(false);
  const [disable, setDisable] = useState<ReadonlySet<string>>(new Set());
  const [reactivate, setReactivate] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  // Una clave por apertura del drawer (AGENTS §4): se renueva al cerrar, no en cada reintento.
  const [idempotencyKey, setIdempotencyKey] = useState(() => newPlanChangeKey());
  const [pendingCancelled, setPendingCancelled] = useState(false);

  const reset = useCallback(() => {
    setIdempotencyKey(newPlanChangeKey());
    setPendingCancelled(false);
    setTo(null);
    setPreview(null);
    setError(null);
    setCanRefresh(false);
    setDisable(new Set());
    setReactivate(new Set());
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const load = useCallback(async (plan: SaasPlan) => {
    setLoading(true);
    setError(null);
    setCanRefresh(false);
    setPreview(null);
    setDisable(new Set());
    setReactivate(new Set());
    try {
      const r = await previewPlanChange(plan);
      if (r.ok) setPreview(r.data);
      else setError(r.error);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  function choose(plan: SaasPlan) {
    if (plan === "LIBRE") {
      const label = all.find((c) => c.plan === currentPlan)?.label ?? SAAS_PLAN_LABEL[currentPlan];
      onContactSales(libreDraft(label, usersNow));
      onClose();
      return;
    }
    if (plan === currentPlan) return;
    setTo(plan);
    void load(plan);
  }

  const state = preview ? planChangeSelectionState(preview, disable, reactivate) : null;
  const toLabel = to ? (all.find((c) => c.plan === to)?.label ?? SAAS_PLAN_LABEL[to]) : "";
  const fromLabel = all.find((c) => c.plan === currentPlan)?.label ?? SAAS_PLAN_LABEL[currentPlan];
  const billing = preview?.billing;
  // MPS-D18: con la baja programada el server lo rechaza (`cancel_pending`); no se ofrece confirmar.
  const blocked = billing?.kind === "blocked_cancel_pending";
  const scheduled = billing?.kind === "scheduled_downgrade";
  const canConfirm = !!state?.canConfirm && !blocked;
  const showPendingPlan = !!pendingPlan && !pendingCancelled;

  async function onCancelPendingPlan() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await cancelScheduledPlanChange();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPendingCancelled(true);
      toast.success("Listo: seguís con tu plan.");
      onChanged();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  async function onConfirm() {
    if (!preview || !to || !canConfirm || pending) return;
    if (disable.size > 0) {
      const when = scheduled && billing ? ` el ${dayMonthKey(billing.effectiveOn)}` : "";
      const ok = await confirm({
        title: `¿Pasar al plan ${toLabel}?`,
        message:
          (disable.size === 1 ? `1 persona va a perder el acceso${when}.` : `${disable.size} personas van a perder el acceso${when}.`) +
          " No se borra nada: sus turnos siguen en la agenda para reasignarlos y las podés reactivar si volvés a subir de plan.",
        tone: "danger",
        confirmLabel: "Cambiar de plan",
        cancelLabel: "Revisar",
      });
      if (!ok) return;
    }
    setPending(true);
    setError(null);
    try {
      const r = await runStepUp(() =>
        applyPlanChange({
          to,
          disableMembershipIds: [...disable],
          reactivateMembershipIds: [...reactivate],
          expectedUpdatedAt: preview.tenantUpdatedAt,
          idempotencyKey,
        })
      );
      if (!r.ok) {
        setError(r.error);
        const reason = "reason" in r ? r.reason : undefined;
        setCanRefresh(reason === "stale" || reason === "does_not_fit" || reason === "invalid_selection");
        return;
      }
      const done = "data" in r ? r.data : null;
      if (done?.billing?.kind === "scheduled_downgrade") {
        toast.success(`Listo: tu plan pasa a ${toLabel} el ${dayMonthKey(done.billing.effectiveOn)}`, {
          description: "Hasta ese día nadie pierde el acceso.",
        });
      } else if (done) {
        toast.success(`Listo: ahora tenés el plan ${toLabel}`, { description: planChangeToastDescription(done) });
      }
      onChanged();
      onClose();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  const dirty = disable.size > 0 || reactivate.size > 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Cambiar de plan"
      width={560}
      dirty={dirty}
      dirtyMessage="Elegiste personas para este cambio. Si cerrás, no se cambia el plan."
    >
      <div style={{ display: "grid", gap: 16 }}>
        {showPendingPlan && pendingPlan && (
          <div data-pending-plan={pendingPlan.plan} style={{ display: "grid", gap: 8, padding: "10px 12px", borderRadius: 12, background: "rgba(15,30,51,0.04)", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.45 }}>
            <span>
              Ya programaste el cambio: tu plan pasa a {pendingPlan.planLabel} el {dayMonthKey(pendingPlan.effectiveOn)}.
            </span>
            <div>
              <Button type="button" variant="ghost" onClick={() => void onCancelPendingPlan()} disabled={pending}>
                {SUBSCRIPTION_COPY.cancelPendingPlan}
              </Button>
            </div>
          </div>
        )}

        <PlanPicker choices={all} current={currentPlan} selected={to} onChoose={choose} disabled={pending} />

        {loading && (
          <p role="status" style={{ margin: 0, fontSize: 13.5, color: "var(--navy-500)" }}>
            Calculando qué cambia…
          </p>
        )}

        {preview && state && to && (
          <PlanChangeReview
            preview={preview}
            toLabel={toLabel}
            fromLabel={fromLabel}
            firstPeriod={firstPeriod}
            vertical={vertical}
            trialing={trialing}
            disable={disable}
            reactivate={reactivate}
            state={state}
            disabled={pending}
            onToggleDisable={(id) => setDisable((s) => toggle(s, id))}
            onToggleReactivate={(id) => setReactivate((s) => toggle(s, id))}
          />
        )}

        {error && (
          <div role="alert" style={{ display: "grid", gap: 8, padding: "10px 12px", borderRadius: 10, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 13 }}>
            <span>{error}</span>
            {canRefresh && to && (
              <div>
                <Button type="button" variant="ghost" onClick={() => void load(to)} disabled={loading}>
                  Actualizar
                </Button>
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void onConfirm()} disabled={!canConfirm || pending || loading}>
            {pending ? "Cambiando…" : to ? (scheduled ? `Programar el cambio a ${toLabel}` : `Pasar a ${toLabel}`) : "Elegí un plan"}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

function toggle(s: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const n = new Set(s);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

export function PlanPicker({
  choices,
  current,
  selected,
  onChoose,
  disabled,
}: {
  choices: readonly PlanChoice[];
  current: SaasPlan;
  selected: SaasPlan | null;
  onChoose: (p: SaasPlan) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Planes" style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
      {choices.map((c) => {
        const isCurrent = c.plan === current;
        const on = c.plan === selected;
        const libre = c.plan === "LIBRE";
        return (
          <button
            key={c.plan}
            type="button"
            role="radio"
            aria-checked={on}
            data-plan={c.plan}
            disabled={disabled || isCurrent}
            onClick={() => onChoose(c.plan)}
            style={{
              textAlign: "left",
              display: "grid",
              gap: 4,
              padding: "12px 14px",
              borderRadius: 14,
              border: on ? "2px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.1)",
              background: isCurrent ? "rgba(15,30,51,0.04)" : "var(--card-bg)",
              cursor: disabled || isCurrent ? "default" : "pointer",
              font: "inherit",
              color: "var(--navy-900)",
              minWidth: 0,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{c.label}</span>
              {isCurrent && <Tag tone="soft">Tu plan</Tag>}
            </span>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {c.priceLabel}
              {c.period && <span style={{ fontWeight: 400, color: "var(--navy-500)" }}> por {c.period}</span>}
            </span>
            <span style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.4 }}>{c.limitsLabel}</span>
            {libre && !isCurrent && <span style={{ fontSize: 12.5, color: "var(--sky-700)", fontWeight: 600 }}>Consultanos →</span>}
          </button>
        );
      })}
    </div>
  );
}

const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 700, color: "var(--navy-900)" };
const muted: React.CSSProperties = { margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 };

/** Primer período sin cargos: desde cuándo se factura y el día del primer cobro (claves AR). */
export type FirstPeriod = { billableFrom: string; nextChargeOn: string };

/** Vista previa + selección (sin estado propio). */
export function PlanChangeReview({
  preview,
  toLabel,
  fromLabel,
  firstPeriod,
  vertical,
  trialing,
  disable,
  reactivate,
  state,
  disabled,
  onToggleDisable,
  onToggleReactivate,
}: {
  /** `billing` (MPS-3a) viene de `previewPlanChange`; opcional para el preview de antes (y Plataforma). */
  preview: PlanChangePreview & { billing?: PlanChangeBilling };
  toLabel: string;
  /** Plan actual (para «Hasta ese día seguís con …» de la bajada). */
  fromLabel?: string;
  firstPeriod?: FirstPeriod | null;
  vertical: TenantVertical;
  trialing: boolean;
  disable: ReadonlySet<string>;
  reactivate: ReadonlySet<string>;
  state: PlanChangeSelectionState;
  disabled?: boolean;
  onToggleDisable: (membershipId: string) => void;
  onToggleReactivate: (membershipId: string) => void;
}) {
  const gained = moduleLabels(preview.modulesGained);
  const lost = moduleLabels(preview.modulesLost);
  const pendingInvites = preview.usage.total.used - preview.candidates.length;
  const hint = selectionHint(state);
  const mustChoose = state.required > 0 || disable.size > 0;
  // El proporcional del alta solo cuando el cambio rige ya (sin cargos todavía no hay subida ni bajada «de período»).
  const firstNotice =
    firstPeriod && (!preview.billing || preview.billing.kind === "immediate")
      ? firstPeriodNotice({ billableFrom: firstPeriod.billableFrom, nextChargeOn: firstPeriod.nextChargeOn, priceCents: preview.priceCents, hasCharges: false })
      : null;
  return (
    <div style={{ display: "grid", gap: 14 }} data-plan-review={preview.to}>
      <section style={{ display: "grid", gap: 4 }}>
        <h3 style={sectionTitle}>Precio</h3>
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }}>
          {preview.priceCents != null ? (
            <>
              <strong>{formatARS(preview.priceCents)}</strong> por mes
            </>
          ) : (
            "Precio a confirmar: te lo contamos antes del primer cargo."
          )}
        </p>
        <p style={muted} data-plan-billing={preview.billing?.kind ?? ""}>
          {(preview.billing && planChangeBillingCopy(preview.billing, { toLabel, fromLabel: fromLabel ?? "tu plan actual", trialing })) ??
            (trialing
              ? "Seguís en la prueba hasta la misma fecha. El primer cargo sale con el plan que tengas al terminarla."
              : preview.billing
                ? "El plan nuevo rige desde hoy y el próximo cargo sale con este precio."
                : "El plan nuevo rige desde el próximo cargo.")}
        </p>
        {firstNotice && <p style={muted}>{firstNotice}</p>}
      </section>

      {(gained.length > 0 || lost.length > 0) && (
        <section style={{ display: "grid", gap: 6 }}>
          <h3 style={sectionTitle}>Funciones</h3>
          {gained.length > 0 && (
            <div data-modules-gained style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>Ganás:</span>
              {gained.map((g) => (
                <Tag key={g} tone="lime">
                  {g}
                </Tag>
              ))}
            </div>
          )}
          {lost.length > 0 && (
            <div data-modules-lost style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>Perdés:</span>
              {lost.map((g) => (
                <Tag key={g} tone="soft">
                  {g}
                </Tag>
              ))}
            </div>
          )}
          {preview.modulesLost.includes("salas") && (
            <p style={muted}>Las salas quedan guardadas: si volvés a un plan con salas (Clínica o Libre), reaparecen como estaban.</p>
          )}
        </section>
      )}

      <section style={{ display: "grid", gap: 6 }}>
        <h3 style={sectionTitle}>Usuarios</h3>
        <p style={muted}>{targetUsageLabel(toLabel, preview.usage, Math.max(0, pendingInvites))}</p>
        {mustChoose && (
          <p data-must-disable={state.required} style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)", lineHeight: 1.45 }}>
            {state.required === 1
              ? "Sobra 1 persona: elegí quién pierde el acceso."
              : `Sobran ${state.required} personas: elegí exactamente quiénes pierden el acceso.`}{" "}
            Quedan deshabilitadas, no se borran: sus turnos siguen en la agenda.
          </p>
        )}
      </section>

      {mustChoose && (
        <ul aria-label="Quiénes pierden el acceso" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {preview.candidates.map((c) => {
            const selectable = selectableForDisable(c);
            const checked = disable.has(c.membershipId);
            // CT-INT (fix M): el co-titular llega con `isOwner` cuando quien mira no es el principal.
            const why = c.isOwner
              ? c.coOwner
                ? "Co-titular: solo el titular principal le puede quitar el acceso"
                : "Titular: no puede perder el acceso"
              : c.isSelf
                ? "Sos vos: no te podés quitar el acceso"
                : null;
            return (
              <li key={c.membershipId}>
                <label
                  data-candidate={c.membershipId}
                  data-selectable={selectable ? "true" : "false"}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(15,30,51,0.08)",
                    background: checked ? "var(--danger-bg)" : "var(--card-bg)",
                    opacity: selectable ? 1 : 0.7,
                    cursor: selectable && !disabled ? "pointer" : "default",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!selectable || disabled}
                    onChange={() => onToggleDisable(c.membershipId)}
                    aria-label={`Quitarle el acceso a ${c.name}`}
                    style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
                  />
                  <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{c.name}</span>
                    <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                      {roleLabel(c.role, vertical, { clinical: c.clinical })}
                      {why ? ` · ${why}` : ` · ${candidateLoadLabel(c)}`}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {preview.reactivatable.length > 0 && (
        <section style={{ display: "grid", gap: 6 }}>
          <h3 style={sectionTitle}>Reactivar</h3>
          <p style={muted}>Estas personas perdieron el acceso en una baja de plan anterior. Elegí a quiénes volver a habilitar.</p>
          <ul aria-label="A quiénes reactivar" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {preview.reactivatable.map((r) => {
              const can = canReactivate(preview, disable, reactivate, r.membershipId);
              return (
                <li key={r.membershipId}>
                  <label
                    data-reactivatable={r.membershipId}
                    style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 12, border: "1px solid rgba(15,30,51,0.08)", opacity: can ? 1 : 0.6 }}
                  >
                    <input
                      type="checkbox"
                      checked={reactivate.has(r.membershipId)}
                      disabled={!can || disabled}
                      onChange={() => onToggleReactivate(r.membershipId)}
                      aria-label={`Reactivar a ${r.name}`}
                      style={{ marginTop: 3, width: 18, height: 18, flexShrink: 0 }}
                    />
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{r.name}</span>
                      <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                        {roleLabel(r.role, vertical, { clinical: r.clinical })}
                        {!can && " · no entra en este plan"}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {preview.invitesToRevoke.length > 0 && (
        <section style={{ display: "grid", gap: 6 }}>
          <h3 style={sectionTitle}>Invitaciones que se anulan</h3>
          <p style={muted}>No entran en el plan: se anulan al confirmar (las podés volver a mandar si se libera lugar).</p>
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13, color: "var(--navy-700)" }}>
            {preview.invitesToRevoke.map((i) => (
              <li key={i.invitationId} style={{ overflowWrap: "anywhere" }}>
                Invitación pendiente de {roleLabel(i.role, vertical)} ({i.email})
              </li>
            ))}
          </ul>
        </section>
      )}

      {hint && (
        <p role="status" data-selection-hint style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--sky-800)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Descripción del toast al aplicar el cambio de plan. PL-Z B1: antes las invitaciones anuladas solo aparecían si
 * además había personas sin acceso o reactivadas; con solo invitaciones anuladas el toast decía «El precio nuevo
 * rige…» y la anulación pasaba desapercibida. Exportada para el test.
 */
export function planChangeToastDescription(d: { disabled: number; reactivated: number; revokedInvites: number }): string {
  const parts = [
    d.disabled > 0 ? `${d.disabled} sin acceso` : null,
    d.reactivated > 0 ? `${d.reactivated} ${d.reactivated === 1 ? "reactivado" : "reactivados"}` : null,
    d.revokedInvites > 0 ? `${d.revokedInvites} ${d.revokedInvites === 1 ? "invitación anulada" : "invitaciones anuladas"}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length > 0 ? parts.join(" · ") : "El precio nuevo rige desde el próximo cargo.";
}
