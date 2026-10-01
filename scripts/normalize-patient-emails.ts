/**
 * Normaliza `Patient.email` (trim + minúsculas) de las fichas existentes.
 *
 * Por qué (A2a-S08): desde A2 los schemas de alta/edición guardan el email
 * normalizado, pero las filas viejas pueden tener "Juan@Mail.com " — el índice
 * único `(tenantId, email)` es case-sensitive, así que conviven duplicados
 * "del mismo" email, y el callback del portal (match por email) linkea uno solo.
 * NO es una migración: lo corre el dueño DESPUÉS del deploy de A2 (el código
 * nuevo ya no vuelve a meter emails sin normalizar).
 *
 * Seguridad:
 *  - `--dry-run` es el DEFAULT: solo lista qué cambiaría y las colisiones.
 *    Para escribir hay que pasar `--apply`.
 *  - DATABASE_URL explícita (sin fallback) y `assertSafeTarget`: contra un
 *    remoto exige KINESOFT_CONFIRM_PROD=<project ref>.
 *  - Colisión = dos o más fichas del MISMO tenant cuyo email normalizado
 *    coincide (o que coincidiría con una ficha ya normalizada). Esas NO se
 *    tocan (el UPDATE rompería el índice único): se reportan para que el
 *    consultorio decida cuál es la ficha buena. Se imprimen ids, no emails.
 *
 *  - La conexión tiene que ser owner/BYPASSRLS (DIRECT_URL): con el rol de la
 *    app, RLS devuelve 0 fichas. El script lo verifica y aborta.
 *
 * Uso (local):
 *   DATABASE_URL="postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public" \
 *     npx tsx scripts/normalize-patient-emails.ts            # dry-run
 *   ... npx tsx scripts/normalize-patient-emails.ts --apply  # escribe
 * Prod: con la URL owner (BYPASSRLS) + KINESOFT_CONFIRM_PROD=<ref>, primero en
 * dry-run, con backup previo.
 */
import { PrismaClient } from "@prisma/client";
import { assertSafeTarget } from "./lib/assert-safe-target";

const url = process.env.DATABASE_URL;
assertSafeTarget({
  url,
  allowRemote: true,
  confirm: process.env.KINESOFT_CONFIRM_PROD,
  scriptName: "normalize-patient-emails",
});
const apply = process.argv.includes("--apply");
const db = new PrismaClient({ datasources: { db: { url } } });

const normalize = (e: string) => e.trim().toLowerCase();

/** Enmascara un email para el log (no se imprime PII completa). */
const mask = (e: string) => {
  const [user, domain] = e.split("@");
  return `${(user ?? "").slice(0, 2)}***@${domain ?? "?"}`;
};

async function main() {
  console.log(`[normalize-patient-emails] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"}`);
  // Con el rol de la app (RLS FORCE, sin GUC de tenant) `Patient` se lee VACÍA
  // y el script diría "0 a normalizar": un falso verde. Exigir BYPASSRLS/owner.
  const [role] = await db.$queryRaw<{ bypass: boolean; superuser: boolean }[]>`
    SELECT rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass && !role?.superuser) {
    throw new Error(
      "[normalize-patient-emails] la conexión no tiene BYPASSRLS: bajo RLS no se ve ninguna ficha. Usá la URL owner (DIRECT_URL).",
    );
  }
  const rows = await db.patient.findMany({
    where: { email: { not: null } },
    select: { id: true, tenantId: true, email: true },
    orderBy: [{ tenantId: "asc" }, { createdAt: "asc" }],
  });

  // Agrupar por (tenant, email normalizado).
  const groups = new Map<string, { id: string; tenantId: string; email: string }[]>();
  for (const r of rows) {
    const key = `${r.tenantId}\u0000${normalize(r.email!)}`;
    const list = groups.get(key) ?? [];
    list.push({ id: r.id, tenantId: r.tenantId, email: r.email! });
    groups.set(key, list);
  }

  const toFix: { id: string; tenantId: string; from: string; to: string }[] = [];
  const collisions: { tenantId: string; normalized: string; ids: string[] }[] = [];
  for (const [key, list] of groups) {
    const normalized = key.split("\u0000")[1];
    const dirty = list.filter((r) => r.email !== normalized);
    if (dirty.length === 0) continue;
    if (list.length > 1) {
      collisions.push({ tenantId: list[0].tenantId, normalized, ids: list.map((r) => r.id) });
      continue;
    }
    toFix.push({ id: dirty[0].id, tenantId: dirty[0].tenantId, from: dirty[0].email, to: normalized });
  }

  console.log(`Fichas con email: ${rows.length}`);
  console.log(`A normalizar sin conflicto: ${toFix.length}`);
  for (const f of toFix) {
    console.log(`  • tenant ${f.tenantId} · paciente ${f.id} · ${mask(f.from)}`);
  }
  console.log(`Colisiones (NO se tocan, revisar a mano): ${collisions.length}`);
  for (const c of collisions) {
    console.log(`  ⚠ tenant ${c.tenantId} · ${mask(c.normalized)} · pacientes ${c.ids.join(", ")}`);
  }

  if (!apply) {
    console.log("Dry-run: no se escribió nada. Repetí con --apply para normalizar.");
    return;
  }
  let updated = 0;
  for (const f of toFix) {
    // WHERE con el email leído: si alguien lo editó mientras tanto, no se pisa.
    const r = await db.patient.updateMany({
      where: { id: f.id, tenantId: f.tenantId, email: f.from },
      data: { email: f.to },
    });
    updated += r.count;
  }
  console.log(`Normalizados: ${updated}/${toFix.length}.`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
