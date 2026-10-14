/**
 * IAM-2c · `/auth/confirm` resistente a escáneres (GET → `/auth/confirm/continuar` → POST).
 *
 * Bug que lo motiva: Outlook Safe Links (y otros escáneres) abren los links de los mails antes que la
 * persona. Con el GET que canjeaba el token (`verifyOtp`), el escáner lo gastaba y la persona llegaba a
 * «El link venció o ya se usó» con la cuenta ya verificada (o sin poder resetear).
 *
 * Se corren los handlers REALES (`GET`/`POST` del route) contra Postgres; solo se mockea la red de
 * Supabase (`verifyOtp`, con registro a mano) y cookies/headers de Next (integration-setup.ts).
 * Se afirma el efecto observable: el redirect, si se llamó o no a `verifyOtp`, la fila de UserProfile y la
 * cookie `ks_recovery` (AUDIT §5.20: solo en `recovery`, firmada, del mismo usuario).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { RECOVERY_COOKIE, verifyRecoveryCookie } from "@/lib/recovery-cookie";
import { env } from "@/lib/env";
import { ownerClient, uniqueSuffix } from "@/tests/helpers/tenant-factory";

const sb = vi.hoisted(() => ({
  calls: [] as Array<{ type: string; token_hash: string }>,
  result: null as null | { user: { id: string; email: string; user_metadata?: Record<string, unknown> } | null; error: { message: string } | null },
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      verifyOtp: async (p: { type: string; token_hash: string }) => {
        sb.calls.push(p);
        const r = sb.result ?? { user: null, error: { message: "Token has expired or is invalid" } };
        return { data: { user: r.user, session: r.user ? {} : null }, error: r.error };
      },
    },
  }),
}));

import { GET, POST } from "@/app/auth/confirm/route";

const RUN = process.env.INTEGRATION === "1";
const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
const HASH = "f".repeat(56);

const get = (q: string) => GET(new Request(`${ORIGIN}/auth/confirm?${q}`));
const post = (fields: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
  POST(
    new Request(`${ORIGIN}/auth/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    })
  );
const location = (r: Response) => {
  const l = r.headers.get("location");
  if (!l) return null;
  const u = new URL(l, ORIGIN);
  return `${u.pathname}${u.search}`;
};

describe.skipIf(!RUN)("/auth/confirm · GET no consume, POST canjea", () => {
  let db: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    if (users.length) await db.userProfile.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });
  beforeEach(() => {
    sb.calls = [];
    sb.result = null;
    cookies().delete(RECOVERY_COOKIE);
  });

  const newUser = () => {
    const id = `test-user-confirm-${uniqueSuffix()}`;
    users.push(id);
    return { id, email: `${id}@test.local` };
  };

  it("[IAM-2c] el GET de /auth/confirm no consume el token: redirige a continuar sin llamar a verifyOtp", async () => {
    const r = await get(`token_hash=${HASH}&type=signup&next=/onboarding`);
    expect(sb.calls).toHaveLength(0);
    expect(r.status).toBe(303);
    expect(location(r)).toBe(`/auth/confirm/continuar?token_hash=${HASH}&type=signup&next=%2Fonboarding`);
    // El token viaja en la URL: ni cache intermedio ni Referer a otro sitio.
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("GET con next ajeno: el next ya sale saneado hacia continuar", async () => {
    const r = await get(`token_hash=${HASH}&type=signup&next=${encodeURIComponent("//evil.com")}`);
    expect(location(r)).toBe(`/auth/confirm/continuar?token_hash=${HASH}&type=signup&next=%2Fdashboard`);
  });

  it("GET sin token o con type desconocido → /login?error=link_invalid, sin verifyOtp", async () => {
    for (const q of [`type=signup`, `token_hash=${HASH}&type=email_change`, ``]) {
      const r = await get(q);
      expect(location(r)).toBe("/login?error=link_invalid");
    }
    expect(sb.calls).toHaveLength(0);
  });

  it("[IAM-2c] un POST de otro origen se rechaza sin canjear el token", async () => {
    const r = await post({ token_hash: HASH, type: "recovery", next: "/reset" }, { origin: "https://evil.example" });
    expect(sb.calls).toHaveLength(0);
    expect(location(r)).toBe("/login?error=link_invalid");
    expect(cookies().get(RECOVERY_COOKIE)).toBeUndefined();
  });

  it("POST cross-site sin Origin (Sec-Fetch-Site) también se rechaza", async () => {
    const r = await post({ token_hash: HASH, type: "signup" }, { "sec-fetch-site": "cross-site" });
    expect(sb.calls).toHaveLength(0);
    expect(location(r)).toBe("/login?error=link_invalid");
  });

  it("POST propio de signup: verifyOtp, upsert del UserProfile, 303 a next, sin cookie de recovery", async () => {
    const u = newUser();
    sb.result = { user: { id: u.id, email: u.email.toUpperCase(), user_metadata: { full_name: "Ana Pérez" } }, error: null };
    const r = await post({ token_hash: HASH, type: "signup", next: "/onboarding" });
    expect(sb.calls).toEqual([{ type: "signup", token_hash: HASH }]);
    expect(r.status).toBe(303);
    expect(location(r)).toBe("/onboarding");
    const prof = await db.userProfile.findUnique({ where: { id: u.id } });
    expect(prof).toMatchObject({ email: u.email, fullName: "Ana Pérez" });
    expect(cookies().get(RECOVERY_COOKIE)).toBeUndefined();
  });

  it("POST de recovery: deja ks_recovery firmada para ESE usuario y va a /reset (AUDIT §5.20)", async () => {
    const u = newUser();
    sb.result = { user: { id: u.id, email: u.email }, error: null };
    const r = await post({ token_hash: HASH, type: "recovery", next: "/reset" });
    expect(location(r)).toBe("/reset");
    const c = cookies().get(RECOVERY_COOKIE)?.value;
    expect(verifyRecoveryCookie(c, u.id)).toBe(true);
    expect(verifyRecoveryCookie(c, "otro-usuario")).toBe(false);
  });

  it("POST con next ajeno (el form se puede adulterar): vuelve a sanearse en el POST", async () => {
    const u = newUser();
    sb.result = { user: { id: u.id, email: u.email }, error: null };
    const r = await post({ token_hash: HASH, type: "magiclink", next: "https://evil.com/x" });
    expect(location(r)).toBe("/dashboard");
  });

  it("POST con token vencido o ya usado → /login?error=link_invalid, sin perfil ni cookie", async () => {
    const r = await post({ token_hash: HASH, type: "recovery", next: "/reset" });
    expect(sb.calls).toHaveLength(1);
    // IAM-2d: el login recibe el tipo de link para ofrecer una sola salida («olvidé mi contraseña»).
    expect(location(r)).toBe("/login?error=link_invalid&link=recovery");
    expect(cookies().get(RECOVERY_COOKIE)).toBeUndefined();
  });

  it("POST con parámetros inválidos → link_invalid sin llamar a verifyOtp", async () => {
    const r = await post({ token_hash: "x y", type: "signup" });
    expect(sb.calls).toHaveLength(0);
    expect(location(r)).toBe("/login?error=link_invalid");
  });
});
