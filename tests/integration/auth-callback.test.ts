/**
 * PL-2e · callback de OAuth (Google y Facebook) contra Postgres: perfil con nombre y avatar, y nunca un
 * `UserProfile` con email vacío (H-PL2, plan §20.5.8 / C-PL12).
 *
 * Antes:
 *  - el callback hacía `email: user.email ?? ""`: una cuenta de Facebook registrada con teléfono (sin email) o que
 *    negó el permiso de email creaba un `UserProfile` con `""` — una identidad sin forma de recuperar la cuenta ni
 *    de recibir avisos, y que choca con el resto de la app que asume email;
 *  - solo leía `full_name` / `avatar_url` de `user_metadata` (las claves de Google). Facebook vía GoTrue puede traer
 *    solo `name` / `picture`, y el perfil quedaba sin nombre (y la app terminaba mostrando el email, decisión 19);
 *  - si GoTrue volvía con `?error=…` (consentimiento negado, proveedor sin email) el callback decía
 *    `missing_code` sin distinguir.
 *
 * Route REAL; se reemplaza solo la red de Supabase del server (canje del code y cierre de sesión).
 * El vínculo del portal (AUDIT §5.8) lo cubre `portal-auth.test.ts`, que no se toca.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { env } from "@/lib/env";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";

type FakeUser = {
  id: string;
  email?: string | null;
  email_confirmed_at: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
};
const sb = vi.hoisted(() => ({
  user: null as null | FakeUser,
  signOuts: 0,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      exchangeCodeForSession: async () =>
        sb.user
          ? { data: { user: sb.user, session: {} }, error: null }
          : { data: { user: null, session: null }, error: { message: "invalid code" } },
      signOut: async () => {
        sb.signOuts += 1;
        return { error: null };
      },
    },
  }),
}));

import { GET as callbackGET } from "@/app/auth/callback/route";

const RUN = process.env.INTEGRATION === "1";
const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;

const loginError = (res: Response) => {
  const u = new URL(res.headers.get("location")!);
  return u.pathname === "/login" ? u.searchParams.get("error") : null;
};

describe.skipIf(!RUN)("PL-2e · callback de OAuth: perfil desde Google/Facebook y sin email → rechazo", () => {
  let db: PrismaClient;
  const ids: string[] = [];
  const newId = () => {
    const id = `test-oauth-${uniqueSuffix()}`;
    ids.push(id);
    return id;
  };
  const call = (q = "code=abc&next=/onboarding") => callbackGET(new Request(`${ORIGIN}/auth/callback?${q}`));

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    if (ids.length) await db?.userProfile.deleteMany({ where: { id: { in: ids } } });
    await db?.$disconnect();
  });
  beforeEach(() => {
    sb.user = null;
    sb.signOuts = 0;
  });

  it("[PL-2e] Facebook sin email crea un perfil vacío → rechazo con oauth_no_email, sin UserProfile y sesión cerrada", async () => {
    const id = newId();
    sb.user = {
      id,
      email: "",
      email_confirmed_at: null,
      app_metadata: { provider: "facebook" },
      user_metadata: { name: "Sin Mail", picture: "https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=1" },
    };
    const res = await call();
    expect(loginError(res)).toBe("oauth_no_email");
    expect(await db.userProfile.findUnique({ where: { id } })).toBeNull();
    expect(sb.signOuts).toBe(1);
  });

  it("email ausente (undefined) también se rechaza y nunca se escribe un perfil con \"\"", async () => {
    const id = newId();
    sb.user = { id, email_confirmed_at: null, app_metadata: { provider: "facebook" }, user_metadata: {} };
    const res = await call();
    expect(loginError(res)).toBe("oauth_no_email");
    expect(await db.userProfile.count({ where: { id } })).toBe(0);
  });

  it("Google: guarda full_name y avatar_url (lh3)", async () => {
    const id = newId();
    const email = `g-${uniqueSuffix()}@test.local`;
    sb.user = {
      id,
      email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: "google" },
      user_metadata: { full_name: "Ana Gómez", avatar_url: "https://lh3.googleusercontent.com/a/abc=s96-c" },
    };
    const res = await call();
    expect(new URL(res.headers.get("location")!).pathname).toBe("/onboarding");
    const p = await db.userProfile.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ email, fullName: "Ana Gómez", avatarUrl: "https://lh3.googleusercontent.com/a/abc=s96-c" });
  });

  it("[PL-2e] Facebook con solo name/picture: guarda nombre y avatar", async () => {
    const id = newId();
    const email = `fb-${uniqueSuffix()}@test.local`;
    const pic = "https://platform-lookaside.fbsbx.com/platform/profilepic/?asid=123&height=100&width=100";
    sb.user = {
      id,
      email,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: "facebook" },
      user_metadata: { name: "Bruno Díaz", picture: pic },
    };
    await call();
    const p = await db.userProfile.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ email, fullName: "Bruno Díaz", avatarUrl: pic });
  });

  it("avatar de un host ajeno o nombre que es un email no se guardan (decisión 19, next/image)", async () => {
    const id = newId();
    const email = `x-${uniqueSuffix()}@test.local`;
    sb.user = {
      id,
      email,
      email_confirmed_at: new Date().toISOString(),
      user_metadata: { full_name: email, avatar_url: "https://evil.example/a.png" },
    };
    await call();
    const p = await db.userProfile.findUniqueOrThrow({ where: { id } });
    expect(p.fullName).toBeNull();
    expect(p.avatarUrl).toBeNull();
  });

  it("re-ingreso sin nombre ni avatar no pisa lo que ya había", async () => {
    const id = newId();
    const email = `re-${uniqueSuffix()}@test.local`;
    await db.userProfile.create({
      data: { id, email, fullName: "Ya Estaba", avatarUrl: "https://lh3.googleusercontent.com/a/old" },
    });
    sb.user = { id, email, email_confirmed_at: new Date().toISOString(), user_metadata: {} };
    await call();
    const p = await db.userProfile.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ email, fullName: "Ya Estaba", avatarUrl: "https://lh3.googleusercontent.com/a/old" });
  });

  it("[PL-2e] GoTrue vuelve con ?error= por falta de email → oauth_no_email; otro error → oauth_failed", async () => {
    const noEmail = await call(
      "error=server_error&error_code=unexpected_failure&error_description=Error+getting+user+email+from+external+provider"
    );
    expect(loginError(noEmail)).toBe("oauth_no_email");
    const denied = await call("error=access_denied&error_description=The+user+denied+the+request");
    expect(loginError(denied)).toBe("oauth_failed");
  });

  it("[ES4-Z] con destino en el portal, el error vuelve a /portal?error= (no al login del equipo)", async () => {
    const res = await call("error=access_denied&next=/portal/c/demo");
    const u = new URL(res.headers.get("location")!);
    expect(u.pathname).toBe("/portal");
    expect(u.searchParams.get("error")).toBe("oauth_failed");
    expect(loginError(await call("error=access_denied&next=/dashboard"))).toBe("oauth_failed");
  });

  it("sin code ni error sigue siendo missing_code; next malicioso se sanea", async () => {
    expect(loginError(await call("next=/x"))).toBe("missing_code");
    const id = newId();
    sb.user = { id, email: `n-${uniqueSuffix()}@test.local`, email_confirmed_at: null, user_metadata: {} };
    const res = await call("code=abc&next=//evil.com");
    expect(new URL(res.headers.get("location")!).origin).toBe(ORIGIN);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });
});
