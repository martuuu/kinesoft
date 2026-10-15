/**
 * BO3-E · lógica pura del visor de auditoría de Plataforma (`lib/platform-audit-logic.ts`).
 *
 * Lo crítico: del payload salen CLAVES y solo los valores de la allowlist (enums, booleanos, contadores). Un texto
 * libre, un mail o un dato clínico que algún call site meta en el payload no puede llegar al visor, que cruza
 * consultorios. También: el cursor es total (uno roto no tira) y el rango de fechas es del día AR, no del host.
 */
import { describe, it, expect } from "vitest";
import {
  auditDayRange,
  auditHref,
  decodeAuditCursor,
  encodeAuditCursor,
  normalizeAuditFilters,
  sanitizeAuditPayload,
} from "@/lib/platform-audit-logic";

/** Fixture con PHI y textos libres: ninguno de estos valores puede aparecer en el resultado. */
const PHI_PAYLOAD = {
  email: "paciente.secreto@test.local",
  label: "Dolor lumbar de Juana Pérez",
  name: "Juana Pérez",
  dni: "30111222",
  reason: "Pidió la baja por diagnóstico de cáncer",
  note: "nota interna",
  diagnosis: { text: "Hernia L4-L5" },
  plan: "Juana Pérez tiene plan PRO", // enum key con texto libre → no pasa ENUMISH
  status: "SUSPENDED",
  role: "OWNER",
  count: 3,
  self: true,
  changed: ["email", "fullName"],
  before: { plan: "FREE", email: "viejo@test.local" },
  after: { plan: "PRO", email: "nuevo@test.local" },
  platform: { actorHomeTenantId: "t-home" },
};

describe("[BO3-E] sanitizeAuditPayload", () => {
  it("lista claves; muestra solo valores de la allowlist y ningún valor sensible", () => {
    const out = sanitizeAuditPayload(PHI_PAYLOAD);
    const json = JSON.stringify(out);
    for (const secret of [
      "paciente.secreto",
      "Juana",
      "30111222",
      "cáncer",
      "nota interna",
      "Hernia",
      "viejo@test.local",
      "nuevo@test.local",
      "t-home",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const byKey = Object.fromEntries(out.map((e) => [e.key, e.value]));
    expect(byKey).toMatchObject({
      email: null,
      label: null,
      name: null,
      dni: null,
      reason: null,
      diagnosis: null,
      plan: null,
      status: "SUSPENDED",
      role: "OWNER",
      count: "3",
      self: "sí",
      changed: "email, fullName",
      "before.plan": "FREE",
      "before.email": null,
      "after.plan": "PRO",
      "after.email": null,
    });
    // El bloque interno del escritor no se lista.
    expect(out.some((e) => e.key.startsWith("platform"))).toBe(false);
  });

  it("es total: null, array, escalar → []; claves raras (con espacios o mails) se descartan", () => {
    expect(sanitizeAuditPayload(null)).toEqual([]);
    expect(sanitizeAuditPayload([1, 2])).toEqual([]);
    expect(sanitizeAuditPayload("texto")).toEqual([]);
    const out = sanitizeAuditPayload({ "juana@test.local": 1, "Juana Pérez": "x", ok: 1 });
    expect(out.map((e) => e.key)).toEqual(["ok"]);
  });

  it("contadores solo enteros; changed solo con identificadores", () => {
    const out = sanitizeAuditPayload({ count: 1.5, futureBookings: "3", changed: ["email", "dato con espacios"] });
    expect(out).toEqual([
      { key: "count", value: null },
      { key: "futureBookings", value: null },
      { key: "changed", value: null },
    ]);
  });
});

describe("[BO3-E] cursor (createdAt, id)", () => {
  it("ida y vuelta", () => {
    const d = new Date("2026-10-14T13:45:12.345Z");
    const c = encodeAuditCursor(d, "clx123abc");
    expect(decodeAuditCursor(c)).toEqual({ createdAt: d, id: "clx123abc" });
  });
  it("roto o editado a mano → null (no tira)", () => {
    expect(decodeAuditCursor("")).toBeNull();
    expect(decodeAuditCursor("no-es-base64-!!")).toBeNull();
    expect(decodeAuditCursor(Buffer.from("fecha-mala|id").toString("base64url"))).toBeNull();
    expect(decodeAuditCursor(Buffer.from("2026-10-14T00:00:00.000Z|id con espacios").toString("base64url"))).toBeNull();
    expect(decodeAuditCursor("x".repeat(500))).toBeNull();
  });
});

describe("[BO3-E] auditDayRange (día AR, UTC-3)", () => {
  it("desde = 03:00 UTC del día; hasta = 03:00 UTC del día siguiente (exclusivo)", () => {
    const r = auditDayRange("2026-10-01", "2026-10-14");
    expect(r.gte?.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(r.lt?.toISOString()).toBe("2026-10-15T03:00:00.000Z");
  });
  it("día inválido se ignora", () => {
    expect(auditDayRange("14/10/2026", undefined)).toEqual({ gte: undefined, lt: undefined });
  });
});

describe("[BO3-E] normalizeAuditFilters + auditHref", () => {
  it("descarta lo inválido y arma la URL sin claves vacías", () => {
    const f = normalizeAuditFilters({
      action: "platform.tenant",
      tenantId: "t1",
      actorEmail: "  super@test.local ",
      targetUserId: "u 1", // espacio → inválido
      from: "2026-10-01",
      to: "ayer",
      cursor: "",
    });
    expect(f).toEqual({
      action: "platform.tenant",
      tenantId: "t1",
      actorEmail: "super@test.local",
      targetUserId: undefined,
      from: "2026-10-01",
      to: undefined,
      cursor: undefined,
    });
    expect(auditHref(f)).toBe(
      "/plataforma/auditoria?action=platform.tenant&tenantId=t1&actorEmail=super%40test.local&from=2026-10-01"
    );
    expect(auditHref({})).toBe("/plataforma/auditoria");
    expect(auditHref({}, "abc")).toBe("/plataforma/auditoria?cursor=abc");
  });
});
