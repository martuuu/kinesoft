"use client";

/**
 * Tarjeta «Solo en Auth» del directorio (BO3-D): aparece cuando se busca un email exacto que el servicio de acceso
 * conoce y la base no (el invitado revocado, el alta abandonada: el email queda «tomado» para una invitación
 * nueva). «Borrar» solo si el server dijo `canDelete` (nunca confirmó, nunca entró, sin perfil/membresías/fichas);
 * la action lo vuelve a chequear igual, porque borrar de más es irreversible.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { repairDeleteAuthOrphan } from "@/lib/platform-users";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import type { PlatformAuthOnlyHit } from "@/lib/platform-health-logic";
import { formatDateTimeAR } from "@/components/plataforma/users/users-logic";

export function AuthOnlyCard({ hit }: { hit: PlatformAuthOnlyHit }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    const ok = await confirm({
      title: "¿Borrar esta cuenta?",
      message: `Se borra la cuenta de ${hit.email ?? "este usuario"} del servicio de acceso y el email queda libre para una invitación nueva. No se puede deshacer.`,
      confirmLabel: "Borrar",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await runPlatform(() => repairDeleteAuthOrphan({ authUserId: hit.authUserId }));
      if (r.ok) {
        toast.success("Cuenta borrada");
      } else {
        toast.error("No se pudo borrar", { description: r.error });
      }
    } catch {
      toast.error("No se pudo borrar", { description: "Probá de nuevo en unos minutos." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: 16, border: "1px dashed rgba(15,30,51,0.18)" }} aria-label="Solo en Auth">
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: 14, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{hit.email ?? "(sin email)"}</strong>
            <Tag tone="soft">Solo en Auth</Tag>
          </div>
          <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: "6px 0 0", lineHeight: 1.45, maxWidth: 560 }}>
            Tiene cuenta en el servicio de acceso pero no perfil en KineSoft: no puede entrar a nada y deja el email
            ocupado.
          </p>
          <div style={{ fontSize: 12, color: "var(--navy-300)", marginTop: 6 }}>
            Creada {formatDateTimeAR(hit.createdAt) || "—"} · {hit.emailConfirmed ? "Email confirmado" : "Email sin confirmar"} ·{" "}
            {hit.lastSignInAt ? `Último ingreso ${formatDateTimeAR(hit.lastSignInAt)}` : "Nunca entró"}
          </div>
        </div>
        {hit.canDelete ? (
          <Button variant="ghost" onClick={onDelete} disabled={busy}>
            {busy ? "Borrando…" : "Borrar"}
          </Button>
        ) : (
          <span style={{ fontSize: 12, color: "var(--navy-500)", maxWidth: 260, lineHeight: 1.4 }}>
            No se puede borrar desde acá: la cuenta se usó (confirmó el email o entró).
          </span>
        )}
      </div>
    </Card>
  );
}
