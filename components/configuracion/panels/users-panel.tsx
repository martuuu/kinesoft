"use client";

import { displayUserName } from "@/lib/display-name";
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
import { StepUpProvider, useStepUpAction } from "@/components/account/step-up-modal";
import type { InvitationRow, InvitationSendResult, TeamMemberRow } from "@/lib/invitations-types";
import type { TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";
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
  setMemberClinical,
  setMemberGrants,
  transferOwnership,
} from "@/lib/invitations";
import { ROLE_ORDER, INVITABLE_ROLES, roleLabel, roleDescription, isClinicalMember } from "@/lib/roles";
import { canAddSeat, seatKindOf } from "@/lib/plan-catalog";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { PublicBookingSwitch } from "./practitioners/public-booking-switch";
import { ErrorBox, Switch } from "../controls";

/** Roles del selector de un miembro. OWNER no: la titularidad se transfiere aparte (con confirmación y step-up). */
const ASSIGNABLE_ROLES: readonly Role[] = ROLE_ORDER.filter((r) => r !== "OWNER");

/**
 * Rótulo de un miembro (PL-3b): «Titular» / «Titular (sin agenda)» según atienda; el resto por su rol
 * («Administrador/a», «Kinesiólogo/a» o «Profesional», «Secretario/a», «Facturación»). Exportada para el test.
 */
export function memberRoleLabel(m: Pick<TeamMemberRow, "role" | "clinical">, vertical: TenantVertical): string {
  return roleLabel(m.role, vertical, { clinical: isClinicalMember(m) });
}

/**
 * «¿Atiende?» al invitar (§20.17): lo define el rol. Profesional sí; Administrador/a, Secretaría y Facturación no.
 * Exportada para el test.
 */
export function inviteAttendsCopy(role: Role): string {
  if (role === "PRACTITIONER") return "Atiende pacientes: tiene agenda propia y ocupa un lugar del plan.";
  const base = "No atiende pacientes: no tiene agenda ni ve historias clínicas.";
  return role === "ADMIN" ? `${base} Entra con permiso para cambiar la Configuración.` : base;
}

// PL-Z M3: el copy anterior hablaba de «lugar de profesional / no clínico del plan», una distinción que el plan no
// muestra en ningún lado (el cupo es uno: «Lugares»). Se dice solo lo que cambia para la persona.
const ATTENDS_ON_COPY = "Tenés agenda propia, ves historias clínicas y podés aparecer en el turnero online.";
const ATTENDS_OFF_COPY = "No tenés agenda ni aparecés en el turnero, y no ves historias clínicas (como la Secretaría).";

/*
 * IAM-D3 → PL-3b: el equipo lo gestiona quien tiene «Configuración» (`tenant.admin`): el Titular, o quien la tenga
 * delegada, con los límites del Administrador/a (no toca al Titular ni lo transfiere). SOLO el Titular ve y cambia
 * los permisos delegados, su propio «Atiendo pacientes» y transfiere la titularidad; esas tres piden step-up
 * (`StepUpProvider`, PL-D11). El server lo rechaza igual (`lib/invitations.ts`): esto solo evita ofrecerlo.
 */
export function UsersPanel({
  team,
  pending: pendingInvites,
  viewerRole = "OWNER",
  seats,
}: {
  team: TeamMemberRow[];
  pending: InvitationRow[];
  viewerRole?: Role;
  /** Cupos del plan (`planUsage.seats` de Configuración, `seatsSummary`). Sin él no se muestra el indicador. */
  seats?: TenantPlanUsageView["seats"];
}) {
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<InvitationSendResult | null>(null);
  const viewerIsOwner = viewerRole === "OWNER";

  return (
    <StepUpProvider>
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <header
          style={{
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            borderBottom: "1px solid rgba(15,30,51,0.06)",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 240px" }}>
            <EyebrowLabel>Equipo</EyebrowLabel>
            <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
              Profesionales y administrativos con acceso al consultorio.
            </div>
            {seats && (
              <div data-testid="team-seats" style={{ marginTop: 6, display: "grid", gap: 2 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--navy-900)" }}>Lugares: {seats.value}</span>
                  {seats.full && <Tag tone="soft">Cupo lleno</Tag>}
                </div>
                {seats.detail && (
                  <div style={{ fontSize: 11.5, color: seats.full ? "var(--warn-fg)" : "var(--navy-500)", lineHeight: 1.4 }}>
                    {seats.detail}
                  </div>
                )}
              </div>
            )}
          </div>
          <Button variant="primary" onClick={() => setInviting(true)}>
            <IconPlus size={14} /> Invitar usuario
          </Button>
        </header>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {team.map((m) => (
            <TeamRow key={m.membershipId} member={m} viewerIsOwner={viewerIsOwner} currentOwner={team.find((x) => x.role === "OWNER") ?? null} />
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
          seats={seats}
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
    </StepUpProvider>
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

const NOTICE_COLOR: Record<RowNotice["tone"], string> = { ok: "var(--navy-500)", warn: "var(--warn-fg)", error: "var(--danger-fg)" };

/**
 * Fila de un miembro (IAM-4c → PL-3b). El rol se cambia con el <select> (salvo el del Titular, que se transfiere);
 * el resto de las acciones van en el menú «⋯»: «Transferir titularidad» (solo el Titular), «Suspender acceso» /
 * «Reactivar», «Mandar link para nueva contraseña» y «Quitar del equipo». Debajo, según corresponda: «Atiendo
 * pacientes» (fila propia del Titular), los permisos delegados (solo los ve el Titular) y «Aparece en el turnero
 * online» (quien atiende). Todo confirma con `useConfirm` y el resultado (o el rechazo del server) queda escrito
 * debajo de la fila.
 */
function TeamRow({
  member,
  viewerIsOwner = false,
  currentOwner = null,
}: {
  member: TeamMemberRow;
  viewerIsOwner?: boolean;
  currentOwner?: TeamMemberRow | null;
}) {
  const isOwnerRow = member.role === "OWNER";
  const ownerLocked = !viewerIsOwner && isOwnerRow;
  const router = useRouter();
  const vertical = useTenantVertical();
  const label = (r: Role) => roleLabel(r, vertical);
  const runStepUp = useStepUpAction();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<RowNotice | null>(null);
  const [transferring, setTransferring] = useState(false);
  const suspended = !!member.disabledAt;
  const attends = isClinicalMember(member);
  // DIR-0: nunca el email como nombre (el email ya va en su propia línea de la fila).
  const who = displayUserName(member.fullName);
  const tz = { timeZone: "America/Argentina/Buenos_Aires" } as const;

  const confirm = useConfirm();

  /**
   * Corre la action (con step-up si la pide); error → aviso debajo de la fila. Sin `router.refresh()`: las tres
   * revalidan `/configuracion` y la respuesta de la action ya trae el árbol nuevo (PF-0d, ratchet de refresh).
   */
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, onOk?: () => void) => {
    setNotice(null);
    start(async () => {
      const r = await runStepUp(fn);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      onOk?.();
    });
  };

  const changeRole = async (role: Role) => {
    if (member.isYou || role === member.role) return;
    // IAM-4c: el rol decide si atiende. Se avisa qué pasa con su agenda antes de confirmar.
    const agenda =
      role === "PRACTITIONER"
        ? member.hasAgenda
          ? ""
          : " Se le crea su agenda con el horario del consultorio."
        : member.hasAgenda
          ? " Deja de atender: sale de la agenda y del turnero. Si tiene turnos futuros o pacientes asignados, primero reasignalos."
          : "";
    const ok = await confirm({
      title: `¿Cambiar el rol de ${who}?`,
      message: `De ${memberRoleLabel(member, vertical)} a ${label(role)}: ${roleDescription(role, vertical)}${agenda}`,
      confirmLabel: "Cambiar rol",
    });
    if (!ok) return;
    // PL-Z (FX3 H4): pasar a Administrador/a pide step-up (`changeMemberRoleImpl` → `requireStepUp`). Sin `runStepUp`
    // el digest del step-up llegaba crudo como error de la fila; ahora abre el modal y reintenta. Sin
    // `router.refresh()`: la action revalida `/configuracion` (como `run`).
    run(() => changeMemberRole(member.membershipId, role));
  };

  const toggleAttends = async () => {
    const next = !attends;
    const ok = await confirm({
      title: next ? "¿Vas a atender pacientes?" : "¿Dejás de atender pacientes?",
      message: next
        ? `${ATTENDS_ON_COPY} Si no tenías agenda, se crea con el horario del consultorio.`
        : `${ATTENDS_OFF_COPY} Si tenés turnos futuros, pacientes asignados o planes activos, primero reasignalos.`,
      confirmLabel: next ? "Sí, atiendo" : "Dejar de atender",
      tone: next ? undefined : "danger",
    });
    if (!ok) return;
    run(() => setMemberClinical({ membershipId: member.membershipId, clinical: next }));
  };

  const setGrant = async (key: "grantSettings" | "grantBilling", value: boolean) => {
    const what = key === "grantSettings" ? "cambiar la Configuración del consultorio" : "ver y cambiar el plan y los pagos";
    const ok = await confirm({
      title: value ? `¿Darle permiso a ${who}?` : `¿Sacarle el permiso a ${who}?`,
      message: value
        ? `Va a poder ${what}. Lo podés sacar cuando quieras.`
        : `Deja de poder ${what}.`,
      confirmLabel: value ? "Dar permiso" : "Sacar permiso",
      tone: value ? undefined : "danger",
    });
    if (!ok) return;
    run(() =>
      setMemberGrants({
        membershipId: member.membershipId,
        grantSettings: key === "grantSettings" ? value : member.grantSettings,
        grantBilling: key === "grantBilling" ? value : member.grantBilling,
      })
    );
  };

  const transfer = () => run(() => transferOwnership(member.membershipId), () => setTransferring(false));

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
      message: `Vuelve a entrar al consultorio como ${memberRoleLabel(member, vertical)}.`,
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
  // La titularidad va a alguien que ya aceptó y no está suspendido (el server también lo frena).
  const canTransferTo = viewerIsOwner && !isOwnerRow && !suspended && !!member.joinedAt;
  const actions: MemberAction[] = isOwnerRow
    ? [{ label: "Mandar link para nueva contraseña", onSelect: sendReset }]
    : [
        ...(canTransferTo ? [{ label: "Transferir titularidad", onSelect: () => setTransferring(true) }] : []),
        suspended
          ? { label: "Reactivar", onSelect: reactivate }
          : { label: "Suspender acceso", onSelect: suspend, danger: true },
        // A un suspendido no se le manda un link para entrar: primero se reactiva (el server también lo frena).
        ...(suspended ? [] : [{ label: "Mandar link para nueva contraseña", onSelect: sendReset }]),
        { label: "Quitar del equipo", onSelect: remove, danger: true },
      ];
  const showAttends = viewerIsOwner && isOwnerRow && member.isYou;
  const showGrants = viewerIsOwner && !isOwnerRow;
  const showTurnero = attends && !!member.practitionerId && !suspended;

  return (
    <li
      data-member={member.membershipId}
      style={{
        padding: "14px 20px",
        display: "flex",
        flexWrap: "wrap",
        gap: "10px 14px",
        alignItems: "center",
        borderBottom: "1px solid rgba(15,30,51,0.04)",
      }}
    >
      <div style={{ opacity: suspended ? 0.65 : 1, flex: "1 1 220px", minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ overflowWrap: "anywhere" }}>{who}</span>
          {member.isYou && (
            <span style={{ fontSize: 11, color: "var(--sky-700)", fontWeight: 700 }}>(vos)</span>
          )}
          {suspended && <Tag tone="soft">Suspendido</Tag>}
        </div>
        <div style={{ fontSize: 12, color: "var(--navy-500)", overflowWrap: "anywhere" }}>{member.email}</div>
        {member.specialty && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{member.specialty}</div>}
        {suspended && member.disabledAt && (
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 2 }}>
            Sin acceso desde el {member.disabledAt.toLocaleDateString("es-AR", tz)}
          </div>
        )}
        {!notice && lastReset && (
          <div style={{ fontSize: 11, marginTop: 2, color: lastReset.status === "sent" ? "var(--navy-500)" : "var(--danger-fg)" }}>
            {lastReset.status === "sent" ? "Link de contraseña enviado" : "Link de contraseña no enviado"}
            {` · ${lastReset.at.toLocaleDateString("es-AR", tz)}`}
          </div>
        )}
      </div>
      {isOwnerRow ? (
        // El Titular no se cambia con el selector: se transfiere (menú «⋯» de la persona que va a serlo).
        <span data-role-label style={{ flex: "0 0 auto" }}>
          <Tag tone="lime">{memberRoleLabel(member, vertical)}</Tag>
        </span>
      ) : (
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
            maxWidth: "100%",
            flex: "0 0 auto",
          }}
        >
          {ASSIGNABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {label(r)}
            </option>
          ))}
        </select>
      )}
      <div style={{ textAlign: "right", flex: "0 0 32px" }}>
        {/* Sin menú en la fila propia; quien no es Titular no toca al Titular (IAM-D3). */}
        {!member.isYou && !ownerLocked && <MemberActionsMenu who={who} actions={actions} disabled={pending} />}
      </div>

      {(showAttends || showGrants || showTurnero) && (
        <div
          style={{
            flex: "1 1 100%",
            display: "flex",
            flexWrap: "wrap",
            gap: "10px 24px",
            paddingTop: 4,
          }}
        >
          {showAttends && (
            <div data-attends style={{ display: "grid", gap: 4, flex: "1 1 260px", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Switch on={attends} onChange={toggleAttends} disabled={pending} aria-label="Atiendo pacientes" />
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>Atiendo pacientes</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4 }}>
                {attends ? ATTENDS_ON_COPY : ATTENDS_OFF_COPY}
              </div>
            </div>
          )}
          {showGrants && (
            <fieldset
              data-grants
              disabled={pending}
              style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 6, flex: "1 1 260px", minWidth: 0 }}
            >
              <legend style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-500)", padding: 0, marginBottom: 4 }}>
                Permisos
              </legend>
              <GrantCheckbox
                label="Puede cambiar la Configuración"
                checked={member.grantSettings}
                onChange={(v) => setGrant("grantSettings", v)}
              />
              <GrantCheckbox
                label="Puede ver y cambiar el plan y los pagos"
                checked={member.grantBilling}
                onChange={(v) => setGrant("grantBilling", v)}
              />
            </fieldset>
          )}
          {showTurnero && member.practitionerId && (
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <PublicBookingSwitch practitionerId={member.practitionerId} name={who} enabled={member.publicBookingEnabled} compact />
            </div>
          )}
        </div>
      )}

      {notice && (
        <div role="status" style={{ flex: "1 1 100%", fontSize: 11.5, color: NOTICE_COLOR[notice.tone] }}>
          {notice.text}
        </div>
      )}
      {transferring && (
        <TransferOwnershipModal
          member={member}
          currentOwner={currentOwner}
          vertical={vertical}
          pending={pending}
          onCancel={() => setTransferring(false)}
          onConfirm={transfer}
        />
      )}
    </li>
  );
}

/** Un permiso delegado: checkbox nativo (teclado y lector de pantalla sin trabajo extra), 44 px de alto táctil. */
function GrantCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--navy-900)", minHeight: 44, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        // Controlado por el server: el valor cambia recién después del refresh (si el step-up se cancela, no cambió).
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: "var(--sky-700)" }}
      />
      {label}
    </label>
  );
}

/** El email de la persona, tipeado (sin distinguir mayúsculas): la confirmación reforzada de transferir. */
export function transferConfirmMatches(typed: string, email: string): boolean {
  const t = typed.trim().toLowerCase();
  return t.length > 0 && t === email.trim().toLowerCase();
}

function TransferOwnershipModal({
  member,
  currentOwner,
  vertical,
  pending,
  onCancel,
  onConfirm,
}: {
  member: TeamMemberRow;
  currentOwner: TeamMemberRow | null;
  vertical: TenantVertical;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = transferConfirmMatches(typed, member.email);
  const who = displayUserName(member.fullName);
  // §20.17: el Administrador/a no atiende. Quien transfiere y atiende queda Profesional (conserva su agenda) con
  // «Configuración»; si no atiende, Administrador/a con «Configuración» (`changeMemberRoleInTx`).
  const youStay = currentOwner && isClinicalMember(currentOwner)
    ? `${roleLabel("PRACTITIONER", vertical)} (conservás tu agenda)`
    : roleLabel("ADMIN", vertical);
  return (
    <Modal onClose={onCancel} title="Transferir la titularidad" width={520}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !pending) onConfirm();
        }}
        style={{ display: "grid", gap: 12 }}
      >
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
          <strong>{who}</strong> pasa a ser {roleLabel("OWNER", vertical)} del consultorio: maneja el plan y los pagos, el
          equipo y quién puede hacer qué. Vos quedás como {youStay}, con permiso para cambiar la Configuración. Desde tu
          cuenta no lo vas a poder deshacer. Te vamos a pedir tu código de verificación.
        </p>
        <FormField
          label={`Para confirmar, escribí el email de ${who}`}
          name="confirmEmail"
          type="email"
          value={typed}
          onChange={setTyped}
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
    </Modal>
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
        // PL-Z M4: era 28×28, por debajo del target táctil de 44 px.
        style={{
          width: 44,
          height: 44,
          borderRadius: 10,
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
          style={{ position: "absolute", top: 46, right: 0, width: 250, borderRadius: 12, padding: 4, zIndex: 25, textAlign: "left" }}
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
                color: a.danger ? "var(--danger-fg)" : "var(--navy-700)",
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
            <div style={{ fontSize: 11, marginTop: 2, color: last.tone === "ok" ? "var(--navy-500)" : last.tone === "warn" ? "var(--warn-fg)" : "var(--danger-fg)" }}>
              {last.tone === "ok" ? "Mail enviado" : "Mail no enviado"}
              {invite.lastSentAt && ` · ${invite.lastSentAt.toLocaleDateString("es-AR", tz)}`}
              {invite.sendCount > 1 && ` · ${invite.sendCount} envíos`}
            </div>
          )}
          {error && <div style={{ fontSize: 11, color: "var(--danger-fg)", marginTop: 2 }}>{error}</div>}
        </div>
        <Tag tone="soft">{roleLabel(invite.role, vertical)}</Tag>
        <div style={{ fontSize: 11, color: expired ? "var(--danger-fg)" : "var(--navy-500)" }}>
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
          <button type="button" onClick={revoke} disabled={pending} style={{ ...linkStyle, color: "var(--danger-fg)" }}>
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
  seats,
}: {
  onClose: () => void;
  onSuccess: (result: InvitationSendResult) => void;
  seats?: TenantPlanUsageView["seats"];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const vertical = useTenantVertical();
  // Controlado solo para mostrar la descripción del rol elegido debajo: un
  // <option> nativo no admite una segunda línea. El valor sigue viajando por
  // FormData (`name="role"`), como antes.
  const [role, setRole] = useState<Role>("PRACTITIONER");
  // PL-3b (C-PL3): cada invitación reserva un lugar del tipo de su rol. Si no queda, se dice antes de cargar todo
  // (el server igual lo frena con `seatsFullCopy`).
  const noSeat = !!seats && !canAddSeat(seats.byKind, seatKindOf({ role, clinical: role === "PRACTITIONER" }));

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
        <div data-invite-attends style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45, marginTop: -4 }}>
          {inviteAttendsCopy(role)}
        </div>
        {noSeat && (
          <div role="status" style={{ fontSize: 12, color: "var(--warn-fg)", lineHeight: 1.45 }}>
            No quedan lugares en el plan para sumar a alguien con este rol. Liberá un lugar o cambiá de plan en «Plan y
            uso».
          </div>
        )}
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
          <Button type="submit" variant="primary" disabled={pending || noSeat}>
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
          color: status.tone === "ok" ? "var(--navy-900)" : status.tone === "warn" ? "var(--warn-fg)" : "var(--danger-fg)",
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
