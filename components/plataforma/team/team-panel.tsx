"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role, TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import {
  platformChangeMemberRole,
  platformReactivateMember,
  platformRemoveMember,
  platformResendInvitation,
  platformRevokeInvitation,
  platformSendMemberPasswordReset,
  platformSuspendMember,
  platformTransferOwnership,
} from "@/lib/platform-team";
import { inviteEmailStatusCopy, passwordResetEmailStatusCopy } from "@/lib/invitations-constants";
import { isClinicalRole, roleDescription, roleLabel } from "@/lib/roles";
import type {
  InvitationSendResult,
  PlatformTeamInvitationRow,
  PlatformTeamMemberRow,
  PlatformTenantTeam,
} from "@/lib/invitations-types";
import {
  ASSIGNABLE_ROLES,
  OWNER_LOCKED_REASON,
  emailStatusLabel,
  formatARDate,
  formatARDateTime,
  invitationStatusLabel,
  memberActions,
  memberDisplayName,
  seatsSummary,
  type ActionState,
} from "./team-logic";
import { InviteDrawer } from "./invite-drawer";
import { InviteResultNotice } from "./invite-result";
import { TransferOwnershipDialog } from "./transfer-dialog";

/**
 * /plataforma/consultorios/[id]/equipo (BO3-C, plan §19.5). El superadmin gestiona el equipo de un consultorio ajeno
 * con las MISMAS reglas que Configuración → Usuarios (los núcleos de `lib/team-internal.ts`, `via: "platform"`).
 * Molde: `components/configuracion/panels/users-panel.tsx`, sin importarlo (arrastra contextos del consultorio).
 *
 * Errores del server → Toast con el mensaje tal cual (el server ya habla en rioplatense y explica qué hacer).
 * Después de cada acción OK → `router.refresh()` (las actions también revalidan `/plataforma`).
 */
export function PlatformTeamPanel({
  team,
  vertical,
}: {
  team: PlatformTenantTeam;
  vertical: TenantVertical;
}) {
  const [inviting, setInviting] = useState(false);
  const seats = seatsSummary(team.seats);
  const owner = team.members.find((m) => m.role === "OWNER") ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <Card style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <EyebrowLabel>Cupos</EyebrowLabel>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              <span data-testid="seats" style={{ fontSize: 16, fontWeight: 700, color: "var(--navy-900)" }}>
                {seats.text}
              </span>
              {seats.full && <Tag tone="soft">Cupo lleno</Tag>}
            </div>
            <div style={{ fontSize: 12, color: seats.full ? "#7A4A00" : "var(--navy-500)", marginTop: 4, lineHeight: 1.45 }}>
              {seats.hint}
            </div>
          </div>
          <Button variant="primary" onClick={() => setInviting(true)}>
            <IconPlus size={14} /> Invitar
          </Button>
        </div>
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
          <EyebrowLabel>Miembros</EyebrowLabel>
          <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>
            {team.members.length === 1 ? "1 persona" : `${team.members.length} personas`} con acceso al consultorio.
          </div>
        </header>
        {team.members.length === 0 ? (
          <div style={{ padding: "16px 20px", fontSize: 13, color: "var(--navy-500)" }}>
            El consultorio no tiene miembros. Invitá a alguien y, cuando acepte, transferile la titularidad.
          </div>
        ) : (
          <ul aria-label="Miembros del equipo" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {team.members.map((m) => (
              <MemberRow key={m.membershipId} tenantId={team.tenantId} member={m} owner={owner} vertical={vertical} />
            ))}
          </ul>
        )}
      </Card>

      {team.invitations.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
            <EyebrowLabel>Invitaciones sin aceptar</EyebrowLabel>
            <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>
              «Reenviar» manda otro mail (y reabre una vencida, si hay lugar). «Anular» hace que el link deje de valer.
            </div>
          </header>
          <ul aria-label="Invitaciones" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {team.invitations.map((i) => (
              <InvitationItem key={i.id} tenantId={team.tenantId} invite={i} vertical={vertical} />
            ))}
          </ul>
        </Card>
      )}

      <InviteDrawer
        open={inviting}
        onClose={() => setInviting(false)}
        tenantId={team.tenantId}
        vertical={vertical}
        seatsFull={team.seats.full}
      />
    </div>
  );
}

const ROW_STYLE: React.CSSProperties = {
  padding: "14px 20px",
  display: "flex",
  flexWrap: "wrap",
  gap: "10px 16px",
  alignItems: "center",
  borderBottom: "1px solid rgba(15,30,51,0.04)",
};

const LINK_BTN: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--sky-700)",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
  padding: "4px 0",
};

/** Botón-link con su estado. Apagado: el porqué va en `title` del contenedor (un botón disabled no dispara hover en todos los browsers). */
function RowAction({
  state,
  label,
  onClick,
  danger,
  busy,
}: {
  state: ActionState | null;
  label: string;
  onClick: () => void;
  danger?: boolean;
  busy: boolean;
}) {
  if (!state) return null;
  const disabled = !state.enabled || busy;
  return (
    <span title={state.reason} style={{ display: "inline-flex" }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-disabled={disabled}
        aria-label={state.reason ? `${label} (no disponible: ${state.reason})` : undefined}
        style={{
          ...LINK_BTN,
          color: danger ? "#9F1F1F" : LINK_BTN.color,
          opacity: state.enabled ? 1 : 0.45,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        {label}
      </button>
    </span>
  );
}

export function MemberRow({
  tenantId,
  member,
  owner,
  vertical,
}: {
  tenantId: string;
  member: PlatformTeamMemberRow;
  owner: PlatformTeamMemberRow | null;
  vertical: TenantVertical;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  // BO4: suspender, quitar y transferir la titularidad son riesgo high (re-verificación con MFA en enforce).
  const runPlatform = usePlatformAction();
  const [busy, start] = useTransition();
  const [transferring, setTransferring] = useState(false);
  const who = memberDisplayName(member);
  const label = (r: Role) => roleLabel(r, vertical);
  const suspended = !!member.disabledAt;
  const isOwner = member.role === "OWNER";
  const acts = memberActions(member);
  const ref = { tenantId, membershipId: member.membershipId };

  /** Corre la action; error → Toast con el mensaje del server tal cual; OK → refresh. */
  const run = <T,>(
    fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>,
    onOk?: (data: T) => void,
    after?: () => void
  ) => {
    start(async () => {
      const r = await runPlatform(fn);
      after?.();
      if (!r.ok) {
        toast.error("No se pudo completar", { description: r.error });
        return;
      }
      onOk?.(r.data);
      router.refresh();
    });
  };

  const changeRole = async (role: Exclude<Role, "OWNER">) => {
    if (role === member.role) return;
    const agenda = isClinicalRole(role)
      ? member.hasAgenda
        ? ""
        : " Se le crea su agenda con el horario del consultorio."
      : member.hasAgenda
        ? " Deja de atender: sale de la agenda y del turnero. Si tiene turnos futuros o pacientes asignados, primero hay que reasignarlos."
        : "";
    const ok = await confirm({
      title: `¿Cambiar el rol de ${who}?`,
      message: `De ${label(member.role)} a ${label(role)}: ${roleDescription(role, vertical)}${agenda}`,
      confirmLabel: "Cambiar rol",
    });
    if (!ok) return;
    run(() => platformChangeMemberRole({ ...ref, role }), () => toast.success(`${who} ahora es ${label(role)}.`));
  };

  const suspend = async () => {
    const ok = await confirm({
      title: `¿Suspender el acceso de ${who}?`,
      message:
        "No va a poder entrar a este consultorio ni recibir turnos nuevos hasta que lo reactiven. No se borra nada: sus turnos, pacientes e historia quedan como están.",
      confirmLabel: "Suspender",
      tone: "danger",
    });
    if (!ok) return;
    run(
      () => platformSuspendMember(ref),
      ({ futureBookings: n }) => {
        if (n > 0) {
          toast.warning(`${who} quedó suspendido`, {
            description: `Tiene ${n} turno${n === 1 ? "" : "s"} futuro${n === 1 ? "" : "s"}: siguen agendados. El consultorio tiene que reasignarlos o cancelarlos.`,
            duration: 0,
          });
        } else toast.success(`${who} quedó suspendido.`);
      }
    );
  };

  const reactivate = async () => {
    const ok = await confirm({
      title: `¿Reactivar a ${who}?`,
      message: `Vuelve a entrar al consultorio como ${label(member.role)}.${isClinicalRole(member.role) ? " Ocupa un lugar de profesional del cupo." : ""}`,
      confirmLabel: "Reactivar",
    });
    if (!ok) return;
    run(() => platformReactivateMember(ref), () => toast.success(`${who} volvió a tener acceso.`));
  };

  const remove = async () => {
    const ok = await confirm({
      title: `¿Quitar a ${who} del equipo?`,
      message:
        "Deja de tener acceso al consultorio. Si tiene turnos futuros o pacientes asignados, primero hay que reasignarlos. Si solo hay que cortarle el acceso por un tiempo, usá «Suspender».",
      confirmLabel: "Quitar",
      tone: "danger",
    });
    if (!ok) return;
    run(() => platformRemoveMember(ref), () => toast.success(`${who} ya no está en el equipo.`));
  };

  const sendReset = async () => {
    const ok = await confirm({
      title: `¿Mandarle a ${who} un link para cambiar la contraseña?`,
      message: `Le llega por mail a ${member.email}; no lo ves vos. La contraseña actual sigue funcionando hasta que la cambie.`,
      confirmLabel: "Mandar link",
    });
    if (!ok) return;
    run(
      () => platformSendMemberPasswordReset(ref),
      (d) => {
        const c = passwordResetEmailStatusCopy(d.emailStatus, d.emailReason);
        toast.show(c.tone === "ok" ? "success" : c.tone === "warn" ? "warning" : "error", c.text);
      }
    );
  };

  const transfer = () =>
    run(
      () => platformTransferOwnership(ref),
      () => toast.success(`${who} es ahora ${label("OWNER")} del consultorio.`),
      () => setTransferring(false)
    );

  return (
    <li style={ROW_STYLE} data-member={member.membershipId}>
      <div style={{ flex: "1 1 200px", minWidth: 0, opacity: suspended ? 0.65 : 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ overflowWrap: "anywhere" }}>{who}</span>
          {isOwner && <Tag tone="lime">Titular</Tag>}
          {suspended ? <Tag tone="soft">Suspendido</Tag> : null}
          {!member.joinedAt && <Tag tone="soft">Sin aceptar</Tag>}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)", overflowWrap: "anywhere" }}>{member.email}</div>
        <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 2 }}>
          {suspended && member.disabledAt ? `Sin acceso desde el ${formatARDate(member.disabledAt)} · ` : "Activo · "}
          {member.hasAgenda ? "Tiene agenda" : isClinicalRole(member.role) ? "Sin agenda (revisar en Salud)" : "Sin agenda"}
        </div>
      </div>

      <span title={isOwner ? OWNER_LOCKED_REASON : undefined} style={{ display: "inline-flex", flex: "0 0 auto" }}>
        <select
          value={member.role}
          disabled={!acts.changeRole?.enabled || busy}
          onChange={(e) => changeRole(e.target.value as Exclude<Role, "OWNER">)}
          aria-label={`Rol de ${who}`}
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(15,30,51,0.1)",
            background: "rgba(255,255,255,0.7)",
            fontSize: 12.5,
            fontWeight: 600,
            maxWidth: "100%",
          }}
        >
          {/* El dueño muestra su rol (apagado); al resto no se le ofrece OWNER: eso es «Transferir titularidad». */}
          {isOwner && <option value="OWNER">{label("OWNER")}</option>}
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {label(r)}
            </option>
          ))}
        </select>
      </span>

      <div style={{ display: "flex", gap: "4px 12px", flexWrap: "wrap", flex: "1 1 100%", justifyContent: "flex-end" }}>
        <RowAction state={acts.transfer} label="Transferir titularidad" onClick={() => setTransferring(true)} busy={busy} />
        <RowAction state={acts.passwordReset} label="Mandar link para cambiar la contraseña" onClick={sendReset} busy={busy} />
        <RowAction state={acts.reactivate} label="Reactivar" onClick={reactivate} busy={busy} />
        <RowAction state={acts.suspend} label="Suspender" onClick={suspend} danger busy={busy} />
        <RowAction state={acts.remove} label="Quitar del equipo" onClick={remove} danger busy={busy} />
      </div>
      {isOwner && (
        <div style={{ flex: "1 1 100%", fontSize: 11.5, color: "var(--navy-500)" }}>
          Para cambiarle el rol, suspenderlo o quitarlo, primero transferí la titularidad a otra persona del equipo.
        </div>
      )}

      {transferring && (
        <TransferOwnershipDialog
          member={member}
          currentOwner={owner}
          vertical={vertical}
          pending={busy}
          onCancel={() => setTransferring(false)}
          onConfirm={transfer}
        />
      )}
    </li>
  );
}

export function InvitationItem({
  tenantId,
  invite,
  vertical,
}: {
  tenantId: string;
  invite: PlatformTeamInvitationRow;
  vertical: TenantVertical;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const runPlatform = usePlatformAction();
  const [busy, start] = useTransition();
  const [linkResult, setLinkResult] = useState<InvitationSendResult | null>(null);
  const ref = { tenantId, invitationId: invite.id };
  const expired = invite.status === "expired";
  const mail = emailStatusLabel(invite.lastEmailStatus);
  const mailColor = mail.tone === "ok" ? "var(--navy-500)" : mail.tone === "warn" ? "#7A4A00" : "#9F1F1F";

  const resend = async () => {
    const ok = await confirm({
      title: `¿Reenviar la invitación a ${invite.email}?`,
      message: expired
        ? "Estaba vencida: se reabre por otros 7 días y le llega un mail nuevo. Si es para un profesional, ocupa un lugar del cupo."
        : "Le llega otro mail con el link. El que ya tenía sigue valiendo.",
      confirmLabel: "Reenviar",
    });
    if (!ok) return;
    start(async () => {
      const r = await runPlatform(() => platformResendInvitation(ref));
      if (!r.ok) {
        toast.error("No se pudo reenviar", { description: r.error });
        return;
      }
      const c = inviteEmailStatusCopy(r.data.emailStatus, r.data.emailReason);
      if (r.data.emailSent) toast.success(c.text);
      else setLinkResult(r.data); // el mail no salió: se muestra el link para pasarlo a mano
      router.refresh();
    });
  };

  const revoke = async () => {
    const ok = await confirm({
      title: `¿Anular la invitación a ${invite.email}?`,
      message: "El link deja de funcionar. Si después hay que sumarlo, se lo invita de nuevo.",
      confirmLabel: "Anular",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await runPlatform(() => platformRevokeInvitation(ref));
      if (!r.ok) {
        toast.error("No se pudo anular", { description: r.error });
        return;
      }
      toast.success("Invitación anulada.");
      router.refresh();
    });
  };

  return (
    <li style={ROW_STYLE} data-invitation={invite.id}>
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ overflowWrap: "anywhere" }}>
            {invite.firstName} {invite.lastName}
          </span>
          <Tag tone={expired ? "soft" : "sky"}>{invitationStatusLabel(invite)}</Tag>
          <Tag tone="soft">{roleLabel(invite.role, vertical)}</Tag>
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)", overflowWrap: "anywhere" }}>{invite.email}</div>
        <div style={{ fontSize: 11, marginTop: 2, color: "var(--navy-500)" }}>
          {invite.lastSentAt ? `Último envío: ${formatARDateTime(invite.lastSentAt)}` : "Sin envíos"}
          {invite.sendCount > 1 ? ` · ${invite.sendCount} envíos` : ""}
          {" · "}
          <span style={{ color: mailColor }}>{mail.text}</span>
          {" · "}
          <span style={{ color: expired ? "#9F1F1F" : "var(--navy-500)" }}>
            {expired ? "Venció el " : "Vence el "}
            {formatARDate(invite.expiresAt)}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "flex-end", flex: "0 0 auto" }}>
        <button type="button" onClick={resend} disabled={busy} style={LINK_BTN}>
          Reenviar
        </button>
        <button type="button" onClick={revoke} disabled={busy} style={{ ...LINK_BTN, color: "#9F1F1F" }}>
          Anular
        </button>
      </div>
      {linkResult && (
        <Modal onClose={() => setLinkResult(null)} title="Invitación reenviada" width={520}>
          <InviteResultNotice result={linkResult} />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setLinkResult(null)}>
              Cerrar
            </Button>
          </div>
        </Modal>
      )}
    </li>
  );
}
