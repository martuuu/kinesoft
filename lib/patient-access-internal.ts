import "server-only";

import type { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/session";
import { patientAccessFor } from "@/lib/visibility";

// P0-Cs (Planes, ola P0.0): movido tal cual desde `lib/patients.ts` para que
// `lib/programs.ts` (y las actions de Planes que vienen) compartan el mismo
// gate sin duplicarlo. Vive en un `*-internal` server-only porque un archivo
// "use server" no puede exportar helpers que no sean actions (AUDIT §5.12).

/**
 * A2b-S-vis (30-sep) — gate `full` de las mutaciones de HC. Decisión del
 * dueño: acceso básico = solo ver. Antes estas actions solo chequeaban el
 * tenant, así que un profesional no asignado ni compartido podía editar el
 * diagnóstico, crear/editar planes, cargar EVA o archivar pacientes ajenos
 * desde la consola. Devuelve el mensaje de error, o `null` si puede seguir.
 * Corre dentro del `runWithRls` del caller (pasa su `tx`).
 */
export async function hcAccessError(
  actor: Actor,
  patientId: string,
  tx: Prisma.TransactionClient
): Promise<string | null> {
  const access = await patientAccessFor(actor, patientId, tx);
  if (access === "none") return "Paciente no encontrado.";
  if (access !== "full") return "No tenés acceso completo a este paciente.";
  return null;
}
