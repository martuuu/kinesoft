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
 *
 * PL-0 (M8 pl_accounts_billing) suma modelos a las tres categorías (el guard exige que cada uno exista en el
 * schema, así que el repo de juguete los declara con su RLS): GLOBAL_READONLY `SaasPlanConfig`; SERVICE_ONLY
 * `SaasPlanPriceChange` y las de 2FA (sin tenantId); TENANT_READONLY `SaasSubscription`/`SaasCharge`/`SaasPayment`.
 * TP-M (M18 turnero_cobros_mp) suma SERVICE_ONLY `MpCredential` (tokens sellados) y TENANT_READONLY `MpAccount`.
 * MIG (T6+T7, X0): M15 suma SERVICE_ONLY `WhatsAppCredential` y TENANT_READONLY `WhatsApp{Account,Template,Message,
 * Inbound}`; M16 suma TENANT_READONLY `SaasAdjustment`. `ReceptionDisplay` (M17) queda en la categoría por defecto.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/guard-tenant-isolation.mjs");

// MIG (M15/M16): modelos con tenantId del repo de juguete (su RLS va en M15/M16 de abajo).
const WA_M16_MODELS = [
  "WhatsAppAccount",
  "WhatsAppCredential",
  "WhatsAppTemplate",
  "WhatsAppMessage",
  "WhatsAppInbound",
  "SaasAdjustment",
];

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
model SaasPlanPriceChange {
  id String @id
}
model TwoFactorChallenge {
  id String @id
}
model TwoFactorRecoveryCode {
  id String @id
}
model UserSecurityEvent {
  id       String  @id
  tenantId String?
}
model SaasSubscription {
  tenantId String @id
}
model SaasCharge {
  id       String @id
  tenantId String
}
model SaasPayment {
  id       String @id
  tenantId String
}
model ProfessionalPublicProfile {
  id     String @id
  userId String @unique
}
model MpAccount {
  id       String @id
  tenantId String
}
model MpCredential {
  id       String @id
  tenantId String
}
${WA_M16_MODELS.map((m) => `model ${m} {\n  id       String @id\n  tenantId String\n}`).join("\n")}
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

// PL-0 (M8): SERVICE_ONLY sin policies y TENANT_READONLY con solo SELECT por tenant.
const M8_SERVICE_ONLY = ["SaasPlanPriceChange", "TwoFactorChallenge", "TwoFactorRecoveryCode", "UserSecurityEvent"];
const M8_TENANT_READONLY = ["SaasSubscription", "SaasCharge", "SaasPayment"];
const M8 = [
  ...M8_SERVICE_ONLY.map(
    (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`
  ),
  ...M8_TENANT_READONLY.map(
    (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;
CREATE POLICY "${m}_tenant_read" ON "${m}" FOR SELECT USING ("tenantId" = app_current_tenant_id());`
  ),
].join("\n");

// DIR-1 (M11 public_directory): perfil por persona, SERVICE_ONLY sin tenantId (como las tablas de 2FA de M8).
const M11 = `ALTER TABLE "ProfessionalPublicProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProfessionalPublicProfile" FORCE ROW LEVEL SECURITY;`;

// GLOBAL_READONLY (B-pre M-cat + PL-0 SaasPlanConfig) exige sus modelos: se declaran sin tenantId con su policy SELECT.
// FC-0 (M14): + DiagnosisCode (CIE-11 MMS, global, solo lectura para la app).
const CATALOG = ["Specialty", "Practice", "PracticeSpecialty", "Payer", "CatalogImportRun", "SaasPlanConfig", "DiagnosisCode"];
const CATALOG_SCHEMA = CATALOG.map((m) => `model ${m} {\n  id String @id\n}`).join("\n");
const CATALOG_SQL = CATALOG.map(
  (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;
CREATE POLICY "${m}_read" ON "${m}" FOR SELECT USING (true);`
).join("\n");

// TP-M (M18 turnero_cobros_mp): la cuenta de Mercado Pago la LEE el consultorio (TENANT_READONLY: la escriben solo el
// callback OAuth, desconectar, la delegación y el cron por el canal service) y los tokens sellados no los ve nadie más
// que el canal service (SERVICE_ONLY, cero policies).
const M18_SERVICE_ONLY = ["MpCredential"];
const M18_TENANT_READONLY = ["MpAccount"];
const M18 = [
  ...M18_SERVICE_ONLY.map(
    (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`
  ),
  ...M18_TENANT_READONLY.map(
    (m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;
CREATE POLICY "${m}_tenant_read" ON "${m}" FOR SELECT USING ("tenantId" = app_current_tenant_id());`
  ),
].join("\n");

// MIG (M15 whatsapp_messaging + M16 saas_mp_subscriptions): la cola, las plantillas, la cuenta y los entrantes de
// WhatsApp y los ajustes de la suscripción los LEE el consultorio y los escribe solo el canal service; el token de
// sistema y el PIN sellados no los ve nadie más que el canal service.
const M15_SERVICE_ONLY = ["WhatsAppCredential"];
const M15_TENANT_READONLY = ["WhatsAppAccount", "WhatsAppTemplate", "WhatsAppMessage", "WhatsAppInbound"];
const M16_TENANT_READONLY = ["SaasAdjustment"];
const readonlySql = (m: string) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;
CREATE POLICY "${m}_tenant_read" ON "${m}" FOR SELECT USING ("tenantId" = app_current_tenant_id());`;
const M15 = [
  ...M15_SERVICE_ONLY.map((m) => `ALTER TABLE "${m}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${m}" FORCE ROW LEVEL SECURITY;`),
  ...M15_TENANT_READONLY.map(readonlySql),
].join("\n");
const M16 = M16_TENANT_READONLY.map(readonlySql).join("\n");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function runGuard(p: {
  schemaExtra?: string;
  m7?: string;
  m18?: string;
  m15?: string;
  m16?: string;
  extraMigration?: string;
}) {
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
  mig("20261015180000_pl_accounts_billing", M8);
  mig("20261019120000_public_directory", M11);
  mig("20261022120000_turnero_cobros_mp", p.m18 ?? M18);
  mig("20261024120000_whatsapp_messaging", p.m15 ?? M15);
  mig("20261025120000_saas_mp_subscriptions", p.m16 ?? M16);
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
    expect(r.out).toContain("GLOBAL_READONLY (7): ENABLE + FORCE, SELECT-only policies");
    expect(r.out).toContain("SERVICE_ONLY (9): ENABLE + FORCE, zero policies. TENANT_READONLY (10)");
    expect(r.code).toBe(0);
  });

  it("[TP-M] MpAccount TENANT_READONLY y MpCredential SERVICE_ONLY en el guard", () => {
    const ok = runGuard({});
    expect(ok.out).toContain("SERVICE_ONLY (9): ENABLE + FORCE, zero policies. TENANT_READONLY (10)");
    expect(ok.code).toBe(0);
    // La app no escribe cuentas: una policy de escritura en MpAccount rompe el contrato.
    const w = runGuard({
      extraMigration: `CREATE POLICY "MpAccount_w" ON "MpAccount" FOR UPDATE USING ("tenantId" = app_current_tenant_id());`,
    });
    expect(w.code).toBe(1);
    expect(w.out).toMatch(/MpAccount: write policy "MpAccount_w" \(FOR UPDATE\)/);
    // Los tokens no los ve la app con ningún GUC: cualquier policy en MpCredential rompe el contrato.
    const r = runGuard({
      extraMigration: `CREATE POLICY "MpCredential_read" ON "MpCredential" FOR SELECT USING ("tenantId" = app_current_tenant_id());`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/MpCredential: policy "MpCredential_read" \(FOR SELECT\)/);
    // Sin FORCE, el owner de la tabla la leería salteando RLS.
    const f = runGuard({ m18: M18.replace(`ALTER TABLE "MpCredential" FORCE ROW LEVEL SECURITY;`, "") });
    expect(f.code).toBe(1);
    expect(f.out).toMatch(/MpCredential: RLS not FORCEd/);
  });

  it("[WA-M] WhatsApp{Account,Template,Message,Inbound} y SaasAdjustment TENANT_READONLY; WhatsAppCredential SERVICE_ONLY", () => {
    const ok = runGuard({});
    expect(ok.out).toContain("SERVICE_ONLY (9): ENABLE + FORCE, zero policies. TENANT_READONLY (10)");
    expect(ok.code).toBe(0);
    // La app no encola ni marca mensajes: una policy de escritura en la cola rompe el contrato.
    const w = runGuard({
      extraMigration: `CREATE POLICY "WhatsAppMessage_w" ON "WhatsAppMessage" FOR INSERT WITH CHECK ("tenantId" = app_current_tenant_id());`,
    });
    expect(w.code).toBe(1);
    expect(w.out).toMatch(/WhatsAppMessage: write policy "WhatsAppMessage_w" \(FOR INSERT\)/);
    // Ni los ajustes de la suscripción (la app no se acredita saldo a favor).
    const a = runGuard({
      extraMigration: `CREATE POLICY "SaasAdjustment_w" ON "SaasAdjustment" USING ("tenantId" = app_current_tenant_id());`,
    });
    expect(a.code).toBe(1);
    expect(a.out).toMatch(/SaasAdjustment: write policy "SaasAdjustment_w" \(FOR ALL\)/);
    // El token de sistema de Meta no lo ve la app con ningún GUC.
    const r = runGuard({
      extraMigration: `CREATE POLICY "WhatsAppCredential_read" ON "WhatsAppCredential" FOR SELECT USING ("tenantId" = app_current_tenant_id());`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/WhatsAppCredential: policy "WhatsAppCredential_read" \(FOR SELECT\)/);
    const f = runGuard({ m15: M15.replace(`ALTER TABLE "WhatsAppCredential" FORCE ROW LEVEL SECURITY;`, "") });
    expect(f.code).toBe(1);
    expect(f.out).toMatch(/WhatsAppCredential: RLS not FORCEd/);
  });

  it("[PL-0] falla si una tabla de cobro gana una policy de escritura (la app no puede marcar un pago)", () => {
    const r = runGuard({
      extraMigration: `CREATE POLICY "SaasPayment_w" ON "SaasPayment" FOR INSERT WITH CHECK ("tenantId" = app_current_tenant_id());`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SaasPayment: write policy "SaasPayment_w" \(FOR INSERT\)/);
  });

  it("[PL-0] falla si una tabla de 2FA gana una policy", () => {
    const r = runGuard({
      extraMigration: `CREATE POLICY "TwoFactorChallenge_read" ON "TwoFactorChallenge" FOR SELECT USING (true);`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/TwoFactorChallenge: policy "TwoFactorChallenge_read" \(FOR SELECT\)/);
  });

  it("[PL-0] falla si el catálogo de planes gana una policy de escritura", () => {
    const r = runGuard({
      extraMigration: `CREATE POLICY "SaasPlanConfig_w" ON "SaasPlanConfig" FOR UPDATE USING (true);`,
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/SaasPlanConfig: write policy "SaasPlanConfig_w" \(FOR UPDATE\)/);
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
