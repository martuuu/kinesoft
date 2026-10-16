/**
 * [MB-0a] `SwRegister` (C-MB5, MB-D5/MB-D6).
 *
 * Render sin jsdom: `useEffect` no corre en `renderToStaticMarkup`, así que se mockea SOLO `react.useEffect` para que
 * ejecute el efecto en el acto. El componente y su lógica son los reales; lo de afuera es `navigator.serviceWorker`
 * (falso) y el entorno (`NODE_ENV`, `NEXT_PUBLIC_PWA`, con `vi.stubEnv`).
 *
 * Lo observable: si se llamó `register("/sw.js", { scope: "/", updateViaCache: "none" })`, o si se desregistraron
 * todos los SW (interruptor de emergencia `NEXT_PUBLIC_PWA=off`), y que el componente no pinta nada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useEffect = (fn: () => void | (() => void)) => void fn();
  return { ...actual, default: { ...actual, useEffect }, useEffect };
});

import { SwRegister } from "@/components/pwa/sw-register";

function fakeServiceWorker(opts: { registerRejects?: boolean } = {}) {
  const unregistered: number[] = [];
  const regs = [0, 1].map((i) => ({ unregister: vi.fn(async () => (unregistered.push(i), true)) }));
  const sw = {
    register: vi.fn(async () => {
      if (opts.registerRejects) throw new Error("SecurityError");
      return {};
    }),
    getRegistrations: vi.fn(async () => regs),
  };
  return { sw, regs, unregistered };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("[MB-0a] SwRegister", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    errSpy.mockRestore();
  });

  it("en producción registra /sw.js con scope / y updateViaCache none, y no pinta nada", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sw } = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    expect(renderToStaticMarkup(<SwRegister />)).toBe("");
    await flush();
    expect(sw.register).toHaveBeenCalledTimes(1);
    expect(sw.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    expect(sw.getRegistrations).not.toHaveBeenCalled();
  });

  it("en desarrollo no registra (un SW en `next dev` pisa el HMR)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { sw } = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    renderToStaticMarkup(<SwRegister />);
    await flush();
    expect(sw.register).not.toHaveBeenCalled();
    expect(sw.getRegistrations).not.toHaveBeenCalled();
  });

  it("sin navigator.serviceWorker (Safari privado, http) no hace nada ni tira", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("navigator", {});
    expect(() => renderToStaticMarkup(<SwRegister />)).not.toThrow();
    await flush();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("NEXT_PUBLIC_PWA=off desregistra TODOS los SW y no registra (interruptor MB-D6)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_PWA", "off");
    const { sw, unregistered } = fakeServiceWorker();
    vi.stubGlobal("navigator", { serviceWorker: sw });
    renderToStaticMarkup(<SwRegister />);
    await flush();
    expect(sw.register).not.toHaveBeenCalled();
    expect(unregistered.sort()).toEqual([0, 1]);
  });

  it("si el registro falla, va al log de consola y nunca tira al usuario", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sw } = fakeServiceWorker({ registerRejects: true });
    vi.stubGlobal("navigator", { serviceWorker: sw });
    expect(() => renderToStaticMarkup(<SwRegister />)).not.toThrow();
    await flush();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
