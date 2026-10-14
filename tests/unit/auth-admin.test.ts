/**
 * IAM-0d · Puerto de Auth admin (C-IAM3), implementación REAL sobre supabase-js.
 *
 * Lo único que se reemplaza es el cliente admin (`getSupabaseAdminClient`): es la
 * red. El fake de cliente devuelve `{ data, error }` como supabase-js, y también
 * puede TIRAR (fetch caído), para probar que el puerto nunca tira.
 * Registro a mano (`calls`), no `vi.fn` (vitest 2.1.9, ver tests/helpers/fetch-fake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

let currentClient: SupabaseClient | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => currentClient,
}));

import {
  __setAuthAdminForTests,
  authAdmin,
  classifyAuthAdminError,
  type AuthAdminErrorCode,
} from "@/lib/identity/auth-admin";
import { GotrueFake } from "../helpers/gotrue-fake";

type Resp = { data: unknown; error: unknown } | { throws: unknown };
type Call = { method: string; args: unknown[] };

function rawUser(over: Record<string, unknown> = {}) {
  return {
    id: "u-1",
    email: "ana@kine.test",
    email_confirmed_at: undefined,
    last_sign_in_at: undefined,
    created_at: "2026-10-14T12:00:00Z",
    banned_until: undefined,
    user_metadata: {},
    ...over,
  };
}

function apiError(message: string, status: number, code?: string) {
  // Forma de AuthApiError: duck-typing, igual que lo ve el puerto.
  return Object.assign(new Error(message), { name: "AuthApiError", status, code, __isAuthError: true });
}

/** Cliente admin de mentira: cada método responde lo que diga `responses[método]` (cola o fijo). */
function makeClient(responses: Record<string, Resp | Resp[] | ((...a: unknown[]) => Resp)>) {
  const calls: Call[] = [];
  const handler = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    const r = responses[method];
    let resp: Resp;
    if (typeof r === "function") resp = r(...args);
    else if (Array.isArray(r)) resp = r.shift() ?? { data: null, error: apiError("sin respuesta", 500) };
    else resp = r ?? { data: null, error: apiError("no configurado", 500) };
    if ("throws" in resp) throw resp.throws;
    return resp;
  };
  const admin = Object.fromEntries(
    ["createUser", "deleteUser", "updateUserById", "getUserById", "listUsers", "generateLink"].map((m) => [m, handler(m)])
  );
  const client = { auth: { admin } } as unknown as SupabaseClient;
  return { client, calls };
}

beforeEach(() => {
  currentClient = null;
  __setAuthAdminForTests(null);
});
afterEach(() => {
  __setAuthAdminForTests(null);
});

describe("classifyAuthAdminError", () => {
  const cases: Array<[string, unknown, AuthAdminErrorCode]> = [
    ["code email_exists", apiError("x", 422, "email_exists"), "email_exists"],
    ["code user_already_exists", apiError("x", 422, "user_already_exists"), "email_exists"],
    [
      "422 sin code con el texto de GoTrue viejo",
      apiError("A user with this email address has already been registered", 422),
      "email_exists",
    ],
    ["weak_password", apiError("Password should be at least 6 characters", 422, "weak_password"), "weak_password"],
    ["422 a secas NO es email_exists", apiError("Unprocessable", 422), "error"],
    ["user_not_found", apiError("User not found", 404, "user_not_found"), "not_found"],
    ["404 sin code", apiError("not found", 404), "not_found"],
    ["429", apiError("Too many", 429), "rate_limited"],
    ["over_request_rate_limit", apiError("x", 400, "over_request_rate_limit"), "rate_limited"],
    ["500", apiError("boom", 500, "unexpected_failure"), "error"],
    ["no es objeto", "texto", "error"],
    ["null", null, "error"],
  ];
  it.each(cases)("%s", (_n, err, code) => {
    expect(classifyAuthAdminError(err)).toBe(code);
  });
});

describe("authAdmin() sin cliente admin", () => {
  it("todas las operaciones devuelven code config y no tiran", async () => {
    const a = authAdmin();
    const results = await Promise.all([
      a.createUser({ email: "a@b.c", emailConfirm: true }),
      a.deleteUser("x"),
      a.updateUserById("x", { password: "secreta123" }),
      a.getUser("x"),
      a.findUserByEmail("a@b.c"),
      a.generateLink({ type: "recovery", email: "a@b.c" }),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "config" });
  });
});

describe("createUser", () => {
  it("normaliza el email, manda email_confirm y full_name en user_metadata, y mapea a AuthUserLite", async () => {
    const { client, calls } = makeClient({
      createUser: {
        data: { user: rawUser({ email_confirmed_at: "2026-10-14T12:00:01Z" }) },
        error: null,
      },
    });
    currentClient = client;
    const r = await authAdmin().createUser({
      email: "  Ana@Kine.TEST ",
      password: "s3creta-larga",
      emailConfirm: true,
      fullName: "  Ana Pérez ",
    });
    expect(calls[0].args[0]).toEqual({
      email: "ana@kine.test",
      password: "s3creta-larga",
      email_confirm: true,
      user_metadata: { full_name: "Ana Pérez" },
    });
    expect(r).toEqual({
      ok: true,
      data: {
        id: "u-1",
        email: "ana@kine.test",
        emailConfirmedAt: "2026-10-14T12:00:01Z",
        lastSignInAt: null,
        createdAt: "2026-10-14T12:00:00Z",
        bannedUntil: null,
      },
    });
  });

  it("sin password ni nombre no manda esas claves", async () => {
    const { client, calls } = makeClient({ createUser: { data: { user: rawUser() }, error: null } });
    currentClient = client;
    await authAdmin().createUser({ email: "ana@kine.test", emailConfirm: false, fullName: null });
    expect(calls[0].args[0]).toEqual({ email: "ana@kine.test", email_confirm: false });
  });

  it.each([
    [apiError("A user with this email address has already been registered", 422, "email_exists"), "email_exists"],
    [apiError("Password is known to be weak", 422, "weak_password"), "weak_password"],
    [apiError("rate", 429, "over_request_rate_limit"), "rate_limited"],
    [apiError("db down", 500), "error"],
  ] as const)("traduce el {error} de supabase-js (%#) sin tirar", async (error, code) => {
    const { client } = makeClient({ createUser: { data: { user: null }, error } });
    currentClient = client;
    const r = await authAdmin().createUser({ email: "ana@kine.test", emailConfirm: true });
    expect(r).toMatchObject({ ok: false, code });
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
  });

  it("si supabase-js TIRA (fetch caído), devuelve code error", async () => {
    const { client } = makeClient({ createUser: { throws: new TypeError("fetch failed") } });
    currentClient = client;
    await expect(authAdmin().createUser({ email: "ana@kine.test", emailConfirm: true })).resolves.toMatchObject({
      ok: false,
      code: "error",
    });
  });

  it("respuesta sin usuario y sin error = error (no un ok con data rota)", async () => {
    const { client } = makeClient({ createUser: { data: { user: null }, error: null } });
    currentClient = client;
    expect(await authAdmin().createUser({ email: "ana@kine.test", emailConfirm: true })).toMatchObject({
      ok: false,
      code: "error",
    });
  });
});

describe("updateUserById", () => {
  it("traduce password, emailConfirm, fullName y banDuration a los nombres de GoTrue", async () => {
    const { client, calls } = makeClient({
      updateUserById: { data: { user: rawUser({ banned_until: "2126-10-14T12:00:00Z" }) }, error: null },
    });
    currentClient = client;
    const r = await authAdmin().updateUserById("u-1", {
      password: "nueva-larga-1",
      emailConfirm: true,
      fullName: null,
      banDuration: "876000h",
    });
    expect(calls[0].args).toEqual([
      "u-1",
      { password: "nueva-larga-1", email_confirm: true, user_metadata: { full_name: null }, ban_duration: "876000h" },
    ]);
    expect(r).toMatchObject({ ok: true, data: { bannedUntil: "2126-10-14T12:00:00Z" } });
  });

  it("solo manda lo que viene (sin claves undefined)", async () => {
    const { client, calls } = makeClient({ updateUserById: { data: { user: rawUser() }, error: null } });
    currentClient = client;
    await authAdmin().updateUserById("u-1", { banDuration: "none" });
    expect(calls[0].args[1]).toEqual({ ban_duration: "none" });
  });

  it("usuario inexistente → not_found", async () => {
    const { client } = makeClient({
      updateUserById: { data: { user: null }, error: apiError("User not found", 404, "user_not_found") },
    });
    currentClient = client;
    expect(await authAdmin().updateUserById("nope", { password: "x" })).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("deleteUser / getUser", () => {
  it("deleteUser ok → data null; 404 → not_found", async () => {
    const { client, calls } = makeClient({
      deleteUser: [
        { data: { user: rawUser() }, error: null },
        { data: { user: null }, error: apiError("User not found", 404, "user_not_found") },
      ],
    });
    currentClient = client;
    expect(await authAdmin().deleteUser("u-1")).toEqual({ ok: true, data: null });
    expect(await authAdmin().deleteUser("u-1")).toMatchObject({ ok: false, code: "not_found" });
    // Borrado duro: nunca el soft-delete (dejaría el email tomado sin poder reusarlo).
    expect(calls[0].args).toEqual(["u-1"]);
  });

  it("getUser mapea; email vacío de GoTrue queda null", async () => {
    const { client } = makeClient({ getUserById: { data: { user: rawUser({ email: "" }) }, error: null } });
    currentClient = client;
    expect(await authAdmin().getUser("u-1")).toMatchObject({ ok: true, data: { id: "u-1", email: null } });
  });
});

describe("findUserByEmail", () => {
  function page(n: number, prefix: string) {
    return Array.from({ length: n }, (_, i) => rawUser({ id: `${prefix}-${i}`, email: `${prefix}${i}@kine.test` }));
  }

  it("pagina listUsers de a 1000 hasta encontrar, con match exacto normalizado", async () => {
    const { client, calls } = makeClient({
      listUsers: [
        { data: { users: page(1000, "p1-"), aud: "authenticated", nextPage: 2, lastPage: 2, total: 1001 }, error: null },
        {
          data: { users: [rawUser({ id: "target", email: "jperez@hotmail.com" })], aud: "authenticated", nextPage: null, lastPage: 2, total: 1001 },
          error: null,
        },
      ],
    });
    currentClient = client;
    const r = await authAdmin().findUserByEmail("  JPerez@Hotmail.com ");
    expect(r).toMatchObject({ ok: true, data: { id: "target" } });
    expect(calls.map((c) => c.args[0])).toEqual([
      { page: 1, perPage: 1000 },
      { page: 2, perPage: 1000 },
    ]);
  });

  it("no matchea comodines: `jpere_@hotmail.com` NO encuentra a `jperez@hotmail.com` (el bug del ILIKE)", async () => {
    const { client } = makeClient({
      listUsers: { data: { users: [rawUser({ email: "jperez@hotmail.com" })], aud: "a", nextPage: null, lastPage: 1, total: 1 }, error: null },
    });
    currentClient = client;
    expect(await authAdmin().findUserByEmail("jpere_@hotmail.com")).toEqual({ ok: true, data: null });
    expect(await authAdmin().findUserByEmail("%@hotmail.com")).toEqual({ ok: true, data: null });
  });

  it("corta en la página corta (no pide una página de más)", async () => {
    const { client, calls } = makeClient({
      listUsers: { data: { users: page(3, "x"), aud: "a", nextPage: null, lastPage: 1, total: 3 }, error: null },
    });
    currentClient = client;
    expect(await authAdmin().findUserByEmail("nadie@kine.test")).toEqual({ ok: true, data: null });
    expect(calls).toHaveLength(1);
  });

  it("email vacío → null sin llamar a GoTrue", async () => {
    const { client, calls } = makeClient({});
    currentClient = client;
    expect(await authAdmin().findUserByEmail("   ")).toEqual({ ok: true, data: null });
    expect(calls).toHaveLength(0);
  });

  it("error de listUsers → code (no `null`, que el caller leería como «no existe»)", async () => {
    const { client } = makeClient({ listUsers: { data: { users: [] }, error: apiError("boom", 500) } });
    currentClient = client;
    expect(await authAdmin().findUserByEmail("a@kine.test")).toMatchObject({ ok: false, code: "error" });
  });
});

describe("generateLink", () => {
  it("manda type/email/password/redirectTo y devuelve hashedToken, verificationType y userId", async () => {
    const { client, calls } = makeClient({
      generateLink: {
        data: {
          properties: { hashed_token: "h4sh", verification_type: "signup", action_link: "x", email_otp: "1", redirect_to: "" },
          user: rawUser({ id: "nuevo" }),
        },
        error: null,
      },
    });
    currentClient = client;
    const r = await authAdmin().generateLink({
      type: "signup",
      email: " Ana@Kine.test",
      password: "s3creta-larga",
      redirectTo: "https://app.kinesoft.test/x",
    });
    expect(calls[0].args[0]).toEqual({
      type: "signup",
      email: "ana@kine.test",
      password: "s3creta-larga",
      options: { redirectTo: "https://app.kinesoft.test/x" },
    });
    expect(r).toEqual({ ok: true, data: { hashedToken: "h4sh", verificationType: "signup", userId: "nuevo" } });
  });

  it("recovery sin password ni redirectTo: no manda esas claves", async () => {
    const { client, calls } = makeClient({
      generateLink: {
        data: { properties: { hashed_token: "h", verification_type: "recovery" }, user: rawUser() },
        error: null,
      },
    });
    currentClient = client;
    await authAdmin().generateLink({ type: "recovery", email: "ana@kine.test" });
    expect(calls[0].args[0]).toEqual({ type: "recovery", email: "ana@kine.test" });
  });

  it("200 sin hashed_token = error (el caso que en Traze dejaba «verde y sin acceso»)", async () => {
    const { client } = makeClient({
      generateLink: { data: { properties: { verification_type: "recovery" }, user: rawUser() }, error: null },
    });
    currentClient = client;
    expect(await authAdmin().generateLink({ type: "recovery", email: "ana@kine.test" })).toMatchObject({
      ok: false,
      code: "error",
    });
  });

  it("verification_type desconocido → el tipo pedido", async () => {
    const { client } = makeClient({
      generateLink: { data: { properties: { hashed_token: "h", verification_type: "email_change_new" }, user: null }, error: null },
    });
    currentClient = client;
    expect(await authAdmin().generateLink({ type: "magiclink", email: "ana@kine.test" })).toEqual({
      ok: true,
      data: { hashedToken: "h", verificationType: "magiclink", userId: null },
    });
  });

  it("recovery de un email sin cuenta → not_found", async () => {
    const { client } = makeClient({
      generateLink: { data: { properties: null, user: null }, error: apiError("User with this email not found", 404, "user_not_found") },
    });
    currentClient = client;
    expect(await authAdmin().generateLink({ type: "recovery", email: "x@kine.test" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("inyección del fake", () => {
  it("authAdmin() devuelve el fake inyectado y vuelve al real con null", async () => {
    const fake = new GotrueFake();
    __setAuthAdminForTests(fake);
    expect(authAdmin()).toBe(fake);
    __setAuthAdminForTests(null);
    expect(authAdmin()).not.toBe(fake);
    // El real, sin cliente: config.
    expect(await authAdmin().getUser("x")).toMatchObject({ ok: false, code: "config" });
  });
});

describe("GotrueFake (supuestos que verifica scripts/diagnose-auth.ts)", () => {
  it("createUser repetido (sin distinguir mayúsculas) → email_exists", async () => {
    const fake = new GotrueFake();
    expect(await fake.createUser({ email: "ana@kine.test", emailConfirm: false })).toMatchObject({ ok: true });
    expect(await fake.createUser({ email: " ANA@kine.test", emailConfirm: true })).toMatchObject({
      ok: false,
      code: "email_exists",
    });
    expect(fake.users.size).toBe(1);
  });

  it("failNext inyecta un error una sola vez (opcionalmente por método) y queda registrado en calls", async () => {
    const fake = new GotrueFake();
    fake.failNext("rate_limited", "generateLink");
    expect(await fake.createUser({ email: "a@kine.test", emailConfirm: true })).toMatchObject({ ok: true });
    expect(await fake.generateLink({ type: "recovery", email: "a@kine.test" })).toMatchObject({
      ok: false,
      code: "rate_limited",
    });
    expect(await fake.generateLink({ type: "recovery", email: "a@kine.test" })).toMatchObject({ ok: true });
    expect(fake.calls.map((c) => c.method)).toEqual(["createUser", "generateLink", "generateLink"]);
  });

  it("recovery sin cuenta → not_found y NO crea usuario", async () => {
    const fake = new GotrueFake();
    expect(await fake.generateLink({ type: "recovery", email: "x@kine.test" })).toMatchObject({ ok: false, code: "not_found" });
    expect(fake.users.size).toBe(0);
    expect(fake.links).toHaveLength(0);
  });

  it("magiclink sin cuenta → GoTrue CREA el usuario sin confirmar y lo emite como signup", async () => {
    const fake = new GotrueFake();
    const r = await fake.generateLink({ type: "magiclink", email: "nuevo@kine.test" });
    expect(r).toMatchObject({ ok: true, data: { verificationType: "signup" } });
    const u = await fake.findUserByEmail("nuevo@kine.test");
    expect(u).toMatchObject({ ok: true, data: { emailConfirmedAt: null } });
    if (r.ok && u.ok) expect(r.data.userId).toBe(u.data?.id);
  });

  it("signup: sin cuenta exige password; sobre no confirmado re-emite; sobre confirmado → email_exists", async () => {
    const fake = new GotrueFake();
    expect(await fake.generateLink({ type: "signup", email: "s@kine.test" })).toMatchObject({ ok: false, code: "error" });
    expect(await fake.generateLink({ type: "signup", email: "s@kine.test", password: "s3creta-larga" })).toMatchObject({
      ok: true,
      data: { verificationType: "signup" },
    });
    expect(await fake.generateLink({ type: "signup", email: "s@kine.test" })).toMatchObject({ ok: true });
    const u = await fake.findUserByEmail("s@kine.test");
    if (!u.ok || !u.data) throw new Error("falta el usuario");
    await fake.updateUserById(u.data.id, { emailConfirm: true });
    expect(await fake.generateLink({ type: "signup", email: "s@kine.test" })).toMatchObject({
      ok: false,
      code: "email_exists",
    });
  });

  it("password corta → weak_password; ban y desban", async () => {
    const fake = new GotrueFake({ now: () => new Date("2026-10-14T12:00:00Z") });
    const c = await fake.createUser({ email: "b@kine.test", emailConfirm: true });
    if (!c.ok) throw new Error("alta");
    expect(await fake.updateUserById(c.data.id, { password: "123" })).toMatchObject({ ok: false, code: "weak_password" });
    expect(await fake.updateUserById(c.data.id, { banDuration: "24h" })).toMatchObject({
      ok: true,
      data: { bannedUntil: "2026-10-15T12:00:00.000Z" },
    });
    expect(await fake.updateUserById(c.data.id, { banDuration: "none" })).toMatchObject({ ok: true, data: { bannedUntil: null } });
  });
});
