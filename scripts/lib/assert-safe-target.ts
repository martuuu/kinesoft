/**
 * Guard for scripts/seeds that connect straight to a database.
 *
 * Why (AUDIT 2026-09-23, ops-datos-prod): `.env` is a hand-toggled DEV/PROD
 * file and the Prisma CLI / `new PrismaClient()` read it. `prisma/seed.ts`
 * wipes every booking+payment of the `movare` tenant, `seed-santiago` moves a
 * real practitioner between tenants, and `set-platform-admin` silently fell
 * back to localhost when DATABASE_URL was unset (so `--list` "confirmed" a
 * change that never reached prod). Every script now states its target up
 * front and refuses a remote database unless explicitly allowed AND confirmed
 * with the exact Supabase project ref.
 */

export type TargetDescription = {
  host: string;
  isLocal: boolean;
  isSupabase: boolean;
  /** Supabase project ref when derivable (pooler user `postgres.<ref>` or db.<ref>.supabase.co). */
  projectRef: string | null;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "host.docker.internal", "db"]);

export function describeTarget(url: string): TargetDescription {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL no es una URL válida.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const isSupabase = host.endsWith(".supabase.com") || host.endsWith(".supabase.co");
  let projectRef: string | null = null;
  const userRef = decodeURIComponent(parsed.username).match(/^[a-z_]+\.([a-z0-9]{10,})$/);
  if (userRef) projectRef = userRef[1];
  const hostRef = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (!projectRef && hostRef) projectRef = hostRef[1];
  return { host, isLocal: LOCAL_HOSTS.has(host), isSupabase, projectRef };
}

export function assertSafeTarget(opts: {
  url: string | undefined;
  /** When false the script is local-only (no override exists). */
  allowRemote: boolean;
  /** Value of KINESOFT_CONFIRM_PROD, compared against the project ref / host. */
  confirm?: string | undefined;
  scriptName: string;
  log?: (msg: string) => void;
}): TargetDescription {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!opts.url) {
    throw new Error(
      `[${opts.scriptName}] Falta DATABASE_URL. Pasala explícita en la línea de comandos: no hay fallback silencioso a localhost.`,
    );
  }
  const t = describeTarget(opts.url);
  log(`[${opts.scriptName}] destino: ${t.host}${t.projectRef ? ` (ref ${t.projectRef})` : ""}`);
  if (t.isLocal) return t;
  if (!opts.allowRemote) {
    throw new Error(`[${opts.scriptName}] es solo LOCAL y el destino es remoto (${t.host}). Abortado.`);
  }
  const expected = t.projectRef ?? t.host;
  if (opts.confirm !== expected) {
    throw new Error(
      `[${opts.scriptName}] destino remoto (${t.host}). Para confirmar, repetí el comando con KINESOFT_CONFIRM_PROD=${expected}`,
    );
  }
  log(`[${opts.scriptName}] destino remoto CONFIRMADO (${expected}).`);
  return t;
}
