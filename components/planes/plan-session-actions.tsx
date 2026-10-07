"use client";

/**
 * Acciones por sesión y "Generar turnos para pendientes" de la PlanCard
 * (S22e, ES3 P3.2). Props congeladas de P3-C (`plan-editor-types.ts`).
 *
 *   - "Agendar" (sesión "sin turno", `permissions.schedule`, plan ACTIVE) y
 *     "Generar turnos para pendientes" → editor en modo `generate` (el server
 *     gatea `plans.schedule` y genera solo en ACTIVE: `plans-adopt-internal`).
 *     Siempre con `patientId` (handoff S18: la Secretaria no tiene
 *     `getPlanDetail`).
 *   - "Editar desde la sesión N" → editor `replan` (`plans.manage`; el server
 *     re-planifica solo un plan ACTIVE, `assertReplanInput`).
 *   - "Archivar sesión" → `archivePlanSessions({sessionIds})` con CAS
 *     (`plan.updatedAt`) y `useConfirm`; en paquete pregunta C13 "¿Mantenemos
 *     el total o el precio por sesión?" en un diálogo propio (el confirm del
 *     design system es sí/no).
 *   - "Restaurar sesión" → `restoreSession` (server: `plans.manage` + OWNER/
 *     ADMIN → `permissions.restore`).
 * Ninguna abre un editor propio. Sin el permiso que corresponde, la acción no
 * aparece; sin ninguna, no se renderiza nada. Nada de esto toca
 * `canOperateBooking`/`canWriteClinical` (el turno se opera desde la agenda).
 */
import { useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { PackageChoice, PlanDialogShell } from "@/components/planes/plan-edit-dialogs";
import { archivePlanSessions, restoreSession } from "@/lib/plans-edit";
import type {
  GeneratePendingButtonProps,
  PackageCountPricing,
  PlanEditTarget,
  PlanEditorRequest,
  PlanPermissions,
  PlanSessionActionsProps,
} from "./plan-editor-types";

export type { GeneratePendingButtonProps, PlanSessionActionsProps };

// ─── Helpers puros (exportados para los tests) ───────────────────────────────

export type PlanSessionActionKind = "schedule" | "replan" | "archive" | "restore";

type SessionLike = PlanSessionActionsProps["session"];

/**
 * Qué acciones ve el actor sobre UNA sesión (espejo de los gates del server
 * para no mostrar botones que rebotan; la barrera real es el server).
 */
export function planSessionActionKinds(
  plan: Pick<PlanEditTarget, "status">,
  session: SessionLike,
  permissions: PlanPermissions
): PlanSessionActionKind[] {
  const out: PlanSessionActionKind[] = [];
  if (session.archivedAt != null) {
    if (permissions.restore) out.push("restore");
    return out;
  }
  if (permissions.schedule && session.sinTurno && plan.status === "ACTIVE") out.push("schedule");
  const open = session.state !== "done" && session.booking?.status !== "COMPLETED";
  if (permissions.manage && open && plan.status === "ACTIVE" && session.ordinal != null) out.push("replan");
  if (permissions.manage && open) out.push("archive");
  return out;
}

export function planSessionActionLabel(kind: PlanSessionActionKind, ordinal: number | null): string {
  switch (kind) {
    case "schedule":
      return "Agendar";
    case "replan":
      return ordinal != null ? `Editar desde la sesión ${ordinal}` : "Editar desde esta sesión";
    case "archive":
      return "Archivar sesión";
    case "restore":
      return "Restaurar sesión";
  }
}

/** Pedido al editor único (C10). */
export function scheduleSessionRequest(plan: Pick<PlanEditTarget, "programId" | "patientId">, sessionId: string): PlanEditorRequest {
  return { mode: "generate", programId: plan.programId, patientId: plan.patientId, generateForSessionIds: [sessionId] };
}
export function replanRequest(plan: Pick<PlanEditTarget, "programId" | "patientId">, sessionId: string): PlanEditorRequest {
  return { mode: "replan", programId: plan.programId, patientId: plan.patientId, replanFromSessionId: sessionId };
}
export function generatePendingRequest(plan: Pick<PlanEditTarget, "programId" | "patientId">): PlanEditorRequest {
  return { mode: "generate", programId: plan.programId, patientId: plan.patientId };
}

/**
 * "Generar turnos para pendientes" visible: `plans.schedule`, plan ACTIVE y
 * MÁS DE UNA "sin turno" (decisión S22h): con una sola, el "Agendar" de su
 * fila hace lo mismo y el botón grande sobraba.
 */
export function generatePendingVisible(plan: Pick<PlanEditTarget, "status">, pendingCount: number, permissions: PlanPermissions): boolean {
  return permissions.schedule && plan.status === "ACTIVE" && pendingCount > 1;
}

/** Copy del confirm de archivar (el server cancela el turno impago y rechaza lo cobrado/realizado). */
export function archiveSessionCopy(session: SessionLike): { title: string; message: string } {
  const n = session.ordinal;
  const title = n != null ? `¿Archivás la sesión ${n}?` : "¿Archivás esta sesión?";
  const hasBooking = session.booking != null && (session.booking.status === "PENDING" || session.booking.status === "CONFIRMED");
  const message = hasBooking
    ? "Su turno se cancela si no tiene un cobro registrado (con cobro no se puede archivar). La podés restaurar después."
    : "Deja de contar en el plan. La podés restaurar después.";
  return { title, message };
}

// ─── Componentes ─────────────────────────────────────────────────────────────

const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" };
const small: CSSProperties = { padding: "5px 10px", fontSize: 12 };

export function PlanSessionActions({ plan, session, permissions, onOpenEditor, onChanged, onStale }: PlanSessionActionsProps): JSX.Element | null {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [askPackage, setAskPackage] = useState(false);
  const [choice, setChoice] = useState<PackageCountPricing>("keep-total");
  const kinds = planSessionActionKinds(plan, session, permissions);
  if (kinds.length === 0) return null;

  const fail = (r: { error: string; kind?: string }) => {
    toast.error(r.error);
    if (r.kind === "stale") onStale?.();
  };

  const doArchive = async (packagePricing?: PackageCountPricing) => {
    setBusy(true);
    try {
      const r = await archivePlanSessions({
        programId: plan.programId,
        expectedUpdatedAt: plan.updatedAt,
        sessionIds: [session.id],
        ...(packagePricing ? { packagePricing } : {}),
      });
      if (r.ok) {
        const c = r.data.cancelledBookings;
        toast.success(c > 0 ? "Sesión archivada · turno cancelado" : "Sesión archivada");
        setAskPackage(false);
        onChanged({ notice: r.notice });
        return;
      }
      fail(r);
    } catch {
      toast.error("No pudimos archivar la sesión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (plan.pricingMode === "PACKAGE") return setAskPackage(true);
    const copy = archiveSessionCopy(session);
    const ok = await confirm({ ...copy, confirmLabel: "Archivar", tone: "danger" });
    if (ok) await doArchive();
  };

  const restore = async () => {
    setBusy(true);
    try {
      const r = await restoreSession({ programId: plan.programId, sessionId: session.id, expectedUpdatedAt: plan.updatedAt });
      if (r.ok) {
        toast.success("Sesión restaurada");
        onChanged({ notice: r.notice });
        return;
      }
      fail(r);
    } catch {
      toast.error("No pudimos restaurar la sesión. Probá de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const run = (k: PlanSessionActionKind) => {
    if (k === "schedule") return onOpenEditor(scheduleSessionRequest(plan, session.id));
    if (k === "replan") return onOpenEditor(replanRequest(plan, session.id));
    if (k === "archive") return void archive();
    return void restore();
  };

  const copy = archiveSessionCopy(session);
  return (
    <div style={row} role="group" aria-label={session.ordinal != null ? `Acciones de la sesión ${session.ordinal}` : "Acciones de la sesión"}>
      {kinds.map((k) => (
        <Button key={k} type="button" variant="ghost" style={small} onClick={() => run(k)} disabled={busy} data-action={k}>
          {planSessionActionLabel(k, session.ordinal)}
        </Button>
      ))}
      {askPackage && (
        <PlanDialogShell open={askPackage} onClose={() => setAskPackage(false)} title={copy.title} description={copy.message} width={460}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <PackageChoice name={`archive-pkg-${session.id}`} totalCents={null} value={choice} onChange={setChoice} disabled={busy} />
            <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="ghost" onClick={() => setAskPackage(false)} disabled={busy}>
                Cancelar
              </Button>
              <Button type="button" variant="primary" onClick={() => void doArchive(choice)} disabled={busy}>
                {busy ? "Archivando…" : "Archivar"}
              </Button>
            </footer>
          </div>
        </PlanDialogShell>
      )}
    </div>
  );
}

export function GeneratePendingButton({ plan, pendingCount, permissions, onOpenEditor }: GeneratePendingButtonProps): JSX.Element | null {
  if (!generatePendingVisible(plan, pendingCount, permissions)) return null;
  return (
    <Button type="button" variant="ghost" onClick={() => onOpenEditor(generatePendingRequest(plan))} aria-label={pendingCount === 1 ? "Generar el turno de la sesión pendiente" : `Generar turnos para las ${pendingCount} sesiones pendientes`}>
      Generar turnos para pendientes ({pendingCount})
    </Button>
  );
}
