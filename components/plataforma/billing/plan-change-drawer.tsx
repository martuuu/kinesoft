"use client";

/**
 * «Cambiar de plan» desde Plataforma (PL-3c, C-PL4; mismo núcleo que Configuración → Facturación, con Libre
 * permitido). Flujo: elegir el plan → `platformPreviewPlanChange` dice qué se pierde/gana, cuántas personas sobran,
 * qué invitaciones se anulan y a quiénes se puede reactivar → el superadmin elige a quiénes deshabilitar (nunca el
 * Titular ni a sí mismo; deshabilitar no borra nada) → `platformApplyPlanChange` con el `tenantUpdatedAt` del preview
 * como CAS. Si otro cambio entró en el medio (stale) se vuelve a pedir el preview y se avisa.
 *
 * La cuenta de «¿entra?» es la del núcleo (`mustDisableFor` sobre lo que queda), así el botón se habilita solo con una
 * selección que el server va a aceptar. Los cupos de Libre (vacío = sin límite) se fijan después en «Editar
 * suscripción» (`tenant-edit-drawer.tsx`).
 */
import { useState } from "react";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatARS } from "@/lib/format";
import { roleLabel } from "@/lib/roles";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { platformApplyPlanChange, platformPreviewPlanChange } from "@/lib/platform-billing";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox, WarnBox } from "@/components/plataforma/tenants/detail-ui";
// PL-Z (B10): los mismos nombres de módulo que ve el consultorio en «Plan y uso» (`MODULE_UI_LABEL`), así el
// superadmin y el Titular hablan de lo mismo; los que no son pantallas reales no se listan.
import { moduleLabels } from "@/lib/saas-billing-view";
import {
  isSelectable,
  limitText,
  selectionFits,
  selectionShortfall,
  shortfallText,
} from "@/components/plataforma/billing/billing-logic";

function loadsText(c: PlanChangePreview["candidates"][number]): string {
  const parts: string[] = [];
  if (c.futureBookings) parts.push(c.futureBookings === 1 ? "1 turno futuro" : `${c.futureBookings} turnos futuros`);
  if (c.assignedPatients) parts.push(c.assignedPatients === 1 ? "1 paciente asignado" : `${c.assignedPatients} pacientes asignados`);
  if (c.activePlans) parts.push(c.activePlans === 1 ? "1 plan activo" : `${c.activePlans} planes activos`);
  return parts.length ? parts.join(" · ") : "Sin turnos ni pacientes asignados";
}

const box = {
  padding: 12,
  borderRadius: "var(--r-sm)",
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.7)",
  display: "grid",
  gap: 8,
} as const;

const h3 = { margin: 0, fontSize: 13, fontWeight: 700, color: "var(--navy-900)" } as const;

/** Cuerpo controlado y sin efectos (render test con props). */
export function PlanChangeForm({
  current,
  vertical,
  to,
  preview,
  loading,
  disable,
  reactivate,
  error,
  pending,
  onPick,
  onToggleDisable,
  onToggleReactivate,
  onApply,
  onCancel,
}: {
  current: SaasPlan;
  vertical: TenantVertical;
  to: SaasPlan | null;
  preview: PlanChangePreview | null;
  loading: boolean;
  disable: ReadonlySet<string>;
  reactivate: ReadonlySet<string>;
  error: string | null;
  pending: boolean;
  onPick: (p: SaasPlan) => void;
  onToggleDisable: (membershipId: string) => void;
  onToggleReactivate: (membershipId: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const ready = !!preview && !loading && preview.to === to;
  const fits = ready && selectionFits(preview!, disable, reactivate);
  const missing = ready ? shortfallText(selectionShortfall(preview!, disable, reactivate)) : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (fits && !pending) onApply();
      }}
      style={{ display: "grid", gap: 16 }}
    >
      <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        <legend style={{ padding: 0, marginBottom: 6, fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>Plan nuevo</legend>
        {SAAS_PLANS.map((p) => (
          <label
            key={p}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${to === p ? "rgba(31,79,190,0.35)" : "rgba(15,30,51,0.1)"}`,
              background: to === p ? "rgba(31,79,190,0.06)" : "transparent",
              fontSize: 13.5,
              fontWeight: 600,
              color: p === current ? "var(--navy-300)" : "var(--navy-900)",
              cursor: p === current || pending ? "not-allowed" : "pointer",
            }}
          >
            <input
              type="radio"
              name="plan"
              value={p}
              checked={to === p}
              disabled={p === current || pending}
              onChange={() => onPick(p)}
              style={{ accentColor: "var(--sky-700)" }}
            />
            {SAAS_PLAN_LABEL[p]}
            {p === current && <span style={{ fontWeight: 500, fontSize: 12 }}>(plan actual)</span>}
          </label>
        ))}
      </fieldset>

      {loading && <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Calculando qué cambia…</p>}

      {ready && preview && (
        <>
          <div style={box}>
            <h3 style={h3}>
              {SAAS_PLAN_LABEL[preview.from]} → {SAAS_PLAN_LABEL[preview.to]}
            </h3>
            <div style={{ fontSize: 12.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
              Precio de lista: {preview.priceCents == null ? "Consultá" : `${formatARS(preview.priceCents)}/mes`} (si el consultorio
              tiene precio a medida, sigue ese). Usuarios: {limitText(preview.limits.maxUsers)} en total · profesionales:{" "}
              {limitText(preview.limits.maxProfessionals)} · no clínicos: {limitText(preview.limits.maxStaff)}.
            </div>
            {moduleLabels(preview.modulesLost).length > 0 && (
              <div style={{ fontSize: 12.5, color: "var(--danger-fg)" }}>Pierde: {moduleLabels(preview.modulesLost).join(", ")}. No se borra nada.</div>
            )}
            {moduleLabels(preview.modulesGained).length > 0 && (
              <div style={{ fontSize: 12.5, color: "var(--lime-700)" }}>Suma: {moduleLabels(preview.modulesGained).join(", ")}.</div>
            )}
            {preview.to === "LIBRE" && (
              <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                Los cupos de Libre se fijan después en «Editar suscripción» (vacío = sin límite).
              </div>
            )}
          </div>

          {(preview.mustDisable.total > 0 || disable.size > 0) && (
            <div style={box} role="group" aria-label="Quiénes pierden el acceso">
              <h3 style={h3}>Quiénes pierden el acceso</h3>
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
                Quedan deshabilitados, no se borran: si después vuelven a entrar en el plan, se reactivan.
              </p>
              {preview.candidates.map((c) => {
                const selectable = isSelectable(c);
                return (
                  <label
                    key={c.membershipId}
                    data-candidate={c.membershipId}
                    style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, cursor: selectable && !pending ? "pointer" : "not-allowed" }}
                  >
                    <input
                      type="checkbox"
                      checked={disable.has(c.membershipId)}
                      disabled={!selectable || pending}
                      onChange={() => onToggleDisable(c.membershipId)}
                      style={{ marginTop: 2, width: 16, height: 16, accentColor: "var(--sky-700)" }}
                    />
                    <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: "var(--navy-900)", overflowWrap: "anywhere" }}>
                        {c.name} · {roleLabel(c.role, vertical, { clinical: c.clinical })}
                        {c.isSelf && (
                          <>
                            {" "}
                            <Tag tone="soft">Vos</Tag>
                          </>
                        )}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--navy-500)" }}>
                        {c.isOwner ? "El titular no puede perder el acceso." : c.isSelf ? "No podés quitarte el acceso a vos." : loadsText(c)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {preview.reactivatable.length > 0 && (
            <div style={box} role="group" aria-label="Reactivar">
              <h3 style={h3}>Deshabilitados por una baja de plan anterior</h3>
              {preview.reactivatable.map((r) => (
                <label key={r.membershipId} data-reactivatable={r.membershipId} style={{ display: "flex", gap: 10, fontSize: 13, cursor: pending ? "not-allowed" : "pointer" }}>
                  <input
                    type="checkbox"
                    checked={reactivate.has(r.membershipId)}
                    disabled={pending}
                    onChange={() => onToggleReactivate(r.membershipId)}
                    style={{ width: 16, height: 16, accentColor: "var(--sky-700)" }}
                  />
                  <span>
                    Reactivar a {r.name} · {roleLabel(r.role, vertical, { clinical: r.clinical })}
                  </span>
                </label>
              ))}
            </div>
          )}

          {preview.invitesToRevoke.length > 0 && (
            <WarnBox>
              {preview.invitesToRevoke.length === 1
                ? "Se anula 1 invitación pendiente que no entra en el plan:"
                : `Se anulan ${preview.invitesToRevoke.length} invitaciones pendientes que no entran en el plan:`} {preview.invitesToRevoke.map((i) => `${i.email} (${roleLabel(i.role, vertical)})`).join(", ")}.
            </WarnBox>
          )}

          {missing && <WarnBox>{missing}</WarnBox>}
        </>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!fits || pending}>
          {pending ? "Cambiando…" : "Cambiar de plan"}
        </Button>
      </div>
    </form>
  );
}

export type PlatformPlanChangeProps = {
  tenantId: string;
  tenantName: string;
  current: SaasPlan;
  vertical: TenantVertical;
};

/**
 * PF1.2 (C-PF2): el Drawer sin su disparador. Lo baja con `next/dynamic` `PlatformPlanChangeDrawer`
 * (`plan-change-launcher.tsx`), que pinta el botón y monta esto recién al primer click; cada apertura lo remonta con
 * una `key` nueva, así arranca sin plan elegido ni preview (lo que antes hacía `openDrawer`).
 */
export function PlatformPlanChangePanel({
  tenantId,
  tenantName,
  current,
  vertical,
  open,
  onClose,
}: PlatformPlanChangeProps & { open: boolean; onClose: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [to, setTo] = useState<SaasPlan | null>(null);
  const [preview, setPreview] = useState<PlanChangePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [disable, setDisable] = useState<Set<string>>(new Set());
  const [reactivate, setReactivate] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const loadPreview = async (plan: SaasPlan, keepError = false) => {
    setLoading(true);
    if (!keepError) setError(null);
    setDisable(new Set());
    setReactivate(new Set());
    try {
      const res = await runPlatform(() => platformPreviewPlanChange(tenantId, plan));
      if (!res.ok) {
        setPreview(null);
        setError(res.error);
        return;
      }
      setPreview(res.data);
    } catch {
      setPreview(null);
      setError("No pudimos calcular el cambio. Revisá la conexión y probá de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  const onPick = (p: SaasPlan) => {
    setTo(p);
    void loadPreview(p);
  };

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const onApply = async () => {
    if (!preview || !to) return;
    const parts = [
      disable.size ? `Se deshabilita${disable.size === 1 ? " 1 persona" : `n ${disable.size} personas`} (no se borra nada).` : "",
      reactivate.size ? `Se reactiva${reactivate.size === 1 ? " 1 persona" : `n ${reactivate.size} personas`}.` : "",
      preview.invitesToRevoke.length ? `Se anula${preview.invitesToRevoke.length === 1 ? " 1 invitación" : `n ${preview.invitesToRevoke.length} invitaciones`}.` : "",
      moduleLabels(preview.modulesLost).length ? `Deja de ver: ${moduleLabels(preview.modulesLost).join(", ")}.` : "",
    ].filter(Boolean);
    const yes = await confirm({
      title: `¿Pasar ${tenantName} a ${SAAS_PLAN_LABEL[to]}?`,
      message: parts.length ? parts.join(" ") : "El cambio rige ya. Sin prorrateo: el precio nuevo se cobra desde el próximo cargo.",
      confirmLabel: "Cambiar de plan",
      cancelLabel: "Volver",
      tone: disable.size || preview.modulesLost.length ? "danger" : "default",
    });
    if (!yes) return;
    setPending(true);
    setError(null);
    try {
      const res = await runPlatform(() =>
        platformApplyPlanChange({
          tenantId,
          to,
          disableMembershipIds: [...disable],
          reactivateMembershipIds: [...reactivate],
          expectedUpdatedAt: preview.tenantUpdatedAt,
        })
      );
      if (!res.ok) {
        setError(res.error);
        // Stale o la foto cambió (alguien entró o salió del equipo): se vuelve a calcular con lo de ahora.
        if ("reason" in res && (res.reason === "stale" || res.reason === "does_not_fit" || res.reason === "invalid_selection")) {
          void loadPreview(to, true);
        }
        return;
      }
      onClose();
      // Sin refresh extra del router: `platformApplyPlanChange` revalida y la respuesta ya trae la pestaña nueva (PF-0d).
      toast.success(`Plan cambiado a ${SAAS_PLAN_LABEL[to]}`);
    } catch {
      setError("No se pudo cambiar el plan. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Cambiar de plan" dirty={to !== null} width={480}>
      <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
        {tenantName}. Rige ya; sin prorrateo: el precio nuevo se cobra desde el próximo cargo.
      </p>
      <PlanChangeForm
        current={current}
        vertical={vertical}
        to={to}
        preview={preview}
        loading={loading}
        disable={disable}
        reactivate={reactivate}
        error={error}
        pending={pending}
        onPick={onPick}
        onToggleDisable={(id) => setDisable((s) => toggle(s, id))}
        onToggleReactivate={(id) => setReactivate((s) => toggle(s, id))}
        onApply={() => void onApply()}
        onCancel={onClose}
      />
    </Drawer>
  );
}
