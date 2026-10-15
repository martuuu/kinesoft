/**
 * [BO5-C] Lógica pura del export completo del consultorio (lib/tenant-export-logic.ts). Corre en TZ=UTC y TZ=AR
 * (`npm test` y `npm run test:tz-ar`): el nombre del archivo lleva la fecha AR aunque el host esté en UTC.
 */
import { tenantExportRequestEmail } from "@/lib/email/templates";
import { describe, it, expect } from "vitest";
import {
  EXPORT_ENTITIES,
  EXPORT_FIELDS,
  EXPORT_FORBIDDEN_FIELDS,
  TENANT_EXPORT_RATE_LIMIT,
  auditSince,
  chooseExportTenant,
  exportChunks,
  exportFilename,
  selectOf,
  serializeRow,
  type ExportMembership,
  type TenantExportManifest,
} from "@/lib/tenant-export-logic";

const D = new Date("2026-01-01T00:00:00Z");
const m = (tenantId: string, role: ExportMembership["role"], extra: Partial<ExportMembership> = {}): ExportMembership => ({
  tenantId,
  role,
  acceptedAt: D,
  disabledAt: null,
  ...extra,
});

describe("[BO5-C] chooseExportTenant: solo el OWNER, también con el consultorio bloqueado", () => {
  it("OWNER del consultorio activo → ese", () => {
    expect(chooseExportTenant({ memberships: [m("A", "OWNER")], userDisabled: false, activeTenantId: "A", requestedTenantId: null })).toEqual({ ok: true, tenantId: "A" });
  });

  it("ADMIN (y cualquier otro rol) del consultorio activo → 403", () => {
    for (const role of ["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"] as const) {
      expect(chooseExportTenant({ memberships: [m("A", role)], userDisabled: false, activeTenantId: "A", requestedTenantId: null })).toEqual({ ok: false, status: 403, reason: "not_owner" });
    }
  });

  it("sin Actor (consultorio suspendido/de baja) y OWNER de uno solo → ese (BO-D4)", () => {
    expect(chooseExportTenant({ memberships: [m("S", "OWNER"), m("X", "ADMIN")], userDisabled: false, activeTenantId: null, requestedTenantId: null })).toEqual({ ok: true, tenantId: "S" });
  });

  it("sin Actor y OWNER de varios → 400 (que elija con ?tenant=)", () => {
    expect(chooseExportTenant({ memberships: [m("S", "OWNER"), m("T", "OWNER")], userDisabled: false, activeTenantId: null, requestedTenantId: null })).toEqual({ ok: false, status: 400, reason: "choose_tenant" });
  });

  it("?tenant= de un consultorio donde NO es OWNER → 403 aunque sea OWNER del activo (no cae a otro)", () => {
    expect(chooseExportTenant({ memberships: [m("A", "OWNER"), m("B", "ADMIN")], userDisabled: false, activeTenantId: "A", requestedTenantId: "B" })).toEqual({ ok: false, status: 403, reason: "not_owner" });
    expect(chooseExportTenant({ memberships: [m("A", "OWNER")], userDisabled: false, activeTenantId: "A", requestedTenantId: "ajeno" })).toEqual({ ok: false, status: 403, reason: "not_owner" });
  });

  it("?tenant= de otro consultorio donde SÍ es OWNER → ese", () => {
    expect(chooseExportTenant({ memberships: [m("A", "ADMIN"), m("B", "OWNER")], userDisabled: false, activeTenantId: "A", requestedTenantId: "B" })).toEqual({ ok: true, tenantId: "B" });
  });

  it("membresía OWNER no aceptada o deshabilitada no cuenta; usuario deshabilitado → 403", () => {
    expect(chooseExportTenant({ memberships: [m("A", "OWNER", { acceptedAt: null })], userDisabled: false, activeTenantId: null, requestedTenantId: null }).ok).toBe(false);
    expect(chooseExportTenant({ memberships: [m("A", "OWNER", { disabledAt: D })], userDisabled: false, activeTenantId: null, requestedTenantId: "A" }).ok).toBe(false);
    expect(chooseExportTenant({ memberships: [m("A", "OWNER")], userDisabled: true, activeTenantId: "A", requestedTenantId: null })).toEqual({ ok: false, status: 403, reason: "user_disabled" });
  });
});

describe("[BO5-C] allowlist de columnas", () => {
  it("ninguna entidad exporta secretos ni ids de Auth (token, idempotencyKey, rawPayload, storageKey, userId, ip…)", () => {
    for (const e of EXPORT_ENTITIES) {
      for (const f of EXPORT_FORBIDDEN_FIELDS) {
        expect(EXPORT_FIELDS[e] as readonly string[], `${e}.${f}`).not.toContain(f);
      }
    }
  });

  it("`userId` (id de Auth) solo en el equipo (para atribuir el audit); nunca en pacientes ni profesionales", () => {
    for (const e of EXPORT_ENTITIES) {
      if (e !== "team") expect(EXPORT_FIELDS[e] as readonly string[], e).not.toContain("userId");
    }
    expect(EXPORT_FIELDS.team).toContain("userId");
  });

  it("todas llevan `id` (el cursor de la paginación) y `selectOf` arma el select de Prisma", () => {
    for (const e of EXPORT_ENTITIES) expect(EXPORT_FIELDS[e] as readonly string[], e).toContain("id");
    expect(selectOf("emergencyContacts")).toEqual({ id: true, patientId: true, name: true, relation: true, phone: true });
  });

  it("entidades del contrato presentes; Invitation/EmailLog/PatientTenantLink afuera", () => {
    for (const e of ["tenant", "locations", "rooms", "services", "insurers", "practitioners", "patients", "coverages", "emergencyContacts", "bookings", "payments", "treatmentPrograms", "sessions", "sessionExercises", "clinicalCases", "diagnoses", "evaScores", "patientFiles", "auditEvents"]) {
      expect(EXPORT_ENTITIES).toContain(e);
    }
    for (const e of ["invitations", "emailLogs", "patientTenantLinks", "notifications"]) expect(EXPORT_ENTITIES).not.toContain(e);
  });

  it("rate limit: 3 por hora", () => {
    expect(TENANT_EXPORT_RATE_LIMIT).toEqual({ limit: 3, windowMs: 3_600_000 });
  });
});

describe("[BO5-C] archivo", () => {
  it("nombre con la fecha AR (23:30 AR del 13 = 02:30 UTC del 14 → 13)", () => {
    expect(exportFilename("mi-consultorio", new Date("2026-10-14T02:30:00Z"))).toBe("kinesoft-mi-consultorio-2026-10-13.json");
    expect(exportFilename("mi-consultorio", new Date("2026-10-14T03:00:00Z"))).toBe("kinesoft-mi-consultorio-2026-10-14.json");
  });

  it("el slug se limpia (va a un header Content-Disposition)", () => {
    expect(exportFilename('a"b\r\nc/../d', new Date("2026-10-14T15:00:00Z"))).toBe("kinesoft-abcd-2026-10-14.json");
    expect(exportFilename("", new Date("2026-10-14T15:00:00Z"))).toBe("kinesoft-consultorio-2026-10-14.json");
  });

  it("los pedazos arman un JSON válido con manifest al final; las fechas salen ISO UTC", () => {
    const manifest = { version: 1, counts: { tenant: 1, locations: 0 } } as unknown as TenantExportManifest;
    const json =
      exportChunks.open() +
      exportChunks.entityOpen("tenant", true) +
      exportChunks.row({ id: "t1", name: '=HYPERLINK("x")', at: new Date("2026-10-14T03:00:00Z") }, true) +
      exportChunks.entityClose() +
      exportChunks.entityOpen("locations", false) +
      exportChunks.entityClose() +
      exportChunks.close(manifest);
    const parsed = JSON.parse(json);
    expect(parsed.data.tenant).toEqual([{ id: "t1", name: '=HYPERLINK("x")', at: "2026-10-14T03:00:00.000Z" }]);
    expect(parsed.data.locations).toEqual([]);
    expect(parsed.manifest.counts.tenant).toBe(1);
    // Un archivo cortado antes del manifest no parsea (no puede pasar por completo).
    expect(() => JSON.parse(json.slice(0, json.indexOf(',"manifest"')))).toThrow();
  });

  it("serializeRow: Json anidado tal cual, bigint como string", () => {
    expect(serializeRow({ a: { b: [1, "x"] }, n: BigInt(5) })).toBe('{"a":{"b":[1,"x"]},"n":"5"}');
  });

  it("auditSince: 12 meses atrás", () => {
    expect(auditSince(new Date("2026-10-14T12:00:00Z")).toISOString()).toBe("2025-10-14T12:00:00.000Z");
  });
});

describe("[BO5-C] mail «descargá tu export»", () => {
  it("escapa el nombre del consultorio, link http(s) y nada de PHI", () => {
    const mail = tenantExportRequestEmail({ tenantName: 'Kine <a href="x">Hacé clic</a>\nBcc: x', url: "https://app.kinesoft.ar/configuracion?tab=exportar" });
    expect(mail.subject).not.toMatch(/[<>\n]/);
    expect(mail.html).not.toContain('<a href="x">');
    expect(mail.html).toContain("https://app.kinesoft.ar/configuracion?tab=exportar");
    expect(mail.text).toContain("Configuración → Exportar datos");
    const bad = tenantExportRequestEmail({ tenantName: "K", url: "javascript:alert(1)" });
    expect(bad.html).not.toContain("javascript:");
  });
});
