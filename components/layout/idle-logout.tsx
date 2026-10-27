"use client";

/**
 * IN (§27): cierre de sesión por inactividad, la parte del navegador. Lo monta SOLO `AppShell` (todo `(app)`,
 * incluida `/sala`), y solo cuando el layout le pasa `idle` (= sesión «de navegador»: destildó «Mantenerme conectado»;
 * la política está en `lib/idle-logout.ts` → `idlePolicyFor`). `/tv`, el portal y `/plataforma` no están bajo
 * `AppShell`: no lo cargan.
 *
 * Cómo funciona:
 *  - Actividad = `pointerdown`, `keydown`, `wheel`, `touchstart`, `scroll` CONFIABLES (`isTrusted`: un script de la
 *    página no puede mantener viva la sesión) + `pointermove` con throttle de 5 s. El realtime (la agenda que se
 *    actualiza sola) y `visibilitychange` NO cuentan: una recepción con la agenda abierta y nadie adelante tiene que
 *    cerrarse igual.
 *  - La verdad es la cookie `kine_idle` (`"<lastSec>.<minutes>.<tag>"`), escrita como mucho cada 5 s y en hora del
 *    SERVER (`serverNowMs` del layout − `Date.now()` al montar = offset): el layout `(app)` la compara con su reloj y,
 *    si escribiéramos con el reloj del equipo, una PC atrasada vencería antes en el server que acá.
 *  - Tick cada 5 s (1 s durante el aviso) que relee la cookie: así una pestaña activa mantiene vivas las demás.
 *    `BroadcastChannel("kine-idle")` solo acelera (avisa «hubo actividad» / «se venció»); sin él todo funciona igual
 *    con el tick.
 *  - A T−60 s la pestaña VISIBLE muestra «¿Seguís ahí?» (`idle-warning-modal.tsx`, `next/dynamic`: el `Modal` trae
 *    framer y no tiene por qué estar en el first load de cada ruta). Con el aviso en pantalla solo «Seguir conectado»
 *    (o cerrarlo) reinicia el reloj; la actividad suelta no (ver `onEvent`). A T, POST oculto a `/api/auth/sign-out` con
 *    `idleSignOutAction(path)` → `/login?reason=idle&next=<path>`: la ruta exige Origin propio, y un form del mismo
 *    origen lo manda.
 *  - Si la cookie desaparece o pasa a ser de OTRA sesión después de haberla visto (otra pestaña cerró sesión, o se
 *    inició otra sesión en este navegador), se recarga la página: el server decide (login, o la sesión nueva). Nunca se
 *    re-escribe por encima: eso revivía la sesión que otra pestaña acababa de cerrar.
 *
 * Bundle: va en todas las rutas del workspace → sin framer, sin zod, sin imports de server. Las piezas puras van
 * exportadas para el unit test (`tests/unit/in-idle-client.test.ts`).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  IDLE_CHANNEL,
  IDLE_COOKIE,
  idlePhase,
  idleSignOutAction,
  parseIdleCookie,
  secondsLeft,
  serializeIdleCookie,
} from "@/lib/idle-logout";

const IdleWarningModal = dynamic(() => import("./idle-warning-modal").then((m) => m.IdleWarningModal), {
  ssr: false,
  loading: () => null,
});

/** La cookie se escribe como mucho cada 5 s (cada `document.cookie =` viaja en todos los requests siguientes). */
export const IDLE_WRITE_EVERY_MS = 5_000;
/** `pointermove` dispara decenas de veces por segundo: cuenta una vez cada 5 s. */
export const IDLE_MOVE_THROTTLE_MS = 5_000;
export const IDLE_TICK_MS = 5_000;
/** Durante el aviso el contador baja de a un segundo. */
export const IDLE_TICK_WARNING_MS = 1_000;

/** Eventos que cuentan como actividad (además de `pointermove`, con throttle). */
export const IDLE_ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;

/** Offset reloj del server − reloj local, medido al montar con la hora que mandó el layout. */
export function clockOffsetMs(serverNowMs: number, clientNowMs: number): number {
  return Number.isFinite(serverNowMs) ? serverNowMs - clientNowMs : 0;
}

/**
 * ¿Este evento cuenta como actividad? Solo confiables; `pointermove` solo si pasaron 5 s desde el último que contó.
 * `lastMoveAt` es la hora (cualquier reloj, el mismo que `now`) del último `pointermove` que contó.
 */
export function countsAsActivity(type: string, isTrusted: boolean, now: number, lastMoveAt: number): boolean {
  if (!isTrusted) return false;
  if (type === "pointermove") return now - lastMoveAt >= IDLE_MOVE_THROTTLE_MS;
  return (IDLE_ACTIVITY_EVENTS as readonly string[]).includes(type);
}

/** ¿Hay actividad sin escribir y ya pasaron 5 s de la última escritura? */
export function shouldWriteIdleCookie(now: number, localLast: number, writtenLast: number, lastWriteAt: number): boolean {
  return localLast > writtenLast && now - lastWriteAt >= IDLE_WRITE_EVERY_MS;
}

/** Valor de una cookie en `document.cookie` (sin decodificar: `kine_idle` es ASCII sin `;` ni `=`). */
export function readCookieValue(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export type IdleTickResult =
  /** Cookie borrada o de otra sesión después de haberla visto: recargar y que decida el server. */
  | { kind: "gone" }
  /** Todavía no hay cookie de esta sesión (primer render después del login): escribirla con `now`. */
  | { kind: "init"; last: number }
  | { kind: "phase"; phase: "active" | "warning" | "expired"; last: number; seconds: number };

/**
 * Un tick: combina la última actividad local con la de la cookie (otra pestaña pudo haber tenido actividad) y
 * devuelve la fase. `seen` = esta pestaña ya vio (o escribió) una cookie de su sesión.
 *
 * Al montar con una cookie de esta sesión NO se reinicia el reloj (`localLast` = 0): recargar la página justo en el
 * borde (entre T y T+gracia el server todavía deja pasar) no puede regalar otros 15 minutos.
 */
export function idleTick(p: {
  now: number;
  localLast: number;
  cookieRaw: string | null;
  tag: string;
  minutes: number;
  seen: boolean;
}): IdleTickResult {
  const c = parseIdleCookie(p.cookieRaw);
  if (!c || c.tag !== p.tag) return p.seen ? { kind: "gone" } : { kind: "init", last: p.now };
  const last = Math.max(p.localLast, c.lastMs);
  return { kind: "phase", phase: idlePhase(p.now, last, p.minutes), last, seconds: secondsLeft(p.now, last, p.minutes) };
}

type Phase = "active" | "warning" | "expired";

export function IdleLogout({ minutes, sessionTag, serverNowMs }: { minutes: number; sessionTag: string; serverNowMs: number }) {
  const [phase, setPhase] = useState<Phase>("active");
  const [seconds, setSeconds] = useState(60);
  const [visible, setVisible] = useState(true);
  const formRef = useRef<HTMLFormElement | null>(null);
  const offsetRef = useRef(0);
  const localLastRef = useRef(0);
  const writtenLastRef = useRef(0);
  const lastWriteAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastMoveAtRef = useRef(Number.NEGATIVE_INFINITY);
  const seenRef = useRef(false);
  const doneRef = useRef(false);
  const phaseRef = useRef<Phase>("active");
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tickRef = useRef<() => void>(() => {});

  // El layout puede re-renderizar (router.refresh) con otra hora: se re-mide el offset.
  useEffect(() => {
    offsetRef.current = clockOffsetMs(serverNowMs, Date.now());
  }, [serverNowMs]);

  const now = useCallback(() => Date.now() + offsetRef.current, []);

  const writeCookie = useCallback(
    (last: number) => {
      const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
      // De sesión (sin Max-Age): muere con el navegador, igual que las cookies de Supabase en este modo.
      document.cookie = `${IDLE_COOKIE}=${serializeIdleCookie(last, minutes, sessionTag)}; Path=/; SameSite=Lax${secure}`;
      writtenLastRef.current = last;
      lastWriteAtRef.current = now();
      // `seen` NO se marca acá sino cuando el tick la relee: si el navegador no la guardara (cookies bloqueadas), «la
      // vi y desapareció» dispararía una recarga en bucle.
      try {
        channelRef.current?.postMessage({ t: "a" });
      } catch {
        // Canal cerrado: el tick de las otras pestañas lee la cookie igual.
      }
    },
    [minutes, sessionTag, now]
  );

  const expire = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    phaseRef.current = "expired";
    setPhase("expired");
    try {
      channelRef.current?.postMessage({ t: "x" });
    } catch {
      // idem
    }
    const form = formRef.current;
    if (!form) return;
    form.action = idleSignOutAction(window.location.pathname + window.location.search);
    form.submit();
  }, []);

  const tick = useCallback(() => {
    if (doneRef.current) return;
    const t = now();
    if (shouldWriteIdleCookie(t, localLastRef.current, writtenLastRef.current, lastWriteAtRef.current)) {
      writeCookie(localLastRef.current);
    }
    const r = idleTick({
      now: t,
      localLast: localLastRef.current,
      cookieRaw: readCookieValue(document.cookie, IDLE_COOKIE),
      tag: sessionTag,
      minutes,
      seen: seenRef.current,
    });
    if (r.kind === "gone") {
      doneRef.current = true;
      window.location.reload();
      return;
    }
    if (r.kind === "init") {
      localLastRef.current = r.last;
      writeCookie(r.last);
      return;
    }
    seenRef.current = true;
    localLastRef.current = r.last;
    if (r.phase === "expired") {
      expire();
      return;
    }
    phaseRef.current = r.phase;
    setPhase(r.phase);
    setSeconds(r.seconds);
    setVisible(document.visibilityState !== "hidden");
  }, [now, writeCookie, expire, sessionTag, minutes]);
  tickRef.current = tick;

  const markActive = useCallback(
    (force: boolean) => {
      if (doneRef.current) return;
      const t = now();
      localLastRef.current = t;
      if (force || t - lastWriteAtRef.current >= IDLE_WRITE_EVERY_MS) writeCookie(t);
      // «Seguir conectado» cierra el aviso ya (no al próximo tick).
      if (force && phaseRef.current === "warning") tickRef.current();
    },
    [now, writeCookie]
  );

  // Escuchas: una sola vez por montaje (los callbacks van por ref para no re-suscribir).
  const markRef = useRef(markActive);
  markRef.current = markActive;
  const expireRef = useRef(expire);
  expireRef.current = expire;
  useEffect(() => {
    const onEvent = (e: Event) => {
      // Con el aviso en pantalla, la actividad suelta NO cuenta: solo «Seguir conectado» (o cerrar el aviso). Si contara,
      // el `pointerdown` sobre «Cerrar sesión» cerraba el modal antes del `click` y el botón no hacía nada; y mover el
      // mouse sin querer no tiene por qué decidir por la persona. La actividad en OTRA pestaña sí lo cierra (cookie).
      if (phaseRef.current === "warning") return;
      const t = Date.now() + offsetRef.current;
      if (!countsAsActivity(e.type, e.isTrusted, t, lastMoveAtRef.current)) return;
      if (e.type === "pointermove") lastMoveAtRef.current = t;
      markRef.current(false);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const types = [...IDLE_ACTIVITY_EVENTS, "pointermove"];
    for (const type of types) window.addEventListener(type, onEvent, opts);
    // `visibilitychange` NO es actividad; solo re-evalúa (la pestaña que vuelve a verse en el aviso muestra el modal).
    const onVisibility = () => tickRef.current();
    document.addEventListener("visibilitychange", onVisibility);

    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(IDLE_CHANNEL);
        channel.onmessage = (ev: MessageEvent) => {
          const t = (ev.data as { t?: unknown } | null)?.t;
          // «Se venció» en otra pestaña: esta también cierra (con su propio path para volver).
          if (t === "x") {
            const r = idleTick({
              now: Date.now() + offsetRef.current,
              localLast: localLastRef.current,
              cookieRaw: readCookieValue(document.cookie, IDLE_COOKIE),
              tag: sessionTag,
              minutes,
              seen: true,
            });
            // Solo si de verdad venció también acá (un mensaje no puede cerrar una sesión con actividad reciente).
            if (r.kind !== "phase" || r.phase === "expired") {
              expireRef.current();
              return;
            }
          }
          tickRef.current();
        };
      } catch {
        channel = null;
      }
    }
    channelRef.current = channel;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = () => {
      tickRef.current();
      if (doneRef.current) return;
      timer = setTimeout(loop, phaseRef.current === "warning" ? IDLE_TICK_WARNING_MS : IDLE_TICK_MS);
    };
    loop();

    return () => {
      for (const type of types) window.removeEventListener(type, onEvent, opts);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
      channel?.close();
      channelRef.current = null;
    };
    // Montaje único: `sessionTag`/`minutes` no cambian dentro de una sesión (otra sesión = recarga).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const stay = useCallback(() => markRef.current(true), []);

  return (
    <>
      {/* POST oculto del cierre: el `action` real (con el path actual) se arma al enviarlo. */}
      <form ref={formRef} method="post" action={idleSignOutAction()} hidden aria-hidden="true" data-testid="idle-signout-form" />
      {phase === "warning" && visible && <IdleWarningModal seconds={seconds} onStay={stay} />}
      {phase === "expired" && (
        // Mientras viaja el POST, la pantalla con datos de pacientes queda tapada (PC compartida).
        <div
          data-testid="idle-closing"
          role="status"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: "var(--z-toast)",
            background: "var(--bg-app)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--navy-700)",
            fontSize: 15,
          }}
        >
          Cerrando sesión…
        </div>
      )}
    </>
  );
}
