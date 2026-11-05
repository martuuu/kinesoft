import { describe, it, expect, vi } from "vitest";

/**
 * [CF2-TU1] Lógica pura de «Configuración › Mi agenda» (brief CF2 T.B/T.C): borrador del contacto dentro de la
 * anticipación (mismas reglas que `planLeadContactWrite` del server, para que el error salga en el campo antes del
 * round-trip), estado de «Este dispositivo» y el flujo de «Activar en este dispositivo» con sus dependencias
 * inyectadas (permiso → `serviceWorker.ready` con tope de 3 s → `pushManager.subscribe` → `savePushSubscription`).
 * Símbolos reales; lo único falso es el navegador (objetos con la forma de `Notification`, `PushManager`…).
 */
import {
  MI_AGENDA_COPY,
  activateThisDevice,
  base64UrlToUint8Array,
  deviceLine,
  displayArMobile,
  leadContactDirty,
  leadContactDraftOf,
  leadContactNeedsConsent,
  leadContactSavedOf,
  leadFieldErrorsOf,
  pushDeviceState,
  readPushSupportInput,
  validateLeadContactDraft,
  withTimeout,
  type ActivateDeps,
} from "@/components/configuracion/panels/mi-agenda-logic";
import { LEAD_CONTACT_PHONE_COPY, SELF_SETTINGS_COPY } from "@/lib/practitioner-self-settings-logic";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";

const DATA: ConfiguracionMiAgendaData = {
  practitionerId: "pr_1",
  name: "Ana Gómez",
  publicBookingEnabled: true,
  tenantPublicBookingEnabled: true,
  publicMinLeadMinutes: null,
  tenantPublicMinLeadMinutes: 60,
  contactWhatsapp: null,
  showContactInLeadWindow: false,
  contactConsentAt: null,
  notifyBookingEmail: false,
  notifyBookingPush: false,
  ownPublicBookingEnabled: true,
  showPublicPrice: true,
  showContactForInsured: false,
  tenantSlug: "tmp",
  bookingUrl: "/c/tmp/booking?pro=pr_1",
  // CF3b CT-L (M23): la matrícula de la persona (sin cargar).
  license: { license: null, updatedAt: null },
  // CF3b PH-U1 (M24, contrato FOTO): sin foto subida.
  photo: { url: null, showPublic: false },
};
const ON = { ...DATA, contactWhatsapp: "+5491123456789", showContactInLeadWindow: true, contactConsentAt: "2026-11-01T12:00:00.000Z" };

describe("[CF2-TU1] contacto dentro de la anticipación (borrador)", () => {
  it("[CF2-TU1-1] el borrador abre con lo guardado y sin cambios no está sucio", () => {
    const saved = leadContactSavedOf(ON);
    const d = leadContactDraftOf(saved);
    expect(d).toEqual({ phone: "+54 9 1123456789", show: true, accept: false });
    expect(leadContactDirty(d, saved)).toBe(false);
    // El número mostrado vuelve al mismo E.164: abrir y guardar sin tocar no cambia nada.
    expect(validateLeadContactDraft(d, saved)).toEqual({
      ok: true,
      input: { contactWhatsapp: "+5491123456789", show: true },
    });
    expect(displayArMobile(null)).toBe("");
  });

  it("[CF2-TU1-2] escribir el mismo número en otro formato no ensucia; otro número o el switch sí", () => {
    const saved = leadContactSavedOf(ON);
    expect(leadContactDirty({ phone: "011 15 2345-6789", show: true, accept: false }, saved)).toBe(false);
    expect(leadContactDirty({ phone: "011 15 2345-6780", show: true, accept: false }, saved)).toBe(true);
    expect(leadContactDirty({ phone: "+5491123456789", show: false, accept: false }, saved)).toBe(true);
    // A medio tipear (inválido) también es un cambio: salir de la pestaña lo perdería.
    expect(leadContactDirty({ phone: "011 15", show: true, accept: false }, saved)).toBe(true);
  });

  it("[CF2-TU1-3] prender exige celular válido (mismo copy que el server) y el consentimiento", () => {
    const saved = leadContactSavedOf(DATA);
    expect(validateLeadContactDraft({ phone: "", show: true, accept: true }, saved)).toEqual({
      ok: false,
      errors: { contactWhatsapp: LEAD_CONTACT_PHONE_COPY.empty },
    });
    expect(validateLeadContactDraft({ phone: "011 4321-5678", show: true, accept: true }, saved)).toEqual({
      ok: false,
      errors: { contactWhatsapp: LEAD_CONTACT_PHONE_COPY.landline },
    });
    expect(leadContactNeedsConsent({ phone: "11 2345 6789", show: true, accept: false }, saved)).toBe(true);
    expect(validateLeadContactDraft({ phone: "11 2345 6789", show: true, accept: false }, saved)).toEqual({
      ok: false,
      errors: { acceptConsent: SELF_SETTINGS_COPY.consentRequired },
    });
    expect(validateLeadContactDraft({ phone: "11 2345 6789", show: true, accept: true }, saved)).toEqual({
      ok: true,
      input: { contactWhatsapp: "+5491123456789", show: true, acceptConsent: true },
    });
  });

  it("[CF2-TU1-4] seguir prendido con el mismo número no pide consentimiento; cambiarlo sí; apagar nunca", () => {
    const saved = leadContactSavedOf(ON);
    expect(leadContactNeedsConsent({ phone: "+5491123456789", show: true, accept: false }, saved)).toBe(false);
    expect(leadContactNeedsConsent({ phone: "+5491123456780", show: true, accept: false }, saved)).toBe(true);
    expect(leadContactNeedsConsent({ phone: "+5491123456780", show: false, accept: false }, saved)).toBe(false);
    // Versión vieja del texto: el server lo pide con `fieldErrors.acceptConsent` y la UI fuerza la casilla.
    expect(leadContactNeedsConsent({ phone: "+5491123456789", show: true, accept: false }, saved, true)).toBe(true);
    // Apagar con el número vacío = borrarlo (y sin error).
    expect(validateLeadContactDraft({ phone: "  ", show: false, accept: false }, saved)).toEqual({
      ok: true,
      input: { contactWhatsapp: null, show: false },
    });
  });

  it("[CF2-TU1-5] los errores del server van al campo (y el resto al formulario)", () => {
    expect(
      leadFieldErrorsOf({ ok: false, error: "x", fieldErrors: { contactWhatsapp: ["Revisá el número"] } })
    ).toEqual({ contactWhatsapp: "Revisá el número" });
    expect(leadFieldErrorsOf({ ok: false, error: SELF_SETTINGS_COPY.consentRequired, fieldErrors: { acceptConsent: ["c"] } })).toEqual({
      acceptConsent: "c",
    });
    expect(leadFieldErrorsOf({ ok: false, error: "Soporte no puede…" })).toEqual({ form: "Soporte no puede…" });
  });
});

describe("[CF2-TU1] «Este dispositivo»", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";

  it("[CF2-TU1-6] lee el navegador sin pedir nada: iPhone en pestaña = instalar; Android = listo", () => {
    const iphoneTab = {
      navigator: { userAgent: IPHONE, maxTouchPoints: 5 },
      matchMedia: () => ({ matches: false }),
    };
    expect(readPushSupportInput(iphoneTab)).toMatchObject({ standalone: false, hasPushManager: false, permission: null });
    const requestPermission = vi.fn();
    const android = {
      navigator: { userAgent: ANDROID, maxTouchPoints: 5, serviceWorker: {} },
      matchMedia: () => ({ matches: false }),
      PushManager: function PushManager() {},
      Notification: { permission: "default", requestPermission },
    };
    expect(readPushSupportInput(android)).toEqual({
      userAgent: ANDROID,
      maxTouchPoints: 5,
      standalone: false,
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
      permission: "default",
    });
    // Leer el estado NUNCA pide el permiso (D-CF2-12: solo al tocar «Activar»).
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readPushSupportInput({ navigator: { userAgent: IPHONE }, matchMedia: () => ({ matches: true }) }).standalone).toBe(true);
  });

  it("[CF2-TU1-7] estados y copy: sin VAPID, iPhone, sin soporte, bloqueado, listo, activo", () => {
    expect(pushDeviceState({ vapid: false, support: "ready", subscribed: false })).toMatchObject({
      kind: "no-vapid",
      message: "Los avisos al celular todavía no están habilitados en este consultorio",
      canActivate: false,
    });
    expect(pushDeviceState({ vapid: true, support: null, subscribed: null }).kind).toBe("checking");
    const ios = pushDeviceState({ vapid: true, support: "needs-install-ios", subscribed: null });
    expect(ios.message).toBe(
      "En iPhone y iPad las notificaciones funcionan con la app instalada: Compartir → Agregar a inicio, y activalas desde ahí"
    );
    expect(ios.canActivate).toBe(false);
    expect(pushDeviceState({ vapid: true, support: "unsupported", subscribed: null })).toMatchObject({
      kind: "unsupported",
      canActivate: false,
    });
    expect(pushDeviceState({ vapid: true, support: "denied", subscribed: false })).toMatchObject({
      kind: "denied",
      canActivate: false,
    });
    expect(pushDeviceState({ vapid: true, support: "ready", subscribed: false })).toMatchObject({
      kind: "ready",
      canActivate: true,
      canDeactivate: false,
    });
    // Permiso ya dado pero sin suscripción (la borró otro dispositivo, o se quitó de la lista): se puede reactivar.
    expect(pushDeviceState({ vapid: true, support: "granted", subscribed: false })).toMatchObject({ kind: "ready", canActivate: true });
    expect(pushDeviceState({ vapid: true, support: "granted", subscribed: true })).toMatchObject({
      kind: "active",
      canActivate: false,
      canDeactivate: true,
      message: MI_AGENDA_COPY.pushActive,
    });
  });

  it("[CF2-TU1-8] la clave pública base64url pasa a bytes (la forma que pide `applicationServerKey`)", () => {
    const bytes = base64UrlToUint8Array("BPz-_w");
    expect(Array.from(bytes)).toEqual([0x04, 0xfc, 0xfe, 0xff]);
  });

  it("[CF2-TU1-9] la lista dice qué dispositivo es y cuándo (hora AR)", () => {
    expect(
      deviceLine({ id: "d1", label: "Chrome en Android", createdAt: "2026-11-02T02:30:00.000Z", lastSuccessAt: null, current: true })
    ).toEqual({ title: "Chrome en Android (este dispositivo)", detail: "Activado el 01/11/2026 · Todavía sin avisos" });
    expect(
      deviceLine({ id: "d2", label: null, createdAt: "2026-10-20T15:00:00.000Z", lastSuccessAt: "2026-11-01T13:00:00.000Z", current: false })
    ).toEqual({ title: "Navegador", detail: "Activado el 20/10/2026 · Último aviso el 01/11/2026" });
  });
});

describe("[CF2-TU1] «Activar en este dispositivo»", () => {
  const KEY = "BPz-_w";
  const JSON_SUB = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } };
  function deps(over: Partial<ActivateDeps> = {}) {
    const calls: string[] = [];
    const subscribe = vi.fn(async (opts: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      calls.push(`subscribe:${opts.userVisibleOnly}:${opts.applicationServerKey.length}`);
      return { toJSON: () => JSON_SUB, unsubscribe: async () => true };
    });
    const d: ActivateDeps = {
      requestPermission: async () => {
        calls.push("permission");
        return "granted";
      },
      serviceWorkerReady: async () => {
        calls.push("ready");
        return { pushManager: { subscribe, getSubscription: async () => null } };
      },
      applicationServerKey: KEY,
      save: async (sub) => {
        calls.push(`save:${sub.endpoint}`);
        return { ok: true, data: { deviceId: "dev_1" } };
      },
      ...over,
    };
    return { d, calls, subscribe };
  }

  it("[CF2-TU1-10] orden: permiso → SW listo → subscribe(userVisibleOnly, clave) → guardar", async () => {
    const { d, calls } = deps();
    await expect(activateThisDevice(d)).resolves.toEqual({ ok: true, deviceId: "dev_1" });
    expect(calls).toEqual(["permission", "ready", "subscribe:true:4", `save:${JSON_SUB.endpoint}`]);
  });

  it("[CF2-TU1-11] permiso negado o descartado: no se suscribe ni se guarda nada", async () => {
    const denied = deps({ requestPermission: async () => "denied" });
    await expect(activateThisDevice(denied.d)).resolves.toMatchObject({ ok: false, reason: "denied" });
    expect(denied.calls).toEqual([]);
    const dismissed = deps({ requestPermission: async () => "default" });
    await expect(activateThisDevice(dismissed.d)).resolves.toMatchObject({ ok: false, reason: "dismissed" });
    expect(dismissed.subscribe).not.toHaveBeenCalled();
  });

  it("[CF2-TU1-12] el SW que no está listo en 3 s corta con un aviso (no queda colgado)", async () => {
    vi.useFakeTimers();
    try {
      const { d, subscribe } = deps({ serviceWorkerReady: () => new Promise(() => {}) });
      const p = activateThisDevice(d);
      await vi.advanceTimersByTimeAsync(2999);
      let settled = false;
      void p.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toMatchObject({ ok: false, reason: "sw-timeout", error: MI_AGENDA_COPY.swTimeout });
      expect(subscribe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("[CF2-TU1-13] suscripción con otra clave (rotación): se da de baja y se reintenta una vez", async () => {
    const unsubscribe = vi.fn(async () => true);
    let n = 0;
    const subscribe = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new DOMException("other key", "InvalidStateError");
      return { toJSON: () => JSON_SUB, unsubscribe };
    });
    const { d } = deps({
      serviceWorkerReady: async () => ({
        pushManager: { subscribe, getSubscription: async () => ({ toJSON: () => JSON_SUB, unsubscribe }) },
      }),
    });
    await expect(activateThisDevice(d)).resolves.toEqual({ ok: true, deviceId: "dev_1" });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("[CF2-TU1-14] el server rechaza el alta: el error del server, y la suscripción no queda huérfana", async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscribe = vi.fn(async () => ({ toJSON: () => JSON_SUB, unsubscribe }));
    const { d } = deps({
      serviceWorkerReady: async () => ({ pushManager: { subscribe, getSubscription: async () => null } }),
      save: async () => ({ ok: false, error: "Este navegador no es compatible con los avisos de turnos." }),
    });
    await expect(activateThisDevice(d)).resolves.toEqual({
      ok: false,
      reason: "save-failed",
      error: "Este navegador no es compatible con los avisos de turnos.",
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("[CF2-TU1-15] withTimeout deja pasar lo que llega a tiempo", async () => {
    await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
  });
});
