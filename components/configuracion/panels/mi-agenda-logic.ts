/**
 * CF2 (§29, T-U1; brief T.B/T.C) — lógica PURA de «Configuración › Mi agenda». Sin React, sin `next/*` y sin tocar
 * globales del navegador (lo que lee del navegador lo recibe por parámetro): la testea
 * `tests/unit/cf2-mi-agenda-logic.test.ts` y la usa `mi-agenda-panel.tsx` / `push-device-card.tsx`.
 *
 *   • Borrador del contacto dentro de la anticipación (D-CF2-9): repite las reglas de `planLeadContactWrite`
 *     (`lib/practitioner-self-settings-logic.ts`, la barrera real es el server) para que el error salga en el campo
 *     sin un round-trip, con el MISMO copy. Si el server pide el consentimiento igual (texto de versión vieja: el loader
 *     no manda la versión), la UI fuerza la casilla con `forceConsent`.
 *   • «Este dispositivo» (D-CF2-12): el estado se deriva de `pushSupportState` (`lib/web-push-types.ts`) + VAPID + si
 *     este navegador ya tiene suscripción. El permiso se pide SOLO dentro de `activateThisDevice`, que corre al tocar
 *     «Activar en este dispositivo»: pedirlo al abrir la pestaña es lo que hace que la gente lo bloquee para siempre
 *     (y Chrome castiga a los sitios que lo piden sin gesto).
 */
import { normalizeArMobile } from "@/lib/phone-e164";
import { LEAD_CONTACT_PHONE_COPY, SELF_SETTINGS_COPY } from "@/lib/practitioner-self-settings-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  type PushDeviceView,
  type PushPermission,
  type PushSubscriptionInput,
  type PushSupportInput,
  type PushSupportState,
} from "@/lib/web-push-types";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";
import type { ActionResult } from "@/lib/validation";

export const MI_AGENDA_COPY = {
  cardTurnero: "Turnero online",
  turneroIntro: "Si aparecés en el turnero y con cuánta anticipación te pueden reservar.",
  cardLeadContact: "Si te piden un turno antes",
  leadContactIntro:
    "Si tu anticipación no deja reservar un lugar libre de hoy, el turnero puede ofrecerle al paciente escribirte o " +
    "llamarte para coordinar. Nunca muestra tus horarios: solo tu nombre y los botones de WhatsApp y Llamar.",
  phoneLabel: "Tu celular con WhatsApp",
  phoneHint: "Con código de área, por ejemplo 11 2345 6789 o 351 512 3456.",
  showLabel: "Mostrar mi contacto en el turnero",
  // ZB-11: «Se muestra solo hoy…» no decía a quién ni cuándo; esto describe la regla real de `buildLeadContact`.
  showHintOn:
    "Tu celular aparece en el turnero solo cuando alguien busca turno para hoy dentro de tu anticipación mínima y " +
    "todavía tenés lugar.",
  showHintOff: "No se muestra. El número queda guardado para cuando lo vuelvas a prender.",
  consentLabel: "Lo acepto",
  save: "Guardar",
  saving: "Guardando…",
  saved: "Listo, quedó guardado.",
  network: "No pudimos guardar. Revisá la conexión y probá de nuevo.",
  cardNotifications: "Avisos de turnos online",
  notificationsIntro: "Cuando un paciente reserva un turno con vos desde el turnero, te avisamos.",
  emailLabel: "Avisarme por mail",
  emailHint: "Te llega un mail a la casilla de tu usuario con el día y la hora del turno.",
  pushLabel: "Avisarme con una notificación",
  pushHint: "En los dispositivos que actives acá abajo (celular o compu).",
  deviceTitle: "Este dispositivo",
  activate: "Activar en este dispositivo",
  activating: "Activando…",
  deactivate: "Desactivar en este dispositivo",
  test: "Probar notificación",
  testSent: "Listo: te mandamos una notificación de prueba.",
  devicesTitle: "Dispositivos con avisos",
  devicesEmpty: "Todavía no activaste los avisos en ningún dispositivo.",
  devicesLoading: "Cargando dispositivos…",
  devicesError: "No pudimos cargar tus dispositivos.",
  retry: "Reintentar",
  remove: "Quitar",
  removeConfirmTitle: "¿Quitar este dispositivo?",
  removeConfirmMessage: "Deja de recibir los avisos de turnos online. Lo podés volver a activar desde ese dispositivo.",
  pushNoVapid: "Los avisos al celular todavía no están habilitados en este consultorio",
  pushChecking: "Revisando este dispositivo…",
  pushIos:
    "En iPhone y iPad las notificaciones funcionan con la app instalada: Compartir → Agregar a inicio, y activalas desde ahí",
  pushUnsupported: "Este navegador no permite notificaciones. Los avisos te siguen llegando por mail si lo prendiste.",
  pushDenied:
    "Las notificaciones de este sitio están bloqueadas en este navegador. Para activarlas, permitilas desde la " +
    "configuración del navegador (el candado junto a la dirección) y volvé a tocar «Activar».",
  pushReady: "Tocá «Activar» y aceptá el permiso que te pide el navegador.",
  pushActive: "Este dispositivo recibe los avisos de turnos online.",
  permissionDismissed: "No se activó: el navegador no recibió el permiso. Probá de nuevo y tocá «Permitir».",
  swTimeout: "Este dispositivo todavía no está listo para recibir avisos. Recargá la página y probá de nuevo.",
  subscribeFailed: "El navegador no pudo activar los avisos en este dispositivo. Probá de nuevo.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Contacto dentro de la anticipación
// ─────────────────────────────────────────────────────────────────────────────

export type LeadContactSaved = { contactWhatsapp: string | null; show: boolean; consentAt: string | null };
export type LeadContactDraft = { phone: string; show: boolean; accept: boolean };
export type LeadContactField = "contactWhatsapp" | "acceptConsent";
export type LeadContactErrors = Partial<Record<LeadContactField | "form", string>>;
export type LeadContactSaveInput = { contactWhatsapp: string | null; show: boolean; acceptConsent?: boolean };

export function leadContactSavedOf(d: ConfiguracionMiAgendaData): LeadContactSaved {
  return { contactWhatsapp: d.contactWhatsapp, show: d.showContactInLeadWindow, consentAt: d.contactConsentAt };
}

/**
 * `+5491123456789` → `+54 9 1123456789`: legible sin adivinar dónde termina el código de área (2, 3 o 4 dígitos), y
 * `normalizeArMobile` lo vuelve a leer como el mismo E.164 (abrir y guardar sin tocar no cambia nada).
 */
export function displayArMobile(e164: string | null): string {
  if (!e164) return "";
  return e164.startsWith("+549") && e164.length === 14 ? `+54 9 ${e164.slice(4)}` : e164;
}

export function leadContactDraftOf(saved: LeadContactSaved): LeadContactDraft {
  return { phone: displayArMobile(saved.contactWhatsapp), show: saved.show, accept: false };
}

/** El E.164 si el texto es un celular válido; null si está vacío; el texto tal cual si no (= distinto de lo guardado). */
function phoneValue(phone: string): string | null {
  const raw = phone.trim();
  if (!raw) return null;
  const n = normalizeArMobile(raw);
  return n.ok ? n.e164 : raw;
}

export function leadContactDirty(draft: LeadContactDraft, saved: LeadContactSaved): boolean {
  return phoneValue(draft.phone) !== saved.contactWhatsapp || draft.show !== saved.show;
}

/** Mismo criterio que `planLeadContactWrite`: prender, o seguir prendido con otro número, pide aceptar el texto. */
export function leadContactNeedsConsent(draft: LeadContactDraft, saved: LeadContactSaved, forceConsent = false): boolean {
  if (!draft.show) return false;
  if (forceConsent) return true;
  const stillValid = saved.show && saved.consentAt != null && saved.contactWhatsapp === phoneValue(draft.phone);
  return !stillValid;
}

export type LeadContactValidation = { ok: true; input: LeadContactSaveInput } | { ok: false; errors: LeadContactErrors };

export function validateLeadContactDraft(
  draft: LeadContactDraft,
  saved: LeadContactSaved,
  forceConsent = false
): LeadContactValidation {
  const raw = draft.phone.trim();
  let e164: string | null = null;
  if (raw) {
    const n = normalizeArMobile(raw);
    if (!n.ok) return { ok: false, errors: { contactWhatsapp: LEAD_CONTACT_PHONE_COPY[n.reason] } };
    e164 = n.e164;
  } else if (draft.show) {
    return { ok: false, errors: { contactWhatsapp: LEAD_CONTACT_PHONE_COPY.empty } };
  }
  const needs = leadContactNeedsConsent(draft, saved, forceConsent);
  if (needs && !draft.accept) return { ok: false, errors: { acceptConsent: SELF_SETTINGS_COPY.consentRequired } };
  return { ok: true, input: { contactWhatsapp: e164, show: draft.show, ...(needs ? { acceptConsent: true } : {}) } };
}

/** Errores de `setOwnLeadContact`: los de campo a su campo; el resto (soporte, sin profesional, modo lectura) arriba. */
export function leadFieldErrorsOf(r: { ok: false; error: string; fieldErrors?: Record<string, string[] | undefined> }): LeadContactErrors {
  const out: LeadContactErrors = {};
  for (const f of ["contactWhatsapp", "acceptConsent"] as const) {
    const msg = r.fieldErrors?.[f]?.[0];
    if (msg) out[f] = msg;
  }
  if (!out.contactWhatsapp && !out.acceptConsent) out.form = r.error;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Push: «Este dispositivo»
// ─────────────────────────────────────────────────────────────────────────────

type WindowLike = {
  navigator?: { userAgent?: string; maxTouchPoints?: number; standalone?: boolean; serviceWorker?: unknown };
  matchMedia?: (q: string) => { matches: boolean };
  PushManager?: unknown;
  Notification?: { permission?: string };
};

/** Lo que `pushSupportState` necesita, leído de un `window` (el real en el cliente; uno falso en el test). */
export function readPushSupportInput(w: WindowLike): PushSupportInput {
  const nav = w.navigator ?? {};
  let standalone = nav.standalone === true;
  try {
    standalone = standalone || w.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    /* matchMedia raro: queda lo de navigator.standalone */
  }
  const perm = w.Notification?.permission;
  return {
    userAgent: nav.userAgent ?? "",
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone,
    hasServiceWorker: nav.serviceWorker != null,
    hasPushManager: w.PushManager != null,
    hasNotification: w.Notification != null,
    permission: perm === "default" || perm === "granted" || perm === "denied" ? (perm as PushPermission) : null,
  };
}

export type PushDeviceKind = "no-vapid" | "checking" | "needs-install-ios" | "unsupported" | "denied" | "ready" | "active";
export type PushDeviceUi = { kind: PushDeviceKind; message: string | null; canActivate: boolean; canDeactivate: boolean };

/**
 * `support` null = todavía no se leyó el navegador (SSR o antes del efecto). `subscribed` null = no se sabe. Con permiso
 * ya dado pero sin suscripción (la quitó desde otro dispositivo) se ofrece activar de nuevo: `requestPermission`
 * resuelve al toque sin diálogo.
 */
export function pushDeviceState(i: { vapid: boolean; support: PushSupportState | null; subscribed: boolean | null }): PushDeviceUi {
  const ui = (kind: PushDeviceKind, message: string | null, canActivate = false, canDeactivate = false): PushDeviceUi => ({
    kind,
    message,
    canActivate,
    canDeactivate,
  });
  if (!i.vapid) return ui("no-vapid", MI_AGENDA_COPY.pushNoVapid);
  if (i.support === null) return ui("checking", MI_AGENDA_COPY.pushChecking);
  if (i.support === "needs-install-ios") return ui("needs-install-ios", MI_AGENDA_COPY.pushIos);
  if (i.support === "unsupported") return ui("unsupported", MI_AGENDA_COPY.pushUnsupported);
  if (i.support === "denied") return ui("denied", MI_AGENDA_COPY.pushDenied);
  if (i.support === "granted" && i.subscribed === true) return ui("active", MI_AGENDA_COPY.pushActive, false, true);
  return ui("ready", MI_AGENDA_COPY.pushReady, true);
}

/** `applicationServerKey`: la clave pública VAPID (base64url sin relleno) como bytes. */
export function base64UrlToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TimeoutError extends Error {}

/** `p` o un `TimeoutError` a los `ms` (el timer se limpia si `p` llega antes). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(`timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** `serviceWorker.ready` no tiene tope: sin SW registrado (dev, `NEXT_PUBLIC_PWA=off`) queda colgado para siempre. */
export const SW_READY_TIMEOUT_MS = 3000;

type SubscriptionLike = {
  toJSON(): { endpoint?: string | null; keys?: Record<string, string> | null };
  unsubscribe(): Promise<boolean>;
};
type PushManagerLike = {
  subscribe(o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<SubscriptionLike>;
  getSubscription(): Promise<SubscriptionLike | null>;
};

export type ActivateDeps = {
  /** `Notification.requestPermission()`: se llama primero y solo acá (gesto del usuario). */
  requestPermission: () => Promise<string>;
  /** `navigator.serviceWorker.ready`. */
  serviceWorkerReady: () => Promise<{ pushManager: PushManagerLike }>;
  applicationServerKey: string;
  /** `savePushSubscription`. */
  save: (sub: PushSubscriptionInput) => Promise<ActionResult<{ deviceId: string }>>;
  readyTimeoutMs?: number;
};

export type ActivateOutcome =
  | { ok: true; deviceId: string }
  | { ok: false; reason: "denied" | "dismissed" | "sw-timeout" | "subscribe-failed" | "save-failed"; error: string };

function asInput(sub: SubscriptionLike): PushSubscriptionInput {
  const j = sub.toJSON();
  return { endpoint: j.endpoint ?? "", keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } };
}

/**
 * «Activar en este dispositivo»: permiso → SW listo (tope 3 s) → `subscribe` → `savePushSubscription`.
 * - `subscribe` con una suscripción previa de OTRA clave (se rotó VAPID) tira `InvalidStateError`: se da de baja la
 *   vieja (muerta: el push service la rechaza) y se reintenta una vez.
 * - Si el server rechaza el alta (navegador con un push service que no está en la lista), la suscripción del navegador
 *   se da de baja: si quedara, el navegador creería tener avisos que nunca le van a llegar.
 */
export async function activateThisDevice(d: ActivateDeps): Promise<ActivateOutcome> {
  let permission: string;
  try {
    permission = await d.requestPermission();
  } catch {
    permission = "default";
  }
  if (permission === "denied") return { ok: false, reason: "denied", error: MI_AGENDA_COPY.pushDenied };
  if (permission !== "granted") return { ok: false, reason: "dismissed", error: MI_AGENDA_COPY.permissionDismissed };

  let pm: PushManagerLike;
  try {
    pm = (await withTimeout(d.serviceWorkerReady(), d.readyTimeoutMs ?? SW_READY_TIMEOUT_MS)).pushManager;
  } catch {
    return { ok: false, reason: "sw-timeout", error: MI_AGENDA_COPY.swTimeout };
  }

  const opts = { userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(d.applicationServerKey) };
  let sub: SubscriptionLike;
  try {
    sub = await pm.subscribe(opts);
  } catch (err) {
    const stale = (err as { name?: unknown } | null)?.name === "InvalidStateError" ? await pm.getSubscription().catch(() => null) : null;
    if (!stale) return { ok: false, reason: "subscribe-failed", error: MI_AGENDA_COPY.subscribeFailed };
    try {
      await stale.unsubscribe();
      sub = await pm.subscribe(opts);
    } catch {
      return { ok: false, reason: "subscribe-failed", error: MI_AGENDA_COPY.subscribeFailed };
    }
  }

  let r: ActionResult<{ deviceId: string }>;
  try {
    r = await d.save(asInput(sub));
  } catch {
    r = { ok: false, error: MI_AGENDA_COPY.subscribeFailed };
  }
  if (!r.ok) {
    await sub.unsubscribe().catch(() => false);
    return { ok: false, reason: "save-failed", error: r.error };
  }
  return { ok: true, deviceId: r.data.deviceId };
}

/** `2026-11-01` → `01/11/2026` (día AR: `toARDateKey`, nunca el del host). */
function arDate(iso: string): string {
  const [y, m, d] = toARDateKey(iso).split("-");
  return `${d}/${m}/${y}`;
}

/** Una fila de «Dispositivos con avisos». */
export function deviceLine(d: PushDeviceView): { title: string; detail: string } {
  const name = d.label?.trim() || "Navegador";
  return {
    title: d.current ? `${name} (este dispositivo)` : name,
    detail: `Activado el ${arDate(d.createdAt)} · ${d.lastSuccessAt ? `Último aviso el ${arDate(d.lastSuccessAt)}` : "Todavía sin avisos"}`,
  };
}
