import { describe, it, expect } from "vitest";
import { describeConnection, redactedSummary } from "@/scripts/lib/db-url";

// OPS-1b: lo que `scripts/diagnose-db.ts` deduce de cada URL (sin conectarse) y que nunca imprime la contraseña.
const REF = "abcdefghijklmnopqrst";
const TX = `postgresql://kinesoft_app.${REF}:s3cr3t@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=3`;
const SESSION = `postgresql://postgres.${REF}:s3cr3t@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;
const DIRECT = `postgresql://postgres:s3cr3t@db.${REF}.supabase.co:5432/postgres`;

describe("[OPS-1b] describeConnection", () => {
  it("6543 con pgbouncer y connection_limit: modo transacción, sin avisos, ref del usuario", () => {
    const d = describeConnection("DATABASE_URL", TX);
    expect(d).toMatchObject({ mode: "transaction-pooler", user: `kinesoft_app.${REF}`, port: 6543, connectionLimit: 3 });
    expect(d.projectRef).toBe(REF);
    expect(d.warnings).toEqual([]);
  });
  it("6543 sin pgbouncer=true ni connection_limit: dos avisos", () => {
    const d = describeConnection("DATABASE_URL", TX.split("?")[0]!);
    expect(d.warnings.join(" | ")).toMatch(/pgbouncer=true/);
    expect(d.warnings.join(" | ")).toMatch(/connection_limit/);
  });
  it("pooler de Supabase en 5432 = sesión; DIRECT_URL ahí está bien", () => {
    const d = describeConnection("DIRECT_URL", SESSION);
    expect(d.mode).toBe("session-pooler");
    expect(d.warnings).toEqual([]);
  });
  it("DIRECT_URL en el 6543 avisa que migrate deploy necesita sesión", () => {
    expect(describeConnection("DIRECT_URL", TX).warnings.join(" ")).toMatch(/migrate deploy/);
  });
  it("db.<ref>.supabase.co = directa; como DATABASE_URL avisa que conviene el pooler", () => {
    const d = describeConnection("DATABASE_URL", DIRECT);
    expect(d).toMatchObject({ mode: "direct", projectRef: REF });
    expect(d.warnings.join(" ")).toMatch(/6543/);
  });
  it("local: 5433 directa, 6433 (pgbouncer del perfil pooler) transacción", () => {
    expect(describeConnection("DATABASE_URL", "postgresql://kinesoft_app:x@localhost:5433/kinesoft").mode).toBe("direct");
    expect(
      describeConnection("DATABASE_URL", "postgresql://kinesoft_app:x@127.0.0.1:6433/kinesoft?pgbouncer=true&connection_limit=3")
        .mode
    ).toBe("transaction-pooler");
  });
  it("el resumen nunca lleva la contraseña ni el esquema de la URL", () => {
    for (const url of [TX, SESSION, DIRECT]) {
      const s = redactedSummary(describeConnection("DATABASE_URL", url));
      expect(s).not.toMatch(/s3cr3t|postgresql:\/\//);
    }
  });
});
