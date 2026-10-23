"use client";

/**
 * Tarjeta «Suscripción y cobro» del ledger de un consultorio en /plataforma (MPS-4b, §26.6 UI de Plataforma, C-MPS11):
 * cómo paga, el estado del débito automático (con el email del pagador ENMASCARADO: el completo nunca sale del
 * server), la autorización pendiente, la bajada de plan y la baja programadas, y las acciones de Plataforma:
 * «Consultar en Mercado Pago» (`getMpSubscriptionStatus`, un GET en vivo del preapproval), «Permitir/Bloquear débito»,
 * «Re-anclar al 4» (preview + confirmación), «Deshacer baja» y «Anular bajada».
 *
 * Lo que se muestra depende de `SAAS_BILLING_MODE` (`mpsUiFor`): con `off` la tarjeta no se monta (la decide el
 * ledger); con `manual` no hay nada de Mercado Pago (el puerto está apagado).
 *
 * El link de autorización del débito (`initPoint`) NO se muestra: lo abre el titular desde su Configuración, con su
 * cuenta de Mercado Pago; que Plataforma lo abra no sirve y confunde.
 *
 * Todas las escrituras van por `usePlatformAction` (re-verificación/step-up y rate limit) y revalidan el detalle: no
 * hay refresh después de un ok (PF-0d). La consulta en vivo es solo lectura y no revalida nada.
 */
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatARS, formatDateAR } from "@/lib/format";
import {
  applyReanchor,
  cancelScheduledPlanFor,
  getMpSubscriptionStatus,
  previewReanchor,
  setAutoDebitAllowed,
  undoCancelFor,
} from "@/lib/platform-billing";
import type { PlatformReanchorPreview, PlatformTenantLedger } from "@/lib/platform-billing-types";
import type { BillingAutoDebitState, PlatformMpSubscriptionStatus } from "@/lib/saas-billing-types";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox, Facts, Section, WarnBox, muted } from "@/components/plataforma/tenants/detail-ui";
import { ReanchorDialog } from "@/components/plataforma/billing/ledger-dialogs";
import {
  AUTO_DEBIT_STATUS_LABEL,
  collectionMethodText,
  dayMonthAR,
  instantDayMonthAR,
  mpDriftText,
  mpPreapprovalStatusText,
  type MpsUi,
} from "@/components/plataforma/billing/billing-logic";

const blockStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  gap: "8px 14px",
  padding: "12px 0 0",
  marginTop: 12,
  borderTop: "1px solid rgba(15,30,51,0.06)",
  fontSize: 13,
  color: "var(--navy-700)",
  lineHeight: 1.45,
};

/** «Débito activo · m***@gmail.com · próximo 4/12 por $ 50.000» (copy de §26.6). */
function autoDebitText(d: BillingAutoDebitState): string {
  const parts: string[] = [AUTO_DEBIT_STATUS_LABEL[d.status]];
  if (d.payerEmailMasked && d.status !== "none") parts.push(d.payerEmailMasked);
  if (d.status === "active" && d.nextDebitOn) {
    parts.push(`próximo ${dayMonthAR(d.nextDebitOn)}${d.amountCents != null ? ` por ${formatARS(d.amountCents)}` : ""}`);
  } else if (d.amountCents != null && (d.status === "pending_authorization" || d.status === "paused")) {
    parts.push(`por ${formatARS(d.amountCents)}`);
  }
  return parts.join(" · ");
}

function autoDebitTone(d: BillingAutoDebitState): "lime" | "sky" | "soft" {
  if (d.status === "active") return "lime";
  if (d.status === "pending_authorization") return "sky";
  return "soft";
}

// ── Vistas sin estado (render test) ─────────────────────────────────────────────────────────────────────────────

/** Resultado de «Consultar en Mercado Pago»: lo que dice MP ahora vs. lo guardado, y el desvío explicado. */
export function MpLiveStatusPanel({ status }: { status: PlatformMpSubscriptionStatus }) {
  const drift = mpDriftText(status);
  const unread = status.liveStatus === null;
  return (
    <div data-mp-live style={{ ...blockStyle, display: "grid", gap: 10 }}>
      {unread ? (
        <p style={{ margin: 0 }}>
          {status.preapprovalId
            ? "No pudimos leer el estado en Mercado Pago. Se muestra lo guardado; probá de nuevo en un rato."
            : "No hay un débito autorizado en Mercado Pago para este consultorio."}
        </p>
      ) : drift ? (
        <WarnBox>{drift}</WarnBox>
      ) : (
        <p style={{ margin: 0, color: "var(--navy-500)" }}>Coincide con lo guardado.</p>
      )}
      <Facts
        items={[
          ["En Mercado Pago", unread ? muted("Sin dato") : mpPreapprovalStatusText(status.liveStatus)],
          ["Guardado", mpPreapprovalStatusText(status.storedStatus)],
          [
            "Monto",
            status.liveAmountCents != null
              ? formatARS(status.liveAmountCents)
              : status.amountCents != null
                ? `${formatARS(status.amountCents)} (guardado)`
                : muted("—"),
          ],
          ["Próximo débito", status.nextDebitAt ? instantDayMonthAR(status.nextDebitAt) : muted("—")],
          ["Última sincronización", status.syncedAt ? formatDateAR(status.syncedAt, "longDateTime") : muted("Nunca")],
          ["Pagador", status.payerEmailMasked ?? muted("—")],
        ]}
      />
      {status.pendingPreapprovalId && (
        <p style={{ margin: 0 }}>
          Hay una autorización pendiente
          {status.pendingCreatedAt ? ` desde el ${instantDayMonthAR(status.pendingCreatedAt)}` : ""}: el titular todavía no
          la confirmó en Mercado Pago. A los 7 días se cancela sola.
        </p>
      )}
      {status.preapprovalId && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--navy-300)", overflowWrap: "anywhere" }}>
          Id del débito en Mercado Pago: {status.preapprovalId}
          {status.retiredPreapprovalId ? ` · anterior: ${status.retiredPreapprovalId}` : ""}
        </p>
      )}
    </div>
  );
}

export function SubscriptionMpCardView({
  ledger,
  ui,
  live,
  liveError,
  pending,
  onConsult,
  onToggleAllowed,
  onReanchor,
  onUndoCancel,
  onCancelPendingPlan,
}: {
  ledger: PlatformTenantLedger;
  ui: MpsUi;
  live: PlatformMpSubscriptionStatus | null;
  liveError: string | null;
  pending: boolean;
  onConsult: () => void;
  onToggleAllowed: (allowed: boolean) => void;
  onReanchor: () => void;
  onUndoCancel: () => void;
  onCancelPendingPlan: () => void;
}) {
  const d = ledger.autoDebit ?? null;
  const cancelled = ledger.subscriptionStatus === "CANCELLED";
  const items: [string, ReactNode][] = [["Cómo paga", collectionMethodText(ledger.collectionMethod)]];
  if (ui.mercadoPago && d) {
    items.push([
      "Débito automático",
      <span key="d" data-auto-debit={d.status} style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <Tag tone={autoDebitTone(d)}>{d.status === "active" ? "Activo" : d.allowed ? "Permitido" : "Bloqueado"}</Tag>
        <span>{autoDebitText(d)}</span>
      </span>,
    ]);
    if (d.syncedAt) items.push(["Última sincronización", formatDateAR(d.syncedAt, "longDateTime")]);
  }
  if (ledger.billableFrom) items.push(["Factura desde", dayMonthAR(ledger.billableFrom)]);

  return (
    <Section
      title="Suscripción y cobro"
      description="Cómo paga el consultorio y lo que está programado. El titular elige el medio desde su Configuración."
      action={
        ui.mercadoPago ? (
          <Button type="button" variant="ghost" onClick={onConsult} disabled={pending}>
            {pending ? "Consultando…" : "Consultar en Mercado Pago"}
          </Button>
        ) : undefined
      }
    >
      <Facts items={items} />

      {ui.mercadoPago && d && (
        <div style={blockStyle}>
          <span>
            {d.allowed
              ? "Plataforma permite el débito automático para este consultorio."
              : "Plataforma bloqueó el débito automático: el consultorio tiene que pagar por Mercado Pago cada mes o por transferencia."}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <Button type="button" variant="ghost" onClick={() => onToggleAllowed(!d.allowed)} disabled={pending}>
              {d.allowed ? "Bloquear débito" : "Permitir débito"}
            </Button>
          </span>
        </div>
      )}

      {ledger.anchorDay != null && ledger.anchorDay !== 4 && (
        <div data-reanchor style={blockStyle}>
          <span>
            Cobra el día {ledger.anchorDay}.{ledger.billableFrom ? ` Factura desde el ${dayMonthAR(ledger.billableFrom)}.` : ""} Todos los
            consultorios pasan a cobrar el 4.
          </span>
          <span style={{ marginLeft: "auto" }}>
            <Button type="button" variant="ghost" onClick={onReanchor} disabled={pending}>
              Re-anclar al 4
            </Button>
          </span>
        </div>
      )}

      {ledger.pendingPlan && (
        <div data-pending-plan style={blockStyle}>
          <span>
            <strong style={{ color: "var(--navy-900)" }}>Bajada programada.</strong> Pasa a {ledger.pendingPlan.planLabel} el{" "}
            {dayMonthAR(ledger.pendingPlan.effectiveOn)}
            {ledger.pendingPlan.disableCount > 0
              ? ` · se deshabilitan ${ledger.pendingPlan.disableCount === 1 ? "1 usuario" : `${ledger.pendingPlan.disableCount} usuarios`}`
              : ""}
            .
          </span>
          <span style={{ marginLeft: "auto" }}>
            <Button type="button" variant="ghost" onClick={onCancelPendingPlan} disabled={pending}>
              Anular bajada
            </Button>
          </span>
        </div>
      )}

      {ledger.cancel &&
        (cancelled ? (
          <div data-cancel="applied" style={blockStyle}>
            <span>Dada de baja desde el {dayMonthAR(ledger.cancel.effectiveOn)}.</span>
          </div>
        ) : (
          <div data-cancel="scheduled" style={blockStyle}>
            <span>
              <strong style={{ color: "var(--navy-900)" }}>Baja programada.</strong> El consultorio tiene acceso completo hasta el{" "}
              {dayMonthAR(ledger.cancel.effectiveOn)}
              {ledger.cancel.requestedAt ? ` (la pidió el ${instantDayMonthAR(ledger.cancel.requestedAt)})` : ""}.
            </span>
            <span style={{ marginLeft: "auto" }}>
              <Button type="button" variant="ghost" onClick={onUndoCancel} disabled={pending}>
                Deshacer baja
              </Button>
            </span>
          </div>
        ))}

      {liveError && (
        <div style={{ marginTop: 12 }}>
          <ErrorBox>{liveError}</ErrorBox>
        </div>
      )}
      {ui.mercadoPago && live && <MpLiveStatusPanel status={live} />}
    </Section>
  );
}

// ── Contenedor ──────────────────────────────────────────────────────────────────────────────────────────────────

type Result = { ok: true } | { ok: false; error: string };

export function SubscriptionMpCard({ ledger, ui }: { ledger: PlatformTenantLedger; ui: MpsUi }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<PlatformMpSubscriptionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reanchor, setReanchor] = useState<PlatformReanchorPreview | null>(null);
  const [reanchorError, setReanchorError] = useState<string | null>(null);
  const tenantId = ledger.tenantId;

  /** Corre una escritura; ante un error muestra el copy del server y refresca (suele ser «ya no estaba programada»). */
  const write = async (fn: () => Promise<Result>, okMessage: string, onError: (e: string) => void = setError) => {
    setBusy(true);
    try {
      const res = await runPlatform(fn);
      if (!res.ok) {
        onError(res.error);
        // refresh-ok: la action falló y no revalida; el error suele ser «ya no está programada» y hay que ver lo vigente.
        router.refresh();
        return false;
      }
      setError(null);
      // Lo consultado en vivo ya no vale después de un cambio: se vuelve a pedir a mano.
      setLive(null);
      toast.success(okMessage);
      return true;
    } catch {
      onError("No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onConsult = async () => {
    setBusy(true);
    try {
      const res = await runPlatform(() => getMpSubscriptionStatus({ tenantId }));
      if (!res.ok) {
        setLive(null);
        setError(res.error);
        return;
      }
      setError(null);
      setLive(res.data);
    } catch {
      setError("No pudimos consultar Mercado Pago. Revisá la conexión y probá de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const onToggleAllowed = async (allowed: boolean) => {
    const yes = await confirm(
      allowed
        ? {
            title: "¿Permitir el débito automático?",
            message: "El titular va a poder elegir el débito automático desde su Configuración. No se reactiva solo: lo tiene que autorizar de nuevo en Mercado Pago.",
            confirmLabel: "Permitir débito",
            cancelLabel: "Volver",
          }
        : {
            title: "¿Bloquear el débito automático?",
            message: "Se cancela en Mercado Pago el débito vigente y cualquier autorización pendiente. El consultorio sigue pudiendo pagar cada cargo por Mercado Pago o por transferencia.",
            confirmLabel: "Bloquear débito",
            cancelLabel: "Volver",
            tone: "danger",
          }
    );
    if (!yes) return;
    await write(async () => {
      const r = await setAutoDebitAllowed({ tenantId, allowed });
      return r.ok ? { ok: true } : r;
    }, allowed ? "Débito automático permitido" : "Débito automático bloqueado");
  };

  const onReanchor = async () => {
    setBusy(true);
    setReanchorError(null);
    try {
      const res = await runPlatform(() => previewReanchor({ tenantId }));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setError(null);
      setReanchor(res.data);
    } catch {
      setError("No pudimos calcular el re-anclaje. Revisá la conexión y probá de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const onApplyReanchor = async () => {
    const ok = await write(
      async () => {
        const r = await applyReanchor({ tenantId });
        return r.ok ? { ok: true } : r;
      },
      "Consultorio re-anclado al 4",
      setReanchorError
    );
    if (ok) setReanchor(null);
  };

  const onUndoCancel = async () => {
    if (!ledger.cancel) return;
    const yes = await confirm({
      title: "¿Deshacer la baja?",
      message: `La suscripción sigue después del ${dayMonthAR(ledger.cancel.effectiveOn)} y el débito automático (si lo tiene) se reanuda.`,
      confirmLabel: "Deshacer baja",
      cancelLabel: "Volver",
    });
    if (!yes) return;
    await write(async () => {
      const r = await undoCancelFor({ tenantId });
      return r.ok ? { ok: true } : r;
    }, "Baja deshecha");
  };

  const onCancelPendingPlan = async () => {
    const p = ledger.pendingPlan;
    if (!p) return;
    const yes = await confirm({
      title: "¿Anular la bajada de plan?",
      message: `El consultorio sigue en ${ledger.planLabel} y no pasa a ${p.planLabel} el ${dayMonthAR(p.effectiveOn)}. Nadie pierde el acceso.`,
      confirmLabel: "Anular bajada",
      cancelLabel: "Volver",
    });
    if (!yes) return;
    await write(async () => {
      const r = await cancelScheduledPlanFor({ tenantId });
      return r.ok ? { ok: true } : r;
    }, "Bajada de plan anulada");
  };

  return (
    <>
      <SubscriptionMpCardView
        ledger={ledger}
        ui={ui}
        live={live}
        liveError={error}
        pending={busy}
        onConsult={() => void onConsult()}
        onToggleAllowed={(a) => void onToggleAllowed(a)}
        onReanchor={() => void onReanchor()}
        onUndoCancel={() => void onUndoCancel()}
        onCancelPendingPlan={() => void onCancelPendingPlan()}
      />
      {reanchor && (
        <ReanchorDialog
          preview={reanchor}
          pending={busy}
          error={reanchorError}
          onCancel={() => setReanchor(null)}
          onConfirm={() => void onApplyReanchor()}
        />
      )}
    </>
  );
}
