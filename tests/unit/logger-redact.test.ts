import { describe, it, expect, vi, afterEach } from "vitest";
import { redact, redactString, isSensitiveKey, REDACTED } from "@/lib/redact";

// [A3b-S-obs] Redacción de PII/secretos en logs y eventos de Sentry.

describe("redactString", () => {
  it("emails → [email]", () => {
    expect(redactString("no se pudo invitar a ana.perez+kine@gmail.com (dup)")).toBe(
      "no se pudo invitar a [email] (dup)",
    );
  });
  it("JWT y Bearer", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk_LMNOP";
    expect(redactString(`sesión ${jwt}`)).toBe("sesión [token]");
    expect(redactString("Authorization: Bearer abc.def-123")).toBe("Authorization: Bearer [token]");
  });
  it("token de Mercado Pago", () => {
    expect(redactString("mp token APP_USR-1234567890123456-092811-abcdef")).toBe("mp token [token]");
  });
  it("parámetros de query sensibles, sin tocar el resto de la URL", () => {
    expect(redactString("https://app.kinesoft.com.ar/invite?token=abc123&next=/agenda")).toBe(
      "https://app.kinesoft.com.ar/invite?token=[redacted]&next=/agenda",
    );
    expect(redactString("/auth/callback?code=xyz&state=1")).toBe("/auth/callback?code=[redacted]&state=1");
  });
  it("[IAM-0b] token_hash de los links de mail (/auth/confirm), sin tocar type ni next", () => {
    expect(redactString("https://app.kinesoft.com.ar/auth/confirm?token_hash=pkce_abc123&type=invite&next=/agenda")).toBe(
      "https://app.kinesoft.com.ar/auth/confirm?token_hash=[redacted]&type=invite&next=/agenda",
    );
    expect(redactString("/auth/confirm?type=recovery&token_hash=xyz")).toBe("/auth/confirm?type=recovery&token_hash=[redacted]");
  });
  it("DNI con puntos o precedido de 'DNI'", () => {
    expect(redactString("paciente 30.123.456 duplicado")).toBe("paciente [dni] duplicado");
    expect(redactString("DNI: 30123456 ya existe")).toBe("DNI [redacted] ya existe");
  });
  it("NO toca ids, montos ni fechas", () => {
    const s = "booking ckx1a2b3c4d5e6f7g8h9 monto 1500000 cents el 2026-09-30T13:00:00.000Z";
    expect(redactString(s)).toBe(s);
  });
});

describe("isSensitiveKey", () => {
  it.each(["password", "newPassword", "access_token", "refreshToken", "Authorization", "cookie", "Set-Cookie", "x-api-key", "documentId", "dni", "phone", "clientSecret"])(
    "%s es sensible",
    (k) => expect(isSensitiveKey(k)).toBe(true),
  );
  it.each(["tenantId", "userId", "idempotencyKey", "email", "amountCents", "kind"])("%s no es sensible", (k) =>
    expect(isSensitiveKey(k)).toBe(false),
  );
});

describe("redact (objetos anidados)", () => {
  it("redacta por clave y por valor a cualquier profundidad, sin mutar la entrada", () => {
    const input = {
      tenantId: "t1",
      email: "pro@kine.com",
      request: {
        headers: { authorization: "Bearer x", cookie: "sb-access-token=abc", "user-agent": "UA" },
        url: "/invite?token=secret1",
      },
      list: [{ password: "hunter2" }, "mail a otro@x.com"],
      patient: { documentId: "30123456", firstName: "Ana" },
    };
    const copy = JSON.parse(JSON.stringify(input));
    const out = redact(input);
    expect(out).toEqual({
      tenantId: "t1",
      email: "[email]",
      request: {
        headers: { authorization: REDACTED, cookie: REDACTED, "user-agent": "UA" },
        url: "/invite?token=[redacted]",
      },
      list: [{ password: REDACTED }, "mail a [email]"],
      patient: { documentId: REDACTED, firstName: "Ana" },
    });
    expect(input).toEqual(copy);
  });
  it("aplana Errors y tolera ciclos", () => {
    const a: Record<string, unknown> = { err: new Error("falló para x@y.com") };
    a.self = a;
    const out = redact(a) as { err: { name: string; message: string }; self: unknown };
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe("falló para [email]");
    expect(out.self).toBe("[circular]");
  });
  it("deja null/undefined/numbers/booleans y claves sensibles vacías como están", () => {
    expect(redact({ n: 1, b: true, z: null, token: null, password: "" })).toEqual({
      n: 1,
      b: true,
      z: null,
      token: null,
      password: "",
    });
  });
});

describe("logger — cada línea sale redactada", () => {
  afterEach(() => vi.restoreAllMocks());

  it("msg + ctx pasan por redact antes de stdout", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { logger } = await import("@/lib/logger");
    logger.error("invite a ana@kine.com falló", {
      token: "abc",
      nested: { headers: { cookie: "sb=1" }, to: "b@c.com" },
    });
    const line = writes.join("");
    expect(line).toContain("invite a [email] falló");
    expect(line).not.toContain("ana@kine.com");
    expect(line).not.toContain("b@c.com");
    expect(line).not.toContain("sb=1");
    expect(line).not.toMatch(/"token":"abc"/);
    expect(line).toContain(`"token":"${REDACTED}"`);
  });
});
