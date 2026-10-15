"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
import { inviteEmailStatusCopy, passwordResetEmailStatusCopy } from "@/lib/invitations-constants";
import {
  createInvitation,
  resendInvitation,
  revokeInvitation,
  regenerateInvitationUrl,
  changeMemberRole,
  removeMember,
  suspendMember,
  reactivateMember,
  sendMemberPasswordReset,
} from "@/lib/invitations";
import { ROLE_ORDER, INVITABLE_ROLES, roleLabel, roleDescription, isClinicalRole } from "@/lib/roles";
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
              {/* IAM-4c: antes decía «Compartí el link», pero la lista nunca muestra el link (se guarda hasheado). */}
              Le mandamos un mail con el link. Si no le llegó, usá «Reenviar». Al aceptarlo, se suma al equipo.
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
 * «Kinesiólogo/a» o «Profesional». Desde EV1 el contexto trae la vertical real
 * (antes se deducía de `has("sesiones")`). Fuera del provider (render tests)
 * el default es Kine, igual que el resto del contexto.
 */
function useTenantVertical(): TenantVertical {
  return useTenantModules().vertical;
}

type RowNotice = { tone: "ok" | "warn" | "error"; text: string };

const NOTICE_COLOR: Record<RowNotice["tone"], string> = { ok: "var(--navy-500)", warn: "#7A4A00", error: "#9F1F1F" };

/**
 * Fila de un miembro (IAM-4c). El rol se cambia con el <select> (como antes); el resto de las acciones van en el
 * menú «⋯»: «Suspender acceso» / «Reactivar», «Mandar link para nueva contraseña» y «Quitar del equipo». Todas
 * confirman con `useConfirm` y el resultado (o el rechazo del server, p. ej. «Reasigná sus N turnos…») queda
 * escrito debajo de la fila. Ni la fila propia ni la del dueño (para un ADMIN) ofrecen acciones: el server igual
 * las rechaza (`lib/invitations.ts`).
 */
function TeamRow({ member, viewerIsAdmin = false }: { member: TeamMemberRow; viewerIsAdmin?: boolean }) {
  const ownerLocked = viewerIsAdmin && member.role === "OWNER";
  const router = useRouter();
  const vertical = useTenantVertical();
  const label = (r: Role) => roleLabel(r, vertical);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<RowNotice | null>(null);
  const suspended = !!member.disabledAt;
  const who = member.fullName ?? member.email;
  const tz = { timeZone: "America/Argentina/Buenos_Aires" } as const;

  const confirm = useConfirm();
  const changeRole = async (role: Role) => {
    if (member.isYou || role === member.role) return;
    // A2b-S-cfg: el <select> cambiaba el rol al instante, sin confirmar. Un
    // cambio de rol cambia qué puede ver y tocar esa persona, y transferir el
    // OWNER te deja a vos como Admin sin vuelta atrás desde tu cuenta: ese
    // caso lleva una segunda confirmación explícita.
    if (role === "OWNER") {
      const first = await confirm({
        title: `¿Transferir la titularidad a ${who}?`,
        message:
          `Pasa a ser el titular del consultorio: gestiona el equipo, los roles y la configuración. Vos quedás como ${label("ADMIN")} y no vas a poder deshacerlo desde tu cuenta.`,
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
      // IAM-4c: el rol decide si atiende. Se avisa qué pasa con su agenda antes de confirmar.
      const agenda = isClinicalRole(role)
        ? member.hasAgenda
          ? ""
          : " Se le crea su agenda con el horario del consultorio."
        : member.hasAgenda
          ? " Deja de atender: sale de la agenda y del turnero. Si tiene turnos futuros o pacientes asignados, primero reasignalos."
          : "";
      const ok = await confirm({
        title: `¿Cambiar el rol de ${who}?`,
        message: `De ${label(member.role)} a ${label(role)}: ${roleDescription(role, vertical)}${agenda}`,
        confirmLabel: "Cambiar rol",
      });
      if (!ok) return;
    }
    setNotice(null);
    start(async () => {
      const r = await changeMemberRole(member.membershipId, role);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  };

  const suspend = async () => {
    const ok = await confirm({
      title: `¿Suspender el acceso de ${who}?`,
      message:
        "No va a poder entrar a este consultorio ni recibir turnos nuevos hasta que lo reactives. No se borra nada: sus turnos, pacientes e historia quedan como están.",
      confirmLabel: "Suspender",
      tone: "danger",
    });
    if (!ok) return;
    setNotice(null);
    start(async () => {
      const r = await suspendMember(member.membershipId);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      const n = r.data.futureBookings;
      if (n > 0) {
        setNotice({
          tone: "warn",
          text: `Tiene ${n} turno${n === 1 ? "" : "s"} futuro${n === 1 ? "" : "s"}: siguen agendados. Reasignalos o cancelalos si no los va a atender.`,
        });
      }
      router.refresh();
    });
  };

  const reactivate = async () => {
    const ok = await confirm({
      title: `¿Reactivar a ${who}?`,
      message: `Vuelve a entrar al consultorio como ${label(member.role)}.`,
      confirmLabel: "Reactivar",
    });
    if (!ok) return;
    setNotice(null);
    start(async () => {
      const r = await reactivateMember(member.membershipId);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  };

  const sendReset = async () => {
    const ok = await confirm({
      title: `¿Mandarle a ${who} un link para crear una contraseña nueva?`,
      message: `Le llega un mail a ${member.email} con un link para elegir su contraseña. Vos no ves el link ni la contraseña. La actual sigue funcionando hasta que la cambie.`,
      confirmLabel: "Mandar link",
    });
    if (!ok) return;
    setNotice(null);
    start(async () => {
      const r = await sendMemberPasswordReset(member.membershipId);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      setNotice(passwordResetEmailStatusCopy(r.data.emailStatus, r.data.emailReason));
      router.refresh();
    });
  };

  const remove = async () => {
    const ok = await confirm({
      title: `¿Quitar a ${who} del equipo?`,
      message:
        "Deja de tener acceso al consultorio. Si tiene turnos futuros o pacientes asignados, primero tenés que reasignarlos. Si solo querés cortarle el acceso por un tiempo, usá «Suspender acceso».",
      confirmLabel: "Quitar",
      tone: "danger",
    });
    if (!ok) return;
    setNotice(null);
    start(async () => {
      const r = await removeMember(member.membershipId);
      if (!r.ok) setNotice({ tone: "error", text: r.error });
      else router.refresh();
    });
  };

  const lastReset = member.lastPasswordResetEmail;
  const actions: MemberAction[] = [
    suspended
      ? { label: "Reactivar", onSelect: reactivate }
      : { label: "Suspender acceso", onSelect: suspend, danger: true },
    // A un suspendido no se le manda un link para entrar: primero se reactiva (el server también lo frena).
    ...(suspended ? [] : [{ label: "Mandar link para nueva contraseña", onSelect: sendReset }]),
    { label: "Quitar del equipo", onSelect: remove, danger: true },
  ];

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
      <div style={{ opacity: suspended ? 0.65 : 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {who}
          {member.isYou && (
            <span style={{ fontSize: 11, color: "var(--sky-700)", fontWeight: 700 }}>(vos)</span>
          )}
          {suspended && <Tag tone="soft">Suspendido</Tag>}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{member.email}</div>
        {suspended && member.disabledAt && (
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 2 }}>
            Sin acceso desde el {member.disabledAt.toLocaleDateString("es-AR", tz)}
          </div>
        )}
        {!notice && lastReset && (
          <div style={{ fontSize: 11, marginTop: 2, color: lastReset.status === "sent" ? "var(--navy-500)" : "#9F1F1F" }}>
            {lastReset.status === "sent" ? "Link de contraseña enviado" : "Link de contraseña no enviado"}
            {` · ${lastReset.at.toLocaleDateString("es-AR", tz)}`}
          </div>
        )}
      </div>
      <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
        {member.specialty ?? "—"}
      </div>
      <select
        value={member.role}
        disabled={member.isYou || pending || ownerLocked}
        onChange={(e) => changeRole(e.target.value as Role)}
        aria-label={`Rol de ${who}`}
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
        {/* El dueño no se suspende ni se quita desde acá; el ADMIN no toca al dueño (IAM-D3). */}
        {!member.isYou && !ownerLocked && member.role !== "OWNER" && (
          <MemberActionsMenu who={who} actions={actions} disabled={pending} />
        )}
        {!member.isYou && !ownerLocked && member.role === "OWNER" && (
          <MemberActionsMenu who={who} actions={[{ label: "Mandar link para nueva contraseña", onSelect: sendReset }]} disabled={pending} />
        )}
      </div>
      {notice && (
        <div role="status" style={{ gridColumn: "1 / -1", fontSize: 11.5, color: NOTICE_COLOR[notice.tone], marginTop: -6 }}>
          {notice.text}
        </div>
      )}
    </li>
  );
}

type MemberAction = { label: string; onSelect: () => void; danger?: boolean };

/** Menú «⋯» de la fila (mismo patrón que `components/patients/patient-row-actions.tsx`: cierra con click afuera o Escape). */
function MemberActionsMenu({ who, actions, disabled }: { who: string; actions: MemberAction[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex", justifyContent: "flex-end" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label={`Acciones para ${who}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          border: "none",
          background: open ? "rgba(31,79,190,0.1)" : "transparent",
          color: "var(--navy-500)",
          cursor: disabled ? "default" : "pointer",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{ position: "absolute", top: 30, right: 0, width: 250, borderRadius: 12, padding: 4, zIndex: 25, textAlign: "left" }}
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 500,
                color: a.danger ? "#9F1F1F" : "var(--navy-700)",
                borderRadius: 8,
                cursor: "pointer",
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
        <FormField label="Email" name="email" type="email" required placeholder="nombre@ejemplo.com" />
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
        <FormField
          label="Especialidad (opcional)"
          name="specialty"
          // EV1-C2: el ejemplo de Kine no sirve en Clínica general.
          placeholder={vertical === "GENERAL" ? "Clínica médica, Nutrición…" : "Osteopatía, RPG…"}
        />
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
            : // IAM-4c: antes mandaba a «pedirle el link al dueño», que tampoco lo puede ver después de crear la invitación.
              "El mail no salió. Probá «Reenviar» en unos minutos."
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
