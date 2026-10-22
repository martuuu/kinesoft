/**
 * TP-P1 · Rotación de `SECRET_BOX_KEYS` sobre `MpCredential` (C-TP1).
 * Wrapper fino: la lógica vive en `lib/secret-box-rotate-internal.ts`.
 *
 * Por qué: los tokens de MP se sellan con la PRIMERA clave de
 * `SECRET_BOX_KEYS` y se abren con cualquiera. Para retirar una clave vieja
 * (rotación programada o sospecha de fuga) hay que re-sellar cada fila con la
 * nueva; si se retira antes, esas cuentas no abren más y el profesional tiene
 * que reconectar Mercado Pago.
 *
 * Seguridad:
 *  - DRY-RUN por defecto: lee, abre cada sobre a re-sellar (para saber si
 *    alguno falla) y NO escribe. Para escribir: `--apply`.
 *  - Conexión: DIRECT_URL (owner, BYPASSRLS) si está, si no DATABASE_URL; se
 *    imprime el NOMBRE de la variable, nunca el valor. Aborta sin BYPASSRLS
 *    (MpCredential es SERVICE_ONLY: bajo RLS se vería vacía = falso verde).
 *  - `assertSafeTarget`: local libre; remoto solo con
 *    KINESOFT_CONFIRM_PROD=<project ref>.
 *  - Imprime conteos, kids e ids de las filas que fallan; nunca sobres,
 *    tokens ni claves (solo las huellas de `secretBoxStatus`).
 *  - El UPDATE es por fila con CAS (no mueve `version`): se puede correr con la
 *    app viva; un refresh concurrente gana y la fila sale como "conflicto".
 *
 * `lib/secret-box.ts` es `server-only`: tsx corre con `--conditions=react-server`.
 *
 * Uso (local, Docker :5433):
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/secret-box-rotate.ts
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/secret-box-rotate.ts --apply
 *
 * Prod (lo corre Martin; nunca un agente):
 *   1. Generar la clave nueva: node -e "console.log('k2:'+require('crypto').randomBytes(32).toString('base64'))"
 *      y guardarla en el gestor de contraseñas.
 *   2. En Vercel (Production): SECRET_BOX_KEYS="k2:<nueva>,k1:<vieja>" → redeploy.
 *      Desde ahí la app sella con k2 y sigue abriendo k1.
 *   3. Con la MISMA SECRET_BOX_KEYS en `.env.prod.local` (comparar huellas con
 *      Sistema): dry-run → revisar `failed` = 0 → `--apply` (KINESOFT_CONFIRM_PROD=<ref>)
 *      → dry-run otra vez: `pendientes` tiene que dar 0.
 *   4. Recién entonces SECRET_BOX_KEYS="k2:<nueva>" en Vercel → redeploy.
 */
import { PrismaClient } from "@prisma/client";
import { secretBoxStatus } from "../lib/secret-box";
import {
  assertResealBypassRls,
  prismaMpCredentialStore,
  resealMpCredentials,
} from "../lib/secret-box-rotate-internal";
import { assertSafeTarget } from "./lib/assert-safe-target";

const NAME = "secret-box-rotate";

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const batchRaw = arg("batch");
  const batchSize = batchRaw ? Number(batchRaw) : 100;

  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[${NAME}] conexión: ${envName}`);
  const target = assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: NAME });

  const status = secretBoxStatus();
  if (!status.configured && !target.isLocal) {
    throw new Error(`[${NAME}] SECRET_BOX_KEYS no está configurada (o está mal formada): contra un remoto no se usa la clave dev.`);
  }
  console.log(
    `[${NAME}] clave primaria: ${status.primaryKid ?? "(ninguna)"}${status.devFallback ? " (dev, solo local)" : ""} · claves: ${
      status.kids.join(", ") || "(ninguna)"
    }`,
  );
  for (const [kid, fp] of Object.entries(status.fingerprints)) console.log(`  • huella ${kid}: ${fp}`);
  console.log(`[${NAME}] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"}`);

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await assertResealBypassRls(db);
    const r = await resealMpCredentials({ apply, batchSize, store: prismaMpCredentialStore(db) });
    const byKid = Object.entries(r.byKid).map(([k, n]) => `${k}=${n}`).join(", ") || "-";
    console.log(
      `[${NAME}] credenciales: ${r.scanned} · por kid: ${byKid} · pendientes: ${r.pending} · re-selladas: ${r.resealed} · conflictos: ${r.conflicts} · fallan: ${r.failed}`,
    );
    for (const f of r.failures) console.log(`  • no abre: MpCredential ${f.id} (${f.code})`);
    if (r.failed > r.failures.length) console.log(`  … y ${r.failed - r.failures.length} más`);
    if (r.failed > 0) {
      console.log(
        `[${NAME}] Hay credenciales que no abren con las claves actuales: NO retires ninguna clave hasta resolverlas (o esas cuentas reconectan).`,
      );
    }
    if (!apply) {
      console.log(
        r.pending === 0
          ? `[${NAME}] Dry-run: todo está sellado con la clave primaria.`
          : `[${NAME}] Dry-run: no se escribió nada. Repetí con --apply para re-sellar.`,
      );
    } else {
      console.log(`[${NAME}] Listo. Corré el dry-run otra vez: pendientes tiene que dar ${r.failed}.`);
    }
    if (r.failed > 0) process.exitCode = 2;
  } finally {
    await db.$disconnect();
  }
}

// Importable sin disparar el CLI (mismo patrón que plans-dedupe-session-index).
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
