"use client";

/**
 * [TP-3a] Card «Cuenta del consultorio» de Configuración → «Cobros online» (§25.10; decisión 1 de Martin, 19-oct).
 *
 * - El ESTADO lo ve todo el que ve la pestaña (`tenant.sensitive`): el Titular, el Admin o el Profesional con
 *   «Configuración» saben a qué cuenta entra la plata (por el `nickname`) y si hay que reconectarla.
 * - Las ACCIONES (conectar, reconectar, desconectar, autorizar links) solo el Titular (`canManageClinicAccount` =
 *   `account.owner`, nunca soporte). Conectar y desconectar piden la verificación en dos pasos: la action tira el
 *   error de step-up y `runStepUp` abre el desafío y la reintenta una vez (`StepUpProvider` lo monta el panel).
 * - Conectar = server action que firma el state y arma la URL de autorización + `location.assign` (TP-UI-D3: el
 *   cliente solo navega, la CSP no cambia). La vuelta es `?tab=cobros-online&mp=…` y el aviso sale de `mpReturn`.
 * - Badge «Cuenta de prueba» / «Simulador local»: una cuenta que no es de producción nunca se ve como si cobrara de
 *   verdad.
 *
 * Los flujos de los botones son funciones exportadas con sus dependencias inyectadas (`connectClinicAccount`,
 * `disconnectClinicAccount`): el repo no tiene DOM en los tests, así que el test llama al mismo código que el click.
 */
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useStepUpAction, type RunStepUpAction, type StepUpFailure } from "@/components/account/step-up-modal";
import { disconnectMpAccount, setMpLinksDelegated, startMpConnect } from "@/lib/mp-connect-actions";
import { formatDateAR } from "@/lib/format";
import { MP_ACCOUNT_STATUS_LABEL, MP_CONNECT_COPY } from "@/lib/online-payments-copy";
import type { MpAccountView, MpConnectMode, MpConnectReturn } from "@/lib/mp-connect-types";
import type { ActionResult } from "@/lib/validation";
import { ErrorBox, Switch } from "../controls";

/** Copy de la card (vocabulario de §25.10: «Mercado Pago» completo, «link de pago», «Secretaría» con tilde). */
export const CLINIC_MP_COPY = {
  ownerOnly: "Solo el titular de la cuenta conecta o desconecta el Mercado Pago del consultorio.",
  connectHint:
    "La plata entra a la cuenta con la que inicies sesión en Mercado Pago. Te vamos a pedir el código de la verificación en dos pasos.",
  none: "El consultorio todavía no conectó una cuenta de Mercado Pago.",
  reauth:
    "El acceso de la app a la cuenta del consultorio venció: hasta que se reconecte, los profesionales que cobran con ella reservan sin cobro online.",
  connect: "Conectar Mercado Pago",
  reconnect: "Reconectar Mercado Pago",
  disconnect: "Desconectar",
  disconnectTitle: "¿Desconectar el Mercado Pago del consultorio?",
  disconnectMessage:
    "Los links de pago activos a esta cuenta se anulan y los profesionales que cobraban con ella reservan sin cobro online hasta que conectes otra.",
  disconnected: (n: number) =>
    n === 0
      ? "Desconectamos el Mercado Pago del consultorio"
      : `Desconectamos el Mercado Pago del consultorio y anulamos ${n} ${n === 1 ? "link de pago activo" : "links de pago activos"}`,
  delegation: "Permitir que la Secretaría y los administradores generen links de pago a la cuenta del consultorio",
  connectedSince: (date: string) => `Conectada desde el ${date}`,
  disconnectedOn: (date: string) => `Desconectada el ${date}`,
  offline: "Los cobros online todavía no están habilitados.",
} as const;

/**
 * Aviso de la vuelta del callback (`?mp=`, `MP_CONNECT_RETURNS`). `in_use` casi no aplica a la cuenta del consultorio
 * (puede coincidir con la de un profesional, §25.4), pero el callback lo puede devolver y no se deja sin texto.
 */
export const CLINIC_MP_RETURN_NOTICE: Readonly<Record<MpConnectReturn, { tone: "ok" | "error"; text: string }>> = {
  ok: { tone: "ok", text: "Listo: conectamos el Mercado Pago del consultorio." },
  denied: { tone: "error", text: "Cancelaste la conexión en Mercado Pago: no se cambió nada." },
  expired: { tone: "error", text: "La conexión se venció antes de terminar. Probá de nuevo." },
  in_use: { tone: "error", text: "Esa cuenta de Mercado Pago ya está conectada por otro profesional del consultorio." },
  error: { tone: "error", text: "No pudimos conectar Mercado Pago. Probá de nuevo en unos minutos." },
};

/**
 * Click en «Conectar / Reconectar»: la action corre dentro de `runStepUp` (pide 2FA) y, si devuelve la URL, se navega
 * con `assign` (`window.location.assign`). Devuelve el error a mostrar, o null si navegó.
 */
export async function connectClinicAccount(deps: {
  runStepUp: RunStepUpAction;
  start: typeof startMpConnect;
  assign: (url: string) => void;
}): Promise<string | null> {
  const res = await deps.runStepUp(() => deps.start({ target: "clinic" }));
  if (res.ok) {
    deps.assign(res.data.url);
    return null;
  }
  return res.error;
}

/**
 * Click en «Desconectar»: confirma con `useConfirm` (AGENTS §5) y la action corre dentro de `runStepUp`. `null` =
 * canceló la confirmación (no se llamó a nada).
 */
export async function disconnectClinicAccount(deps: {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  runStepUp: RunStepUpAction;
  disconnect: typeof disconnectMpAccount;
}): Promise<ActionResult<{ cancelledLinks: number }> | StepUpFailure | null> {
  const ok = await deps.confirm({
    title: CLINIC_MP_COPY.disconnectTitle,
    message: CLINIC_MP_COPY.disconnectMessage,
    confirmLabel: CLINIC_MP_COPY.disconnect,
    tone: "danger",
  });
  if (!ok) return null;
  return deps.runStepUp(() => deps.disconnect({ target: "clinic" }));
}

/** Texto de estado de la cuenta (puro, para el test). Fechas en AR (`formatDateAR`). */
export function clinicAccountStatusLine(a: MpAccountView): string {
  if (a.status === "NONE") return CLINIC_MP_COPY.none;
  if (a.status === "REAUTH_REQUIRED") return CLINIC_MP_COPY.reauth;
  if (a.status === "DISCONNECTED") {
    return a.disconnectedAt ? CLINIC_MP_COPY.disconnectedOn(formatDateAR(a.disconnectedAt, "short")) : MP_ACCOUNT_STATUS_LABEL.DISCONNECTED;
  }
  return a.connectedAt ? CLINIC_MP_COPY.connectedSince(formatDateAR(a.connectedAt, "short")) : MP_ACCOUNT_STATUS_LABEL.ACTIVE;
}

export function MpAccountBadge({ badge }: { badge: MpAccountView["badge"] }) {
  if (!badge) return null;
  return (
    <Tag tone="soft" variant="outline">
      {badge === "fake" ? MP_CONNECT_COPY.badgeFake : MP_CONNECT_COPY.badgeSandbox}
    </Tag>
  );
}

const STATUS_TONE: Record<MpAccountView["status"], "lime" | "sky" | "soft"> = {
  ACTIVE: "lime",
  REAUTH_REQUIRED: "sky",
  DISCONNECTED: "soft",
  NONE: "soft",
};

export function ClinicMpAccountCard({
  account,
  canManage,
  connectMode,
  mpReturn,
  support = false,
}: {
  account: MpAccountView;
  /** `canManageClinicAccount` (Titular, nunca soporte). */
  canManage: boolean;
  connectMode: MpConnectMode;
  /** `?mp=` de la vuelta del callback (la cuenta del consultorio vuelve a esta pestaña). */
  mpReturn: MpConnectReturn | null;
  support?: boolean;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const runStepUp = useStepUpAction();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegated, setDelegated] = useState(account.linksDelegated);
  const [syncedFrom, setSyncedFrom] = useState(account);
  // El árbol nuevo (revalidatePath) manda sobre el switch optimista.
  if (syncedFrom !== account) {
    setSyncedFrom(account);
    setDelegated(account.linksDelegated);
  }

  const off = connectMode === "off";
  const actions = canManage && !support;
  const live = account.status === "ACTIVE" || account.status === "REAUTH_REQUIRED";
  const notice = mpReturn ? CLINIC_MP_RETURN_NOTICE[mpReturn] : null;

  async function onConnect() {
    setPending(true);
    setError(null);
    const err = await connectClinicAccount({ runStepUp, start: startMpConnect, assign: (url) => window.location.assign(url) });
    // Si navegó, la página se va: el botón queda en «pendiente» a propósito (sin doble click).
    if (err) {
      setError(err);
      setPending(false);
    }
  }

  async function onDisconnect() {
    setError(null);
    setPending(true);
    try {
      const r = await disconnectClinicAccount({ confirm, runStepUp, disconnect: disconnectMpAccount });
      if (!r) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(CLINIC_MP_COPY.disconnected("data" in r ? r.data.cancelledLinks : 0));
    } finally {
      setPending(false);
    }
  }

  async function onToggleDelegation() {
    if (pending) return;
    const next = !delegated;
    setDelegated(next);
    setError(null);
    setPending(true);
    const r = await setMpLinksDelegated({ target: "clinic", delegated: next });
    setPending(false);
    if (!r.ok) {
      setDelegated(!next);
      setError(r.error);
    }
  }

  return (
    <Card style={{ padding: 18, display: "grid", gap: 12 }} data-clinic-mp-card="">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <EyebrowLabel>{MP_CONNECT_COPY.clinicAccountCard}</EyebrowLabel>
        <Tag tone={STATUS_TONE[account.status]}>{MP_ACCOUNT_STATUS_LABEL[account.status]}</Tag>
        <MpAccountBadge badge={account.badge} />
      </div>

      {notice &&
        (notice.tone === "error" ? (
          <ErrorBox>{notice.text}</ErrorBox>
        ) : (
          <p role="status" style={{ margin: 0, fontSize: 13, color: "var(--success-fg)", fontWeight: 600 }}>
            {notice.text}
          </p>
        ))}

      <div style={{ fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5, minWidth: 0, overflowWrap: "anywhere" }}>
        {account.nickname && live && (
          <div style={{ fontWeight: 700, color: "var(--navy-900)" }}>{account.nickname}</div>
        )}
        <div>{clinicAccountStatusLine(account)}</div>
      </div>

      {actions ? (
        <>
          {!live && !off && <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{CLINIC_MP_COPY.connectHint}</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {account.status !== "ACTIVE" && (
              <Button type="button" size="sm" disabled={pending || off} onClick={() => void onConnect()}>
                {account.status === "REAUTH_REQUIRED" ? CLINIC_MP_COPY.reconnect : CLINIC_MP_COPY.connect}
              </Button>
            )}
            {live && (
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void onDisconnect()}>
                {CLINIC_MP_COPY.disconnect}
              </Button>
            )}
          </div>
          {account.status === "ACTIVE" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Switch
                on={delegated}
                onChange={() => void onToggleDelegation()}
                disabled={pending}
                aria-label={CLINIC_MP_COPY.delegation}
              />
              <span style={{ fontSize: 13, color: "var(--navy-900)" }}>{CLINIC_MP_COPY.delegation}</span>
            </div>
          )}
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{CLINIC_MP_COPY.ownerOnly}</p>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}
