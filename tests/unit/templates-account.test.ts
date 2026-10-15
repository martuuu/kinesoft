/**
 * PL-2a · plantillas de la cuenta (lib/email/templates-account.ts, puras). El código va solo en el cuerpo: nunca en
 * el asunto ni en el preheader (se ven con el teléfono bloqueado); sin links en el mail del código.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prismaService: {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));

import { recoveryCodeUsedEmail, twoFactorChangedEmail, twoFactorCodeEmail } from "@/lib/email/templates-account";
import { firstLinkHost } from "@/lib/email/transport";
import {
  generateEmailCode,
  generateRecoveryCodes,
  normalizeEmailCode,
  normalizeRecoveryCode,
} from "@/lib/two-factor-internal";

describe("[PL-2a] mails de la cuenta", () => {
  it("código: en el cuerpo (html y texto), nunca en el asunto ni en el preheader; sin links", () => {
    for (const purpose of ["login", "step_up", "enroll_email"] as const) {
      const m = twoFactorCodeEmail({ code: "482913", purpose, minutes: 10 });
      expect(m.subject).not.toMatch(/\d{3}/);
      expect(m.html).toContain("482 913");
      expect(m.text).toContain("Código: 482 913");
      const preheader = m.html.match(/<div style="display:none[^>]*>([^<]*)<\/div>/)?.[1] ?? "";
      expect(preheader).not.toContain("482");
      expect(firstLinkHost(m.html)).toBeNull();
    }
  });

  it("avisos: link a Seguridad de la cuenta (solo http/s) y fecha en hora AR", () => {
    const at = new Date("2026-10-16T02:30:00Z"); // 15-oct 23:30 AR
    const m = twoFactorChangedEmail({ change: "reset_by_platform", at, securityUrl: "https://app.kinesoft.ar/cuenta/seguridad" });
    expect(m.html).toContain("https://app.kinesoft.ar/cuenta/seguridad");
    expect(m.text).toContain("15 de octubre de 2026, 23:30");
    const evil = twoFactorChangedEmail({ change: "totp_enabled", at, securityUrl: "javascript:alert(1)" });
    expect(evil.html).not.toContain("javascript:");
    const r = recoveryCodeUsedEmail({ remaining: 1, at, securityUrl: "https://x.test/cuenta/seguridad" });
    expect(r.text).toContain("Te queda 1 código");
    expect(recoveryCodeUsedEmail({ remaining: 0, at, securityUrl: "https://x.test/" }).text).toContain("No te quedan");
  });
});

describe("[PL-2a] formatos de códigos", () => {
  it("email: 6 dígitos; normaliza espacios y guiones", () => {
    for (let i = 0; i < 50; i++) expect(generateEmailCode()).toMatch(/^\d{6}$/);
    expect(normalizeEmailCode(" 123 456 ")).toBe("123456");
    expect(normalizeEmailCode("123-456")).toBe("123456");
    expect(normalizeEmailCode("12345")).toBeNull();
    expect(normalizeEmailCode(123456)).toBeNull();
  });

  it("recuperación: 10 distintos, sin caracteres ambiguos, se normalizan", () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(c).not.toMatch(/[01ilo]/);
      expect(normalizeRecoveryCode(c.toUpperCase().replace("-", " "))).toBe(c.replace("-", ""));
    }
    expect(normalizeRecoveryCode("abcde-fghi1")).toBeNull();
    expect(normalizeRecoveryCode("short")).toBeNull();
  });
});
