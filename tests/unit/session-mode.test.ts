/**
 * «Mantenerme conectado» (tanda B, §22.13) · `lib/supabase/session-mode.ts`: la política de las cookies de sesión.
 */
import { describe, it, expect } from "vitest";
import {
  SESSION_MODE_COOKIE,
  applySessionCookiePolicy,
  sessionModeCookie,
  sessionModeFromCookie,
  sessionModeFromForm,
} from "@/lib/supabase/session-mode";

// Lo que arma `@supabase/ssr` 0.5 para escribir (maxAge 400 días) y para borrar (maxAge 0), + las nuestras.
const SET = { path: "/", sameSite: "lax" as const, httpOnly: true, secure: false, maxAge: 400 * 24 * 60 * 60 };
const REMOVE = { ...SET, maxAge: 0 };

describe("[B5] session-mode", () => {
  it("persistente = las opciones tal cual (lo de siempre)", () => {
    expect(applySessionCookiePolicy(SET, "persistent")).toBe(SET);
    expect(applySessionCookiePolicy(REMOVE, "persistent")).toBe(REMOVE);
  });

  it("efímera = sin maxAge ni expires (cookie de sesión del navegador); el resto igual", () => {
    const out = applySessionCookiePolicy({ ...SET, expires: new Date(Date.now() + 86_400_000) }, "ephemeral");
    expect(out).toEqual({ path: "/", sameSite: "lax", httpOnly: true, secure: false });
    expect("maxAge" in out).toBe(false);
    expect("expires" in out).toBe(false);
  });

  it("efímera NO toca los borrados (maxAge 0 o expires en el pasado): si no, «borrar» pasaría a «vaciar hasta cerrar»", () => {
    expect(applySessionCookiePolicy(REMOVE, "ephemeral")).toBe(REMOVE);
    const past = { path: "/", expires: new Date(0) };
    expect(applySessionCookiePolicy(past, "ephemeral")).toBe(past);
  });

  it("cookie → modo: solo `ephemeral` exacto es efímero (cualquier otra cosa falla a persistente)", () => {
    expect(sessionModeFromCookie("ephemeral")).toBe("ephemeral");
    for (const v of [undefined, null, "", "EPHEMERAL", "persistent", "1"]) expect(sessionModeFromCookie(v)).toBe("persistent");
  });

  it("form: hidden 0 + checkbox 1 = persistente; solo 0 = efímera; sin el campo (login viejo) = persistente", () => {
    expect(sessionModeFromForm(["0", "1"])).toBe("persistent");
    expect(sessionModeFromForm(["0"])).toBe("ephemeral");
    expect(sessionModeFromForm([])).toBe("persistent");
    expect(sessionModeFromForm(["1"])).toBe("persistent");
  });

  it("la cookie de preferencia: efímera = httpOnly sin vencimiento; persistente = se borra", () => {
    const e = sessionModeCookie("ephemeral");
    expect(e.name).toBe(SESSION_MODE_COOKIE);
    expect(e.value).toBe("ephemeral");
    expect(e.options).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax" });
    expect("maxAge" in e.options).toBe(false);
    const p = sessionModeCookie("persistent");
    expect(p).toMatchObject({ name: SESSION_MODE_COOKIE, value: "", options: { maxAge: 0, httpOnly: true } });
  });
});
