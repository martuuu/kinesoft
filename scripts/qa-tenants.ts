/**
 * INF-S · Consultorios del QA por plan (plan §26.8, decisión 3 de Martin del 22-oct) — wrapper fino del CLI. La
 * lógica vive en `scripts/lib/qa-tenants-core.ts` (con su test de integración contra el Docker y el fake de GoTrue,
 * `tests/integration/qa-tenants-core.test.ts`).
 *
 * Lo corre Martin, nunca un agente (AGENTS: el agente no corre scripts de datos). Crea, idempotente, los 8
 * consultorios `qa-<plan>-<vertical>` (Individual / Consultorio / Clínica / Libre × General / Kinesiología) con su
 * equipo por rol, turnero prendido y ACTIVE, y al final imprime UNA vez la tabla de accesos.
 *
 * Modos:
 *   (sin flag)                       crea o re-alinea los 8 (no toca el estado de acceso de los que ya existen)
 *   --sample-data                    + 10 pacientes «QA Paciente NN» y una semana de turnos por consultorio
 *   --state <slug> <estado>          trial | trial-expired | read-only | past-due | suspended | active
 *   --cleanup                        borra los 8 (base + cuentas de Auth de QA); nada que no sea qa-
 *
 * Variables (nunca en el repo; la contraseña no se imprime):
 *   QA_EMAIL_BASE   email base sin «+»: cada cuenta es <local>+<slug>-<rol>@<dominio> (plus-addressing)
 *   QA_PASSWORD     contraseña de TODAS las cuentas QA (≥ 12 caracteres)
 *   DIRECT_URL      conexión owner (o DATABASE_URL); se imprime el NOMBRE, nunca el valor
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY   el Auth del MISMO proyecto que la base
 *   KINESOFT_CONFIRM_PROD=<project ref>                    obligatorio con --target prod
 *   PROD_SUPABASE_REF                                      con --target local y un Auth remoto (para descartar prod)
 *
 * Seguridad: `--target local|prod` obligatorio; local exige base local y un Auth que no sea el de prod; prod exige
 * `KINESOFT_CONFIRM_PROD=<ref>` y que base y Auth sean el mismo proyecto (`resolveQaTarget`). Las cuentas se crean por
 * el puerto de Auth (`createUser` con email confirmado: no manda mails).
 *
 * `lib/tenant-entitlements-internal.ts` y el puerto de Auth son `server-only`: tsx corre con `--conditions=react-server`.
 *
 * Uso (prod demo, después del push y del postcheck; PUSH-DIA paso F):
 *   QA_EMAIL_BASE=… QA_PASSWORD=… KINESOFT_CONFIRM_PROD=<ref> \
 *     npx dotenv -e .env.prod.local -- npx tsx --conditions=react-server scripts/qa-tenants.ts --target prod --sample-data
 *   … scripts/qa-tenants.ts --target prod --state qa-individual-kinesiologia read-only
 *   … scripts/qa-tenants.ts --target prod --cleanup
 */
import { PrismaClient } from "@prisma/client";
import {
  QA_STATES,
  cleanupQaTenants,
  ensureQaTenants,
  formatAccessTable,
  resolveQaTarget,
  setQaTenantState,
  type QaState,
} from "./lib/qa-tenants-core";

const NAME = "qa-tenants";

function flagValue(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cleanup = argv.includes("--cleanup");
  const stateIdx = argv.indexOf("--state");
  const sampleData = argv.includes("--sample-data");
  if (cleanup && stateIdx >= 0) throw new Error(`[${NAME}] --cleanup y --state no van juntos.`);

  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[${NAME}] conexión: ${envName}`);
  resolveQaTarget({
    target: flagValue("target"),
    dbUrl: url,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    confirm: process.env.KINESOFT_CONFIRM_PROD,
    prodRef: process.env.PROD_SUPABASE_REF,
  });
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(`[${NAME}] Falta SUPABASE_SERVICE_ROLE_KEY (Auth admin).`);

  // Recién después de validar el destino: el puerto lee el entorno al importarse (lib/env).
  const { authAdmin } = await import("../lib/identity/auth-admin");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const deps = { db, auth: authAdmin() };
  try {
    if (cleanup) {
      const r = await cleanupQaTenants(deps, { emailBase: process.env.QA_EMAIL_BASE });
      console.log(
        `[${NAME}] cleanup: ${r.tenants.length} consultorio(s) borrado(s) (${r.tenants.join(", ") || "ninguno"}) · ` +
          `${r.profilesDeleted} perfil(es) · ${r.authUsersDeleted} cuenta(s) de Auth`
      );
      return;
    }
    if (stateIdx >= 0) {
      const slug = argv[stateIdx + 1];
      const state = argv[stateIdx + 2] as QaState | undefined;
      if (!slug || !state) throw new Error(`[${NAME}] Uso: --state <slug> ${QA_STATES.join("|")}`);
      const r = await setQaTenantState(deps, slug, state);
      console.log(`[${NAME}] ${slug} → ${state}: acceso ${r.access.mode} (${r.access.reason}${r.access.daysLeft != null ? `, ${r.access.daysLeft} día(s)` : ""})`);
      return;
    }
    const emailBase = process.env.QA_EMAIL_BASE;
    const password = process.env.QA_PASSWORD;
    if (!emailBase) throw new Error(`[${NAME}] Falta QA_EMAIL_BASE.`);
    if (!password) throw new Error(`[${NAME}] Falta QA_PASSWORD.`);
    const r = await ensureQaTenants(deps, { emailBase, password, sampleData });
    console.log(`[${NAME}] ${r.tenantsCreated} consultorio(s) nuevo(s) · ${r.usersCreated} cuenta(s) nueva(s)\n`);
    console.log(formatAccessTable(r.rows, process.env.NEXT_PUBLIC_APP_URL));
  } finally {
    await db.$disconnect();
  }
}

if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
