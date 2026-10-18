/**
 * OPS-1b · lectura de una URL de base SIN exponerla, para `scripts/diagnose-db.ts` (lógica pura, con unit test).
 *
 * Por qué: OPS-3 (plan §21.3) cambia las tres URLs de prod a mano en Vercel (`DATABASE_URL` → kinesoft_app sobre el
 * pooler de transacción 6543, `DIRECT_URL` → pooler de SESIÓN 5432, `DATABASE_URL_SERVICE` → kinesoft_service). Los
 * errores típicos no se ven hasta que algo falla en runtime: 6543 sin `pgbouncer=true` (Prisma choca con prepared
 * statements), `DIRECT_URL` en modo transacción (`migrate deploy` necesita sesión), sin `connection_limit` (cada
 * lambda abre su pool entero). Esto los nombra antes, y nunca devuelve la contraseña ni la URL completa.
 */
import { describeTarget } from "./assert-safe-target";

export type DbUrlKey = "DATABASE_URL" | "DIRECT_URL" | "DATABASE_URL_SERVICE";

/** Modo que se deduce de la URL. El pooler local del perfil `pooler` (docker-compose.yml) escucha en 6433. */
export type PoolMode = "transaction-pooler" | "session-pooler" | "direct";

export type ConnectionDescription = {
  host: string;
  port: number;
  user: string;
  database: string;
  isLocal: boolean;
  projectRef: string | null;
  pgbouncerFlag: boolean;
  connectionLimit: number | null;
  mode: PoolMode;
  warnings: string[];
};

const TRANSACTION_PORTS = new Set([6543]);
const LOCAL_TRANSACTION_PORTS = new Set([6433]);

export function describeConnection(key: DbUrlKey, url: string): ConnectionDescription {
  const t = describeTarget(url); // tira si no es URL; su mensaje no incluye la URL
  const u = new URL(url);
  const port = Number(u.port || 5432);
  const pgbouncerFlag = u.searchParams.get("pgbouncer") === "true";
  const rawLimit = u.searchParams.get("connection_limit");
  const connectionLimit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Number(rawLimit) : null;

  let mode: PoolMode = "direct";
  if (TRANSACTION_PORTS.has(port) || (t.isLocal && LOCAL_TRANSACTION_PORTS.has(port))) mode = "transaction-pooler";
  else if (t.host.endsWith(".pooler.supabase.com")) mode = "session-pooler";

  const warnings: string[] = [];
  if (mode === "transaction-pooler" && !pgbouncerFlag) {
    warnings.push("modo transacción sin `pgbouncer=true`: Prisma usa prepared statements con nombre y falla al rotar de backend");
  }
  if (mode === "transaction-pooler" && key !== "DIRECT_URL" && connectionLimit === null) {
    warnings.push("sin `connection_limit`: cada lambda abre el pool entero de Prisma (prod usa 3, plan §21.3 OPS-3)");
  }
  if (key === "DIRECT_URL" && mode === "transaction-pooler") {
    warnings.push("`migrate deploy` necesita una SESIÓN: DIRECT_URL va al pooler de sesión (5432), no al 6543");
  }
  if (key === "DATABASE_URL" && mode === "direct" && t.isSupabase) {
    warnings.push("la app en Vercel conviene que vaya por el pooler de transacción (6543), no directo");
  }
  return {
    host: t.host,
    port,
    user: decodeURIComponent(u.username),
    database: u.pathname.replace(/^\//, "") || "postgres",
    isLocal: t.isLocal,
    projectRef: t.projectRef,
    pgbouncerFlag,
    connectionLimit,
    mode,
    warnings,
  };
}

/** Una línea imprimible: usuario, host, puerto, base y flags. Nunca la contraseña ni la query cruda. */
export function redactedSummary(d: ConnectionDescription): string {
  const flags = [d.pgbouncerFlag ? "pgbouncer=true" : null, d.connectionLimit !== null ? `connection_limit=${d.connectionLimit}` : null]
    .filter(Boolean)
    .join(" ");
  return `${d.user}@${d.host}:${d.port}/${d.database}${flags ? ` [${flags}]` : ""}${d.projectRef ? ` (ref ${d.projectRef})` : ""}`;
}
