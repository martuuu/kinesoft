/**
 * safeNext / safeNextFromUrl / isAllowedOrigin (A3b-S-auth).
 *
 * Payloads de open-redirect reales: cada uno, sin el guard, termina en un
 * host ajeno cuando se arma `${origin}${next}` o `new URL(next, origin)`.
 */
import { describe, it, expect } from "vitest";
import { isAllowedOrigin, safeNext, safeNextFromUrl, unwrapConfirmNext } from "@/lib/safe-next";

const APP = "https://app.kinesoft.com.ar";

describe("safeNext", () => {
  it.each([
    "/dashboard",
    "/portal",
    "/invite/abc_DEF-123",
    "/c/movare/booking",
    "/pacientes?q=perez&page=2",
    "/reset#top",
  ])("acepta el path propio %s", (p) => {
    expect(safeNext(p)).toBe(p);
    // y resuelto contra el origin real se queda en casa
    expect(new URL(safeNext(p), APP).origin).toBe(APP);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["protocol-relative con path", "//evil.com/dashboard"],
    ["backslash", "/\\evil.com"],
    ["doble backslash", "\\\\evil.com"],
    ["backslash en el medio", "/foo\\..\\\\evil.com"],
    ["esquema https", "https://evil.com"],
    ["esquema javascript", "javascript:alert(1)"],
    ["esquema data", "data:text/html,<script>alert(1)</script>"],
    ["userinfo (@)", "@evil.com"],
    ["host pelado", "evil.com"],
    ["TAB que el parser descarta", "/\t/evil.com"],
    ["LF", "/\n/evil.com"],
    ["CR", "/\r/evil.com"],
    ["NUL", "/\u0000/evil.com"],
    ["espacio inicial", " /dashboard"],
    ["vacío", ""],
    ["demasiado largo", "/" + "a".repeat(3000)],
  ])("rechaza %s", (_label, payload) => {
    expect(safeNext(payload)).toBe("/dashboard");
  });

  it("null/undefined → fallback", () => {
    expect(safeNext(null)).toBe("/dashboard");
    expect(safeNext(undefined, "/login")).toBe("/login");
  });

  it("el fallback es configurable", () => {
    expect(safeNext("//evil.com", "/portal")).toBe("/portal");
  });

  it("un %2F codificado queda como path propio (no lo decodifica el browser en Location)", () => {
    const r = safeNext("/%2F%2Fevil.com");
    expect(new URL(r, APP).origin).toBe(APP);
  });
});

describe("safeNextFromUrl", () => {
  it("URL absoluta del propio origin → path", () => {
    expect(safeNextFromUrl(`${APP}/invite/tok123?x=1`, [APP])).toBe("/invite/tok123?x=1");
  });
  it("URL absoluta de otro origin → fallback", () => {
    expect(safeNextFromUrl("https://evil.com/invite/x", [APP])).toBe("/dashboard");
  });
  it("userinfo que simula el host propio → fallback", () => {
    expect(safeNextFromUrl(`${APP}@evil.com/x`, [APP])).toBe("/dashboard");
  });
  it("subdominio parecido → fallback", () => {
    expect(safeNextFromUrl("https://app.kinesoft.com.ar.evil.com/x", [APP])).toBe("/dashboard");
  });
  it("paths relativos siguen las reglas de safeNext", () => {
    expect(safeNextFromUrl("/reset", [APP], "/x")).toBe("/reset");
    expect(safeNextFromUrl("//evil.com", [APP], "/reset")).toBe("/reset");
  });
});

describe("isAllowedOrigin", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("Origin propio pasa", () => {
    expect(isAllowedOrigin(h({ origin: APP }), [APP])).toBe(true);
    expect(isAllowedOrigin(h({ origin: "http://localhost:3000" }), ["http://localhost:3000/x", APP])).toBe(true);
  });
  it("Origin ajeno o `null` no pasa", () => {
    expect(isAllowedOrigin(h({ origin: "https://evil.com" }), [APP])).toBe(false);
    expect(isAllowedOrigin(h({ origin: "null" }), [APP])).toBe(false);
  });
  it("sin Origin: decide Sec-Fetch-Site", () => {
    expect(isAllowedOrigin(h({ "sec-fetch-site": "same-origin" }), [APP])).toBe(true);
    expect(isAllowedOrigin(h({ "sec-fetch-site": "none" }), [APP])).toBe(true);
    expect(isAllowedOrigin(h({ "sec-fetch-site": "cross-site" }), [APP])).toBe(false);
    expect(isAllowedOrigin(h({ "sec-fetch-site": "same-site" }), [APP])).toBe(false);
  });
  it("sin Origin ni Sec-Fetch-Site (no-browser) pasa", () => {
    expect(isAllowedOrigin(h({}), [APP])).toBe(true);
  });
});

describe("unwrapConfirmNext (bug signup-confirm-doble-salto)", () => {
  const APP = "https://app.kinesoft.test";
  // Simula el link de la plantilla: /auth/confirm?token_hash=…&type=email&next={{ .RedirectTo }}
  const landing = (redirectTo: string) =>
    unwrapConfirmNext(safeNextFromUrl(redirectTo, [APP], "/dashboard"), "/dashboard");

  it("el emailRedirectTo actual (destino final) aterriza en el destino", () => {
    expect(landing(`${APP}/onboarding`)).toBe("/onboarding");
    expect(landing(`${APP}/invite/abc123`)).toBe("/invite/abc123");
  });

  it("un emailRedirectTo viejo que apunta a /auth/confirm se desenvuelve (no vuelve sin token_hash)", () => {
    expect(landing(`${APP}/auth/confirm?next=%2Fonboarding`)).toBe("/onboarding");
    expect(landing(`${APP}/auth/confirm?next=${encodeURIComponent("/invite/abc123")}`)).toBe("/invite/abc123");
  });

  it("anidado o sin next → fallback, nunca /auth/confirm", () => {
    expect(unwrapConfirmNext("/auth/confirm", "/dashboard")).toBe("/dashboard");
    const deep = "/auth/confirm?next=" + encodeURIComponent("/auth/confirm?next=" + encodeURIComponent("/auth/confirm?next=/auth/confirm"));
    expect(unwrapConfirmNext(deep, "/dashboard")).toBe("/dashboard");
    expect(unwrapConfirmNext("/auth/confirm?next=//evil.com", "/dashboard")).toBe("/dashboard");
  });

  it("paths que no son /auth/confirm pasan intactos", () => {
    expect(unwrapConfirmNext("/auth/confirmado", "/dashboard")).toBe("/auth/confirmado");
    expect(unwrapConfirmNext("/reset", "/dashboard")).toBe("/reset");
  });
});
