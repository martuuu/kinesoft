/**
 * HD-17: `tests/helpers/query-counter.ts` arma su propio `prismaService` con la misma cadena que `lib/db.ts`
 * (`DATABASE_URL_SERVICE` → `DIRECT_URL` → `DATABASE_URL`). Si un `DATABASE_URL_SERVICE` remoto quedaba exportado en la
 * shell (el `dotenv -e .env.local` de los scripts no lo pisa si `.env.local` no la trae), los tests de integración que
 * cuentan statements escribían con BYPASSRLS en esa base. Falla cerrado: solo localhost.
 *
 * Valores MARCADOS: el error nunca lleva la URL (trae la contraseña).
 */
import { describe, expect, it } from "vitest";
import { serviceDbUrlForCounter } from "@/tests/helpers/query-counter";

const LOCAL = "postgresql://kinesoft:local@localhost:5433/kinesoft";
const REMOTE = "postgresql://kinesoft_service.prodmarcado:CLAVE-MARCADA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";

describe("[HD-17] query-counter · la URL de servicio tiene que ser local", () => {
  it("[HD-17] DATABASE_URL_SERVICE remota → tira, sin la URL en el mensaje", () => {
    let msg = "";
    try {
      serviceDbUrlForCounter({ DATABASE_URL_SERVICE: REMOTE, DIRECT_URL: LOCAL, DATABASE_URL: LOCAL });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/DATABASE_URL_SERVICE/);
    expect(msg).not.toMatch(/CLAVE-MARCADA|pooler\.supabase\.com|prodmarcado/);
  });

  it("[HD-17] el fallback también se mira: sin la de servicio, una DIRECT_URL remota tira", () => {
    expect(() => serviceDbUrlForCounter({ DIRECT_URL: REMOTE, DATABASE_URL: LOCAL })).toThrow(/DIRECT_URL/);
  });

  it("[HD-17] URL que no parsea o ausente → tira (no se puede verificar)", () => {
    expect(() => serviceDbUrlForCounter({ DATABASE_URL_SERVICE: "no es url" })).toThrow(/DATABASE_URL_SERVICE/);
    expect(() => serviceDbUrlForCounter({})).toThrow();
  });

  it("[HD-17] localhost / 127.0.0.1 pasan y gana la primera definida", () => {
    expect(serviceDbUrlForCounter({ DATABASE_URL_SERVICE: LOCAL, DIRECT_URL: REMOTE })).toBe(LOCAL);
    const v4 = "postgresql://kinesoft:local@127.0.0.1:5433/kinesoft";
    expect(serviceDbUrlForCounter({ DIRECT_URL: v4, DATABASE_URL: REMOTE })).toBe(v4);
    expect(serviceDbUrlForCounter({ DATABASE_URL: LOCAL })).toBe(LOCAL);
  });
});
