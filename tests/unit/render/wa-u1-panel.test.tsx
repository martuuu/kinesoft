import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [WA-U1] Configuración → WhatsApp (§26.5 «UI»). Render real sin jsdom: se mockean solo las server actions (red), el
 * confirm y el toast (sus providers viven en la raíz). Los clicks no se disparan sin DOM: los flujos con efecto (alta,
 * continuar, desconectar, switches, prueba) son funciones exportadas que el botón llama tal cual, y se prueban con la
 * action mockeada. El alta embebida (`whatsapp-signup.ts`) se prueba con ventana/documento falsos.
 */
const actions = vi.hoisted(() => ({
  startWhatsAppConnect: vi.fn(),
  completeWhatsAppConnect: vi.fn(),
  resumeWhatsAppSetup: vi.fn(),
  disconnectWhatsApp: vi.fn(),
  updateWhatsAppSettings: vi.fn(async (_i: Record<string, boolean>) => ({ ok: true as const, data: undefined })),
  sendWhatsAppTest: vi.fn(),
  getWhatsAppPanel: vi.fn(),
}));
vi.mock("@/lib/whatsapp-actions", () => actions);
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => async () => true }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: () => "", error: () => "", info: () => "" }) }));
// `step-up-modal` (y el loader) arrastran `lib/session.ts`, que usa `cache` de React (solo existe en el server).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import {
  WhatsAppPanel,
  WA_U1_COPY,
  WA_MANAGER_HREF,
  beginWhatsAppConnect,
  disconnectWhatsAppFlow,
  messagingLimitLabel,
  qualityLabel,
  resumeWhatsAppFlow,
  signupResultNotice,
  testResultNotice,
  toggleWhatsAppSetting,
  waPanelState,
  type WhatsAppTabConfig,
} from "@/components/configuracion/panels/whatsapp-panel";
import {
  FB_SDK_SRC,
  fakeDialogHref,
  isSignupOrigin,
  loadFacebookSdk,
  metaLoginOptions,
  parseSignupMessage,
  resetFacebookSdkForTests,
  runFacebookLogin,
  startSignupSession,
  type FbSdk,
  type WaDialogTarget,
} from "@/components/configuracion/panels/whatsapp-signup";
import type { RunStepUpAction } from "@/components/account/step-up-modal";
import { CONFIG_TABS, TabsBar, parseConfigTab, visibleConfigTabs, type ConfigTabAccess } from "@/components/configuracion/controls";
import { WA_COPY, WA_TEMPLATE_STATUS_LABEL } from "@/lib/whatsapp/copy";
import type { WaConnectStart, WaPanel } from "@/lib/whatsapp/account-types";
import type { WaAccountView } from "@/lib/whatsapp/types";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

const FAKE_TARGET: WaDialogTarget = {
  mode: "fake",
  dialogUrl: "http://localhost:3000/api/whatsapp/fake/dialog/signup",
  origin: "http://localhost:3000",
};
const META_TARGET: WaDialogTarget = { mode: "meta", origin: "https://www.facebook.com" };
const CONFIG: WhatsAppTabConfig = { mode: "fake", dialog: FAKE_TARGET, canManage: true };

const START: WaConnectStart = {
  mode: "fake",
  appId: "1234567890",
  configId: "9876543210",
  graphVersion: "v23.0",
  feature: null,
  fakeDialogUrl: FAKE_TARGET.dialogUrl,
  nonce: "n".repeat(32),
};

const ACCOUNT: WaAccountView = {
  id: "acc1",
  mode: "fake",
  status: "ACTIVE",
  setupStep: "DONE",
  displayPhone: "+54 9 11 5555-0000",
  verifiedName: "Consultorio Sur",
  qualityRating: "GREEN",
  messagingLimit: "TIER_1K",
  autoBookingNotice: true,
  autoReminder: false,
  autoReplyText: true,
  paymentIssueAt: null,
  lastErrorCode: null,
  lastErrorAt: null,
  connectedAt: "2026-10-20T13:00:00.000Z",
  templates: [
    { key: "BOOKING_CREATED", name: "cs_turno_agendado_v1", status: "APPROVED", rejectedReason: null },
    { key: "BOOKING_REMINDER", name: "cs_recordatorio_turno_v1", status: "REJECTED", rejectedReason: "INVALID_FORMAT" },
    { key: "DOCUMENT_SHARED", name: "cs_documento_v1", status: "PENDING", rejectedReason: null },
  ],
};
const panelOf = (over: Partial<WaPanel> = {}): WaPanel => ({
  mode: "fake",
  account: ACCOUNT,
  canManage: true,
  canConfigure: true,
  testsLeftToday: 5,
  ...over,
});
const render = (p: WaPanel | null, config: WhatsAppTabConfig = CONFIG, support = false) =>
  renderToStaticMarkup(<WhatsAppPanel config={config} initial={p} support={support} />);

beforeEach(() => {
  for (const f of Object.values(actions)) f.mockClear();
  resetFacebookSdkForTests();
});

describe("[WA-U1] la pestaña «WhatsApp» de Configuración", () => {
  const base: ConfigTabAccess = { tenantAdmin: true, billing: true, team: true, canExport: true };

  it("[WA-U1] existe como `?tab=whatsapp` (link de la campana WHATSAPP_ACCOUNT)", () => {
    expect(CONFIG_TABS).toContain("whatsapp");
    expect(parseConfigTab("whatsapp")).toBe("whatsapp");
  });

  it("[WA-U1] se ve con `tenant.sensitive` y datos del loader (modo ≠ off); sin alguno de los dos, no", () => {
    expect(visibleConfigTabs({ ...base, sensitive: true, whatsapp: true }, [])).toContain("whatsapp");
    expect(visibleConfigTabs({ ...base, sensitive: false, whatsapp: true }, [])).not.toContain("whatsapp");
    expect(visibleConfigTabs({ ...base, sensitive: true, whatsapp: false }, [])).not.toContain("whatsapp");
    expect(visibleConfigTabs({ ...base, sensitive: true }, [])).not.toContain("whatsapp");
    const html = renderToStaticMarkup(
      <TabsBar tab="whatsapp" setTab={() => {}} access={{ ...base, sensitive: true, whatsapp: true }} modules={[]} />
    );
    expect(text(html)).toContain("WhatsApp");
  });
});

describe("[WA-U1] alta embebida: origen y mensajes", () => {
  it("[WA-U1] simulador: solo el origen exacto de la app; Meta: https://*.facebook.com con regex anclada", () => {
    expect(isSignupOrigin("http://localhost:3000", FAKE_TARGET)).toBe(true);
    expect(isSignupOrigin("http://localhost:3001", FAKE_TARGET)).toBe(false);
    expect(isSignupOrigin("https://www.facebook.com", FAKE_TARGET)).toBe(false);
    expect(isSignupOrigin("https://www.facebook.com", META_TARGET)).toBe(true);
    expect(isSignupOrigin("https://web.facebook.com", META_TARGET)).toBe(true);
    expect(isSignupOrigin("https://business.facebook.com", META_TARGET)).toBe(true);
    expect(isSignupOrigin("https://evilfacebook.com", META_TARGET)).toBe(false);
    expect(isSignupOrigin("http://www.facebook.com", META_TARGET)).toBe(false);
    expect(isSignupOrigin("https://www.facebook.com.evil.com", META_TARGET)).toBe(false);
    expect(isSignupOrigin("http://localhost:3000", META_TARGET)).toBe(false);
  });

  it("[WA-U1] lee el STRING JSON del popup (FINISH con code en el simulador, CANCEL) y descarta lo ajeno", () => {
    const fin = JSON.stringify({
      type: "WA_EMBEDDED_SIGNUP",
      event: "FINISH",
      version: 4,
      data: { waba_id: "102030405060", phone_number_id: "908070605040", business_id: "1" },
      code: "FAKECODE",
    });
    expect(parseSignupMessage(fin)).toEqual({ event: "FINISH", wabaId: "102030405060", phoneNumberId: "908070605040", code: "FAKECODE" });
    expect(parseSignupMessage({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "102030405060", phone_number_id: "908070605040" } }))
      .toEqual({ event: "FINISH", wabaId: "102030405060", phoneNumberId: "908070605040", code: null });
    expect(parseSignupMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} }))).toEqual({ event: "CANCEL" });
    expect(parseSignupMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_ONLY_WABA", data: { waba_id: "102030405060" } })))
      .toEqual({ event: "NO_PHONE" });
    expect(parseSignupMessage(JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "x'", phone_number_id: "1" } })))
      .toEqual({ event: "NO_PHONE" });
    expect(parseSignupMessage("no-json")).toBeNull();
    expect(parseSignupMessage(JSON.stringify({ type: "OTRO", event: "FINISH" }))).toBeNull();
    expect(parseSignupMessage(null)).toBeNull();
  });

  it("[WA-U1] el popup del simulador se abre con app_id y config_id", () => {
    expect(fakeDialogHref(START)).toBe(`${FAKE_TARGET.dialogUrl}?app_id=1234567890&config_id=9876543210`);
    expect(fakeDialogHref({ ...START, fakeDialogUrl: undefined })).toBeNull();
  });

  it("[WA-U1] FB.login del Embedded Signup v4: config_id, response_type code y extras v4 (featureType solo con coexistencia)", () => {
    expect(metaLoginOptions(START)).toEqual({
      config_id: "9876543210",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, sessionInfoVersion: "3", version: "v4" },
    });
    expect(metaLoginOptions({ ...START, feature: "whatsapp_business_app_onboarding" }).extras.featureType).toBe(
      "whatsapp_business_app_onboarding"
    );
  });
});

/** Un `window.addEventListener("message")` falso para la sesión. */
function fakeChannel() {
  let fn: ((e: { origin: string; data: unknown }) => void) | null = null;
  return {
    listen: (f: (e: { origin: string; data: unknown }) => void) => {
      fn = f;
      return () => {
        fn = null;
      };
    },
    post: (origin: string, data: unknown) => fn?.({ origin, data }),
    get listening() {
      return fn !== null;
    },
  };
}
const OUTCOME = { status: "ACTIVE" as const, setupStep: "DONE" as const, done: true, errorCode: null };
const FINISH = (code?: string) =>
  JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "102030405060", phone_number_id: "908070605040" }, ...(code ? { code } : {}) });

describe("[WA-U1] sesión del alta: completeWhatsAppConnect apenas están code + ids (el code vive 30 s)", () => {
  it("[WA-U1] simulador: el mensaje trae todo → complete en el acto, con el nonce, una sola vez; otro origen se ignora", async () => {
    const ch = fakeChannel();
    const complete = vi.fn(async () => ({ ok: true as const, data: OUTCOME }));
    const results: unknown[] = [];
    startSignupSession({ start: START, target: FAKE_TARGET, listen: ch.listen, complete, onResult: (r) => results.push(r), networkError: "red" });
    ch.post("https://evil.example", FINISH("FAKECODE"));
    expect(complete).not.toHaveBeenCalled();
    ch.post("http://localhost:3000", FINISH("FAKECODE"));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ code: "FAKECODE", wabaId: "102030405060", phoneNumberId: "908070605040", nonce: START.nonce });
    expect(ch.listening).toBe(false);
    ch.post("http://localhost:3000", FINISH("OTRO"));
    expect(complete).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([{ kind: "done", outcome: OUTCOME }]);
  });

  it("[WA-U1] Meta: ids por postMessage y code por FB.login, en cualquier orden → complete en el mismo tick del segundo", async () => {
    const ch = fakeChannel();
    const complete = vi.fn(async () => ({ ok: true as const, data: OUTCOME }));
    const s = startSignupSession({ start: START, target: META_TARGET, listen: ch.listen, complete, onResult: () => {}, networkError: "red" });
    s.setCode("METACODE");
    expect(complete).not.toHaveBeenCalled();
    ch.post("https://www.facebook.com", FINISH());
    expect(complete).toHaveBeenCalledWith({ code: "METACODE", wabaId: "102030405060", phoneNumberId: "908070605040", nonce: START.nonce });

    const ch2 = fakeChannel();
    const complete2 = vi.fn(async () => ({ ok: false as const, error: "venció" }));
    const results: unknown[] = [];
    const s2 = startSignupSession({ start: START, target: META_TARGET, listen: ch2.listen, complete: complete2, onResult: (r) => results.push(r), networkError: "red" });
    ch2.post("https://web.facebook.com", FINISH());
    expect(complete2).not.toHaveBeenCalled();
    s2.setCode("METACODE2");
    expect(complete2).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(results).toEqual([{ kind: "error", error: "venció" }]);
  });

  it("[WA-U1] CANCEL / sin número / FB.login sin code terminan sin llamar a complete", () => {
    const run = (post: (ch: ReturnType<typeof fakeChannel>, s: ReturnType<typeof startSignupSession>) => void) => {
      const ch = fakeChannel();
      const complete = vi.fn();
      const results: unknown[] = [];
      const s = startSignupSession({ start: START, target: META_TARGET, listen: ch.listen, complete, onResult: (r) => results.push(r), networkError: "red" });
      post(ch, s);
      expect(complete).not.toHaveBeenCalled();
      return results;
    };
    expect(run((ch) => ch.post("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} })))).toEqual([{ kind: "cancelled" }]);
    expect(run((ch) => ch.post("https://www.facebook.com", JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH_ONLY_WABA", data: { waba_id: "102030405060" } })))).toEqual([{ kind: "no_phone" }]);
    const fb: FbSdk = { init: () => {}, login: (cb) => cb({ authResponse: null, status: "unknown" }) };
    expect(run((_ch, s) => runFacebookLogin(fb, START, s))).toEqual([{ kind: "cancelled" }]);
  });

  it("[WA-U1] runFacebookLogin pasa el code del callback a la sesión con las opciones v4", () => {
    const ch = fakeChannel();
    const complete = vi.fn(async () => ({ ok: true as const, data: OUTCOME }));
    const s = startSignupSession({ start: START, target: META_TARGET, listen: ch.listen, complete, onResult: () => {}, networkError: "red" });
    const login = vi.fn((cb: (r: { authResponse?: { code?: string } }) => void, _opts: unknown) => cb({ authResponse: { code: "CB" } }));
    runFacebookLogin({ init: () => {}, login } as FbSdk, START, s);
    expect(login.mock.calls[0][1]).toEqual(metaLoginOptions(START));
    ch.post("https://www.facebook.com", FINISH());
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ code: "CB" }));
  });
});

describe("[WA-U1] SDK de Facebook: se inyecta solo al pedirlo, una vez, desde connect.facebook.net", () => {
  afterEach(() => vi.useRealTimers());

  function fakeDoc() {
    const appended: { id: string; src: string; crossOrigin: string | null; onerror: ((...a: unknown[]) => unknown) | null }[] = [];
    const doc = {
      getElementById: (id: string) => appended.find((n) => n.id === id) ?? null,
      createElement: () => ({ id: "", src: "", async: false, defer: false, crossOrigin: null as string | null, onerror: null }),
      body: { appendChild: (n: unknown) => appended.push(n as (typeof appended)[number]) },
    };
    return { doc, appended };
  }

  it("[WA-U1] inyecta el script, espera fbAsyncInit e inicializa con appId y la versión de Graph", async () => {
    const { doc, appended } = fakeDoc();
    const win: { FB?: FbSdk; fbAsyncInit?: () => void } = {};
    const p = loadFacebookSdk(START, { win, doc });
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(FB_SDK_SRC);
    expect(FB_SDK_SRC.startsWith("https://connect.facebook.net/")).toBe(true);
    expect(appended[0].crossOrigin).toBe("anonymous");
    const init = vi.fn();
    win.FB = { init, login: () => {} };
    win.fbAsyncInit?.();
    await expect(p).resolves.toBe(win.FB);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ appId: "1234567890", version: "v23.0" }));
    await loadFacebookSdk(START, { win, doc });
    expect(appended).toHaveLength(1);
  });

  it("[WA-U1] si el script no carga (bloqueador), rechaza y el próximo intento vuelve a probar", async () => {
    const { doc, appended } = fakeDoc();
    const p = loadFacebookSdk(START, { win: {}, doc });
    appended[0].onerror?.();
    await expect(p).rejects.toThrow("fb_sdk_load");
    const { doc: doc2, appended: appended2 } = fakeDoc();
    void loadFacebookSdk(START, { win: {}, doc: doc2, timeoutMs: 1 }).catch(() => {});
    expect(appended2).toHaveLength(1);
  });
});

describe("[WA-U1] los estados del panel", () => {
  it("[WA-U1] sin cuenta: «Conectá el WhatsApp del consultorio», explicación corta y «Conectar» (Titular)", () => {
    const html = render(panelOf({ account: null }));
    const t = text(html);
    expect(html).toContain('data-wa-state="connect"');
    expect(t).toContain(WA_U1_COPY.connectTitle);
    expect(t).toContain(WA_U1_COPY.connectBody);
    expect(t).toContain(WA_U1_COPY.connectFakeHint);
    expect(t).toContain(">Conectar<".replace(/[<>]/g, ""));
    expect(t).not.toContain(WA_COPY.disconnect);
    expect(html).not.toContain('role="switch"');
    // El estado del alta para el lector de pantalla está montado desde el principio.
    expect(html).toContain('role="status" aria-live="polite"');
  });

  it("[WA-U1] sin `account.owner`: ve el estado pero no «Conectar»; un aviso dice que lo hace el titular", () => {
    const t = text(render(panelOf({ account: null, canManage: false }), { ...CONFIG, canManage: false }));
    expect(t).toContain(WA_U1_COPY.connectTitle);
    expect(t).toContain(WA_U1_COPY.ownerOnly);
    expect(t).not.toContain(WA_U1_COPY.connectFakeHint);
    const tSupport = text(render(panelOf({ account: null }), CONFIG, true));
    expect(tSupport).toContain(WA_U1_COPY.ownerOnly);
  });

  it("[WA-U1] configuración en curso: paso actual y «Continuar configuración»", () => {
    const html = render(panelOf({ account: { ...ACCOUNT, status: "SETUP", setupStep: "REGISTERED", lastErrorCode: "retry:1" } }));
    const t = text(html);
    expect(html).toContain('data-wa-state="setup"');
    expect(t).toContain(WA_U1_COPY.setupTitle);
    expect(t).toContain("Continuar configuración");
    expect(t).toContain("Número registrado");
    expect(t).toContain("WhatsApp no respondió");
  });

  it("[WA-U1] conectado: número, nombre verificado, calidad, badge «Simulador» (fake) / «Prueba» (sandbox), sin badge en live", () => {
    const t = text(render(panelOf()));
    expect(t).toContain("+54 9 11 5555-0000");
    expect(t).toContain("Consultorio Sur");
    expect(t).toContain("Calidad");
    expect(t).toContain("Alta");
    expect(t).toContain("Hasta 1.000 contactos por día");
    expect(t).toContain("Simulador");
    expect(t).toContain("20 de oct de 2026");
    expect(t).toContain(WA_COPY.disconnect);
    expect(t).not.toContain(WA_U1_COPY.connectTitle);
    const sandbox = text(render(panelOf({ mode: "sandbox", account: { ...ACCOUNT, mode: "sandbox" } }), { ...CONFIG, mode: "sandbox", dialog: META_TARGET }));
    expect(sandbox).toContain(WA_U1_COPY.badgeSandbox);
    const live = text(render(panelOf({ mode: "live", account: { ...ACCOUNT, mode: "live" } }), { ...CONFIG, mode: "live", dialog: META_TARGET }));
    expect(live).not.toContain(WA_U1_COPY.badgeSandbox);
    expect(live).not.toContain(WA_U1_COPY.badgeFake);
  });

  it("[WA-U1] hay que volver a conectar: aviso + «Volver a conectar» + «Desconectar»", () => {
    const html = render(panelOf({ account: { ...ACCOUNT, status: "REAUTH_REQUIRED" } }));
    const t = text(html);
    expect(html).toContain('data-wa-state="reauth"');
    expect(t).toContain(WA_U1_COPY.reauthBody);
    expect(t).toContain(WA_COPY.reconnect);
    expect(t).toContain(WA_COPY.disconnect);
  });

  it("[WA-U1] plantillas con su estado y el motivo de rechazo de Meta", () => {
    const html = render(panelOf());
    const t = text(html);
    expect(html).toContain('data-wa-template="BOOKING_REMINDER"');
    expect(t).toContain(WA_TEMPLATE_STATUS_LABEL.APPROVED);
    expect(t).toContain(WA_TEMPLATE_STATUS_LABEL.REJECTED);
    expect(t).toContain(WA_TEMPLATE_STATUS_LABEL.PENDING);
    expect(t).toContain("Motivo de Meta: INVALID_FORMAT");
  });

  it("[WA-U1] checklist del medio de pago: en rojo con `paymentIssueAt`, con link a WhatsApp Manager", () => {
    const ok = render(panelOf());
    expect(ok).toContain('data-wa-payment="ok"');
    expect(ok).toContain(`href="${WA_MANAGER_HREF}"`);
    expect(ok).toContain('rel="noopener noreferrer"');
    expect(text(ok)).toContain(WA_U1_COPY.openManager);
    const bad = render(panelOf({ account: { ...ACCOUNT, paymentIssueAt: "2026-10-21T15:00:00.000Z" } }));
    expect(bad).toContain('data-wa-payment="issue"');
    expect(bad).toContain('role="alert"');
    expect(text(bad)).toContain("Meta avisó un problema con el medio de pago el 21 de oct de 2026");
  });

  it("[WA-U1] los 3 switches con su valor y nombre accesible; la prueba con su input rotulado", () => {
    const html = render(panelOf());
    expect(html).toContain(`role="switch" aria-checked="true" aria-label="${WA_U1_COPY.bookingNotice}"`);
    expect(html).toContain(`role="switch" aria-checked="false" aria-label="${WA_U1_COPY.reminder}"`);
    expect(html).toContain(`role="switch" aria-checked="true" aria-label="${WA_U1_COPY.autoReply}"`);
    const t = text(html);
    expect(t).toContain(WA_U1_COPY.testTitle);
    expect(t).toContain("Te quedan 5 pruebas por hoy.");
    const label = /<label for="([^"]+)"[^>]*>Celular<\/label>/.exec(html);
    expect(label).not.toBeNull();
    expect(html).toContain(`id="${label![1]}"`);
    expect(html).toContain('type="tel"');
  });

  it("[WA-U1] sin pruebas por hoy el input queda deshabilitado; sin cuenta activa no hay prueba", () => {
    const html = render(panelOf({ testsLeftToday: 0 }));
    expect(text(html)).toContain("Ya no te quedan pruebas por hoy.");
    expect(html).toMatch(/type="tel"[^>]*disabled/);
    expect(text(render(panelOf({ account: { ...ACCOUNT, status: "SETUP", setupStep: "TEMPLATES" } })))).not.toContain(WA_U1_COPY.testTitle);
  });

  it("[WA-U1] sin datos todavía: esqueleto (el panel pide getWhatsAppPanel al montar, no en el HTML)", () => {
    const html = renderToStaticMarkup(<WhatsAppPanel config={CONFIG} />);
    expect(html).toContain('aria-busy="true"');
    expect(actions.getWhatsAppPanel).not.toHaveBeenCalled();
  });

  it("[WA-U1] waPanelState / calidad / límite (puros)", () => {
    expect(waPanelState({ mode: "off", account: ACCOUNT })).toBe("off");
    expect(waPanelState({ mode: "fake", account: null })).toBe("connect");
    expect(waPanelState({ mode: "fake", account: { ...ACCOUNT, status: "DISCONNECTED" } })).toBe("connect");
    expect(waPanelState({ mode: "fake", account: { ...ACCOUNT, status: "SETUP" } })).toBe("setup");
    expect(qualityLabel("YELLOW")).toBe("Media");
    expect(qualityLabel(null)).toBe("Sin calificar");
    expect(messagingLimitLabel("TIER_250")).toBe("Hasta 250 contactos por día");
    expect(messagingLimitLabel("TIER_UNLIMITED")).toBe("Sin límite");
    expect(messagingLimitLabel("raro")).toBeNull();
  });
});

describe("[WA-U1] los flujos de los botones", () => {
  const passthrough = async <T,>(fn: () => Promise<T>) => fn();

  it("[WA-U1] «Conectar» corre startWhatsAppConnect dentro de runStepUp (2FA)", async () => {
    actions.startWhatsAppConnect.mockResolvedValueOnce({ ok: true, data: START });
    const runStepUp = vi.fn(passthrough) as unknown as RunStepUpAction & ReturnType<typeof vi.fn>;
    const r = await beginWhatsAppConnect({ runStepUp, start: actions.startWhatsAppConnect });
    expect(runStepUp).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, data: START });
  });

  it("[WA-U1] el step-up cancelado vuelve como error y no se abre nada", async () => {
    const r = await beginWhatsAppConnect({
      runStepUp: async () => ({ ok: false as const, error: "Cancelaste la verificación: no se hizo ningún cambio." }),
      start: actions.startWhatsAppConnect,
    });
    expect(r.ok).toBe(false);
    expect(actions.startWhatsAppConnect).not.toHaveBeenCalled();
  });

  it("[WA-U1] «Continuar configuración» con step-up", async () => {
    actions.resumeWhatsAppSetup.mockResolvedValueOnce({ ok: true, data: OUTCOME });
    const runStepUp = vi.fn(passthrough) as unknown as RunStepUpAction & ReturnType<typeof vi.fn>;
    await expect(resumeWhatsAppFlow({ runStepUp, resume: actions.resumeWhatsAppSetup })).resolves.toEqual({ ok: true, data: OUTCOME });
    expect(runStepUp).toHaveBeenCalledTimes(1);
  });

  it("[WA-U1] «Desconectar» pide confirmación (useConfirm, tono danger); si cancela no llama a la action", async () => {
    actions.disconnectWhatsApp.mockResolvedValue({ ok: true, data: { cancelledMessages: 2 } });
    const seen: unknown[] = [];
    const no = await disconnectWhatsAppFlow({
      confirm: async (o) => (seen.push(o), false),
      runStepUp: passthrough,
      disconnect: actions.disconnectWhatsApp,
    });
    expect(no).toBeNull();
    expect(actions.disconnectWhatsApp).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ title: WA_U1_COPY.disconnectTitle, message: WA_COPY.disconnectConfirm, tone: "danger" });
    const yes = await disconnectWhatsAppFlow({ confirm: async () => true, runStepUp: passthrough, disconnect: actions.disconnectWhatsApp });
    expect(yes).toEqual({ ok: true, data: { cancelledMessages: 2 } });
    expect(WA_U1_COPY.disconnected(2)).toContain("2 mensajes en cola");
  });

  it("[WA-U1] un switch manda solo su clave", async () => {
    await toggleWhatsAppSetting(actions.updateWhatsAppSettings, "autoReminder", true);
    expect(actions.updateWhatsAppSettings).toHaveBeenCalledWith({ autoReminder: true });
  });

  it("[WA-U1] la prueba: enviado / falló con el copy del error (nunca el de Meta) / rechazo de la action", () => {
    expect(testResultNotice({ ok: true, data: { status: "SENT", errorCode: null, testsLeftToday: 3 } })).toEqual({
      tone: "ok",
      text: "Mandamos el mensaje de prueba. Te quedan 3 pruebas por hoy.",
    });
    const failed = testResultNotice({ ok: true, data: { status: "FAILED", errorCode: "recipient:131026", testsLeftToday: 1 } });
    expect(failed.tone).toBe("error");
    expect(failed.text).toContain("No se le pudo entregar a ese número");
    expect(failed.text).toContain("Te queda 1 prueba por hoy.");
    expect(testResultNotice({ ok: false, error: "Ya hiciste las 5 pruebas de hoy." })).toEqual({ tone: "error", text: "Ya hiciste las 5 pruebas de hoy." });
  });

  it("[WA-U1] cómo terminó la ventana de Meta → copy", () => {
    expect(signupResultNotice({ kind: "done", outcome: OUTCOME }).text).toBe(WA_U1_COPY.connected);
    expect(signupResultNotice({ kind: "done", outcome: { ...OUTCOME, done: false } }).text).toBe(WA_U1_COPY.connectedPartial);
    expect(signupResultNotice({ kind: "cancelled" }).text).toBe(WA_U1_COPY.cancelled);
    expect(signupResultNotice({ kind: "no_phone" }).text).toBe(WA_U1_COPY.noPhone);
  });
});

describe("[WA-U1] loader: dato de la pestaña sin queries", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });

  it("[WA-U1] modo off o sin `tenant.sensitive` → null; fake + sensitive → modo, destino del popup y canManage solo del Titular", async () => {
    const { whatsappTabFor } = await import("@/lib/configuracion-page-loader");
    const caps = (...c: string[]) => new Set(c) as never;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL;
    process.env.WHATSAPP_MODE = "off";
    expect(whatsappTabFor({ support: undefined } as never, caps("tenant.sensitive", "account.owner"))).toBeNull();
    process.env.WHATSAPP_MODE = "fake";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(whatsappTabFor({ support: undefined } as never, caps("account.owner"))).toBeNull();
    const owner = whatsappTabFor({ support: undefined } as never, caps("tenant.sensitive", "account.owner"));
    expect(owner).toEqual({
      mode: "fake",
      dialog: { mode: "fake", dialogUrl: "http://localhost:3000/api/whatsapp/fake/dialog/signup", origin: "http://localhost:3000" },
      canManage: true,
    });
    expect(whatsappTabFor({ support: undefined } as never, caps("tenant.sensitive"))?.canManage).toBe(false);
    expect(whatsappTabFor({ support: { sessionId: "s" } } as never, caps("tenant.sensitive", "account.owner"))?.canManage).toBe(false);
  });
});
