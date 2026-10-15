"use client";

import { useState } from "react";
import type { TenantVertical } from "@prisma/client";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { roleLabel } from "@/lib/roles";
import type { PlatformTeamMemberRow } from "@/lib/invitations-types";
import { memberDisplayName, transferConfirmMatches } from "./team-logic";

/**
 * Transferir la titularidad desde Plataforma (BO3-C). Confirmación REFORZADA: hay que tipear el email del nuevo
 * titular. Un `useConfirm` de un clic no alcanza: el superadmin opera sobre un consultorio ajeno, la acción le saca
 * al dueño actual el control del equipo (pasa a Administrador/a, `changeMemberRoleInTx` con `via: "platform"`) y no
 * tiene «deshacer» desde la cuenta del consultorio. Mismo criterio que suspender / cambiar el slug (tipear el slug).
 */
export function TransferOwnershipDialog({
  member,
  currentOwner,
  vertical,
  pending,
  onCancel,
  onConfirm,
}: {
  member: PlatformTeamMemberRow;
  currentOwner: PlatformTeamMemberRow | null;
  vertical: TenantVertical;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <Modal onClose={onCancel} title="Transferir la titularidad" width={520}>
      <TransferOwnershipForm
        member={member}
        currentOwner={currentOwner}
        vertical={vertical}
        typed={typed}
        onTypedChange={setTyped}
        pending={pending}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

/** Cuerpo sin estado (exportado para el render test: con `renderToStaticMarkup` no se puede tipear). */
export function TransferOwnershipForm({
  member,
  currentOwner,
  vertical,
  typed,
  onTypedChange,
  pending,
  onCancel,
  onConfirm,
}: {
  member: PlatformTeamMemberRow;
  currentOwner: PlatformTeamMemberRow | null;
  vertical: TenantVertical;
  typed: string;
  onTypedChange: (v: string) => void;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ok = transferConfirmMatches(typed, member.email);
  const who = memberDisplayName(member);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !pending) onConfirm();
      }}
      style={{ display: "grid", gap: 12 }}
    >
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
        <strong>{who}</strong> pasa a ser {roleLabel("OWNER", vertical)} del consultorio: gestiona el equipo, los roles y
        la configuración.
        {currentOwner
          ? ` ${memberDisplayName(currentOwner)} deja de ser dueño/a y queda como ${roleLabel("ADMIN", vertical)}.`
          : ""}{" "}
        Desde el consultorio no se puede deshacer.
      </p>
      <FormField
        label={`Para confirmar, escribí el email de ${who}`}
        name="confirmEmail"
        type="email"
        value={typed}
        onChange={onTypedChange}
        placeholder={member.email}
        hint={member.email}
        autoFocus
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!ok || pending}>
          {pending ? "Transfiriendo…" : "Transferir titularidad"}
        </Button>
      </div>
    </form>
  );
}
