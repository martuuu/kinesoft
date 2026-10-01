/**
 * Cookie firmada `ks_recovery` (A3b-S-auth): la emite /auth/confirm en
 * `recovery` y la consume el reset de A3c. Tiene que ser infalsificable,
 * atada al usuario y con vencimiento.
 */
import { describe, it, expect } from "vitest";
import { makeRecoveryCookieValue, verifyRecoveryCookie, RECOVERY_TTL_S } from "@/lib/recovery-cookie";

describe("recovery cookie", () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0);

  it("vale para el mismo usuario dentro del TTL", () => {
    const v = makeRecoveryCookieValue("user-1", now);
    expect(verifyRecoveryCookie(v, "user-1", now + 60_000)).toBe(true);
  });
  it("no vale para otro usuario", () => {
    const v = makeRecoveryCookieValue("user-1", now);
    expect(verifyRecoveryCookie(v, "user-2", now)).toBe(false);
  });
  it("vence", () => {
    const v = makeRecoveryCookieValue("user-1", now);
    expect(verifyRecoveryCookie(v, "user-1", now + (RECOVERY_TTL_S + 1) * 1000)).toBe(false);
  });
  it("un flag o una firma inventada no valen", () => {
    expect(verifyRecoveryCookie("1", "user-1", now)).toBe(false);
    expect(verifyRecoveryCookie(undefined, "user-1", now)).toBe(false);
    const exp = Math.floor(now / 1000) + 600;
    expect(verifyRecoveryCookie(`user-1.${exp}.AAAA`, "user-1", now)).toBe(false);
  });
  it("estirar el vencimiento rompe la firma", () => {
    const [uid, exp, mac] = makeRecoveryCookieValue("user-1", now).split(".");
    expect(verifyRecoveryCookie(`${uid}.${Number(exp) + 3600}.${mac}`, "user-1", now)).toBe(false);
  });
});
