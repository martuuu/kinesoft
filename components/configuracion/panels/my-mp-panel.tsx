"use client";

/**
 * [TP-3b] Pestaña «Mi Mercado Pago» (§25.10; TP-UI-D2: pestaña de Configuración + ítem del menú de cuenta). La ve quien
 * tiene profesional propio aunque no tenga ninguna delegación (hallazgo 13 de §25.2: sin esto, un profesional sin
 * «Configuración» no tenía dónde conectar su cuenta). La registra TP-3a en `TAB_DEFS`; las props son las CONGELADAS de
 * `components/payments/payments-ui-types.ts` (TP-K4).
 *
 * Los cuatro estados de `MpAccountView` y qué se puede hacer en cada uno:
 *   - NONE: «Conectar Mercado Pago»;
 *   - ACTIVE: «Desconectar» + switch de delegación (TP-UI-D1: «link de pago» también en el switch);
 *   - REAUTH_REQUIRED: el refresh del cron dio `invalid_grant`. Aviso «Reconectá tu Mercado Pago» (el mismo título de la
 *     campana, C-TP13) + «Reconectar» y «Desconectar». La delegación se conserva y se puede cambiar: es de la fila, no
 *     del token;
 *   - DISCONNECTED: la fila sigue (es la cuenta de los cobros viejos, +7 días para la purga) con `linksDelegated` en
 *     false por el CHECK de M18: sin switch, «Volver a conectar».
 *
 * Arranque OAuth por server action + `location.assign` (TP-UI-D3): la URL de autorización la arma el server con el
 * state firmado y la cookie `kine_mp_oauth`; el cliente solo navega. Un form POST a MP cambiaría la CSP
 * (`form-action`), y un GET a una ruta propia que redirija no podría setear la cookie atada a la sesión con el mismo
 * chequeo del actor. Desconectar confirma con `useConfirm` (AGENTS §5): anula los links de pago activos de la cuenta.
 *
 * Los flujos de los botones (`connectOwnMp`, `disconnectOwnMp`, `toggleOwnDelegation`) están exportados y el botón los
 * llama tal cual: sin jsdom no hay click, y así el test prueba el mismo símbolo que corre (anti-false-green).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { Tag } from "@/components/ui/tag";
import { formatDateAR } from "@/lib/format";
import { disconnectMpAccount, setMpLinksDelegated, startMpConnect } from "@/lib/mp-connect-actions";
import { MP_ACCOUNT_STATUS_LABEL, MP_CONNECT_COPY } from "@/lib/online-payments-copy";
import type { MpConnectReturn } from "@/lib/mp-connect-types";
import type { MyMpPanelProps } from "@/components/payments/payments-ui-types";

type NoticeTone = "success" | "warn" | "danger";

/**
 * Avisos de la vuelta del callback (`?mp=`, C-TP4). Viven acá y no en `lib/online-payments-copy.ts` porque ese archivo
 * no es de esta sesión (handoff a TP-3z: moverlos allá para que «Cobros online» de TP-3a use los mismos con la cuenta
 * del consultorio). `denied` es «warn» y no error: el usuario eligió no autorizar.
 */
const MP_RETURN_NOTICE: Readonly<Record<MpConnectReturn, { tone: NoticeTone; text: string }>> = {
  ok: { tone: "success", text: "Listo: tu Mercado Pago quedó conectado." },
  denied: { tone: "warn", text: "No autorizaste el acceso en Mercado Pago, así que tu cuenta no se conectó." },
  expired: { tone: "danger", text: "La conexión tardó demasiado y venció. Probá conectar de nuevo." },
  in_use: {
    tone: "danger",
    text: "Esa cuenta de Mercado Pago ya está conectada a otro profesional del consultorio. Conectá una cuenta tuya.",
  },
  error: { tone: "danger", text: "No pudimos conectar tu Mercado Pago. Probá de nuevo en unos minutos." },
};

export function mpReturnNotice(r: MpConnectReturn): { tone: NoticeTone; text: string } {
  return MP_RETURN_NOTICE[r];
}

const DISCONNECT_CONFIRM: ConfirmOptions = {
  title: "¿Desconectar tu Mercado Pago?",
  message:
    "Se anulan los links de pago activos a tu cuenta y el turnero deja de cobrar online tus turnos. Lo que ya se pagó no cambia.",
  confirmLabel: "Desconectar",
  tone: "danger",
};

/** Conectar o reconectar la propia: el server arma la URL y setea la cookie; el cliente navega. Devuelve el error. */
export async function connectOwnMp(navigate: (url: string) => void): Promise<string | null> {
  const res = await startMpConnect({ target: "own" });
  if (!res.ok) return res.error;
  navigate(res.data.url);
  return null;
}

export type DisconnectOutcome = { kind: "cancelled" } | { kind: "done"; cancelledLinks: number } | { kind: "error"; error: string };

/** Desconectar la propia, siempre con confirmación (cancelar no llama a la action). */
export async function disconnectOwnMp(confirm: (o: ConfirmOptions) => Promise<boolean>): Promise<DisconnectOutcome> {
  if (!(await confirm(DISCONNECT_CONFIRM))) return { kind: "cancelled" };
  const res = await disconnectMpAccount({ target: "own" });
  return res.ok ? { kind: "done", cancelledLinks: res.data.cancelledLinks } : { kind: "error", error: res.error };
}

/** Prende/apaga la delegación de links de pago a la propia cuenta. Devuelve el error (el caller revierte el switch). */
export async function toggleOwnDelegation(delegated: boolean): Promise<string | null> {
  const res = await setMpLinksDelegated({ target: "own", delegated });
  return res.ok ? null : res.error;
}

const NOTICE_STYLE: Record<NoticeTone, React.CSSProperties> = {
  success: { background: "var(--success-bg)", border: "1px solid var(--success-border)", color: "var(--success-fg)" },
  warn: { background: "var(--warn-bg)", border: "1px solid var(--warn-border)", color: "var(--warn-fg)" },
  danger: { background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger-fg)" },
};

function Notice({ tone, children, ...rest }: { tone: NoticeTone; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // Éxito = status (cortés); lo que hay que resolver = alert. Mismo criterio que el resto de Configuración.
      role={tone === "success" ? "status" : "alert"}
      {...rest}
      style={{ ...NOTICE_STYLE[tone], borderRadius: "var(--r-md)", padding: "10px 12px", fontSize: 13.5, lineHeight: 1.45 }}
    >
      {children}
    </div>
  );
}

const STATUS_TONE: Record<MyMpPanelProps["account"]["status"], React.CSSProperties> = {
  ACTIVE: { color: "var(--success-fg)" },
  REAUTH_REQUIRED: { color: "var(--warn-fg)" },
  DISCONNECTED: { color: "var(--navy-500)" },
  NONE: { color: "var(--navy-500)" },
};

const muted: React.CSSProperties = { margin: 0, fontSize: 13.5, lineHeight: 1.5, color: "var(--navy-600)" };

export function MyMpPanel({ account, mpReturn, support = false }: MyMpPanelProps) {
  const confirm = useConfirm();
  const [delegated, setDelegated] = useState(account.linksDelegated);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [delegating, setDelegating] = useState(false);
  const { status } = account;

  // Desconectar/reconectar revalida `/configuracion` y llegan props nuevas: el switch sigue a la fila, no al estado viejo.
  useEffect(() => setDelegated(account.linksDelegated), [account.linksDelegated]);

  // El aviso `?mp=` se muestra una vez: se saca de la URL (sin navegar) para que recargar o compartir el link no lo
  // repita. `replaceState` y no el router: no hace falta otro render del server.
  useEffect(() => {
    if (!mpReturn) return;
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("mp")) return;
      url.searchParams.delete("mp");
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* sin History API: el aviso vuelve a salir al recargar, nada más */
    }
  }, [mpReturn]);

  async function connect() {
    setPending(true);
    setError(null);
    setDone(null);
    const err = await connectOwnMp((url) => window.location.assign(url));
    // Con éxito queda `pending`: el navegador ya se está yendo a Mercado Pago (evita el doble click).
    if (err) {
      setError(err);
      setPending(false);
    }
  }

  async function disconnect() {
    setError(null);
    setDone(null);
    setPending(true);
    const r = await disconnectOwnMp(confirm);
    setPending(false);
    if (r.kind === "error") setError(r.error);
    if (r.kind === "done") {
      setDone(
        r.cancelledLinks > 0
          ? `Desconectaste tu Mercado Pago. Se ${r.cancelledLinks === 1 ? "anuló 1 link de pago activo" : `anularon ${r.cancelledLinks} links de pago activos`}.`
          : "Desconectaste tu Mercado Pago.",
      );
    }
  }

  async function toggleDelegation() {
    if (delegating) return;
    const next = !delegated;
    setDelegated(next);
    setDelegating(true);
    setError(null);
    const err = await toggleOwnDelegation(next);
    setDelegating(false);
    if (err) {
      setDelegated(!next);
      setError(err);
    }
  }

  const since =
    status === "DISCONNECTED"
      ? account.disconnectedAt && `Desconectada el ${formatDateAR(account.disconnectedAt)}`
      : status !== "NONE" && account.connectedAt
        ? `Conectada el ${formatDateAR(account.connectedAt)}`
        : null;
  const hasSwitch = status === "ACTIVE" || status === "REAUTH_REQUIRED";

  return (
    <div style={{ display: "grid", gap: 14 }} data-my-mp-panel>
      {mpReturn && (
        <Notice tone={MP_RETURN_NOTICE[mpReturn].tone} data-mp-return={mpReturn}>
          {MP_RETURN_NOTICE[mpReturn].text}
        </Notice>
      )}

      <Card style={{ padding: 20, display: "grid", gap: 14 }} data-mp-status={status}>
        <div style={{ display: "grid", gap: 6 }}>
          <EyebrowLabel as="h2">{MP_CONNECT_COPY.myMpTab}</EyebrowLabel>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <strong style={{ fontSize: 15, ...STATUS_TONE[status] }}>{MP_ACCOUNT_STATUS_LABEL[status]}</strong>
            {account.nickname && status !== "NONE" && (
              <span style={{ fontSize: 13.5, color: "var(--navy-700)", overflowWrap: "anywhere" }}>· {account.nickname}</span>
            )}
            {account.badge && (
              <Tag tone="soft" variant="outline">
                {account.badge === "fake" ? MP_CONNECT_COPY.badgeFake : MP_CONNECT_COPY.badgeSandbox}
              </Tag>
            )}
          </div>
          {since && <p style={muted}>{since}</p>}
        </div>

        {status === "NONE" && (
          <p style={muted}>
            Conectá tu cuenta para que el turnero cobre online tus turnos y para recibir links de pago. La plata entra
            directo a tu Mercado Pago.
          </p>
        )}
        {status === "REAUTH_REQUIRED" && (
          <Notice tone="warn">
            <strong>{MP_CONNECT_COPY.reauthTitle}</strong>
            <div>{MP_CONNECT_COPY.reauthBody}</div>
          </Notice>
        )}
        {status === "DISCONNECTED" && (
          <p style={muted}>
            Mientras no la vuelvas a conectar, el turnero no cobra online tus turnos y no se generan links de pago a tu
            nombre. Los cobros que ya entraron siguen en tu historial.
          </p>
        )}

        {support ? (
          <p style={muted}>Desde una sesión de soporte no se conectan ni se cambian cuentas de Mercado Pago.</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {status !== "ACTIVE" && (
              <Button type="button" disabled={pending} onClick={() => void connect()}>
                {status === "NONE"
                  ? "Conectar Mercado Pago"
                  : status === "REAUTH_REQUIRED"
                    ? "Reconectar Mercado Pago"
                    : "Volver a conectar"}
              </Button>
            )}
            {hasSwitch && (
              <Button type="button" variant="ghost" disabled={pending} onClick={() => void disconnect()}>
                Desconectar
              </Button>
            )}
          </div>
        )}

        {done && <Notice tone="success">{done}</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
      </Card>

      {hasSwitch && (
        <Card style={{ padding: 20, display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <Switch
              on={delegated}
              onChange={() => void toggleDelegation()}
              disabled={support || delegating}
              aria-label={MP_CONNECT_COPY.delegationSwitch}
            />
            <div style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{MP_CONNECT_COPY.delegationSwitch}</span>
              <p style={muted}>
                {delegated
                  ? "La Secretaría y los administradores pueden mandarles a tus pacientes links de pago que se cobran en tu cuenta."
                  : "Solo vos generás links de pago a tu cuenta. El turnero la sigue usando para cobrar tus turnos."}
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
