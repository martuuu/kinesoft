/**
 * OPS-1b · diagnóstico de SOLO LECTURA de las conexiones a la base (plan §21.3, verificación de OPS-3).
 *
 * Por qué: OPS-3 cambia a mano en Vercel las tres URLs de prod (kinesoft_app sobre el pooler de transacción,
 * kinesoft_service, DIRECT_URL al pooler de sesión) y «volver atrás = cambiar la variable». Hace falta una forma de
 * ver, sin abrir la app ni leer secretos, con qué rol entra cada URL, si ese rol saltea RLS y por qué modo de pool va.
 *
 * Qué hace, por cada una de DATABASE_URL, DIRECT_URL y DATABASE_URL_SERVICE que esté seteada:
 *   - deduce el modo de la URL (`scripts/lib/db-url.ts`) y avisa los errores típicos;
 *   - se conecta y corre SOLO SELECTs: rol actual, `rolbypassrls`/`rolsuper`, `transaction_read_only`,
 *     `default_transaction_read_only`, puerto del server (si difiere del de la URL hay un pooler en el medio) y versión.
 * No escribe, no cambia GUCs de sesión (en modo transacción quedarían en el backend de otro) y nunca imprime la URL
 * completa ni la contraseña: usuario@host:puerto/base y flags.
 *
 * Uso:
 *   npm run diagnose:db                                          (local, .env.local)
 *   npx dotenv -e .env.prod.local -- npx tsx scripts/diagnose-db.ts   (otro entorno: lo corre Martin)
 * Sale con 1 si alguna URL no conecta.
 */
import { describeConnection, redactedSummary, type DbUrlKey } from "./lib/db-url";

const KEYS: DbUrlKey[] = ["DATABASE_URL", "DIRECT_URL", "DATABASE_URL_SERVICE"];

// Se copian ANTES de cargar `@prisma/client`: el cliente generado lee `.env` al importarse y completa en
// `process.env` las claves que falten, y `.env` puede apuntar a PRODUCCIÓN (AGENTS.md §4). Con `dotenv -e .env.local`
// sin DATABASE_URL_SERVICE, el import la habría traído de `.env` y el script se conectaba a prod «de rebote».
const TARGETS = new Map(KEYS.map((k) => [k, process.env[k]?.trim() || undefined] as const));

type Row = {
  current_user: string;
  session_user: string;
  bypassrls: boolean | null;
  superuser: boolean | null;
  tro: string;
  dtro: string;
  server_port: number | null;
  db: string;
  version: string;
};

async function inspect(key: DbUrlKey, url: string): Promise<boolean> {
  let d;
  try {
    d = describeConnection(key, url);
  } catch {
    console.log(`\n${key}: no es una URL válida (no se muestra)`);
    return false;
  }
  console.log(`\n${key}: ${redactedSummary(d)}`);
  console.log(`  modo por la URL: ${d.mode}`);
  for (const w of d.warnings) console.log(`  AVISO: ${w}`);

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const [r] = await db.$queryRaw<Row[]>`
      SELECT current_user::text AS current_user,
             session_user::text AS session_user,
             r.rolbypassrls AS bypassrls,
             r.rolsuper AS superuser,
             current_setting('transaction_read_only') AS tro,
             current_setting('default_transaction_read_only') AS dtro,
             inet_server_port() AS server_port,
             current_database()::text AS db,
             split_part(version(), ' ', 2) AS version
      FROM pg_roles r WHERE r.rolname = current_user`;
    if (!r) {
      console.log("  conectó, pero el rol actual no aparece en pg_roles");
      return true;
    }
    const rls = r.superuser || r.bypassrls ? "SALTEA RLS (owner/BYPASSRLS)" : "RLS aplicada";
    console.log(`  rol: ${r.current_user}${r.session_user !== r.current_user ? ` (sesión ${r.session_user})` : ""} → ${rls}`);
    console.log(`  transaction_read_only=${r.tro} default_transaction_read_only=${r.dtro}`);
    const pooled = r.server_port !== null && r.server_port !== d.port;
    console.log(
      `  server: Postgres ${r.version}, base ${r.db}, puerto ${r.server_port ?? "?"}` +
        (pooled ? ` ≠ ${d.port} de la URL → ${d.isLocal ? "pooler o mapeo de puertos de Docker" : "hay un pooler en el medio"}` : "")
    );
    if (d.mode === "transaction-pooler" && !pooled && r.server_port !== null && !d.isLocal) {
      console.log("  AVISO: la URL parece de pooler pero el puerto del server coincide: ¿es directa?");
    }
    if (key === "DATABASE_URL" && (r.superuser || r.bypassrls)) {
      console.log("  nota: la app entra con un rol que saltea RLS; el `where: { tenantId }` es la única barrera (OPS-3 lo cambia)");
    }
    return true;
  } catch (err) {
    const code = (err as { errorCode?: string; code?: string }).errorCode ?? (err as { code?: string }).code ?? "?";
    console.log(`  NO CONECTA (Prisma ${code})`);
    return false;
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

async function main() {
  console.log("diagnose-db · solo lectura");
  let ok = true;
  let seen = 0;
  for (const key of KEYS) {
    const url = TARGETS.get(key);
    if (!url) {
      console.log(`\n${key}: no seteada`);
      continue;
    }
    seen += 1;
    ok = (await inspect(key, url)) && ok;
  }
  if (!seen) {
    console.log("\nNinguna URL seteada. Corré con `npm run diagnose:db` o `npx dotenv -e <archivo> -- npx tsx scripts/diagnose-db.ts`.");
    process.exit(1);
  }
  process.exit(ok ? 0 : 1);
}

void main();
