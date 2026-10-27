"use client";

/**
 * Acciones de etapa de un ticket (PV §27, TK-U1): «Tomar» (solo Nuevo), «Marcar resuelto» (Nuevo o En curso, con
 * `useConfirm`) y «Reabrir» (Resuelto; vuelve a «En curso» si ya lo había tomado alguien: el server no borra quién lo
 * tomó).
 *
 * Patrón de la bandeja (PF-0d): `usePlatformAction` y sin `router.refresh()` cuando la action revalida
 * (`revalidatePath("/plataforma/mensajes", "layout")`). Única excepción: «Tomar» con `changed: false` (otro superadmin
 * lo tomó antes; el server NO revalida porque no cambió nada) → ahí sí un refresh, para que se vea quién lo tiene en
 * vez de un botón «Tomar» que no hace nada.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { resolveConfirmMessage } from "@/components/plataforma/inbox/inbox-logic";
import { setInboxThreadStatus, takeInboxThread } from "@/lib/platform-inbox";
import type { TicketStage } from "@/lib/support-threads-types";

const GENERIC_ERROR = "No pudimos guardar. Probá de nuevo en unos minutos.";

export function TicketActions({ threadId, kind, stage }: { threadId: string; kind: "TENANT" | "LEAD"; stage: TicketStage }) {
  const runPlatform = usePlatformAction();
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onOk: (data: T) => void) {
    setPending(true);
    setError(null);
    try {
      const r = await runPlatform(fn);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onOk(r.data);
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  async function onTake() {
    if (pending) return;
    await run(
      () => takeInboxThread({ threadId }),
      (d) => {
        if (d.changed) toast.success("Ticket tomado");
        else {
          toast.info("Ya lo había tomado alguien");
          router.refresh(); // refresh-ok: con changed:false el server no revalida y lo tomó otro superadmin
        }
      }
    );
  }

  async function onResolve() {
    if (pending) return;
    const ok = await confirm({
      title: "¿Marcar como resuelto?",
      message: resolveConfirmMessage(kind),
      confirmLabel: "Marcar resuelto",
      cancelLabel: "Volver",
    });
    if (!ok) return;
    await run(
      () => setInboxThreadStatus({ threadId, status: "CLOSED" }),
      () => toast.success("Ticket resuelto")
    );
  }

  async function onReopen() {
    if (pending) return;
    await run(
      () => setInboxThreadStatus({ threadId, status: "OPEN" }),
      () => toast.success("Ticket reabierto")
    );
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div role="group" aria-label="Acciones del ticket" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {stage === "NEW" && (
          <Button type="button" onClick={() => void onTake()} disabled={pending}>
            Tomar
          </Button>
        )}
        {stage !== "CLOSED" ? (
          <Button type="button" variant="ghost" onClick={() => void onResolve()} disabled={pending}>
            Marcar resuelto
          </Button>
        ) : (
          <Button type="button" variant="ghost" onClick={() => void onReopen()} disabled={pending}>
            Reabrir
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
