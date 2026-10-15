/**
 * [PL-A] `serializeError` / `reportError` (lib/error-report.ts). Se espía la salida real del logger (stdout), no la
 * función bajo test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { reportError, serializeError, STACK_FRAMES } from "@/lib/error-report";

afterEach(() => vi.restoreAllMocks());

describe("[PL-A] serializeError", () => {
  it("Error común: name, message y como mucho 8 frames", () => {
    const e = new TypeError("boom");
    const s = serializeError(e);
    expect(s.name).toBe("TypeError");
    expect(s.message).toBe("boom");
    expect(s.stack!.length).toBeGreaterThan(0);
    expect(s.stack!.length).toBeLessThanOrEqual(STACK_FRAMES);
    expect(s.stack!.every((l) => l.startsWith("at "))).toBe(true);
  });

  it("Prisma: code y meta.code", () => {
    const e = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5",
      meta: { code: "23505", target: ["x"] },
    });
    expect(serializeError(e)).toMatchObject({ code: "P2002", metaCode: "23505", message: "Unique constraint failed" });
  });

  it("digest de Next y valores que no son Error", () => {
    const e = Object.assign(new Error("redacted"), { digest: "123" });
    expect(serializeError(e).digest).toBe("123");
    expect(serializeError("texto")).toEqual({ name: "NonError", message: "texto" });
    expect(serializeError({ message: "obj", code: 42 })).toEqual({ name: "NonError", message: "obj", code: "42" });
  });
});

describe("[PL-A] reportError", () => {
  it("sale por el logger con el evento, el ctx y el error serializado (redactado)", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    reportError("x.failed", new Error("falló para ana@example.com"), { fileId: "f1" });
    const line = write.mock.calls.map((c) => String(c[0])).join("");
    expect(line).toContain("x.failed");
    expect(line).toContain("f1");
    expect(line).not.toContain("ana@example.com");
  });

  it("nunca tira, aunque el error no se pueda serializar", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => reportError("y.failed", circular)).not.toThrow();
  });
});
