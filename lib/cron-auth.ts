/**
 * Autorización de los cron de Vercel (BO5-A, plan §19.5).
 *
 * Vercel llama a cada path de `vercel.json#crons` con `Authorization: Bearer <CRON_SECRET>` cuando la variable
 * existe en el proyecto. Las rutas `/api/cron/*` son públicas a nivel red (el middleware las deja pasar como
 * cualquier `/api`), así que este header es la ÚNICA barrera: sin él cualquiera podría disparar los mails de prueba
 * o el resumen de salud a mano.
 *
 * Puro (sin `process.env`, sin `next/*`): el secreto y el entorno entran por parámetro, así la matriz se testea
 * entera. `node:crypto` sí: la comparación es en tiempo constante.
 *
 * Matriz:
 *  - sin `CRON_SECRET` en Production → 503 (config faltante: que se vea como error en el log de Vercel, no como
 *    un 401 que parece un intento ajeno);
 *  - sin `CRON_SECRET` fuera de Production → 401 (nada puede coincidir; nunca «abierto porque no hay secreto»);
 *  - header ausente, sin `Bearer ` o con otro valor → 401.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401; reason: "unauthorized" }
  | { ok: false; status: 503; reason: "missing_secret" };

/**
 * Se comparan los sha256 y no los strings: `timingSafeEqual` exige el mismo largo, y comparar largos primero
 * filtraría el largo del secreto por tiempo. Con el hash los dos lados miden 32 bytes siempre.
 */
function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function checkCronAuth(p: {
  authorization: string | null | undefined;
  secret: string | null | undefined;
  production: boolean;
}): CronAuthResult {
  const secret = p.secret?.trim();
  if (!secret) {
    return p.production ? { ok: false, status: 503, reason: "missing_secret" } : { ok: false, status: 401, reason: "unauthorized" };
  }
  const m = /^Bearer\s+(.+)$/i.exec((p.authorization ?? "").trim());
  if (!m) return { ok: false, status: 401, reason: "unauthorized" };
  return sameSecret(m[1].trim(), secret) ? { ok: true } : { ok: false, status: 401, reason: "unauthorized" };
}
