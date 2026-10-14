/**
 * IAM-2a · helpers puros de invitaciones: tope de links anteriores al reenviar y el copy del estado del mail
 * (que reemplaza el mensaje engañoso de SUPABASE_SERVICE_ROLE_KEY).
 */
import { describe, it, expect } from "vitest";
import { appendPriorToken, inviteEmailStatusCopy, PRIOR_TOKENS_MAX } from "@/lib/invitations-constants";

describe("appendPriorToken", () => {
  it("agrega el hash que deja de ser vigente al final", () => {
    expect(appendPriorToken(["a"], "b")).toEqual(["a", "b"]);
  });
  it("no duplica y recorta a los más nuevos", () => {
    const many = Array.from({ length: PRIOR_TOKENS_MAX }, (_, i) => `h${i}`);
    const out = appendPriorToken(many, "nuevo");
    expect(out).toHaveLength(PRIOR_TOKENS_MAX);
    expect(out.at(-1)).toBe("nuevo");
    expect(out).not.toContain("h0");
    expect(appendPriorToken(["x", "y"], "x")).toEqual(["y", "x"]);
  });
  it("no muta la lista recibida", () => {
    const prior = ["a"];
    appendPriorToken(prior, "b");
    expect(prior).toEqual(["a"]);
  });
});

describe("inviteEmailStatusCopy", () => {
  it("dice la verdad por estado y nunca menciona Supabase", () => {
    expect(inviteEmailStatusCopy("sent", null).tone).toBe("ok");
    expect(inviteEmailStatusCopy("skipped", "no_api_key")).toMatchObject({ tone: "warn" });
    expect(inviteEmailStatusCopy("skipped", "no_api_key").text).toContain("no está configurado");
    expect(inviteEmailStatusCopy("skipped", "log_only").text).toContain("este entorno");
    expect(inviteEmailStatusCopy("failed", "provider_error").tone).toBe("error");
    expect(inviteEmailStatusCopy("blocked", "unsafe_link_host").tone).toBe("error");
    for (const s of ["sent", "skipped", "failed", "blocked"] as const) {
      expect(inviteEmailStatusCopy(s, null).text).not.toMatch(/supabase|SERVICE_ROLE/i);
    }
  });
});
