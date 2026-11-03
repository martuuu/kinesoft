"use client";

/**
 * CF2 (§29, T-U1; brief T.C «Push», D-CF2-12) — «Este dispositivo» y «Dispositivos con avisos» dentro de la tarjeta
 * «Avisos de turnos online» de «Mi agenda».
 *
 * - El estado del navegador se lee en un efecto (en el SSR no hay navegador: se ve «Revisando…» y ningún botón, así
 *   el HTML del server no promete algo que el navegador no tiene). Leerlo NUNCA pide el permiso.
 * - «Activar en este dispositivo» es lo único que llama a `Notification.requestPermission()` (flujo en
 *   `activateThisDevice`, `mi-agenda-logic.ts`): Chrome silencia a los sitios que lo piden sin gesto y un «Bloquear»
 *   del usuario es para siempre.
 * - La lista se pide al montar (`listMyPushDevices`), no en el loader de /configuracion (0 queries nuevas para todos,
 *   brief T.C «Presupuestos»). «Quitar» confirma con `useConfirm`.
 * - Sin VAPID en el server (`vapidPublicKey` null) solo el texto de «todavía no habilitados»: no hay nada que activar
 *   ni probar (y `sendTestPush` lo rechazaría).
 */
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  deleteMyPushDevice,
  deletePushSubscription,
  listMyPushDevices,
  savePushSubscription,
  sendTestPush,
} from "@/lib/web-push-actions";
import { pushSupportState, type PushDeviceView, type PushSupportState } from "@/lib/web-push-types";
import {
  MI_AGENDA_COPY as COPY,
  activateThisDevice,
  deviceLine,
  pushDeviceState,
  readPushSupportInput,
  withTimeout,
  SW_READY_TIMEOUT_MS,
} from "./mi-agenda-logic";

type Msg = { tone: "ok" | "err"; text: string } | null;
type Devices = { status: "loading" } | { status: "error" } | { status: "ready"; rows: PushDeviceView[] };

const muted: React.CSSProperties = { fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45, margin: 0 };

/** La suscripción de ESTE navegador, sin esperar a `ready` (sin SW registrado no hay suscripción). */
async function currentBrowserSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager?.getSubscription()) ?? null;
}

export function PushDeviceCard({
  vapidPublicKey,
  onActivated,
}: {
  /** Clave pública VAPID (base64url) o null si el server no tiene las tres variables. */
  vapidPublicKey: string | null;
  /** Después de activar este dispositivo: el panel prende la preferencia «notificación» si estaba apagada. */
  onActivated?: () => void;
}) {
  const vapid = vapidPublicKey !== null;
  const confirm = useConfirm();
  const [support, setSupport] = useState<PushSupportState | null>(null);
  const [browserSub, setBrowserSub] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<Devices>({ status: "loading" });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, start] = useTransition();

  const loadDevices = useCallback(async () => {
    setDevices({ status: "loading" });
    try {
      const r = await listMyPushDevices();
      setDevices(r.ok ? { status: "ready", rows: r.data } : { status: "error" });
    } catch {
      setDevices({ status: "error" });
    }
  }, []);

  useEffect(() => {
    if (!vapid) return;
    setSupport(pushSupportState(readPushSupportInput(window as never)));
    currentBrowserSubscription()
      .then((s) => setBrowserSub(s !== null))
      .catch(() => setBrowserSub(false));
    void loadDevices();
  }, [vapid, loadDevices]);

  if (vapidPublicKey === null) {
    return (
      <p data-push-state="no-vapid" style={muted}>
        {COPY.pushNoVapid}
      </p>
    );
  }

  const applicationServerKey: string = vapidPublicKey;
  // «Activo» = el navegador tiene suscripción Y el server la reconoce como la de este navegador (la cookie): si se la
  // quitó desde otro dispositivo, el navegador la sigue teniendo pero ya no le llega nada.
  const serverKnowsThis = devices.status === "ready" ? devices.rows.some((d) => d.current) : true;
  const subscribed = browserSub === null ? null : browserSub && serverKnowsThis;
  const ui = pushDeviceState({ vapid, support, subscribed });
  const hasDevices = devices.status === "ready" && devices.rows.length > 0;

  const activate = () => {
    setMsg(null);
    start(async () => {
      const out = await activateThisDevice({
        requestPermission: () => Notification.requestPermission(),
        serviceWorkerReady: () => navigator.serviceWorker.ready,
        applicationServerKey,
        save: savePushSubscription,
      });
      // Después de pedir el permiso, el estado del navegador cambió (granted/denied): se relee.
      setSupport(pushSupportState(readPushSupportInput(window as never)));
      if (!out.ok) {
        setMsg({ tone: "err", text: out.error });
        return;
      }
      setBrowserSub(true);
      onActivated?.();
      await loadDevices();
    });
  };

  const deactivate = () => {
    setMsg(null);
    start(async () => {
      try {
        const sub = await withTimeout(currentBrowserSubscription(), SW_READY_TIMEOUT_MS);
        if (sub) {
          const r = await deletePushSubscription(sub.endpoint);
          if (!r.ok) {
            setMsg({ tone: "err", text: r.error });
            return;
          }
          await sub.unsubscribe().catch(() => false);
        }
        setBrowserSub(false);
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      }
      await loadDevices();
    });
  };

  const test = () => {
    setMsg(null);
    start(async () => {
      try {
        const r = await sendTestPush();
        setMsg(r.ok ? { tone: "ok", text: COPY.testSent } : { tone: "err", text: r.error });
        if (r.ok && r.data.removed > 0) await loadDevices();
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      }
    });
  };

  const remove = async (d: PushDeviceView) => {
    const ok = await confirm({
      title: COPY.removeConfirmTitle,
      message: `${deviceLine(d).title}. ${COPY.removeConfirmMessage}`,
      tone: "danger",
      confirmLabel: COPY.remove,
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    setMsg(null);
    start(async () => {
      try {
        const r = await deleteMyPushDevice(d.id);
        if (!r.ok) {
          setMsg({ tone: "err", text: r.error });
          return;
        }
        // Era este navegador: también se da de baja su suscripción (si no, seguiría creyendo que tiene avisos).
        if (d.current) {
          const sub = await currentBrowserSubscription().catch(() => null);
          await sub?.unsubscribe().catch(() => false);
          setBrowserSub(false);
        }
      } catch {
        setMsg({ tone: "err", text: COPY.network });
      }
      await loadDevices();
    });
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section aria-label={COPY.deviceTitle} style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{COPY.deviceTitle}</div>
        <p data-push-state={ui.kind} style={muted}>
          {ui.message}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {ui.canActivate && (
            <Button type="button" variant="primary" size="sm" onClick={activate} disabled={busy}>
              {busy ? COPY.activating : COPY.activate}
            </Button>
          )}
          {ui.canDeactivate && (
            <Button type="button" variant="ghost" size="sm" onClick={deactivate} disabled={busy}>
              {COPY.deactivate}
            </Button>
          )}
          {hasDevices && (
            <Button type="button" variant="ghost" size="sm" onClick={test} disabled={busy}>
              {COPY.test}
            </Button>
          )}
        </div>
        {msg && (
          <div
            role={msg.tone === "err" ? "alert" : "status"}
            style={{ fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--navy-900)" : "var(--danger-fg)" }}
          >
            {msg.text}
          </div>
        )}
      </section>

      <section aria-label={COPY.devicesTitle} style={{ display: "grid", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{COPY.devicesTitle}</div>
        {devices.status === "loading" && <p style={muted}>{COPY.devicesLoading}</p>}
        {devices.status === "error" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <p role="alert" style={{ ...muted, color: "var(--danger-fg)" }}>
              {COPY.devicesError}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadDevices()}>
              {COPY.retry}
            </Button>
          </div>
        )}
        {devices.status === "ready" && devices.rows.length === 0 && <p style={muted}>{COPY.devicesEmpty}</p>}
        {devices.status === "ready" && devices.rows.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {devices.rows.map((d) => {
              const line = deviceLine(d);
              return (
                <li
                  key={d.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(15,30,51,0.08)",
                    background: "var(--card-bg)",
                  }}
                >
                  <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{line.title}</span>
                    <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>{line.detail}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(d)}
                    disabled={busy}
                    aria-label={`${COPY.remove}: ${line.title}`}
                  >
                    {COPY.remove}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
