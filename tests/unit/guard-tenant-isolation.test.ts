/**
 * BO0 (M7 platform_backoffice): el guard de aislamiento (`scripts/guard-tenant-isolation.mjs`) suma las
 * categorías SERVICE_ONLY (ENABLE + FORCE, cero policies) y TENANT_READONLY (solo policy SELECT por tenant).
 *
 * Se corre el script REAL (node, como `npm run guard:isolation`) contra un repo de juguete en un tmpdir
 * (`GUARD_ISOLATION_ROOT`): schema.prisma con los modelos y una cadena de migraciones mínima que incluye el
 * REVOKE guardado de M2 (si falta, el guard falla por otra razón). Cada caso cambia UNA cosa y afirma el
 * exit code y el motivo. El primer caso es el control: con el repo de juguete «sano», pasa.
 *
 * Lo que tiene que seguir siendo cierto (contrato de la sesión BO0):
 *   · acepta PlatformAuditEvent/TenantSlugAlias sin policies y SupportSession con solo SELECT;
 *   · sigue fallando ante una tabla con tenantId SIN policy que no esté en ninguna categoría;
 *   · falla si una SERVICE_ONLY gana una policy o pierde FORCE, o si la TENANT_READONLY gana una de escritura.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/guard-tenant-isolation.mjs");

const SCHEMA = (extra = "") => `
model Tenant {
  id String @id
}
model Patient {
  id       String @id
  tenantId String
}
model PlatformAuditEvent {
  id       String  @id
  tenantId String?
}
model TenantSlugAlias {
  slug     String @id
  tenantId String
}
model SupportSession {
  id       String @id
  tenantId String
}
${extra}
`;

// El bloque de M2 que el chequeo 3c exige encontrar en la cadena.
const M2_REVOKE = `
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM %I', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
  END LOOP;
END $$;
`;

const BASE = `
ALTER TABLE "Patient" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Patient" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Patient_tenant_isolation" ON "Patient" USING ("tenantId" = app_current_tenant_id());
`;

const M7 = `
ALTER TABLE "PlatformAuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAuditEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE "TenantSlugAlias" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSlugAlias" FORCE ROW LEVEL SECURITY;
ALTER TABLE "SupportSession" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportSession" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupportSession_tenant_read" ON "SupportSession"
  FOR SELECT USING ("tenantId" = app_current_tenant_id());
`;

// GLOBAL_READONLY (B-pre M-cat) exige sus 5 modelos: se declaran sin tenantId con su policy SELECT.
const CATALOG = ["Specialty", "Practice", "PracticeSpecialty", "Payer", "CatalogImportRun"];
const CATALOG_SCHEMA = CATALOG.map((m) => `model ${m} {\n  id String @id\n}`).join("\n");
const CATALOG_SQL = CATALOG.map(
  (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;
CREATE POLICY "${m}_read" ON "${m}" FOR SELECT USING (true);`
).join("\n");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function runGuard(p: { schemaExtra?: string; m7?: string; extraMigration?: string }) {
  const root = mkdtempSync(join(tmpdir(), "guard-iso-"));
  dirs.push(root);
  mkdirSync(join(root, "lib"));
  mkdirSync(join(root, "app"));
  mkdirSync(join(root, "prisma/migrations"), { recursive: true });
  writeFileSync(join(root, "prisma/schema.prisma"), SCHEMA(`${CATALOG_SCHEMA}\n${p.schemaExtra ?? ""}`));
  const mig = (name: string, sql: string) => {
    mkdirSync(join(root, "prisma/migrations", name));
    writeFileSync(join(root, "prisma/migrations", name, "migration.sql"), sql);
  };
  mig("20260101000000_base", BASE + CATALOG_SQL + M2_REVOKE);
  mig("20261015120000_platform_backoffice", p.m7 ?? M7);
  if (p.extraMigration) mig("20261016000000_extra", p.extraMigration);
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, GUARD_ISOLATION_ROOT: root, NO_COLOR: "1" },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe("guard de aislamiento · SERVICE_ONLY / TENANT_READONLY (BO0)", () => {
  it("control: el repo de juguete con M7 tal cual pasa", () => {
    const r = runGuard({});
    expect(r.out).toContain("SERVICE_ONLY (2): ENABLE + FORCE, zero policies");
    expect(r.code).toBe(0);
  });

  it("sigue fallando ante una tabla con tenantId SIN policy que no está en ninguna categoría", () => {
    const r = runGuard({ schemaExtra: "model Olvido {\n  id String @id\n  tenantId String\n}" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/carry tenantId but have NO RLS policy[\s\S]*Olvido/);
  });

  it("falla si una SERVICE_ONLY gana una policy", () => {
    const r = runGuard({
      extraMigration: `CREATE POLICY "TenantSlugAlias_read" ON "TenantSlugAlias" FOR SELECT USING (true);`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TenantSlugAlias: policy "TenantSlugAlias_read" \(FOR SELECT\)/);
  });

  it("falla si una SERVICE_ONLY no tiene FORCE", () => {
    const r = runGuard({ m7: M7.replace(`ALTER TABLE "PlatformAuditEvent" FORCE ROW LEVEL SECURITY;`, "") });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/PlatformAuditEvent: RLS not FORCEd/);
  });

  it("falla si la TENANT_READONLY gana una policy de escritura", () => {
    const r = runGuard({
      extraMigration: `CREATE POLICY "SupportSession_w" ON "SupportSession" FOR INSERT WITH CHECK ("tenantId" = app_current_tenant_id());`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SupportSession: write policy "SupportSession_w" \(FOR INSERT\)/);
  });

  it("falla si la policy SELECT de la TENANT_READONLY no filtra por tenant", () => {
    const r = runGuard({
      m7: M7.replace(`FOR SELECT USING ("tenantId" = app_current_tenant_id())`, "FOR SELECT USING (true)"),
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SupportSession: no FOR SELECT policy on "tenantId" = app_current_tenant_id\(\)/);
  });
});
