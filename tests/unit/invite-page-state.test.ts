/**
 * IAM-2b · qué muestra `/invite/<token>` según la invitación y la sesión (`invitePageState`, puro).
 */
import { describe, it, expect } from "vitest";
import { invitePageState, inviteLoginHref } from "@/app/invite/[token]/invite-state";

const base = { status: "pending" as const, inviteEmail: "Ana@Kine.test", sessionEmail: null, hasAccount: false };

describe("[IAM-2b] invitePageState", () => {
  it("link desconocido → not_found (antes: 404 pelado)", () => {
    expect(invitePageState({ ...base, status: null, inviteEmail: null })).toEqual({ kind: "not_found" });
  });

  it("cerradas: aceptada gana, después anulada y vencida; la sesión no las reabre", () => {
    expect(invitePageState({ ...base, status: "accepted" })).toEqual({ kind: "accepted", signedIn: false });
    expect(invitePageState({ ...base, status: "accepted", sessionEmail: "ana@kine.test" })).toEqual({
      kind: "accepted",
      signedIn: true,
    });
    expect(invitePageState({ ...base, status: "revoked", sessionEmail: "ana@kine.test" })).toEqual({ kind: "revoked" });
    expect(invitePageState({ ...base, status: "expired" })).toEqual({ kind: "expired" });
  });

  it("sin sesión: formulario de activación, o «ya tenés cuenta» si el email ya tiene cuenta", () => {
    expect(invitePageState(base)).toEqual({ kind: "activate" });
    expect(invitePageState({ ...base, hasAccount: true })).toEqual({ kind: "has_account" });
  });

  it("con sesión: mismo email (sin distinguir mayúsculas) → join; otro → wrong_email", () => {
    expect(invitePageState({ ...base, sessionEmail: " ANA@kine.test " })).toEqual({ kind: "join" });
    expect(invitePageState({ ...base, sessionEmail: "Otro@Kine.test", hasAccount: true })).toEqual({
      kind: "wrong_email",
      sessionEmail: "otro@kine.test",
    });
  });

  it("un comodín de LIKE no matchea otro email (IAM-0a)", () => {
    expect(invitePageState({ ...base, inviteEmail: "ana_@kine.test", sessionEmail: "anax@kine.test" }).kind).toBe(
      "wrong_email"
    );
  });

  it("login con vuelta a la invitación y email precargado", () => {
    expect(inviteLoginHref("tok_123", "ana@kine.test")).toBe(
      "/login?next=%2Finvite%2Ftok_123&email=ana%40kine.test"
    );
    expect(inviteLoginHref("tok_123")).toBe("/login?next=%2Finvite%2Ftok_123");
  });
});
