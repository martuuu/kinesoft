"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TenantVertical } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { platformInviteTeamMember } from "@/lib/platform-team";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { INVITABLE_ROLES, isClinicalRole, roleDescription, roleLabel } from "@/lib/roles";
import type { InvitationSendResult } from "@/lib/invitations-types";
import type { InvitableRole } from "./team-logic";
import { InviteResultNotice } from "./invite-result";

/**
 * «Invitar al equipo» desde Plataforma (BO3-C). Drawer con dirty-guard (AGENTS.md §5). Al crear, el Drawer muestra
 * el resultado en vez de cerrarse: si el mail no salió, el superadmin necesita el link para pasárselo a mano
 * (`platformInviteTeamMember` devuelve la URL porque el superadmin actúa como dueño).
 *
 * El cupo lleno lo decide el server (`requireFreeSeatInTx`, con el Tenant lockeado): el aviso de acá es solo para
 * no sorprender, y el mensaje del rechazo se muestra tal cual (ya explica que Secretaria y Facturación no ocupan).
 */
export function InviteDrawer({
  open,
  onClose,
  tenantId,
  vertical,
  seatsFull,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  vertical: TenantVertical;
  seatsFull: boolean;
}) {
  // Se remonta en cada apertura (key) para que el formulario y la foto del dirty-guard arranquen limpios.
  const [instance, setInstance] = useState(0);
  return (
    <InviteDrawerBody
      key={instance}
      open={open}
      onClose={() => {
        onClose();
        setInstance((n) => n + 1);
      }}
      tenantId={tenantId}
      vertical={vertical}
      seatsFull={seatsFull}
    />
  );
}

export function InviteDrawerBody({
  open,
  onClose,
  tenantId,
  vertical,
  seatsFull,
  initialResult = null,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  vertical: TenantVertical;
  seatsFull: boolean;
  /** Solo para el render test (no hay jsdom para enviar el form). */
  initialResult?: InvitationSendResult | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const formRef = useRef<HTMLFormElement>(null);
  const [role, setRole] = useState<InvitableRole>("PRACTITIONER");
  const { dirty, onFormInput } = useFormDirty(formRef, { role });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [result, setResult] = useState<InvitationSendResult | null>(initialResult);

  // BO-Z B1: cerrar limpia TODO (resultado, rol, errores) además del remount por `key` del wrapper. El remount solo
  // corre cuando el cierre pasa por el `onClose` del wrapper; si el padre cierra el Drawer por su cuenta (o lo monta
  // sin el wrapper), al reabrir quedaba el resultado de la invitación anterior (con su link) en vez del form vacío.
  const close = () => {
    setResult(null);
    setRole("PRACTITIONER");
    setError(null);
    setFieldErrors({});
    onClose();
  };

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    setFieldErrors({});
    start(async () => {
      const r = await runPlatform(() =>
        platformInviteTeamMember({
          tenantId,
          email: String(fd.get("email") ?? "").trim(),
          firstName: String(fd.get("firstName") ?? ""),
          lastName: String(fd.get("lastName") ?? ""),
          role,
          specialty: String(fd.get("specialty") ?? ""),
        })
      );
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        toast.error("No se pudo invitar", { description: r.error });
        return;
      }
      setResult(r.data);
      router.refresh();
    });
  };

  const fe = (k: string) => fieldErrors[k]?.[0];

  return (
    <Drawer open={open} onClose={close} title="Invitar al equipo" dirty={!result && dirty}>
      {result ? (
        <div style={{ display: "grid", gap: 14 }}>
          <InviteResultNotice result={result} />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="primary" onClick={close}>
              Listo
            </Button>
          </div>
        </div>
      ) : (
        <form
          ref={formRef}
          onSubmit={submit}
          onInput={onFormInput}
          onChange={onFormInput}
          style={{ display: "grid", gap: 12 }}
          noValidate={false}
        >
          <FormField label="Email" name="email" type="email" required placeholder="persona@ejemplo.com" error={fe("email")} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <FormField label="Nombre" name="firstName" required error={fe("firstName")} />
            <FormField label="Apellido" name="lastName" required error={fe("lastName")} />
          </div>
          <FormField
            as="select"
            label="Rol"
            name="role"
            value={role}
            onChange={(v) => setRole(v as InvitableRole)}
            hint={roleDescription(role, vertical)}
            error={fe("role")}
            options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r, vertical) }))}
          />
          <FormField label="Especialidad (opcional)" name="specialty" placeholder="Osteopatía, RPG…" error={fe("specialty")} />
          {seatsFull && isClinicalRole(role) && (
            <div role="note" style={warnBox}>
              El cupo de profesionales está lleno: esta invitación va a ser rechazada. Ampliá el plan o el cupo a medida, o
              invitá a esa persona como {roleLabel("ASSISTANT", vertical)} o {roleLabel("BILLING", vertical)}, que no ocupan lugar.
            </div>
          )}
          {error && (
            <div role="alert" style={errorBox}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Invitando…" : "Mandar invitación"}
            </Button>
          </div>
        </form>
      )}
    </Drawer>
  );
}

const warnBox: React.CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "rgba(228,176,32,0.15)",
  color: "var(--warn-fg)",
  fontSize: 12.5,
  lineHeight: 1.45,
};

const errorBox: React.CSSProperties = {
  padding: 10,
  borderRadius: 10,
  background: "rgba(159,31,31,0.08)",
  color: "var(--danger-fg)",
  fontSize: 12.5,
  lineHeight: 1.45,
};
