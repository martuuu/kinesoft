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
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import {
  createInvitation,
  revokeInvitation,
  regenerateInvitationUrl,
  changeMemberRole,
  removeMember,
} from "@/lib/invitations";
import { ROLE_ORDER, INVITABLE_ROLES, roleLabel, roleDescription } from "@/lib/roles";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { ErrorBox } from "../controls";

export function UsersPanel({ team, pending: pendingInvites }: { team: TeamMemberRow[]; pending: InvitationRow[] }) {
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url: string; emailSent: boolean } | null>(null);

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
            <TeamRow key={m.membershipId} member={m} />
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
          onSuccess={(url, emailSent) => {
            setInviting(false);
            setInviteResult({ url, emailSent });
          }}
        />
      )}
      {inviteResult && (
        <ShareInviteModal
          url={inviteResult.url}
          emailSent={inviteResult.emailSent}
          onClose={() => setInviteResult(null)}
        />
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

function TeamRow({ member }: { member: TeamMemberRow }) {
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
        disabled={member.isYou || pending}
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
        {ROLE_ORDER.map((r) => (
          <option key={r} value={r}>
            {label(r)}
          </option>
        ))}
      </select>
      <div style={{ textAlign: "right" }}>
        {!member.isYou && (
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

function PendingInviteRow({ invite }: { invite: InvitationRow }) {
  const router = useRouter();
  const vertical = useTenantVertical();
  const [pending, start] = useTransition();
  const [shareResult, setShareResult] = useState<{ url: string; emailSent: boolean } | null>(null);

  const regen = () => {
    start(async () => {
      const r = await regenerateInvitationUrl(invite.id);
      if (r.ok) setShareResult({ url: r.data.url, emailSent: r.data.emailSent });
    });
  };
  const confirm = useConfirm();
  const revoke = async () => {
    const ok = await confirm({
      title: `¿Revocar la invitación a ${invite.email}?`,
      confirmLabel: "Revocar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      const r = await revokeInvitation(invite.id);
      if (r.ok) router.refresh();
    });
  };

  return (
    <>
      <li
        style={{
          padding: "12px 20px",
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr 130px 130px",
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
        </div>
        <Tag tone="soft">{roleLabel(invite.role, vertical)}</Tag>
        <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
          Vence {invite.expiresAt.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={regen}
            disabled={pending}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--sky-700)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Reenviar
          </button>
          <button
            type="button"
            onClick={revoke}
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
            Revocar
          </button>
        </div>
      </li>
      {shareResult && (
        <ShareInviteModal
          url={shareResult.url}
          emailSent={shareResult.emailSent}
          onClose={() => setShareResult(null)}
        />
      )}
    </>
  );
}

function InviteModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: (url: string, emailSent: boolean) => void;
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
        onSuccess(r.data.url, r.data.emailSent);
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

function ShareInviteModal({
  url,
  emailSent,
  onClose,
}: {
  url: string;
  emailSent?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Modal
      onClose={onClose}
      title="Link de invitación"
      description={
        emailSent
          ? "Mandamos el email al invitado. Como backup, también podés compartirle este link."
          : "No pudimos mandar el email automáticamente. Pasale este link al invitado para que se registre."
      }
      width={520}
    >
      {emailSent !== undefined && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: emailSent ? "rgba(200,245,100,0.18)" : "rgba(228,176,32,0.15)",
            color: emailSent ? "var(--navy-900)" : "#7A4A00",
            fontSize: 12.5,
            marginBottom: 10,
          }}
        >
          {emailSent
            ? "✓ Email enviado vía Supabase."
            : "⚠ Email no enviado. Configurá SUPABASE_SERVICE_ROLE_KEY en el server o compartí el link manualmente."}
        </div>
      )}
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="ghost" onClick={onClose}>
          Cerrar
        </Button>
        <Button variant="primary" onClick={copy}>
          {copied ? <><IconCheck size={12} stroke={3} /> Copiado</> : "Copiar link"}
        </Button>
      </div>
    </Modal>
  );
}
