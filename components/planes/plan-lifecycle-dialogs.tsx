"use client";

/**
 * Ciclo de vida del plan en la PlanCard (S22a, ES3 P3.2): diálogo D7 para
 * pausar / cancelar / dar el alta / reactivar / archivar, y el Drawer de
 * título y notas.
 *
 * La UI consume las actions de S15 (`lib/plans-lifecycle.ts`) y la tabla pura
 * de `lib/plans-lifecycle-state.ts`; no reimplementa reglas del server:
 *   - lo que se ofrece = `allowedProgramTransitions` (la MISMA tabla que el
 *     server acepta). Antes el `<select>` ofrecía cualquier estado y el server
 *     legacy reactivaba un CANCELLED con los turnos ya cancelados;
 *   - los conteos del diálogo salen de `previewPlanStatusChange` (futuros
 *     impagos / con cobro), y el commit viaja con su `expectedUpdatedAt`: el
 *     usuario confirma exactamente lo que vio;
 *   - `stale` → copy del server + `onStale` (el shell recarga);
 *     `needs-confirmation` → `useConfirm` y reenvío con `confirm`.
 *
 * Decisión de Martin del 08-oct (literal): "Cuando se da el alta antes de
 * tiempo o se cancela, se pregunta qué hacer con los turnos futuros, y por
 * defecto se cancelan. Cancelar no genera cargo. Los turnos ya cobrados
 * quedan en la agenda, el saldo los muestra 'a favor' y el reintegro es
 * manual."
 */
import { useEffect, useId, useState, useTransition } from "react";
import { Modal } from "@/components/ui/modal";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { archivePlan, changePlanStatus, previewPlanStatusChange, updatePlanDetails } from "@/lib/plans-lifecycle";
import {
  DEFAULT_FUTURE_BOOKINGS_ACTION,
  PLAN_LIFECYCLE_COPY,
  allowedProgramTransitions,
  type FutureBookingsAction,
  type ProgramStatusValue,
} from "@/lib/plans-lifecycle-state";
import type { PlanBookingsOutcome, PlanStatusChangePreview } from "@/lib/plans-edit-types";

// ─── Copy y helpers puros (los testea `plan-card.test.tsx`) ──────────────────

/** Botón de cada transición (verbo, no el estado: "Cancelar plan" no se confunde con "Cancelar"). */
export const PLAN_STATUS_ACTION_LABEL: Readonly<Record<ProgramStatusValue, string>> = {
  ACTIVE: "Reactivar",
  PAUSED: "Pausar",
  COMPLETED: "Dar el alta",
  CANCELLED: "Cancelar plan",
};

/** Las transiciones que el menú ofrece: exactamente las de la tabla de S15. */
export function planStatusActions(status: ProgramStatusValue): Array<{ to: ProgramStatusValue; label: string }> {
  return allowedProgramTransitions(status).map((to) => ({ to, label: PLAN_STATUS_ACTION_LABEL[to] }));
}

export function planStatusDialogTitle(from: ProgramStatusValue, to: ProgramStatusValue, mode: "status" | "archive"): string {
  if (mode === "archive") return "¿Cancelar y archivar el plan?";
  if (to === "ACTIVE") return from === "COMPLETED" ? "¿Reactivar el plan completado?" : "¿Reactivar el plan?";
  if (to === "PAUSED") return "¿Pausar el plan?";
  if (to === "COMPLETED") return "¿Le das el alta?";
  return "¿Cancelar el plan?";
}

/**
 * C13 D7 (literal): "¿Qué hacemos con los 6 turnos que quedan? · Cancelarlos
 * (recomendado) · Dejarlos en la agenda · 2 tienen un cobro registrado y no se
 * tocan". `total` = impagos + con cobro (los que "quedan"); la elección solo
 * aplica a los impagos. Sin impagos no hay pregunta (`choice: false`).
 */
export function d7Copy(future: { unpaid: number; withPayment: number }): {
  total: number;
  question: string | null;
  choice: boolean;
  cancelLabel: string;
  keepLabel: string;
  paidNote: string | null;
} {
  const total = future.unpaid + future.withPayment;
  const one = total === 1;
  return {
    total,
    question: total === 0 ? null : one ? "¿Qué hacemos con el turno que queda?" : `¿Qué hacemos con los ${total} turnos que quedan?`,
    choice: future.unpaid > 0,
    cancelLabel: future.unpaid === 1 ? "Cancelarlo (recomendado)" : "Cancelarlos (recomendado)",
    keepLabel: future.unpaid === 1 ? "Dejarlo en la agenda" : "Dejarlos en la agenda",
    paidNote:
      future.withPayment === 0
        ? null
        : future.withPayment === 1
          ? "1 tiene un cobro registrado y no se toca"
          : `${future.withPayment} tienen un cobro registrado y no se tocan`,
  };
}

/** Nota de plata del diálogo (decisión del 08-oct): solo al cancelar o dar el alta. */
export function planStatusMoneyNote(to: ProgramStatusValue, mode: "status" | "archive"): string | null {
  if (mode === "archive" || to === "CANCELLED" || to === "COMPLETED") {
    return "Cancelar no genera cargo. Los turnos ya cobrados quedan en la agenda; si queda saldo a favor del paciente, el reintegro se hace a mano.";
  }
  if (to === "PAUSED") return "Las sesiones se conservan. Podés reactivarlo cuando quieras.";
  return null;
}

const DONE_LABEL: Readonly<Record<ProgramStatusValue, string>> = {
  ACTIVE: "Plan reactivado",
  PAUSED: "Plan pausado",
  COMPLETED: "Le diste el alta",
  CANCELLED: "Plan cancelado",
};

/** Toast de éxito: qué pasó con el plan y con los turnos. */
export function planStatusDoneMessage(
  to: ProgramStatusValue,
  bookings: PlanBookingsOutcome | null,
  mode: "status" | "archive" = "status"
): string {
  const parts = [mode === "archive" ? "Plan cancelado y archivado" : DONE_LABEL[to]];
  if (bookings) {
    if (bookings.cancelled > 0) {
      parts.push(bookings.cancelled === 1 ? "se canceló 1 turno" : `se cancelaron ${bookings.cancelled} turnos`);
    }
    if (bookings.kept > 0) {
      parts.push(bookings.kept === 1 ? "1 turno quedó en la agenda" : `${bookings.kept} turnos quedaron en la agenda`);
    }
    if (bookings.withPayment > 0) {
      parts.push(
        bookings.withPayment === 1 ? "1 turno con cobro no se tocó" : `${bookings.withPayment} turnos con cobro no se tocaron`
      );
    }
  }
  return parts.join(" · ");
}

// ─── D7 ──────────────────────────────────────────────────────────────────────

/** Cancelar (también "Cancelar y archivar") es destructivo: botón con tono danger. */
export function planStatusIsDanger(target: ProgramStatusValue): boolean {
  return target === "CANCELLED";
}

export type PlanLifecycleDone = { message: string; notice?: string };

export type PlanStatusDialogProps = {
  open: boolean;
  onClose: () => void;
  programId: string;
  from: ProgramStatusValue;
  /** Destino. En `archive` se ignora: un plan abierto pasa a CANCELLED en la misma tx (§2.4). */
  to: ProgramStatusValue;
  /** `archive` = `archivePlan({cancelOpen:true})` para un plan ACTIVE/PAUSED. */
  mode?: "status" | "archive";
  onDone: (done: PlanLifecycleDone) => void;
  onStale?: () => void;
};

type Loaded = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ready"; preview: PlanStatusChangePreview };

export function PlanStatusDialog({ open, onClose, programId, from, to, mode = "status", onDone, onStale }: PlanStatusDialogProps) {
  const confirm = useConfirm();
  const target: ProgramStatusValue = mode === "archive" ? "CANCELLED" : to;
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [choice, setChoice] = useState<FutureBookingsAction>(DEFAULT_FUTURE_BOOKINGS_ACTION);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const groupName = useId();
  /**
   * Recarga del preview después de un `stale` (P3.Z): el `expectedUpdatedAt`
   * sale del preview, así que sin recargarlo cada reintento volvía a dar
   * stale (loop). El error de stale queda a la vista mientras recarga.
   */
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    setChoice(DEFAULT_FUTURE_BOOKINGS_ACTION);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoaded({ kind: "loading" });
    previewPlanStatusChange({ programId, to: target })
      .then((r) => {
        if (!alive) return;
        if (!r.ok) setLoaded({ kind: "error", error: r.error });
        else if (!r.preview.allowed) setLoaded({ kind: "error", error: PLAN_LIFECYCLE_COPY.invalid(r.preview.from, target) });
        else setLoaded({ kind: "ready", preview: r.preview });
      })
      .catch(() => {
        if (alive) setLoaded({ kind: "error", error: "No pudimos revisar los turnos del plan. Probá de nuevo." });
      });
    return () => {
      alive = false;
    };
  }, [open, programId, target, reload]);

  const preview = loaded.kind === "ready" ? loaded.preview : null;
  const copy = preview ? d7Copy(preview.futureBookings) : null;
  const asks = !!preview?.asksFutureBookings && !!copy && copy.total > 0;
  const moneyNote = planStatusMoneyNote(target, mode);
  const danger = planStatusIsDanger(target);

  const send = (confirmFlag: boolean) => {
    if (!preview) return;
    setError(null);
    start(async () => {
      const futureBookings = preview.asksFutureBookings ? choice : undefined;
      const r =
        mode === "archive"
          ? await archivePlan({
              programId,
              expectedUpdatedAt: preview.expectedUpdatedAt,
              cancelOpen: true,
              ...(futureBookings ? { futureBookings } : {}),
            })
          : await changePlanStatus({
              programId,
              expectedUpdatedAt: preview.expectedUpdatedAt,
              to: target,
              ...(futureBookings ? { futureBookings } : {}),
              // Este diálogo ES la confirmación de reabrir un completado.
              ...(confirmFlag || preview.requiresConfirmation ? { confirm: true as const } : {}),
            });
      if (r.ok) {
        onDone({ message: planStatusDoneMessage(target, r.data.bookings, mode), notice: r.notice });
        onClose();
        return;
      }
      if ("kind" in r && r.kind === "stale") {
        setError(r.error);
        setReload((n) => n + 1);
        onStale?.();
        return;
      }
      if ("kind" in r && r.kind === "needs-confirmation") {
        const ok = await confirm({ title: r.error, confirmLabel: "Sí, reactivar", cancelLabel: "Volver" });
        if (ok) send(true);
        return;
      }
      setError(r.error);
    });
  };

  return (
    <Modal open={open} onClose={pending ? () => {} : onClose} title={planStatusDialogTitle(from, target, mode)} width={460}>
      <div data-testid="plan-status-dialog" style={{ display: "grid", gap: 12 }}>
        {loaded.kind === "loading" && (
          <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
            Revisando los turnos del plan…
          </p>
        )}
        {loaded.kind === "error" && (
          <p role="alert" style={errorBox}>
            {loaded.error}
          </p>
        )}
        {preview && asks && copy && (
          <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            <legend style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)", marginBottom: 6 }}>{copy.question}</legend>
            {copy.choice && (
              <>
                <label style={radioRow}>
                  <input
                    type="radio"
                    name={groupName}
                    value="cancel"
                    checked={choice === "cancel"}
                    onChange={() => setChoice("cancel")}
                    disabled={pending}
                  />
                  {copy.cancelLabel}
                </label>
                <label style={radioRow}>
                  <input
                    type="radio"
                    name={groupName}
                    value="keep"
                    checked={choice === "keep"}
                    onChange={() => setChoice("keep")}
                    disabled={pending}
                  />
                  {copy.keepLabel}
                </label>
              </>
            )}
            {copy.paidNote && <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{copy.paidNote}</p>}
          </fieldset>
        )}
        {preview && moneyNote && <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{moneyNote}</p>}
        {error && (
          <p role="alert" style={errorBox}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Volver
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => send(false)}
            disabled={pending || !preview}
            data-tone={danger ? "danger" : undefined}
            style={danger ? { background: "var(--danger-fg)" } : undefined}
          >
            {pending ? "Guardando…" : mode === "archive" ? "Cancelar y archivar" : PLAN_STATUS_ACTION_LABEL[target]}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Título y notas ──────────────────────────────────────────────────────────

export type PlanDetailsDrawerProps = {
  open: boolean;
  onClose: () => void;
  programId: string;
  /** `expectedUpdatedAt` (CAS) tal como lo mostró la card. */
  updatedAt: string;
  title: string;
  notes: string | null;
  onDone: (done: PlanLifecycleDone) => void;
  onStale?: () => void;
};

/**
 * PD-10: `updatePlanDetails` edita SOLO título y notas (`PROGRAM_EDITABLE_FIELDS`).
 * Total, frecuencia e inicio salieron de este drawer (handoff S15): cantidad
 * y precio tienen sus diálogos (S22e) y el horario se cambia re-planificando.
 */
export function PlanDetailsDrawer({ open, onClose, programId, updatedAt, title, notes, onDone, onStale }: PlanDetailsDrawerProps) {
  const [t, setT] = useState(title);
  const [n, setN] = useState(notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Solo al abrir (P3.Z): con `title`/`notes` en las deps, un refresh del
  // padre (otro guardado, realtime) pisaba lo que el usuario estaba tipeando.
  useEffect(() => {
    if (!open) return;
    setT(title);
    setN(notes ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const titleChanged = t.trim() !== title.trim();
  const notesChanged = n.trim() !== (notes ?? "").trim();
  const dirty = titleChanged || notesChanged;

  const save = () => {
    if (!dirty) {
      onClose();
      return;
    }
    setError(null);
    start(async () => {
      const r = await updatePlanDetails({
        programId,
        expectedUpdatedAt: updatedAt,
        ...(titleChanged ? { title: t } : {}),
        ...(notesChanged ? { notes: n } : {}),
      });
      if (r.ok) {
        onDone({ message: "Plan actualizado", notice: r.notice });
        onClose();
        return;
      }
      if ("kind" in r && r.kind === "stale") onStale?.();
      setError(r.error);
    });
  };

  return (
    <Drawer open={open} onClose={onClose} title="Editar plan" width={480} dirty={dirty && !pending}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <FormField label="Nombre del plan" name="title" required value={t} onChange={(v) => setT(v.slice(0, 120))} disabled={pending} />
        <FormField as="textarea" label="Notas" name="notes" rows={5} value={n} onChange={(v) => setN(v.slice(0, 4000))} disabled={pending} />
        <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
          La cantidad de sesiones y el precio se cambian desde la tarjeta del plan; el horario, con «Editar desde la sesión».
        </p>
        {error && (
          <p role="alert" style={errorBox}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button type="submit" variant="primary" disabled={pending || !t.trim()} style={{ width: "100%", justifyContent: "center" }}>
            {pending ? "Guardando…" : "Guardar"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending} style={{ width: "100%", justifyContent: "center" }}>
            Cancelar
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const errorBox: React.CSSProperties = {
  margin: 0,
  padding: 10,
  borderRadius: 10,
  background: "var(--danger-bg)",
  color: "var(--danger-fg)",
  fontSize: 12.5,
};

const radioRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13.5,
  color: "var(--navy-900)",
  cursor: "pointer",
};
