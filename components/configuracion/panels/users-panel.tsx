"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role, TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { IconCheck, IconPlus } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { InvitationRow, InvitationSendResult, TeamMemberRow } from "@/lib/invitations-types";
import { inviteEmailStatusCopy } from "@/lib/invitations-constants";
import {
  createInvitation,
  resendInvitation,
  revokeInvitation,
  regenerateInvitationUrl,
  changeMemberRole,
  removeMember,
} from "@/lib/invitations";
import { ROLE_ORDER, INVITABLE_ROLES, roleLabel, roleDescription } from "@/lib/roles";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { ErrorBox } from "../controls";

// IAM-D3: el equipo lo gestionan OWNER y ADMIN. El ADMIN no puede tocar al dueño ni dar el rol de dueño: el server lo
// rechaza (`requireTeamManager` en lib/invitations.ts) y la UI no lo ofrece.
export function UsersPanel({
  team,
  pending: pendingInvites,
  viewerRole = "OWNER",
}: {
  team: TeamMemberRow[];
  pending: InvitationRow[];
  viewerRole?: Role;
}) {
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<InvitationSendResult | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <header
          style={{
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <div>
            <EyebrowLabel>Equipo</EyebrowLabel>
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
              Profesionales y administrativos con acceso al consultorio.
            </div>
          </div>
          <Button variant="primary" onClick={() => setInviting(true)}>
            <IconPlus size={14} /> Invitar usuario
          </Button>
        </header>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {team.map((m) => (
            <TeamRow key={m.membershipId} member={m} viewerIsAdmin={viewerRole === "ADMIN"} />
          ))}
        </ul>
      </Card>

      {pendingInvites.length > 0 && (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
            <EyebrowLabel>Invitaciones pendientes</EyebrowLabel>
            <div style={{ fontSize: 12, color: "var(--navy-500)", marginTop: 4 }}>
              Compartí el link con el invitado. Al aceptarlo, se suma al equipo.
            </div>
          </header>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {pendingInvites.map((i) => (
              <PendingInviteRow key={i.id} invite={i} />
            ))}
          </ul>
        </Card>
      )}

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onSuccess={(result) => {
            setInviting(false);
            setInviteResult(result);
          }}
        />
      )}
      {inviteResult && (
        <ShareInviteModal result={inviteResult} onClose={() => setInviteResult(null)} />
      )}
    </div>
  );
}

/**
 * Vertical del consultorio para la etiqueta del profesional (IAM-0c):
 * «Kinesiólogo/a» o «Profesional». El contexto de módulos no trae la
 * vertical, pero `sesiones` existe solo en Kinesiología (`lib/tenant-modules.ts`)
 * y es independiente del plan. Fuera del provider (render tests) el default
 * es Kine, igual que el del contexto.
 */
function useTenantVertical(): TenantVertical {
  return useTenantModules().has("sesiones") ? "KINESIOLOGY" : "GENERAL";
}

function TeamRow({ member, viewerIsAdmin = false }: { member: TeamMemberRow; viewerIsAdmin?: boolean }) {
  const ownerLocked = viewerIsAdmin && member.role === "OWNER";
  const router = useRouter();
  const vertical = useTenantVertical();
  const label = (r: Role) => roleLabel(r, vertical);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirm = useConfirm();
  const changeRole = async (role: Role) => {
    if (member.isYou || role === member.role) return;
    const who = member.fullName ?? member.email;
    // A2b-S-cfg: el <select> cambiaba el rol al instante, sin confirmar. Un
    // cambio de rol cambia qué puede ver y tocar esa persona, y transferir el
    // OWNER te deja a vos como Admin sin vuelta atrás desde tu cuenta: ese
    // caso lleva una segunda confirmación explícita.
    if (role === "OWNER") {
      const first = await confirm({
        title: `¿Transferir la titularidad a ${who}?`,
        message:
          `Pasa a ser el dueño del consultorio: gestiona el equipo, los roles y la configuración. Vos quedás como ${label("ADMIN")} y no vas a poder deshacerlo desde tu cuenta.`,
        confirmLabel: "Continuar",
        tone: "danger",
      });
      if (!first) return;
      const second = await confirm({
        title: "Confirmá la transferencia",
        message: `${who} va a ser ${label("OWNER")} del consultorio y vos pasás a ${label("ADMIN")}. ¿Seguro?`,
        confirmLabel: "Sí, transferir",
        tone: "danger",
      });
      if (!second) return;
    } else {
      const ok = await confirm({
        title: `¿Cambiar el rol de ${who}?`,
        message: `De ${label(member.role)} a ${label(role)}: ${roleDescription(role, vertical)}`,
        confirmLabel: "Cambiar rol",
      });
      if (!ok) return;
    }
    setError(null);
    start(async () => {
      const r = await changeMemberRole(member.membershipId, role);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };
  const remove = async () => {
    const ok = await confirm({
      title: `¿Quitar a ${member.fullName ?? member.email} del equipo?`,
      message:
        "Deja de tener acceso al consultorio. Si tiene turnos futuros o pacientes asignados, primero tenés que reasignarlos.",
      confirmLabel: "Quitar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await removeMember(member.membershipId);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <li
      style={{
        padding: "14px 20px",
        display: "grid",
        gridTemplateColumns: "1.5fr 1fr 140px 110px",
        gap: 14,
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.04)",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {member.fullName ?? member.email}
          {member.isYou && (
            <span style={{ marginLeft: 6, fontSize: 11, color: "var(--sky-700)", fontWeight: 700 }}>
              (vos)
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{member.email}</div>
      </div>
      <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
        {member.specialty ?? "—"}
      </div>
      <select
        value={member.role}
        disabled={member.isYou || pending || ownerLocked}
        onChange={(e) => changeRole(e.target.value as Role)}
        style={{
          padding: "8px 10px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: "rgba(255,255,255,0.7)",
          fontSize: 12.5,
          fontWeight: 600,
        }}
      >
        {ROLE_ORDER.filter((r) => !viewerIsAdmin || r !== "OWNER" || member.role === "OWNER").map((r) => (
          <option key={r} value={r}>
            {label(r)}
          </option>
        ))}
      </select>
      <div style={{ textAlign: "right" }}>
        {!member.isYou && !ownerLocked && (
          <button
            type="button"
            onClick={remove}
            disabled={pending}
            style={{
              background: "transparent",
              border: "none",
              color: "#9F1F1F",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Quitar
          </button>
        )}
        {error && <div style={{ fontSize: 11, color: "#9F1F1F", marginTop: 4 }}>{error}</div>}
      </div>
    </li>
  );
}

/**
 * IAM-2a: la fila muestra el estado de envío real (de `EmailLog`) y separa las tres acciones de C-IAM5:
 * «Reenviar» (otro mail; el link anterior sigue valiendo), «Generar link nuevo» (anula los anteriores: para un
 * link que se compartió donde no debía) y «Anular» (la invitación deja de valer; queda como historia).
 */
function PendingInviteRow({ invite }: { invite: InvitationRow }) {
  const router = useRouter();
  const vertical = useTenantVertical();
  const [pending, start] = useTransition();
  const [shareResult, setShareResult] = useState<InvitationSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const run = (fn: () => Promise<{ ok: true; data: InvitationSendResult } | { ok: false; error: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) {
        setShareResult(r.data);
        router.refresh();
      } else setError(r.error);
    });
  };
  const resend = () => run(() => resendInvitation(invite.id));
  const regen = async () => {
    const ok = await confirm({
      title: "¿Generar un link nuevo?",
      message: "Los links que ya mandaste dejan de funcionar y le llega un mail nuevo al invitado.",
      confirmLabel: "Generar link nuevo",
    });
    if (ok) run(() => regenerateInvitationUrl(invite.id));
  };
  const revoke = async () => {
    const ok = await confirm({
      title: `¿Anular la invitación a ${invite.email}?`,
      message: "El link deja de funcionar. Si después querés sumarlo, lo invitás de nuevo.",
      confirmLabel: "Anular",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await revokeInvitation(invite.id);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  };

  const tz = { timeZone: "America/Argentina/Buenos_Aires" } as const;
  const expired = invite.status === "expired";
  const last = invite.lastEmail ? inviteEmailStatusCopy(invite.lastEmail.status, invite.lastEmail.reason) : null;
  const linkStyle = {
    background: "transparent",
    border: "none",
    color: "var(--sky-700)",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 700,
    padding: 0,
  } as const;

  return (
    <>
      <li
        style={{
          padding: "12px 20px",
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 150px 210px",
          gap: 14,
          alignItems: "center",
          borderBottom: "1px solid rgba(15,30,51,0.04)",
        }}
      >
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            {invite.firstName} {invite.lastName}
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{invite.email}</div>
          {last && (
            <div style={{ fontSize: 11, marginTop: 2, color: last.tone === "ok" ? "var(--navy-500)" : last.tone === "warn" ? "#7A4A00" : "#9F1F1F" }}>
              {last.tone === "ok" ? "Mail enviado" : "Mail no enviado"}
              {invite.lastSentAt && ` · ${invite.lastSentAt.toLocaleDateString("es-AR", tz)}`}
              {invite.sendCount > 1 && ` · ${invite.sendCount} envíos`}
            </div>
          )}
          {error && <div style={{ fontSize: 11, color: "#9F1F1F", marginTop: 2 }}>{error}</div>}
        </div>
        <Tag tone="soft">{roleLabel(invite.role, vertical)}</Tag>
        <div style={{ fontSize: 11, color: expired ? "#9F1F1F" : "var(--navy-500)" }}>
          {expired ? "Venció el " : "Vence "}
          {invite.expiresAt.toLocaleDateString("es-AR", tz)}
        </div>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={resend} disabled={pending} style={linkStyle}>
            Reenviar
          </button>
          <button type="button" onClick={regen} disabled={pending} style={linkStyle}>
            Generar link nuevo
          </button>
          <button type="button" onClick={revoke} disabled={pending} style={{ ...linkStyle, color: "#9F1F1F" }}>
            Anular
          </button>
        </div>
      </li>
      {shareResult && <ShareInviteModal result={shareResult} onClose={() => setShareResult(null)} />}
    </>
  );
}

function InviteModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (result: InvitationSendResult) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const vertical = useTenantVertical();
  // Controlado solo para mostrar la descripción del rol elegido debajo: un
  // <option> nativo no admite una segunda línea. El valor sigue viajando por
  // FormData (`name="role"`), como antes.
  const [role, setRole] = useState<Role>("PRACTITIONER");

  const submit = (formData: FormData) => {
    setError(null);
    start(async () => {
      const r = await createInvitation({
        email: String(formData.get("email") ?? ""),
        firstName: String(formData.get("firstName") ?? ""),
        lastName: String(formData.get("lastName") ?? ""),
        role: formData.get("role") as
          | "PRACTITIONER"
          | "ADMIN"
          | "ASSISTANT"
          | "BILLING",
        specialty: String(formData.get("specialty") ?? ""),
      });
      if (!r.ok) setError(r.error);
      else {
        router.refresh();
        onSuccess(r.data);
      }
    });
  };

  return (
    <Modal onClose={onClose} title="Invitar usuario" width={520}>
      <form action={submit} style={{ display: "grid", gap: 12 }}>
        <FormField label="Email" name="email" type="email" required placeholder="kine@ejemplo.com" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="Nombre" name="firstName" required />
          <FormField label="Apellido" name="lastName" required />
        </div>
        <FormField
          as="select"
          label="Rol"
          name="role"
          value={role}
          onChange={(v) => setRole(v as Role)}
          hint={roleDescription(role, vertical)}
          options={INVITABLE_ROLES.map((r) => ({ value: r, label: roleLabel(r, vertical) }))}
        />
        <FormField label="Especialidad (opcional)" name="specialty" placeholder="Osteopatía, RPG…" />
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creando…" : "Crear invitación"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Resultado de invitar / reenviar / generar link nuevo. IAM-2a: el estado del mail sale del resultado real de
 * `sendEmail` (antes: «Email enviado vía Supabase» o «Configurá SUPABASE_SERVICE_ROLE_KEY», ninguno cierto). El
 * link solo viene para el OWNER (`url` null para el ADMIN: es una credencial).
 */
function ShareInviteModal({ result, onClose }: { result: InvitationSendResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = result.url;
  const status = inviteEmailStatusCopy(result.emailStatus, result.emailReason);
  const copy = () => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Modal
      onClose={onClose}
      title={url ? "Link de invitación" : "Invitación"}
      description={
        url
          ? "Si hace falta, también podés compartirle este link al invitado."
          : result.emailSent
            ? "Le llega un mail al invitado con el link para sumarse."
            : "El mail no salió. Probá «Reenviar» más tarde o pedile al dueño del consultorio el link."
      }
      width={520}
    >
      <div
        role="status"
        style={{
          padding: 10,
          borderRadius: 10,
          background: status.tone === "ok" ? "rgba(200,245,100,0.18)" : status.tone === "warn" ? "rgba(228,176,32,0.15)" : "rgba(159,31,31,0.08)",
          color: status.tone === "ok" ? "var(--navy-900)" : status.tone === "warn" ? "#7A4A00" : "#9F1F1F",
          fontSize: 12.5,
          marginBottom: 10,
        }}
      >
        {status.text}
      </div>
      {url && (
      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "rgba(15,30,51,0.04)",
          fontSize: 12,
          wordBreak: "break-all",
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 10,
        }}
      >
        {url}
      </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
        {url && (
          <Button variant="primary" onClick={copy}>
            {copied ? <><IconCheck size={12} stroke={3} /> Copiado</> : "Copiar link"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
