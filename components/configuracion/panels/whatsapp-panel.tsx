"use client";

/**
 * [WA-U1] (T6, C-WA6/C-WA9, brief §26.5 «UI») · Configuración → WhatsApp.
 *
 * Quién ve qué (WA-D25, mismo corte que «Cobros online» de T5):
 *   - La pestaña: `tenant.sensitive` con `WHATSAPP_MODE` ≠ off (lo decide el loader; con off no existe).
 *   - Conectar, continuar la configuración y desconectar: solo el Titular (`account.owner`, nunca soporte), con step-up:
 *     la action tira el error de 2FA y `runStepUp` abre el desafío y la reintenta (el `StepUpProvider` lo monta este
 *     panel, como «Cobros online»).
 *   - Los 3 switches y la prueba: todo el que ve la pestaña.
 *
 * Los datos NO vienen en el HTML de la página: el loader solo manda el modo y el destino del popup (0 sentencias), y el
 * panel pide `getWhatsAppPanel()` al montar. Así `/configuracion` no suma lecturas para quien nunca abre la pestaña
 * (el presupuesto de PF2 sigue igual) y el chunk de este panel + `whatsapp-signup.ts` va diferido (`next/dynamic`).
 *
 * El alta (ver `whatsapp-signup.ts`): «Conectar» → `startWhatsAppConnect` (step-up, cookie `kine_wa_signup` + nonce) →
 * ventana de Meta (o del simulador) → `completeWhatsAppConnect` apenas llegan el `code` y los ids. Con Meta real hay un
 * segundo click («Abrir la ventana de Meta»): `FB.login` abre un popup y, fuera del gesto del usuario (después del
 * await de la action y del desafío de 2FA), el navegador lo bloquea. En el simulador se intenta abrir directo y, si el
 * navegador lo bloquea, aparece el mismo botón.
 *
 * Los flujos de los botones son funciones exportadas con sus dependencias inyectadas: el repo no tiene DOM en los tests
 * y el test llama al mismo código que el click (patrón de `clinic-mp-account-card.tsx`).
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button, buttonClassName } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import { SkelForm } from "@/components/ui/skeleton";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { StepUpProvider, useStepUpAction, type RunStepUpAction, type StepUpFailure } from "@/components/account/step-up-modal";
import {
  completeWhatsAppConnect,
  disconnectWhatsApp,
  getWhatsAppPanel,
  resumeWhatsAppSetup,
  sendWhatsAppTest,
  startWhatsAppConnect,
  updateWhatsAppSettings,
} from "@/lib/whatsapp-actions";
import { formatDateAR } from "@/lib/format";
import {
  WA_ACCOUNT_STATUS_LABEL,
  WA_COPY,
  WA_MESSAGE_KIND_LABEL,
  WA_SETUP_STEP_LABEL,
  WA_TEMPLATE_STATUS_LABEL,
  waErrorLabel,
} from "@/lib/whatsapp/copy";
import type { WaConnectStart, WaPanel, WaSettingsInput, WaSetupOutcome, WaTestResult } from "@/lib/whatsapp/account-types";
import type { WaAccountMode, WaAccountView, WaTemplateStatus } from "@/lib/whatsapp/types";
import type { ActionResult } from "@/lib/validation";
import { ErrorBox, Switch } from "../controls";
import {
  WA_SIGNUP_WINDOW,
  WA_SIGNUP_WINDOW_FEATURES,
  fakeDialogHref,
  loadFacebookSdk,
  runFacebookLogin,
  startSignupSession,
  type FbSdk,
  type WaDialogTarget,
  type WaSignupResult,
  type WaSignupSession,
} from "./whatsapp-signup";

/** Lo que manda el loader de Configuración (`ConfiguracionWhatsAppData`): sin lecturas de base. */
export type WhatsAppTabConfig = {
  mode: WaAccountMode;
  dialog: WaDialogTarget;
  /** Titular y no soporte. La action lo vuelve a exigir. */
  canManage: boolean;
};

export const WA_U1_COPY = {
  connectTitle: "Conectá el WhatsApp del consultorio",
  connectBody:
    "Les mandamos a tus pacientes el aviso del turno agendado y el recordatorio del día anterior desde el número del consultorio, y ellos confirman o avisan que no pueden ir con un botón. Solo les escribimos a quienes aceptaron recibir avisos por WhatsApp.",
  connectHint:
    "Necesitás una cuenta de WhatsApp Business: en la ventana de Meta elegís la cuenta y el número. Te vamos a pedir el código de la verificación en dos pasos.",
  connectFakeHint: "Simulador local: la ventana es un Meta falso y no se conecta ningún número real.",
  connect: "Conectar",
  ownerOnly: "Solo el titular de la cuenta conecta o desconecta el WhatsApp del consultorio.",
  setupTitle: "Configuración en curso",
  setupBody: "La conexión con Meta quedó a mitad de camino. Retomala desde donde quedó: no hace falta volver a elegir el número.",
  resume: "Continuar configuración",
  reauthBody:
    "Meta dejó de aceptar el acceso al WhatsApp del consultorio: hasta que lo vuelvas a conectar no sale ningún aviso.",
  openMeta: "Abrir la ventana de Meta",
  openFake: "Abrir el simulador de Meta",
  cancelSignup: "Cancelar",
  starting: "Preparando la conexión…",
  loadingSdk: "Cargando la ventana de Meta…",
  ready: "Todo listo: abrí la ventana de Meta para elegir la cuenta y el número.",
  waiting: "Completá los pasos en la ventana de Meta. Cuando termines, la conexión sigue sola.",
  completing: "Conectando el número…",
  connected: "Conectamos el WhatsApp del consultorio.",
  connectedPartial: "El número quedó conectado, pero falta terminar la configuración.",
  cancelled: "Cancelaste la conexión en Meta: no se cambió nada.",
  noPhone: "Para terminar la conexión tenés que elegir un número de teléfono en la ventana de Meta.",
  sdkError:
    "No pudimos abrir la ventana de Meta. Revisá que el navegador no bloquee las ventanas emergentes ni el contenido de Facebook y probá de nuevo.",
  network: "No pudimos hablar con el servidor. Revisá la conexión y probá de nuevo.",
  loadError: "No pudimos cargar la configuración de WhatsApp. Probá de nuevo en unos minutos.",
  retry: "Reintentar",
  off: "Los avisos por WhatsApp todavía no están habilitados.",
  badgeFake: "Simulador",
  badgeSandbox: "Prueba",
  number: "Número",
  verifiedName: "Nombre verificado",
  quality: "Calidad",
  limit: "Límite de Meta",
  connectedSince: (date: string) => `Conectado desde el ${date}`,
  templatesTitle: "Plantillas de mensajes",
  templatesHint: "Meta revisa cada plantilla antes de que se pueda usar. Las aprobadas son las que salen.",
  rejectedReason: (r: string) => `Motivo de Meta: ${r}`,
  paymentTitle: "Medio de pago en Meta",
  // ZF3: no sabemos si el medio de pago está cargado (Meta solo avisa problemas): no se afirma «Cargado».
  paymentOk: "Meta no avisó problemas con el cobro. Si avisa alguno, lo vas a ver acá.",
  paymentIssue: (date: string) =>
    `Meta avisó un problema con el medio de pago el ${date}. Hasta que lo resuelvas, los avisos pueden no salir.`,
  openManager: "Abrir WhatsApp Manager",
  settingsTitle: "Avisos automáticos",
  bookingNotice: "Aviso de turno agendado",
  bookingNoticeHint: "Cuando se agenda o se reprograma un turno confirmado.",
  reminder: "Recordatorio del día anterior",
  reminderHint: "A las 18 h del día anterior, con los botones «Confirmo» y «No puedo ir».",
  autoReply: "Respuesta automática",
  autoReplyHint: "Si un paciente escribe, le contestamos con el contacto del consultorio (una vez por día).",
  testTitle: "Enviar un mensaje de prueba",
  testLabel: "Celular",
  testHint: "Te mandamos el mensaje de prueba de Meta a ese número.",
  testSend: "Enviar prueba",
  testSent: (left: number) => `Mandamos el mensaje de prueba. ${testsLeftCopy(left)}`,
  disconnectTitle: "¿Desconectar el WhatsApp del consultorio?",
  disconnected: (n: number) =>
    n === 0
      ? "Desconectamos el WhatsApp del consultorio"
      : `Desconectamos el WhatsApp del consultorio y cancelamos ${n} ${n === 1 ? "mensaje en cola" : "mensajes en cola"}`,
} as const;

/** Link al WhatsApp Manager (medio de pago, plantillas, calidad). Es un link que abre el usuario: no es un fetch. */
export const WA_MANAGER_HREF = "https://business.facebook.com/wa/manage/home/";

export function testsLeftCopy(left: number): string {
  if (left <= 0) return "Ya no te quedan pruebas por hoy.";
  return left === 1 ? "Te queda 1 prueba por hoy." : `Te quedan ${left} pruebas por hoy.`;
}

export type WaPanelState = "off" | "connect" | "setup" | "reauth" | "connected";

/** Qué pantalla toca (puro). Sin cuenta o desconectada = «Conectá…». */
export function waPanelState(p: Pick<WaPanel, "mode" | "account">): WaPanelState {
  if (p.mode === "off") return "off";
  const a = p.account;
  if (!a || a.status === "DISCONNECTED") return "connect";
  if (a.status === "SETUP") return "setup";
  if (a.status === "REAUTH_REQUIRED") return "reauth";
  return "connected";
}

const QUALITY_LABEL: Record<string, string> = { GREEN: "Alta", YELLOW: "Media", RED: "Baja" };

/** Calidad del número según Meta (`GREEN|YELLOW|RED`, o lo que mande Meta → «Sin calificar»). */
export function qualityLabel(q: string | null | undefined): string {
  return (q && QUALITY_LABEL[q.toUpperCase()]) || "Sin calificar";
}

/** `TIER_1K` → «Hasta 1.000 contactos por día»; `TIER_UNLIMITED` → «Sin límite»; otro valor → null (no se muestra). */
export function messagingLimitLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  const t = tier.toUpperCase();
  if (t === "TIER_UNLIMITED" || t === "UNLIMITED") return "Sin límite";
  const m = /^TIER_(\d+)(K?)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? 1000 : 1);
  return `Hasta ${n.toLocaleString("es-AR")} contactos por día`;
}

const TEMPLATE_TONE: Record<WaTemplateStatus, "lime" | "sky" | "soft"> = {
  APPROVED: "lime",
  PENDING: "sky",
  NOT_SUBMITTED: "soft",
  REJECTED: "soft",
  PAUSED: "soft",
  DISABLED: "soft",
};

// ── Flujos (exportados para el test: el botón llama exactamente esto) ───────────────────────────────────────────

/** «Conectar» / «Volver a conectar»: la action corre dentro de `runStepUp` (2FA). */
export function beginWhatsAppConnect(deps: {
  runStepUp: RunStepUpAction;
  start: typeof startWhatsAppConnect;
}): Promise<ActionResult<WaConnectStart> | StepUpFailure> {
  return deps.runStepUp(() => deps.start());
}

/** «Continuar configuración»: pasos retomables (SUBSCRIBED → REGISTERED → TEMPLATES → DONE), con step-up. */
export function resumeWhatsAppFlow(deps: {
  runStepUp: RunStepUpAction;
  resume: typeof resumeWhatsAppSetup;
}): Promise<ActionResult<WaSetupOutcome> | StepUpFailure> {
  return deps.runStepUp(() => deps.resume());
}

/** «Desconectar WhatsApp»: `useConfirm` (AGENTS §5) y después la action con step-up. null = canceló la confirmación. */
export async function disconnectWhatsAppFlow(deps: {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  runStepUp: RunStepUpAction;
  disconnect: typeof disconnectWhatsApp;
}): Promise<ActionResult<{ cancelledMessages: number }> | StepUpFailure | null> {
  const ok = await deps.confirm({
    title: WA_U1_COPY.disconnectTitle,
    message: WA_COPY.disconnectConfirm,
    confirmLabel: WA_COPY.disconnect,
    tone: "danger",
  });
  if (!ok) return null;
  return deps.runStepUp(() => deps.disconnect());
}

/** Un switch: manda SOLO la clave tocada (la action rechaza un patch vacío). */
export function toggleWhatsAppSetting(
  update: typeof updateWhatsAppSettings,
  key: keyof WaSettingsInput,
  next: boolean
): Promise<ActionResult> {
  return update({ [key]: next });
}

/** Resultado de la prueba → texto a mostrar y si es error. */
export function testResultNotice(r: ActionResult<WaTestResult>): { tone: "ok" | "error"; text: string } {
  if (!r.ok) return { tone: "error", text: r.error };
  if (r.data.status === "SENT") return { tone: "ok", text: WA_U1_COPY.testSent(r.data.testsLeftToday) };
  return { tone: "error", text: `${waErrorLabel(r.data.errorCode) ?? "No se pudo enviar."} ${testsLeftCopy(r.data.testsLeftToday)}` };
}

/** Copy de cómo terminó la ventana de Meta. */
export function signupResultNotice(r: WaSignupResult): { tone: "ok" | "error"; text: string } {
  if (r.kind === "done") return { tone: "ok", text: r.outcome.done ? WA_U1_COPY.connected : WA_U1_COPY.connectedPartial };
  if (r.kind === "cancelled") return { tone: "error", text: WA_U1_COPY.cancelled };
  if (r.kind === "no_phone") return { tone: "error", text: WA_U1_COPY.noPhone };
  return { tone: "error", text: r.error };
}

// ── Componente ───────────────────────────────────────────────────────────────────────────────────────────────────

type Flow =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "loading_sdk" }
  /** Falta el click que abre la ventana (Meta real siempre; simulador si el navegador bloqueó el popup). */
  | { kind: "ready"; start: WaConnectStart; fb: FbSdk | null }
  | { kind: "waiting" }
  | { kind: "completing" };

const FLOW_STATUS: Partial<Record<Flow["kind"], string>> = {
  starting: WA_U1_COPY.starting,
  loading_sdk: WA_U1_COPY.loadingSdk,
  ready: WA_U1_COPY.ready,
  waiting: WA_U1_COPY.waiting,
  completing: WA_U1_COPY.completing,
};

export function WhatsAppPanel(props: {
  config: WhatsAppTabConfig;
  /** Solo para los tests (render sin efectos): sin esto el panel pide `getWhatsAppPanel()` al montar. */
  initial?: WaPanel | null;
  support?: boolean;
}) {
  return (
    <StepUpProvider>
      <WhatsAppPanelBody {...props} />
    </StepUpProvider>
  );
}

function WhatsAppPanelBody({
  config,
  initial,
  support = false,
}: {
  config: WhatsAppTabConfig;
  initial?: WaPanel | null;
  support?: boolean;
}) {
  const [panel, setPanel] = useState<WaPanel | null | undefined>(initial === undefined ? undefined : initial);
  const [loadFailed, setLoadFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const p = await getWhatsAppPanel();
      setPanel(p);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (initial === undefined) void reload();
  }, [initial, reload]);

  if (loadFailed && panel === undefined) {
    return (
      <Card style={{ padding: 18, display: "grid", gap: 12 }}>
        <ErrorBox>{WA_U1_COPY.loadError}</ErrorBox>
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={() => void reload()}>
            {WA_U1_COPY.retry}
          </Button>
        </div>
      </Card>
    );
  }
  if (panel === undefined) {
    return (
      <div aria-busy="true" aria-label="Cargando WhatsApp" style={{ minHeight: 420 }}>
        <SkelForm fields={4} />
      </div>
    );
  }
  // null = la action dice que no ve la pestaña (perdió `tenant.sensitive` entre la página y el click).
  if (!panel) return null;
  return <WhatsAppPanelView config={config} panel={panel} support={support} onReload={reload} />;
}

function WhatsAppPanelView({
  config,
  panel,
  support,
  onReload,
}: {
  config: WhatsAppTabConfig;
  panel: WaPanel;
  support: boolean;
  onReload: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const runStepUp = useStepUpAction();
  const state = waPanelState(panel);
  const account = panel.account;
  // El panel manda (lo recalcula la action); el loader es el respaldo si la action todavía no volvió.
  const manage = panel.canManage && config.canManage && !support;
  const configure = panel.canConfigure && !support;

  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const session = useRef<WaSignupSession | null>(null);

  useEffect(() => () => session.current?.dispose(), []);

  const busy = pending || flow.kind !== "idle";

  const onSignupResult = useCallback(
    (r: WaSignupResult) => {
      session.current = null;
      const n = signupResultNotice(r);
      setFlow({ kind: "idle" });
      if (n.tone === "ok") {
        toast.success(n.text);
        setNotice(n.text);
        void onReload();
      } else {
        setError(n.text);
      }
    },
    [toast, onReload]
  );

  /** Arranca la escucha de la ventana. `complete` corre en cuanto llegan code + ids (el code vive 30 s). */
  const listenSignup = useCallback(
    (start: WaConnectStart) => {
      session.current?.dispose();
      session.current = startSignupSession({
        start,
        target: config.dialog,
        listen: (fn) => {
          const h = (e: MessageEvent) => fn({ origin: e.origin, data: e.data });
          window.addEventListener("message", h);
          return () => window.removeEventListener("message", h);
        },
        complete: (input) => {
          setFlow({ kind: "completing" });
          return runStepUp(() => completeWhatsAppConnect(input));
        },
        onResult: onSignupResult,
        networkError: WA_U1_COPY.network,
      });
      return session.current;
    },
    [config.dialog, runStepUp, onSignupResult]
  );

  /** Abre la ventana. Tiene que correr dentro del click (si no, el navegador bloquea el popup). */
  function openDialog(start: WaConnectStart, fb: FbSdk | null): boolean {
    if (config.dialog.mode === "fake") {
      const href = fakeDialogHref(start);
      if (!href) return false;
      const w = window.open(href, WA_SIGNUP_WINDOW, WA_SIGNUP_WINDOW_FEATURES);
      if (!w) return false;
      listenSignup(start);
      setFlow({ kind: "waiting" });
      return true;
    }
    if (!fb) return false;
    const s = listenSignup(start);
    setFlow({ kind: "waiting" });
    runFacebookLogin(fb, start, s);
    return true;
  }

  async function onConnect() {
    setError(null);
    setNotice(null);
    setFlow({ kind: "starting" });
    let res: ActionResult<WaConnectStart> | StepUpFailure;
    try {
      res = await beginWhatsAppConnect({ runStepUp, start: startWhatsAppConnect });
    } catch {
      res = { ok: false, error: WA_U1_COPY.network };
    }
    if (!res.ok) {
      setFlow({ kind: "idle" });
      setError(res.error);
      return;
    }
    const start = res.data;
    if (config.dialog.mode === "fake") {
      // Simulador: se intenta abrir directo (mismo origen); bloqueado → botón «Abrir el simulador».
      if (!openDialog(start, null)) setFlow({ kind: "ready", start, fb: null });
      return;
    }
    setFlow({ kind: "loading_sdk" });
    try {
      const fb = await loadFacebookSdk(start, { win: window as never, doc: document as never });
      setFlow({ kind: "ready", start, fb });
    } catch {
      setFlow({ kind: "idle" });
      setError(WA_U1_COPY.sdkError);
    }
  }

  function onOpenReady() {
    if (flow.kind !== "ready") return;
    if (!openDialog(flow.start, flow.fb)) {
      setFlow({ kind: "idle" });
      setError(WA_U1_COPY.sdkError);
    }
  }

  function onCancelSignup() {
    if (session.current) session.current.cancel();
    else setFlow({ kind: "idle" });
  }

  async function onResume() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await resumeWhatsAppFlow({ runStepUp, resume: resumeWhatsAppSetup });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const text = r.data.done ? WA_U1_COPY.connected : WA_U1_COPY.connectedPartial;
      setNotice(text);
      if (r.data.done) toast.success(text);
      else if (r.data.errorCode) setError(waErrorLabel(r.data.errorCode));
      await onReload();
    } catch {
      setError(WA_U1_COPY.network);
    } finally {
      setPending(false);
    }
  }

  async function onDisconnect() {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await disconnectWhatsAppFlow({ confirm, runStepUp, disconnect: disconnectWhatsApp });
      if (!r) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success(WA_U1_COPY.disconnected("data" in r ? r.data.cancelledMessages : 0));
      await onReload();
    } catch {
      setError(WA_U1_COPY.network);
    } finally {
      setPending(false);
    }
  }

  const statusText = FLOW_STATUS[flow.kind] ?? notice ?? "";

  if (state === "off") {
    return (
      <Card style={{ padding: 18 }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>{WA_U1_COPY.off}</p>
      </Card>
    );
  }

  const connectButtons =
    manage &&
    (flow.kind === "ready" ? (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" size="sm" onClick={onOpenReady}>
          {config.dialog.mode === "fake" ? WA_U1_COPY.openFake : WA_U1_COPY.openMeta}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancelSignup}>
          {WA_U1_COPY.cancelSignup}
        </Button>
      </div>
    ) : flow.kind === "waiting" ? (
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={onCancelSignup}>
          {WA_U1_COPY.cancelSignup}
        </Button>
      </div>
    ) : null);

  return (
    <div style={{ display: "grid", gap: 16 }} data-wa-state={state}>
      <Card style={{ padding: 18, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <EyebrowLabel>{WA_COPY.sectionTitle}</EyebrowLabel>
          {account && account.status !== "DISCONNECTED" && (
            <Tag tone={account.status === "ACTIVE" ? "lime" : account.status === "SETUP" ? "sky" : "soft"}>
              {WA_ACCOUNT_STATUS_LABEL[account.status]}
            </Tag>
          )}
          <ModeBadge mode={account && account.status !== "DISCONNECTED" ? account.mode : config.mode} />
        </div>

        {state === "connect" && (
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "var(--navy-900)" }}>{WA_U1_COPY.connectTitle}</h2>
            <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>{WA_U1_COPY.connectBody}</p>
            {manage ? (
              <>
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>
                  {config.mode === "fake" ? WA_U1_COPY.connectFakeHint : WA_U1_COPY.connectHint}
                </p>
                {flow.kind === "ready" || flow.kind === "waiting" ? (
                  connectButtons
                ) : (
                  <div>
                    <Button type="button" size="sm" disabled={busy} onClick={() => void onConnect()}>
                      {WA_U1_COPY.connect}
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{WA_U1_COPY.ownerOnly}</p>
            )}
          </>
        )}

        {state === "setup" && account && (
          <>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: "var(--navy-900)" }}>{WA_U1_COPY.setupTitle}</h2>
            <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>
              {WA_U1_COPY.setupBody} Paso actual: {WA_SETUP_STEP_LABEL[account.setupStep]}.
            </p>
            {account.lastErrorCode && <ErrorBox>{waErrorLabel(account.lastErrorCode)}</ErrorBox>}
            {manage ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button type="button" size="sm" disabled={busy} onClick={() => void onResume()}>
                  {WA_U1_COPY.resume}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onDisconnect()}>
                  {WA_COPY.disconnect}
                </Button>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{WA_U1_COPY.ownerOnly}</p>
            )}
          </>
        )}

        {(state === "connected" || state === "reauth") && account && (
          <>
            <AccountFacts account={account} />
            {state === "reauth" && <ErrorBox>{WA_U1_COPY.reauthBody}</ErrorBox>}
            {manage ? (
              flow.kind === "ready" || flow.kind === "waiting" ? (
                connectButtons
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {state === "reauth" && (
                    <Button type="button" size="sm" disabled={busy} onClick={() => void onConnect()}>
                      {WA_COPY.reconnect}
                    </Button>
                  )}
                  <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void onDisconnect()}>
                    {WA_COPY.disconnect}
                  </Button>
                </div>
              )
            ) : (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{WA_U1_COPY.ownerOnly}</p>
            )}
          </>
        )}

        {/* Estado del alta para el lector de pantalla: siempre montado (un `aria-live` que aparece no se anuncia). */}
        <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", minHeight: 0 }}>
          {statusText}
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
      </Card>

      {account && account.status !== "DISCONNECTED" && account.templates.length > 0 && (
        <TemplatesCard account={account} />
      )}
      {account && account.status !== "DISCONNECTED" && <PaymentCard account={account} />}
      {account && account.status !== "DISCONNECTED" && (
        <SettingsCard account={account} disabled={!configure} key={`${account.id}:${account.autoBookingNotice}:${account.autoReminder}:${account.autoReplyText}`} />
      )}
      {state === "connected" && account && (
        <TestCard disabled={!configure} initialLeft={panel.testsLeftToday} />
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: WaAccountMode }) {
  if (mode === "live") return null;
  return (
    <Tag tone="soft" variant="outline">
      {mode === "fake" ? WA_U1_COPY.badgeFake : WA_U1_COPY.badgeSandbox}
    </Tag>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt style={{ fontSize: 11.5, color: "var(--navy-500)", fontWeight: 600 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13.5, color: "var(--navy-900)", fontWeight: 700, overflowWrap: "anywhere" }}>{value}</dd>
    </div>
  );
}

function AccountFacts({ account }: { account: WaAccountView }) {
  const limit = messagingLimitLabel(account.messagingLimit);
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <dl style={{ margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <Fact label={WA_U1_COPY.number} value={account.displayPhone ?? "—"} />
        <Fact label={WA_U1_COPY.verifiedName} value={account.verifiedName ?? "—"} />
        <Fact label={WA_U1_COPY.quality} value={qualityLabel(account.qualityRating)} />
        {limit && <Fact label={WA_U1_COPY.limit} value={limit} />}
      </dl>
      <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
        {WA_U1_COPY.connectedSince(formatDateAR(account.connectedAt, "short"))}
      </div>
    </div>
  );
}

function TemplatesCard({ account }: { account: WaAccountView }) {
  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }}>
      <EyebrowLabel>{WA_U1_COPY.templatesTitle}</EyebrowLabel>
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{WA_U1_COPY.templatesHint}</p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {account.templates.map((t) => (
          <li key={t.key} data-wa-template={t.key} style={{ display: "grid", gap: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>{WA_MESSAGE_KIND_LABEL[t.key]}</span>
              <Tag tone={TEMPLATE_TONE[t.status]} variant={t.status === "REJECTED" ? "outline" : "fill"}>
                {WA_TEMPLATE_STATUS_LABEL[t.status]}
              </Tag>
            </div>
            {t.status === "REJECTED" && t.rejectedReason && (
              <span style={{ fontSize: 12.5, color: "var(--danger-fg)" }}>{WA_U1_COPY.rejectedReason(t.rejectedReason)}</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PaymentCard({ account }: { account: WaAccountView }) {
  const issue = account.paymentIssueAt;
  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }} data-wa-payment={issue ? "issue" : "ok"}>
      <EyebrowLabel>{WA_U1_COPY.paymentTitle}</EyebrowLabel>
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>{WA_COPY.paymentChecklist}</p>
      {issue ? (
        <ErrorBox>{WA_U1_COPY.paymentIssue(formatDateAR(issue, "short"))}</ErrorBox>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{WA_U1_COPY.paymentOk}</p>
      )}
      <div>
        <a className={buttonClassName({ variant: "ghost", size: "sm" })} href={WA_MANAGER_HREF} target="_blank" rel="noopener noreferrer">
          {WA_U1_COPY.openManager}
        </a>
      </div>
    </Card>
  );
}

const SETTINGS: readonly { key: keyof WaSettingsInput; label: string; hint: string }[] = [
  { key: "autoBookingNotice", label: WA_U1_COPY.bookingNotice, hint: WA_U1_COPY.bookingNoticeHint },
  { key: "autoReminder", label: WA_U1_COPY.reminder, hint: WA_U1_COPY.reminderHint },
  { key: "autoReplyText", label: WA_U1_COPY.autoReply, hint: WA_U1_COPY.autoReplyHint },
];

function SettingsCard({ account, disabled }: { account: WaAccountView; disabled: boolean }) {
  const [values, setValues] = useState<Record<keyof WaSettingsInput, boolean>>({
    autoBookingNotice: account.autoBookingNotice,
    autoReminder: account.autoReminder,
    autoReplyText: account.autoReplyText,
  });
  const [saving, setSaving] = useState<keyof WaSettingsInput | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onToggle(key: keyof WaSettingsInput) {
    if (saving) return;
    const next = !values[key];
    setValues((v) => ({ ...v, [key]: next }));
    setSaving(key);
    setError(null);
    let err: string | null;
    try {
      const r = await toggleWhatsAppSetting(updateWhatsAppSettings, key, next);
      err = r.ok ? null : r.error;
    } catch {
      err = WA_U1_COPY.network;
    } finally {
      setSaving(null);
    }
    if (err) {
      setValues((v) => ({ ...v, [key]: !next }));
      setError(err);
    }
  }

  return (
    <Card style={{ padding: 18, display: "grid", gap: 12 }}>
      <EyebrowLabel>{WA_U1_COPY.settingsTitle}</EyebrowLabel>
      {SETTINGS.map((s) => (
        <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Switch
            on={values[s.key]}
            onChange={() => void onToggle(s.key)}
            disabled={disabled || saving !== null}
            aria-label={s.label}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--navy-900)" }}>{s.label}</div>
            <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{s.hint}</div>
          </div>
        </div>
      ))}
      {error && <ErrorBox>{error}</ErrorBox>}
    </Card>
  );
}

function TestCard({ disabled, initialLeft }: { disabled: boolean; initialLeft: number }) {
  const id = useId();
  const [phone, setPhone] = useState("");
  const [left, setLeft] = useState(initialLeft);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function onSend() {
    if (!phone.trim() || sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = await sendWhatsAppTest({ phone: phone.trim() });
      if (r.ok) setLeft(r.data.testsLeftToday);
      setResult(testResultNotice(r));
    } catch {
      setResult({ tone: "error", text: WA_U1_COPY.network });
    } finally {
      setSending(false);
    }
  }

  const off = disabled || left <= 0;
  return (
    <Card style={{ padding: 18, display: "grid", gap: 10 }}>
      <EyebrowLabel>{WA_U1_COPY.testTitle}</EyebrowLabel>
      <form
        style={{ display: "grid", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void onSend();
        }}
      >
        <label htmlFor={`${id}-phone`} className="k-label">
          {WA_U1_COPY.testLabel}
        </label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            id={`${id}-phone`}
            className="k-input"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="11 2345-6789"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={off || sending}
            aria-describedby={`${id}-hint`}
            style={{ flex: "1 1 200px", minWidth: 0 }}
          />
          <Button type="submit" size="sm" disabled={off || sending || !phone.trim()}>
            {WA_U1_COPY.testSend}
          </Button>
        </div>
        <span id={`${id}-hint`} className="k-hint">
          {WA_U1_COPY.testHint} {testsLeftCopy(left)}
        </span>
      </form>
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 13, color: result?.tone === "error" ? "var(--danger-fg)" : "var(--success-fg)" }}>
        {result?.text ?? ""}
      </p>
    </Card>
  );
}
