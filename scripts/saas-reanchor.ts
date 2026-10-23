/**
 * MPS-2c · Re-anclaje de las suscripciones al día 4 (MPS-D7, plan §22.6 / §26.6) — wrapper fino del CLI.
 * La lógica vive en `lib/saas-reanchor-internal.ts` (con su test de integración, `mps-2c-reanchor.test.ts`).
 *
 * Por qué: M16 cambió el default de `SaasSubscription.anchorDay` a 4 SIN backfill. Las suscripciones creadas antes
 * siguen cobrando el día en que se anclaron (el siguiente al fin de la prueba); el débito automático de Mercado Pago
 * necesita una fecha fija para todos. Este script las pasa al 4:
 *  - sin cargos: billableFrom = max(inicio del cobro, hoy), próximo cobro = el primer 4 ≥ eso;
 *  - con cargos: billableFrom = el próximo cobro viejo (lo cobrado no se toca), próximo cobro = el primer 4 ≥ eso;
 *    el tramo entre los dos lo cobra el primer cargo como proporcional (se imprime proyectado);
 *  - siempre autoDebitAllowed = true.
 * No toca cargos, pagos ni ajustes. Idempotente: una segunda corrida saltea lo ya anclado.
 *
 * Seguridad:
 *  - DRY-RUN por defecto (tx READ ONLY: Postgres rechaza cualquier write). Para escribir: `--apply`.
 *  - Conexión: DIRECT_URL (owner) si está, si no DATABASE_URL; se imprime el NOMBRE de la variable, nunca el valor.
 *    Sin fallback a localhost.
 *  - `assertSafeTarget`: local libre; remoto solo con KINESOFT_CONFIRM_PROD=<project ref>.
 *  - Aborta sin BYPASSRLS (SaasSubscription es TENANT_READONLY: bajo RLS se vería vacía = falso «nada que hacer»).
 *  - `--tenant=<id>[,<id>…]` limita el alcance; sin él, todos los consultorios con suscripción.
 *  - Imprime ids, nombre del consultorio, fechas y montos (sin PHI).
 *
 * `lib/saas-reanchor-internal.ts` es `server-only`: tsx corre con `--conditions=react-server`.
 *
 * Uso (local, Docker :5433):
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/saas-reanchor.ts
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/saas-reanchor.ts --apply
 * Prod (lo corre Martin, nunca un agente; DESPUÉS del deploy de M16 + código, con SAAS_BILLING_MODE en `off` o
 * `manual` y fuera del horario del cron): backup → dry-run → revisar la tabla → --apply (KINESOFT_CONFIRM_PROD=<ref>)
 * → dry-run otra vez (todo tiene que salir «skip»).
 */
import { PrismaClient } from "@prisma/client";
import { runSaasReanchor, type ReanchorScope } from "../lib/saas-reanchor-internal";
import { assertSafeTarget } from "./lib/assert-safe-target";

const NAME = "saas-reanchor";

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

/** Pesos sin depender de `lib/format.ts` (centavos Int → «$ 1.234,56»). */
function ars(cents: number): string {
  const abs = Math.abs(cents);
  const int = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const dec = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$ ${int},${dec}`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const tenantArg = arg("tenant");
  const tenantIds: ReanchorScope = tenantArg ? tenantArg.split(",").map((s) => s.trim()).filter(Boolean) : "all";

  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[${NAME}] conexión: ${envName}`);
  assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: NAME });
  console.log(
    `[${NAME}] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"} · alcance: ${
      tenantIds === "all" ? "todos los consultorios con suscripción" : tenantIds.join(", ")
    }`
  );

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const r = await runSaasReanchor({ db, tenantIds, apply });
    const toUpdate = r.rows.filter((x) => x.action === "update");
    console.log(`[${NAME}] suscripciones: ${r.rows.length} · a re-anclar: ${toUpdate.length} · ya ancladas: ${r.rows.length - toUpdate.length}`);
    for (const x of r.rows) {
      const stub = x.stub ? `${ars(x.stub.amountCents)} (${x.stub.days}/${x.stub.periodDays} días)` : "sin proporcional";
      console.log(
        `  • ${x.action === "skip" ? "skip  " : "update"} ${x.tenantId} «${x.tenantName}» · ${x.saasPlan}/${x.subscriptionStatus} · ` +
          `${x.hasCharges ? "con cargos" : "sin cargos"} · ancla ${x.oldAnchorDay} → ${x.newAnchorDay} · ` +
          `próximo cobro ${x.oldNextChargeOn ?? "-"} → ${x.newNextChargeOn} · billableFrom ${x.oldBillableFrom ?? "-"} → ${x.billableFrom} · ` +
          `débito permitido ${x.oldAutoDebitAllowed ? "sí" : "no"} → sí · stub proyectado ${stub}`
      );
    }
    if (!apply) {
      console.log(
        toUpdate.length === 0
          ? `[${NAME}] Dry-run: todo está anclado al 4. No hace falta --apply.`
          : `[${NAME}] Dry-run: no se escribió nada. Repetí con --apply para re-anclar.`
      );
    } else {
      console.log(`[${NAME}] Re-ancladas: ${r.updated}. Corré el dry-run otra vez: todo tiene que salir «skip».`);
    }
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
