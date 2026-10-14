/**
 * IAM-0d · Emisor de links de acceso (C-IAM3): `buildConfirmUrl` + `issueAccessLink`.
 *
 * El puerto de Auth admin es el fake de GoTrue (`tests/helpers/gotrue-fake.ts`)
 * inyectado con `__setAuthAdminForTests`: el emisor real corre entero. Se fija la
 * base de la app mockeando `@/lib/env` (configuración, no lógica bajo test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.kinesoft.test/", LOG_LEVEL: "debug", NODE_ENV: "test" },
  isProd: false,
}));

import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { buildConfirmUrl, issueAccessLink } from "@/lib/identity/access-link";
import { GotrueFake } from "../helpers/gotrue-fake";

let fake: GotrueFake;
let out: string[];
const realWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  fake = new GotrueFake();
  __setAuthAdminForTests(fake);
  // El logger escribe por process.stdout.write: se captura todo lo que sale.
  out = [];
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  __setAuthAdminForTests(null);
});

function parse(url: string) {
  const u = new URL(url);
  return { origin: u.origin, path: u.pathname, q: Object.fromEntries(u.searchParams) };
}

describe("buildConfirmUrl", () => {
  it("arma ${APP_URL}/auth/confirm con token_hash, type y next (sin doble barra)", () => {
    const url = buildConfirmUrl({ tokenHash: "abc", type: "recovery", next: "/reset" });
    expect(url).toBe("https://app.kinesoft.test/auth/confirm?token_hash=abc&type=recovery&next=%2Freset");
  });

  it("codifica el next propio con query", () => {
    const { q } = parse(buildConfirmUrl({ tokenHash: "t", type: "magiclink", next: "/portal?x=1&y=2" }));
    expect(q).toEqual({ token_hash: "t", type: "magiclink", next: "/portal?x=1&y=2" });
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "@evil.com", "", "/\t/evil.com"])(
    "un next ajeno (%j) cae al default del tipo",
    (next) => {
      expect(parse(buildConfirmUrl({ tokenHash: "t", type: "recovery", next })).q.next).toBe("/reset");
      expect(parse(buildConfirmUrl({ tokenHash: "t", type: "magiclink", next })).q.next).toBe("/dashboard");
    }
  );
});

describe("issueAccessLink", () => {
  async function seed(email: string, confirmed = true) {
    const r = await fake.createUser({ email, emailConfirm: confirmed, password: "s3creta-larga" });
    if (!r.ok) throw new Error("seed");
    return r.data.id;
  }

  it("recovery: link a /auth/confirm con el hashedToken que emitió GoTrue y type=recovery", async () => {
    const id = await seed("ana@kine.test");
    const r = await issueAccessLink({ email: "ana@kine.test", kind: "recovery", next: "/reset" });
    expect(r).toMatchObject({ ok: true, userId: id });
    if (!r.ok) return;
    const { origin, path, q } = parse(r.url);
    expect(origin).toBe("https://app.kinesoft.test");
    expect(path).toBe("/auth/confirm");
    expect(q).toEqual({ token_hash: fake.links[0].hashedToken, type: "recovery", next: "/reset" });
    expect(fake.calls.at(-1)).toMatchObject({ method: "generateLink", args: [{ type: "recovery", email: "ana@kine.test" }] });
  });

  it("recovery de un email sin cuenta → not_found (y no crea a nadie)", async () => {
    expect(await issueAccessLink({ email: "nadie@kine.test", kind: "recovery", next: "/reset" })).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(fake.users.size).toBe(0);
  });

  it("magiclink sobre cuenta existente → type=magiclink", async () => {
    await seed("pac@kine.test");
    const r = await issueAccessLink({ email: "pac@kine.test", kind: "magiclink", next: "/portal" });
    if (!r.ok) throw new Error("debía emitir");
    expect(parse(r.url).q).toMatchObject({ type: "magiclink", next: "/portal" });
  });

  it("magiclink sin cuenta: GoTrue crea el usuario y lo emite como signup → el link dice type=signup", async () => {
    const r = await issueAccessLink({ email: "nuevo@kine.test", kind: "magiclink", next: "/portal" });
    if (!r.ok) throw new Error("debía emitir");
    expect(parse(r.url).q.type).toBe("signup");
    expect(r.userId).not.toBeNull();
  });

  it("signup con password → type=signup y el password llega al puerto", async () => {
    const r = await issueAccessLink({ email: "s@kine.test", kind: "signup", next: "/onboarding", password: "s3creta-larga" });
    if (!r.ok) throw new Error("debía emitir");
    expect(parse(r.url).q).toMatchObject({ type: "signup", next: "/onboarding" });
    expect(fake.calls.at(-1)?.args[0]).toMatchObject({ type: "signup", password: "s3creta-larga" });
  });

  it("magiclink nunca sale como recovery (la cookie de /reset depende del type)", async () => {
    await seed("pac@kine.test");
    fake.forceVerificationTypeNext = "recovery";
    const r = await issueAccessLink({ email: "pac@kine.test", kind: "magiclink", next: "/portal" });
    if (!r.ok) throw new Error("debía emitir");
    expect(parse(r.url).q.type).toBe("magiclink");
  });

  it.each(["rate_limited", "config", "error"] as const)("error del puerto (%s) → {ok:false, code} sin tirar", async (code) => {
    await seed("ana@kine.test");
    fake.failNext(code);
    expect(await issueAccessLink({ email: "ana@kine.test", kind: "recovery", next: "/reset" })).toEqual({ ok: false, code });
  });

  it("next ajeno se sanea en el link emitido", async () => {
    await seed("ana@kine.test");
    const r = await issueAccessLink({ email: "ana@kine.test", kind: "recovery", next: "//evil.com" });
    if (!r.ok) throw new Error("debía emitir");
    expect(parse(r.url).q.next).toBe("/reset");
  });

  it("no loguea el token, la URL ni el email: solo el host", async () => {
    await seed("ana@kine.test");
    const r = await issueAccessLink({ email: "ana@kine.test", kind: "recovery", next: "/reset" });
    await issueAccessLink({ email: "nadie@kine.test", kind: "recovery", next: "/reset" });
    if (!r.ok) throw new Error("debía emitir");
    const logged = out.join("");
    expect(logged).toContain("app.kinesoft.test");
    expect(logged).not.toContain(fake.links[0].hashedToken);
    expect(logged).not.toContain("token_hash");
    expect(logged).not.toContain("/auth/confirm");
    expect(logged).not.toContain("ana@kine.test");
    expect(logged).not.toContain("nadie@kine.test");
  });
});
