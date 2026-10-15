/**
 * PL-2e (C-PL12, H-PL2) · qué se toma de `user_metadata` de Google y Facebook (`lib/identity/oauth-profile.ts`).
 * El efecto en la base (perfil creado o no) lo cubre `tests/integration/auth-callback.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  OAUTH_AVATAR_HOSTS,
  oauthAvatarUrl,
  oauthCallbackErrorCode,
  oauthDisplayName,
  oauthProfileFromUser,
} from "@/lib/identity/oauth-profile";

const FB_PIC = "https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1&height=100&width=100&ext=1&hash=x";
const G_PIC = "https://lh3.googleusercontent.com/a/ACg8=s96-c";

describe("oauthProfileFromUser", () => {
  it("Google: full_name + avatar_url", () => {
    expect(
      oauthProfileFromUser({
        email: "ana@gmail.com",
        app_metadata: { provider: "google" },
        user_metadata: { full_name: "Ana Gómez", name: "Ana", avatar_url: G_PIC, picture: G_PIC },
      })
    ).toEqual({ email: "ana@gmail.com", fullName: "Ana Gómez", avatarUrl: G_PIC, provider: "google" });
  });

  it("Facebook: solo name + picture", () => {
    expect(
      oauthProfileFromUser({
        email: " bruno@fb.test ",
        app_metadata: { provider: "facebook" },
        user_metadata: { name: "Bruno  Díaz", picture: FB_PIC },
      })
    ).toEqual({ email: "bruno@fb.test", fullName: "Bruno Díaz", avatarUrl: FB_PIC, provider: "facebook" });
  });

  it.each([undefined, null, "", "   ", "sin-arroba"])("[PL-2e] email %j → null (nunca un perfil con \"\")", (email) => {
    expect(oauthProfileFromUser({ email, user_metadata: { name: "X" } }).email).toBeNull();
  });
});

describe("oauthDisplayName", () => {
  it("full_name antes que name; cae a name si full_name no sirve", () => {
    expect(oauthDisplayName({ full_name: "A B", name: "C" })).toBe("A B");
    expect(oauthDisplayName({ full_name: "  ", name: "C D" })).toBe("C D");
    expect(oauthDisplayName({ full_name: 42, name: "C D" })).toBe("C D");
  });
  it("nunca un email como nombre (decisión 19), ni basura larga o de control", () => {
    expect(oauthDisplayName({ full_name: "ana@gmail.com" })).toBeNull();
    expect(oauthDisplayName({ name: "x".repeat(121) })).toBeNull();
    expect(oauthDisplayName({ name: "Ana\u0000\nGómez" })).toBe("Ana Gómez");
    expect(oauthDisplayName(null)).toBeNull();
    expect(oauthDisplayName({})).toBeNull();
  });
});

describe("oauthAvatarUrl", () => {
  it("acepta solo https de los hosts de next.config (lh3, lookaside)", () => {
    expect([...OAUTH_AVATAR_HOSTS]).toEqual(["lh3.googleusercontent.com", "platform-lookaside.fbsbx.com"]);
    expect(oauthAvatarUrl({ avatar_url: G_PIC })).toBe(G_PIC);
    expect(oauthAvatarUrl({ picture: FB_PIC })).toBe(FB_PIC);
    expect(oauthAvatarUrl({ avatar_url: "https://evil.example/a.png", picture: FB_PIC })).toBe(FB_PIC);
  });
  it.each([
    "http://lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com.evil.example/a",
    "https://user:pw@lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com:8443/a",
    "javascript:alert(1)",
    "//lh3.googleusercontent.com/a",
    "no es url",
  ])("rechaza %s", (raw) => {
    expect(oauthAvatarUrl({ avatar_url: raw })).toBeNull();
  });
  it("picture como objeto (Graph API crudo) no rompe", () => {
    expect(oauthAvatarUrl({ picture: { data: { url: FB_PIC } } })).toBeNull();
  });
});

describe("oauthCallbackErrorCode", () => {
  it("sin email del proveedor → oauth_no_email", () => {
    expect(oauthCallbackErrorCode("server_error", "unexpected_failure", "Error getting user email from external provider")).toBe(
      "oauth_no_email"
    );
    expect(oauthCallbackErrorCode("server_error", "email_address_not_provided", null)).toBe("oauth_no_email");
  });
  it("email sin verificar que choca con una cuenta → email_not_confirmed", () => {
    expect(oauthCallbackErrorCode("access_denied", "provider_email_needs_verification", "Unverified email…")).toBe(
      "email_not_confirmed"
    );
  });
  it("proveedor apagado → provider_disabled", () => {
    expect(oauthCallbackErrorCode("validation_failed", null, "Unsupported provider: provider is not enabled")).toBe(
      "provider_disabled"
    );
    expect(oauthCallbackErrorCode("x", "provider_disabled", null)).toBe("provider_disabled");
  });
  it("el resto → oauth_failed", () => {
    expect(oauthCallbackErrorCode("access_denied", null, "The user denied the request")).toBe("oauth_failed");
    expect(oauthCallbackErrorCode("invalid_request", "bad_oauth_state", null)).toBe("oauth_failed");
  });
});
