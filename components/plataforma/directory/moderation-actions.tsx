"use client";

/**
 * [DIR-3e] Acciones de moderación de cada fila de /plataforma/directorio (C-DIR9; server de DIR-2c en
 * `lib/platform-directory.ts`):
 *   - ocultar un consultorio o un perfil: motivo obligatorio (3..500) en un Drawer con dirty-guard. Si ya está oculto,
 *     el mismo Drawer corrige el motivo sin mostrar y volver a ocultar (eso dejaría una ventana pública);
 *   - mostrar, verificar y quitar la verificación de la matrícula: `useConfirm` (no hay nada que cargar).
 *
 * Todas pasan por `usePlatformAction()` (BO4: si la sesión de Plataforma pide el código otra vez, el provider de
 * `(platform)` abre el modal y reintenta). Al salir bien, la action ya hizo `revalidatePath("/plataforma/directorio")`
 * y la respuesta de la server action trae la página nueva: no hace falta `router.refresh()`. Al fallar sí, por si otro
 * superadmin cambió la fila en el medio.
 *
 * El motivo lo ve el Titular en Configuración → Directorio (banda «Plataforma ocultó el consultorio: <motivo>»): el
 * hint lo dice para que no se escriba nada interno ni datos de pacientes.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox } from "@/components/plataforma/tenants/detail-ui";
import {
  hideDirectoryProfile,
  hideDirectoryTenant,
  showDirectoryProfile,
  showDirectoryTenant,
  unverifyDirectoryLicense,
  verifyDirectoryLicense,
} from "@/lib/platform-directory";
import type { ActionResult } from "@/lib/validation";
import type { PlatformDirectoryModeration } from "@/lib/platform-directory-read";
import { HIDE_REASON_MAX, hideReasonError, isHideReasonDirty } from "@/components/plataforma/directory/moderation-logic";

type Result = ActionResult<{ changed: boolean }>;
const NETWORK_ERROR = "No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.";

function useModerationRun() {
  const router = useRouter();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [pending, setPending] = useState(false);

  /** Corre la action. Devuelve el resultado para que el Drawer pinte el error en el campo. */
  const run = async (call: () => Promise<Result>, success: string, opts: { toastError: boolean }): Promise<Result> => {
    setPending(true);
    try {
      const res: Result = await runPlatform(call);
      if (!res.ok) {
        if (opts.toastError) toast.error(res.error);
        // refresh-ok: la action falló y no revalida; trae la foto vigente si otro superadmin cambió la fila.
        router.refresh();
        return res;
      }
      toast.success(res.data.changed ? success : "Ya estaba así: no hubo cambios.");
      return res;
    } catch {
      if (opts.toastError) toast.error(NETWORK_ERROR);
      return { ok: false, error: NETWORK_ERROR };
    } finally {
      setPending(false);
    }
  };
  return { run, pending };
}

/**
 * Drawer del motivo. `initial` = motivo vigente (corregir) o "" (ocultar). El padre le cambia la `key` en cada apertura:
 * el estado arranca limpio sin resetear a mano (y sin parpadear el texto viejo durante la animación de cierre).
 */
function HideReasonDrawer({
  open,
  title,
  subject,
  effect,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  subject: string;
  effect: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<Result>;
}) {
  const [reason, setReason] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const err = hideReasonError(reason);
    setError(err);
    if (err) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await onSubmit(reason.trim());
      if (!res.ok) {
        setServerError(res.error);
        setError(res.fieldErrors?.reason?.[0] ?? null);
        return;
      }
      onClose();
    } finally {
      setPending(false);
    }
  };

  const unchanged = initial !== "" && reason.trim() === initial.trim();

  return (
    <Drawer
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      title={title}
      dirty={isHideReasonDirty(reason, initial)}
      dirtyMessage="Tenés un motivo sin guardar. ¿Lo descartás?"
      width={460}
    >
      <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
        <strong style={{ color: "var(--navy-900)" }}>{subject}</strong>. {effect}
      </p>
      <form onSubmit={(e) => void submit(e)} style={{ display: "grid", gap: 14 }}>
        <FormField
          as="textarea"
          rows={4}
          label="Motivo"
          required
          value={reason}
          onChange={(v) => {
            setReason(v);
            if (error) setError(null);
          }}
          hint={`Lo ve el titular del consultorio en Configuración. Sin datos de pacientes. ${reason.trim().length}/${HIDE_REASON_MAX}`}
          error={error ?? undefined}
          disabled={pending}
          autoFocus
        />
        {serverError && <ErrorBox>{serverError}</ErrorBox>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending || unchanged}>
            {pending ? "Guardando…" : submitLabel}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

const rowActions = { display: "flex", gap: 6, flexWrap: "wrap" as const, justifyContent: "flex-end" as const };

/** Ocultar / corregir motivo / mostrar un consultorio. */
export function ClinicModerationActions({
  tenantId,
  name,
  hidden,
}: {
  tenantId: string;
  name: string;
  hidden: PlatformDirectoryModeration;
}) {
  const confirm = useConfirm();
  const { run, pending } = useModerationRun();
  const [drawer, setDrawer] = useState(false);
  const [drawerKey, setDrawerKey] = useState(0);
  const openDrawer = () => {
    setDrawerKey((k) => k + 1);
    setDrawer(true);
  };

  const show = async () => {
    const ok = await confirm({
      title: `¿Volver a mostrar ${name}?`,
      message:
        "Si el titular lo sigue teniendo publicado y el turnero está prendido, vuelve a aparecer en el directorio. El motivo se borra (el cambio queda en Auditoría).",
      confirmLabel: "Mostrar",
      cancelLabel: "Dejarlo oculto",
    });
    if (!ok) return;
    await run(() => showDirectoryTenant({ tenantId }), "El consultorio vuelve a mostrarse", { toastError: true });
  };

  return (
    <div style={rowActions}>
      {hidden ? (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={openDrawer} disabled={pending}>
            Editar motivo
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void show()} disabled={pending}>
            Mostrar
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={openDrawer} disabled={pending}>
          Ocultar
        </Button>
      )}
      <HideReasonDrawer
        key={drawerKey}
        open={drawer}
        title={hidden ? "Editar el motivo" : "Ocultar el consultorio"}
        subject={name}
        effect={
          hidden
            ? "Sigue oculto; solo cambia el motivo que ve el titular."
            : "Sale del directorio aunque el titular lo tenga publicado (su switch no cambia). Sus profesionales dejan de listarse con este consultorio."
        }
        initial={hidden?.reason ?? ""}
        submitLabel={hidden ? "Guardar el motivo" : "Ocultar"}
        onClose={() => setDrawer(false)}
        onSubmit={(reason) =>
          run(() => hideDirectoryTenant({ tenantId, reason }), hidden ? "Motivo actualizado" : "Consultorio oculto del directorio", {
            toastError: false,
          })
        }
      />
    </div>
  );
}

/** Ocultar / corregir motivo / mostrar un perfil, y verificar o quitar la verificación de la matrícula. */
export function ProfileModerationActions({
  profileId,
  name,
  hidden,
  license,
}: {
  profileId: string;
  name: string;
  hidden: PlatformDirectoryModeration;
  /** null = sin matrícula cargada: no hay nada que verificar. */
  license: { text: string; verified: boolean } | null;
}) {
  const confirm = useConfirm();
  const { run, pending } = useModerationRun();
  const [drawer, setDrawer] = useState(false);
  const [drawerKey, setDrawerKey] = useState(0);
  const openDrawer = () => {
    setDrawerKey((k) => k + 1);
    setDrawer(true);
  };

  const show = async () => {
    const ok = await confirm({
      title: `¿Volver a mostrar a ${name}?`,
      message:
        "Si la persona sigue publicando su perfil con el consentimiento vigente, vuelve a aparecer en el directorio. El motivo se borra (el cambio queda en Auditoría).",
      confirmLabel: "Mostrar",
      cancelLabel: "Dejarlo oculto",
    });
    if (!ok) return;
    await run(() => showDirectoryProfile({ profileId }), "El perfil vuelve a mostrarse", { toastError: true });
  };

  const verify = async () => {
    if (!license) return;
    const ok = await confirm({
      title: `¿Marcar la matrícula ${license.text} como verificada?`,
      message:
        "Hacelo solo después de cotejarla en el padrón del colegio o del ministerio. El perfil muestra «Matrícula verificada»; si la persona cambia la matrícula, la verificación se borra sola.",
      confirmLabel: "Marcar verificada",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    await run(() => verifyDirectoryLicense({ profileId }), "Matrícula verificada", { toastError: true });
  };

  const unverify = async () => {
    if (!license) return;
    const ok = await confirm({
      title: "¿Quitar la verificación de la matrícula?",
      message: `El perfil de ${name} deja de mostrar «Matrícula verificada». La matrícula sigue cargada.`,
      confirmLabel: "Quitar la verificación",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!ok) return;
    await run(() => unverifyDirectoryLicense({ profileId }), "Verificación quitada", { toastError: true });
  };

  return (
    <div style={rowActions}>
      {license &&
        (license.verified ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void unverify()} disabled={pending}>
            Quitar verificación
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={() => void verify()} disabled={pending}>
            Verificar matrícula
          </Button>
        ))}
      {hidden ? (
        <>
          <Button type="button" variant="ghost" size="sm" onClick={openDrawer} disabled={pending}>
            Editar motivo
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void show()} disabled={pending}>
            Mostrar
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" size="sm" onClick={openDrawer} disabled={pending}>
          Ocultar
        </Button>
      )}
      <HideReasonDrawer
        key={drawerKey}
        open={drawer}
        title={hidden ? "Editar el motivo" : "Ocultar el perfil"}
        subject={name}
        effect={
          hidden
            ? "Sigue oculto; solo cambia el motivo."
            : "Sale del directorio sin tocar su consentimiento ni su publicación. Los titulares de los consultorios donde atiende ven que Plataforma lo ocultó."
        }
        initial={hidden?.reason ?? ""}
        submitLabel={hidden ? "Guardar el motivo" : "Ocultar"}
        onClose={() => setDrawer(false)}
        onSubmit={(reason) =>
          run(() => hideDirectoryProfile({ profileId, reason }), hidden ? "Motivo actualizado" : "Perfil oculto del directorio", {
            toastError: false,
          })
        }
      />
    </div>
  );
}
