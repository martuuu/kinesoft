"use client";

/**
 * Acciones del detalle de un usuario de /plataforma (BO3-D). Cada una llama a su action de `lib/platform-users.ts`
 * (que hace `requirePlatformAdmin` + zod + audit) y después `router.refresh()`: el detalle es un server component
 * y se vuelve a leer entero.
 *
 * - Link de acceso: si el mail salió, solo «Le mandamos el mail» (el superadmin no ve una credencial de un clic de
 *   otra persona); si no salió, la caja con el link copiable que devuelve el server.
 * - Deshabilitar: Modal con motivo opcional. Habilitar: `useConfirm`. Si Auth no sincronizó el bloqueo, aviso
 *   persistente con «Reintentá» (el server lo hace idempotente). A uno mismo no se ofrece (el server igual lo
 *   rechaza con «No podés deshabilitarte a vos mismo»).
 * - Superadmin: Modal que exige tipear el email exacto (hasta BO4/MFA, `confirmEmail` en el server).
 * - Sincronizar email: solo si Auth respondió y difiere.
 * - Resetear la 2FA (PL-2a): `useConfirm` (riesgo high: con MFA en enforce pide el código otra vez). A uno mismo no se
 *   ofrece (lo cambia desde Seguridad de la cuenta, con step-up). Si quedó un factor en el servicio de acceso, aviso
 *   con «Reintentá» (el server es idempotente).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
// BO4: todas las actions de usuarios pasan por `runPlatform` (rate limit legible; deshabilitar y superadmin son
// riesgo high y, con MFA en enforce, piden el código otra vez).
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import {
  repairSyncProfileEmail,
  resetPlatformUserTwoFactor,
  sendPlatformAccessLink,
  setPlatformSuperadmin,
  setPlatformUserDisabled,
} from "@/lib/platform-users";
import type { PlatformAccessLinkResult, PlatformUserDetail } from "@/lib/platform-health-logic";
import {
  accessLinkBlockReason,
  accessLinkMessage,
  canOfferEmailSync,
  ONE_TIME_LINK_COPY,
  superadminConfirmReady,
  superadminCopy,
  toggleMessage,
  type ResultMessage,
} from "@/components/plataforma/users/users-logic";

const GENERIC_ERROR = "Probá de nuevo en unos minutos.";
const REASON_MAX = 500;

const boxTone: Record<ResultMessage["tone"], React.CSSProperties> = {
  success: { background: "rgba(124,184,40,0.10)", borderColor: "rgba(124,184,40,0.35)" },
  info: { background: "rgba(56,150,220,0.08)", borderColor: "rgba(56,150,220,0.3)" },
  warning: { background: "rgba(217,130,0,0.10)", borderColor: "rgba(217,130,0,0.35)" },
};

function ResultBox({ msg, children }: { msg: ResultMessage; children?: React.ReactNode }) {
  return (
    <div
      role="status"
      style={{ border: "1px solid", borderRadius: 14, padding: "10px 12px", fontSize: 13, color: "var(--navy-700)", ...boxTone[msg.tone] }}
    >
      <strong style={{ color: "var(--navy-900)" }}>{msg.title}</strong>
      {msg.description && <div style={{ marginTop: 4, lineHeight: 1.45 }}>{msg.description}</div>}
      {children}
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <div role="alert" style={{ fontSize: 12.5, color: "var(--danger-fg)", lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

/** Link copiable (solo cuando el mail no salió), con el aviso de credencial y vencimiento (BO-Z B3). */
export function CopyLinkBox({ url }: { url: string }) {
  const toast = useToast();
  return (
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          readOnly
          value={url}
          aria-label="Link de acceso"
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: "1 1 200px",
            minWidth: 0,
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid rgba(15,30,51,0.12)",
            background: "#fff",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
            color: "var(--navy-900)",
          }}
        />
        <Button
          type="button"
          variant="ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast.success("Link copiado");
            } catch {
              toast.error("No se pudo copiar", { description: "Seleccioná el link y copialo a mano." });
            }
          }}
        >
          Copiar
        </Button>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--navy-700)" }}>{ONE_TIME_LINK_COPY}</div>
    </div>
  );
}

// ── Link de acceso ────────────────────────────────────────────────────────────

function AccessLinkAction({ user }: { user: PlatformUserDetail }) {
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlatformAccessLinkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const block = accessLinkBlockReason(user);

  async function onSend() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await runPlatform(() => sendPlatformAccessLink({ userId: user.id }));
      if (r.ok) {
        setResult(r.data);
        if (r.data.emailSent) toast.success("Le mandamos el mail");
      } else {
        setError(r.error);
      }
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionBlock
      title="Link de acceso"
      hint="Le manda un mail para activar la cuenta o elegir una contraseña nueva."
      action={
        <Button variant="ghost" onClick={onSend} disabled={busy || block !== null}>
          {busy ? "Mandando…" : "Mandar link de acceso"}
        </Button>
      }
    >
      {block && <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{block}</div>}
      {error && <ErrorText>{error}</ErrorText>}
      {result && <ResultBox msg={accessLinkMessage(result)}>{result.copyUrl && <CopyLinkBox url={result.copyUrl} />}</ResultBox>}
    </ActionBlock>
  );
}

// ── Deshabilitar / habilitar ─────────────────────────────────────────────────

function DisableAction({ user, isSelf }: { user: PlatformUserDetail; isSelf: boolean }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Aviso persistente si la base quedó bien pero Auth no: con qué valor reintentar.
  const [pendingSync, setPendingSync] = useState<{ disabled: boolean; msg: ResultMessage } | null>(null);

  async function run(disabled: boolean, why?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const r = await runPlatform(() => setPlatformUserDisabled({ userId: user.id, disabled, ...(why ? { reason: why } : {}) }));
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      const msg = toggleMessage(r.data, disabled);
      if (!r.data.authSynced) {
        setPendingSync({ disabled, msg });
      } else {
        setPendingSync(null);
        if (msg.tone === "success") toast.success(msg.title);
        else toast.info(msg.title);
      }
      router.refresh();
      return true;
    } catch {
      setError(GENERIC_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onEnable() {
    const ok = await confirm({
      title: "¿Habilitar a este usuario?",
      message: "Vuelve a poder entrar con su cuenta a los consultorios donde tiene acceso.",
      confirmLabel: "Habilitar",
    });
    if (ok) await run(false);
  }

  async function onDisableSubmit(e: React.FormEvent) {
    e.preventDefault();
    const done = await run(true, reason.trim() || undefined);
    if (done) {
      setOpen(false);
      setReason("");
    }
  }

  return (
    <ActionBlock
      title={user.disabled ? "Usuario deshabilitado" : "Habilitado"}
      hint={
        user.disabled
          ? user.disabledReason
            ? `Motivo: ${user.disabledReason}`
            : "No puede entrar a KineSoft."
          : "Deshabilitarlo le corta el acceso a todo KineSoft, en todos sus consultorios."
      }
      action={
        user.disabled ? (
          <Button variant="ghost" onClick={onEnable} disabled={busy}>
            Habilitar
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setOpen(true)} disabled={busy || isSelf}>
            Deshabilitar
          </Button>
        )
      }
    >
      {isSelf && !user.disabled && <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>No podés deshabilitarte a vos mismo.</div>}
      {error && !open && <ErrorText>{error}</ErrorText>}
      {pendingSync && (
        <ResultBox msg={pendingSync.msg}>
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" onClick={() => run(pendingSync.disabled)} disabled={busy}>
              {busy ? "Reintentando…" : "Reintentá"}
            </Button>
          </div>
        </ResultBox>
      )}
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="Deshabilitar usuario"
        description={`${user.email} no va a poder entrar a KineSoft en ningún consultorio hasta que lo habilites.`}
      >
        <form onSubmit={onDisableSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <FormField
            as="textarea"
            label="Motivo (opcional)"
            value={reason}
            onChange={(v) => setReason(v.slice(0, REASON_MAX))}
            placeholder="Ej.: dejó de trabajar en el consultorio"
            rows={3}
          />
          {error && <ErrorText>{error}</ErrorText>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Deshabilitando…" : "Deshabilitar"}
            </Button>
          </div>
        </form>
      </Modal>
    </ActionBlock>
  );
}

// ── Superadmin ────────────────────────────────────────────────────────────────

/**
 * Formulario del Modal de superadmin. Exportado para el render test: el botón de confirmar queda deshabilitado
 * hasta que el email tipeado coincide (el server lo vuelve a exigir).
 */
export function SuperadminForm({
  email,
  grant,
  busy,
  error,
  initialTyped = "",
  onCancel,
  onConfirm,
}: {
  email: string;
  grant: boolean;
  busy: boolean;
  error: string | null;
  initialTyped?: string;
  onCancel: () => void;
  onConfirm: (typed: string) => void;
}) {
  const [typed, setTyped] = useState(initialTyped);
  const ready = superadminConfirmReady(typed, email);
  const copy = superadminCopy(grant);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onConfirm(typed);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      <FormField
        label={`Escribí ${email}`}
        name="confirmEmail"
        type="email"
        value={typed}
        onChange={setTyped}
        placeholder={email}
        autoFocus
      />
      {error && <ErrorText>{error}</ErrorText>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || busy} data-testid="superadmin-confirm">
          {busy ? "Guardando…" : copy.confirmLabel}
        </Button>
      </div>
    </form>
  );
}

function SuperadminAction({ user }: { user: PlatformUserDetail }) {
  const router = useRouter();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remonta el form en cada apertura: el email tipeado no queda de la vez anterior.
  const [formKey, setFormKey] = useState(0);
  const grant = !user.isPlatformAdmin;
  const copy = superadminCopy(grant);

  async function onConfirm(typed: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await runPlatform(() => setPlatformSuperadmin({ userId: user.id, grant, confirmEmail: typed }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setOpen(false);
      if (r.data.changed) toast.success(grant ? "Ahora tiene acceso a Plataforma" : "Ya no tiene acceso a Plataforma");
      else toast.info(grant ? "Ya tenía acceso a Plataforma" : "Ya no tenía acceso a Plataforma");
      router.refresh();
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionBlock
      title={user.isPlatformAdmin ? "Tiene acceso a Plataforma" : "Sin acceso a Plataforma"}
      hint={user.isPlatformAdmin ? "Es superadmin: ve y cambia todos los consultorios." : "Plataforma es solo para el equipo de KineSoft."}
      action={
        <Button
          variant="ghost"
          onClick={() => {
            setError(null);
            setFormKey((k) => k + 1);
            setOpen(true);
          }}
          disabled={grant && user.disabled}
        >
          {grant ? "Dar acceso a Plataforma" : "Quitar acceso a Plataforma"}
        </Button>
      }
    >
      {grant && user.disabled && <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>Habilitalo antes de darle acceso.</div>}
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={copy.title}
        description={copy.description}
      >
        <SuperadminForm
          key={formKey}
          email={user.email}
          grant={grant}
          busy={busy}
          error={error}
          onCancel={() => setOpen(false)}
          onConfirm={onConfirm}
        />
      </Modal>
    </ActionBlock>
  );
}

// ── Sincronizar email ─────────────────────────────────────────────────────────

/** También la usa Salud (detector de emails distintos). */
export function useSyncEmail() {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  return async function syncEmail(p: { userId: string; profileEmail: string; authEmail: string | null }): Promise<void> {
    const ok = await confirm({
      title: "¿Sincronizar el email?",
      message: `El perfil pasa de ${p.profileEmail} a ${p.authEmail ?? "el email de su cuenta"}, que es con el que entra.`,
      confirmLabel: "Sincronizar",
    });
    if (!ok) return;
    try {
      const r = await runPlatform(() => repairSyncProfileEmail({ userId: p.userId }));
      if (!r.ok) {
        toast.error("No se pudo sincronizar", { description: r.error });
        return;
      }
      toast.success(r.data.changed ? "Email sincronizado" : "Ya estaba sincronizado");
      router.refresh();
    } catch {
      toast.error("No se pudo sincronizar", { description: GENERIC_ERROR });
    }
  };
}

function SyncEmailAction({ user }: { user: PlatformUserDetail }) {
  const syncEmail = useSyncEmail();
  const [busy, setBusy] = useState(false);
  if (!canOfferEmailSync(user.auth) || user.auth.status !== "ok") return null;
  const authEmail = user.auth.email;
  return (
    <ActionBlock
      title="Email distinto"
      hint={`El perfil dice ${user.email} y su cuenta de acceso dice ${authEmail ?? "—"}. Se copia el de la cuenta, que es con el que entra.`}
      action={
        <Button
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await syncEmail({ userId: user.id, profileEmail: user.email, authEmail });
            setBusy(false);
          }}
        >
          Sincronizar email con Auth
        </Button>
      }
    />
  );
}

// ── Resetear la verificación en dos pasos (PL-2a) ─────────────────────────────

function TwoFactorResetAction({ user, isSelf }: { user: PlatformUserDetail; isSelf: boolean }) {
  // Sin `router.refresh()`: la action ya hace `revalidatePath("/plataforma", "layout")` (PF-0d).
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState(false);
  // PL-Z (FX2): el server ya rechaza resetear la 2FA de otro superadmin (`resetPlatformUserTwoFactor`,
  // RESET_OTHER_ADMIN); acá se deshabilita de entrada con el porqué en vez de dejar que choque al confirmar.
  const otherAdmin = !isSelf && user.isPlatformAdmin;

  async function run(ask: boolean) {
    if (ask) {
      const ok = await confirm({
        title: "¿Resetear la verificación en dos pasos?",
        message: `${user.fullName?.trim() || "Esta persona"} va a poder entrar solo con su contraseña hasta que la vuelva a activar. Se borran su app de autenticación, el código por email y sus códigos de recuperación, se cierran sus sesiones y le avisamos por mail. Hacelo solo si confirmaste que es ella quien lo pide.`,
        confirmLabel: "Resetear",
        tone: "danger",
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await runPlatform(() => resetPlatformUserTwoFactor({ userId: user.id }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPendingSync(!r.data.authSynced);
      if (r.data.authSynced) {
        toast.success(r.data.hadAny || r.data.factorsRemoved > 0 ? "Verificación reseteada" : "No tenía verificación en dos pasos");
      }
    } catch {
      setError(GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ActionBlock
      title="Verificación en dos pasos"
      hint="Si perdió el teléfono y los códigos de recuperación, la reseteás para que pueda entrar y activarla de nuevo."
      action={
        <Button variant="ghost" onClick={() => run(true)} disabled={busy || isSelf || otherAdmin}>
          {busy ? "Reseteando…" : "Resetear verificación"}
        </Button>
      }
    >
      {isSelf && (
        <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>La tuya la cambiás desde Seguridad de la cuenta.</div>
      )}
      {otherAdmin && (
        <div data-reset-other-admin style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
          Es superadmin: su verificación la cambia esa persona desde Seguridad de la cuenta.
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      {pendingSync && (
        <ResultBox
          msg={{
            tone: "warning",
            title: "Quedó reseteada en KineSoft, pero no pudimos borrar su app del servicio de acceso.",
            description: "Ya puede entrar sin el segundo paso. Reintentá para terminar de limpiar.",
          }}
        >
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" onClick={() => run(false)} disabled={busy}>
              {busy ? "Reintentando…" : "Reintentá"}
            </Button>
          </div>
        </ResultBox>
      )}
    </ActionBlock>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

function ActionBlock({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint: string;
  action: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: "14px 0", borderTop: "1px solid rgba(15,30,51,0.06)" }}>
      <div style={{ display: "flex", gap: 12, justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>{title}</div>
          <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.45, overflowWrap: "anywhere" }}>{hint}</div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function UserActions({ user, actorId }: { user: PlatformUserDetail; actorId: string }) {
  const isSelf = user.id === actorId;
  return (
    <div>
      <SyncEmailAction user={user} />
      <AccessLinkAction user={user} />
      <DisableAction user={user} isSelf={isSelf} />
      <TwoFactorResetAction user={user} isSelf={isSelf} />
      <SuperadminAction user={user} />
    </div>
  );
}
