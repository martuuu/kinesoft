/**
 * T4 FC-2f · token de confirmación de la subida firmada (lib/patient-file-upload-token.ts, símbolo real; C-FC10,
 * FC-D29). Se mockea solo el ENV (la service key de la que se deriva la clave) y la cookie de `next/headers` (la
 * importa two-factor-cookie, que se usa para el cruce de etiquetas). Vencimiento en epoch puro: no depende del huso.
 */
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
const over = vi.hoisted(() => ({ key: "service-key-A" as string | undefined }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k === "SUPABASE_SERVICE_ROLE_KEY" ? over.key : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import { makePatientFileUploadToken, readPatientFileUploadToken } from "@/lib/patient-file-upload-token";
import { makePortalInviteToken } from "@/lib/portal-invite-token";
import { PATIENT_FILE_MAX_BYTES, PATIENT_FILE_UPLOAD_TTL_S } from "@/lib/files-types";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const BASE = {
  tenantId: "ten_11112222",
  patientId: "pat_7f9c2b1e3a4d",
  fileId: "0123456789abcdef01234567",
  mime: "application/pdf",
  sizeBytes: 20 * 1024 * 1024,
  category: "REPORT" as const,
  fileName: "Resonancia rodilla — Ñandú.pdf",
  userId: "user-ana",
};

function reMac(payload: string): string {
  const key = createHmac("sha256", "service-key-A").update("kinesoft:patient-file-upload:v1").digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

beforeEach(() => {
  over.key = "service-key-A";
});

describe("[FC-2f] token de subida firmada", () => {
  it("ida y vuelta con todos los claims y exp = emisión + 15 min", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    expect(t.length).toBeLessThanOrEqual(2048);
    expect(readPatientFileUploadToken(t, NOW + 60_000)).toEqual({
      ...BASE,
      exp: Math.floor(NOW / 1000) + PATIENT_FILE_UPLOAD_TTL_S,
    });
    expect(PATIENT_FILE_UPLOAD_TTL_S).toBe(900);
  });

  it("la clave es HMAC(service key, «kinesoft:patient-file-upload:v1»): re-firmar con esa etiqueta valida", () => {
    const [payload, mac] = makePatientFileUploadToken(BASE, NOW).split(".");
    expect(mac).toBe(reMac(payload));
  });

  it("vencido (exactamente en exp o después) → null", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    expect(readPatientFileUploadToken(t, NOW + PATIENT_FILE_UPLOAD_TTL_S * 1000)).toBeNull();
    expect(readPatientFileUploadToken(t, NOW + 16 * 60_000)).toBeNull();
  });

  it("adulterado: otro fileId/tenant/tamaño con la firma vieja → null", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    const [payload, mac] = t.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    for (const patch of [{ f: "ffffffffffffffffffffffff" }, { t: "ten_otro" }, { s: 1 }, { m: "text/html" }, { u: "user-b" }]) {
      const forged = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url");
      expect(readPatientFileUploadToken(`${forged}.${mac}`, NOW)).toBeNull();
    }
    expect(readPatientFileUploadToken(`${payload}.${mac.slice(0, -1)}A`, NOW)).toBeNull();
    expect(readPatientFileUploadToken(`${payload}.${mac}.x`, NOW)).toBeNull();
    expect(readPatientFileUploadToken("", NOW)).toBeNull();
    expect(readPatientFileUploadToken(null, NOW)).toBeNull();
    expect(readPatientFileUploadToken("a".repeat(2049), NOW)).toBeNull();
  });

  it("bien firmado pero con un exp más lejano que el TTL (no lo emitimos nunca) → null", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    const claims = JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8"));
    const payload = Buffer.from(JSON.stringify({ ...claims, x: claims.x + 3600 })).toString("base64url");
    expect(readPatientFileUploadToken(`${payload}.${reMac(payload)}`, NOW)).toBeNull();
  });

  it("bien firmado con un id que armaría otra ruta (`/`, `..`) → null", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    const claims = JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString("utf8"));
    for (const patch of [{ p: "../otro" }, { t: "a/b" }, { f: "../../x" }, { s: PATIENT_FILE_MAX_BYTES + 1 }, { c: "HACK" }]) {
      const payload = Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url");
      expect(readPatientFileUploadToken(`${payload}.${reMac(payload)}`, NOW)).toBeNull();
    }
  });

  it("otra service key → null (rotar la key invalida los tokens en vuelo)", () => {
    const t = makePatientFileUploadToken(BASE, NOW);
    over.key = "service-key-B";
    expect(readPatientFileUploadToken(t, NOW)).toBeNull();
  });

  it("un token de invitación al portal (otra etiqueta) no valida acá", () => {
    const invite = makePortalInviteToken({ patientId: BASE.patientId, tenantId: BASE.tenantId, email: "a@b.com" }, NOW);
    expect(readPatientFileUploadToken(invite, NOW)).toBeNull();
  });

  it("emitir con claims fuera de formato tira (error de programación, no se firma)", () => {
    expect(() => makePatientFileUploadToken({ ...BASE, fileId: "corto" }, NOW)).toThrow();
    expect(() => makePatientFileUploadToken({ ...BASE, sizeBytes: 0 }, NOW)).toThrow();
    expect(() => makePatientFileUploadToken({ ...BASE, tenantId: "a/b" }, NOW)).toThrow();
  });
});
