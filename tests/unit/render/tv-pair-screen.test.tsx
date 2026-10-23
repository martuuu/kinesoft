/**
 * [TV-2u1] `/tv` (T7, §26.4 C-TV): pantalla de vínculo, layout, manifest y la page que elige entre vínculo y TV.
 *
 * Render sin jsdom (`renderToStaticMarkup`). Se mockean solo la red y lo que el react-dom 18 de node no trae:
 *   - `useFormState`/`useFormStatus` de `react-dom` (en la app los da el React canary de Next): se inyecta el estado de
 *     la action y se captura QUÉ action recibe el form (tiene que ser la del server: sin JS es lo único que funciona);
 *   - `@/lib/display-device` (`pairDisplay`: base, cookie, rate limit) y `@/lib/display-device-internal` (la sesión por
 *     cookie, el feed y el bootstrap de Realtime: base y env);
 *   - `@/components/tv/tv-screen` (TV-2u2, otra sesión): se afirma que la page le pasa el feed y el bootstrap.
 * El componente de vínculo, su lógica pura (`pairInputValue`, `pairReasonMessage`), el manifest y la page corren reales.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { DisplayFeed } from "@/lib/reception-displays-types";

const form = vi.hoisted(() => ({ state: null as unknown, actions: [] as unknown[] }));
vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormState: (fn: unknown) => {
    form.actions.push(fn);
    return [form.state, "/tv"];
  },
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const device = vi.hoisted(() => ({
  session: { state: "unpaired" } as unknown,
  feed: null as unknown,
  feedCalls: [] as unknown[],
  bootstrapFails: false,
  pairCalls: [] as unknown[],
  pairResult: { ok: false, error: "x" } as unknown,
}));
vi.mock("@/lib/display-device-internal", () => ({
  resolveDisplaySession: async () => device.session,
  loadDisplayFeed: async (s: unknown, now: unknown) => {
    device.feedCalls.push([s, now]);
    return device.feed;
  },
  displayRealtimeBootstrap: async (tenantId: string) => {
    if (device.bootstrapFails) throw new Error("rt");
    return { driver: "supabase", tenantId };
  },
}));
vi.mock("@/lib/display-device", () => ({
  pairDisplay: async (input: unknown) => {
    device.pairCalls.push(input);
    return device.pairResult;
  },
}));

const screen = vi.hoisted(() => ({ props: [] as unknown[] }));
vi.mock("@/components/tv/tv-screen", () => ({
  TvScreen: (props: unknown) => {
    screen.props.push(props);
    return <div data-testid="tv-screen">TV</div>;
  },
}));

import { PAIR_FAILED_MESSAGE } from "@/lib/reception-displays-types";
import { TvPairScreen, pairInputValue, pairReasonMessage } from "@/components/tv/tv-pair-screen";
import TvPage, { dynamic } from "@/app/(display)/tv/page";
import TvLayout, { metadata, viewport } from "@/app/(display)/tv/layout";
import { GET as manifestGET } from "@/app/(display)/tv/manifest/route";
import appManifest from "@/app/manifest";
import TvError from "@/app/(display)/tv/error";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noopAction = async () => null;

const FEED: DisplayFeed = {
  v: 1,
  serverNow: "2026-10-22T13:00:00.000Z",
  dayKey: "2026-10-22",
  clinicName: "Consultorio Demo",
  locationName: null,
  config: {
    nameMode: "SHORT_NAME",
    theme: "DARK",
    mediaKind: "NONE",
    mediaRef: null,
    mediaLayout: "SIDE",
    mediaMuted: true,
    mediaDuringCall: "DUCK",
  },
  hero: null,
  recent: [],
  waiting: [],
  waitingCount: 0,
};

beforeEach(() => {
  form.state = null;
  form.actions = [];
  device.session = { state: "unpaired" };
  device.feed = null;
  device.feedCalls = [];
  device.bootstrapFails = false;
  device.pairCalls = [];
  device.pairResult = { ok: false, error: PAIR_FAILED_MESSAGE };
  screen.props = [];
});

describe("[TV-2u1] máscara del código", () => {
  it("normaliza y enmascara mientras se tipea (Crockford O→0, I/L→1; guion después del 4.º)", () => {
    expect(pairInputValue("")).toBe("");
    expect(pairInputValue("abc")).toBe("ABC");
    expect(pairInputValue("abcd")).toBe("ABCD");
    expect(pairInputValue("abcde")).toBe("ABCD-E");
    expect(pairInputValue("abcd efgh")).toBe("ABCD-EFGH");
    expect(pairInputValue("ab-cd-ef-gh")).toBe("ABCD-EFGH");
    expect(pairInputValue("oil0")).toBe("0110");
  });

  it("corta en 8 caracteres de código (lo pegado de más no se acumula)", () => {
    expect(pairInputValue("ABCDEFGHJK")).toBe("ABCD-EFGH");
    // Borrar el guion con backspace no lo deja trabado: la máscara lo vuelve a poner solo si hay 5+ caracteres.
    expect(pairInputValue("ABCD")).toBe("ABCD");
  });
});

describe("[TV-2u1] TvPairScreen", () => {
  it("copy, label, foco inicial, ayuda y región aria-live del error", () => {
    const h = renderToStaticMarkup(<TvPairScreen action={noopAction} />);
    const t = text(h);
    expect(t).toContain("Vinculá esta pantalla");
    expect(t).toContain("Generá el código en Sala de espera → Pantallas");
    // label asociado al input
    const id = /<input[^>]*id="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toContain(`for="${id}"`);
    expect(h).toMatch(/<input[^>]*name="code"/);
    expect(h).toMatch(/<input[^>]*autofocus/i);
    expect(h).toMatch(/<input[^>]*autoComplete="off"|<input[^>]*autocomplete="off"/i);
    // la región del error existe ANTES del primer error (si aparece junto con el texto, varios lectores no la anuncian)
    expect(h).toMatch(/role="alert"/);
    expect(h).toMatch(/aria-live="assertive"/);
    expect(t).not.toContain(PAIR_FAILED_MESSAGE);
  });

  it("el form usa la action del server tal cual (sin JS el POST funciona igual)", () => {
    renderToStaticMarkup(<TvPairScreen action={noopAction} />);
    expect(form.actions).toContain(noopAction);
  });

  it("error de la action: mensaje en el alert e input marcado inválido", () => {
    form.state = { ok: false, error: PAIR_FAILED_MESSAGE };
    const h = renderToStaticMarkup(<TvPairScreen action={noopAction} />);
    expect(text(h)).toContain(PAIR_FAILED_MESSAGE);
    expect(h).toMatch(/<input[^>]*aria-invalid="true"/);
    const errId = /role="alert"[^>]*id="([^"]+)"|id="([^"]+)"[^>]*role="alert"/.exec(h);
    expect(errId).toBeTruthy();
  });

  it("vinculada: avisa que está cargando (la page se re-renderiza sola)", () => {
    form.state = { ok: true, data: undefined };
    const t = text(renderToStaticMarkup(<TvPairScreen action={noopAction} />));
    expect(t).toContain("Pantalla vinculada");
  });

  it("reason revoked / unavailable: mensaje propio; sin reason, ninguno", () => {
    expect(pairReasonMessage("revoked")).toMatch(/desvinculó/);
    expect(pairReasonMessage("unavailable")).toMatch(/no está disponible/);
    expect(pairReasonMessage(undefined)).toBeNull();
    const r = text(renderToStaticMarkup(<TvPairScreen action={noopAction} reason="revoked" />));
    expect(r).toContain(pairReasonMessage("revoked")!);
    const u = text(renderToStaticMarkup(<TvPairScreen action={noopAction} reason="unavailable" />));
    expect(u).toContain(pairReasonMessage("unavailable")!);
  });

  it("legible a 3 m: el input y el título van con tipografía grande (≥ 48 px en una TV 1080p)", () => {
    const h = renderToStaticMarkup(<TvPairScreen action={noopAction} />);
    expect(h).toMatch(/<input[^>]*style="[^"]*font-size:clamp\(48px/);
    expect(h).toMatch(/<h1[^>]*style="[^"]*font-size:clamp\(40px/);
  });
});

describe("[TV-2u1] page /tv", () => {
  it("force-dynamic (lee la cookie del dispositivo en cada request)", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("sin vincular → pantalla de vínculo; con revoked/unavailable pasa el reason", async () => {
    let t = text(renderToStaticMarkup((await TvPage()) as ReactElement));
    expect(t).toContain("Vinculá esta pantalla");
    expect(t).not.toContain(pairReasonMessage("revoked")!);
    expect(screen.props).toHaveLength(0);
    expect(device.feedCalls).toHaveLength(0);

    device.session = { state: "revoked" };
    t = text(renderToStaticMarkup((await TvPage()) as ReactElement));
    expect(t).toContain(pairReasonMessage("revoked")!);

    device.session = { state: "unavailable", reason: "no_module" };
    t = text(renderToStaticMarkup((await TvPage()) as ReactElement));
    expect(t).toContain(pairReasonMessage("unavailable")!);
    expect(screen.props).toHaveLength(0);
  });

  const PAIRED = { state: "paired", displayId: "d1", tenantId: "t1", locationId: null, isPrimaryLocation: true };

  it("vinculada → TvScreen con el feed inicial de la sesión y el bootstrap del tenant", async () => {
    device.session = PAIRED;
    device.feed = FEED;
    const h = renderToStaticMarkup((await TvPage()) as ReactElement);
    expect(h).toContain('data-testid="tv-screen"');
    expect(text(h)).not.toContain("Vinculá esta pantalla");
    expect(device.feedCalls).toHaveLength(1);
    expect((device.feedCalls[0] as unknown[])[0]).toBe(PAIRED);
    expect((device.feedCalls[0] as unknown[])[1]).toBeInstanceOf(Date);
    expect(screen.props).toEqual([{ initialFeed: FEED, bootstrap: { driver: "supabase", tenantId: "t1" } }]);
  });

  it("si el bootstrap de Realtime falla, la TV arranca igual con bootstrap null (polling)", async () => {
    device.session = PAIRED;
    device.feed = FEED;
    device.bootstrapFails = true;
    renderToStaticMarkup((await TvPage()) as ReactElement);
    expect(screen.props).toEqual([{ initialFeed: FEED, bootstrap: null }]);
  });

  it("la action del form normaliza el FormData y llama a pairDisplay({code})", async () => {
    renderToStaticMarkup((await TvPage()) as ReactElement);
    const action = form.actions.at(-1) as (prev: unknown, fd: FormData) => Promise<unknown>;
    expect(typeof action).toBe("function");
    const fd = new FormData();
    fd.set("code", "abcd-efgh");
    const res = await action(null, fd);
    expect(device.pairCalls).toEqual([{ code: "abcd-efgh" }]);
    expect(res).toEqual({ ok: false, error: PAIR_FAILED_MESSAGE });
  });
});

describe("[TV-2u1] layout y manifest", () => {
  it("metadata: noindex, manifest propio y tema oscuro", () => {
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.manifest).toBe("/tv/manifest");
    expect(String(viewport.themeColor)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(viewport.themeColor).not.toBe("#1F4FBE");
  });

  it("error.tsx: «Reconectando…» en una región viva, sin el mensaje del error", () => {
    const h = renderToStaticMarkup(<TvError error={new Error("prisma: secreto")} reset={() => {}} />);
    expect(text(h)).toContain("Reconectando…");
    expect(h).toMatch(/role="status"/);
    expect(h).not.toContain("secreto");
  });

  it("layout sin providers: pinta el fondo de pantalla completa", () => {
    const h = renderToStaticMarkup(<TvLayout>{<p>hola</p>}</TvLayout>);
    expect(h).toContain("hola");
    expect(h).toMatch(/<style>[^<]*body\{[^}]*background/);
  });

  it("manifest: id/start_url/scope /tv, fullscreen, landscape y los mismos íconos que app/manifest.ts", async () => {
    const res = await manifestGET();
    expect(res.headers.get("content-type")).toMatch(/application\/manifest\+json/);
    const m = await res.json();
    expect(m).toMatchObject({
      id: "/tv",
      start_url: "/tv",
      scope: "/tv",
      display: "fullscreen",
      orientation: "landscape",
    });
    expect(m.icons).toEqual(appManifest().icons);
  });
});
