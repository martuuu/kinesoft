/**
 * Disciplina sugerida de un servicio a partir del catálogo global (S13, ES2b;
 * PQ-11 de PLANES.md: "sugerida desde `practiceId`, se confirma a mano").
 *
 * Puro: recibe los slugs de especialidad de la práctica (`PracticeSpecialty` →
 * `Specialty.slug`, que el caller ya leyó del catálogo) y no escribe nada. La
 * sugerencia NUNCA se guarda sola: la UI la ofrece y el admin la confirma,
 * igual que la duración sugerida de la práctica (B1.4). Así un catálogo mal
 * curado no cambia en silencio el filtro de planes ni el "Fuera de plan" de la
 * agenda (V2), que dependen de `Service.discipline`.
 */
import type { Discipline } from "@/lib/plans-constants";

/**
 * Especialidades del catálogo (`prisma/catalog/specialties.csv`) que implican
 * cada disciplina. Kinesiología = la profesión (`prof-kinesiologia`) y todas
 * sus orientaciones (`kine-*`). Fisiatría (`med-fisiatria`) NO: es una
 * especialidad médica, aunque comparta prácticas de rehabilitación.
 */
const OSTEOPATHY_SPECIALTY_SLUGS: ReadonlySet<string> = new Set(["osteopatia"]);
const KINESIOLOGY_SPECIALTY_PREFIX = "kine-";
const KINESIOLOGY_SPECIALTY_SLUGS: ReadonlySet<string> = new Set(["prof-kinesiologia"]);

function disciplineOfSpecialty(slug: string): Discipline | null {
  if (OSTEOPATHY_SPECIALTY_SLUGS.has(slug)) return "OSTEOPATHY";
  if (KINESIOLOGY_SPECIALTY_SLUGS.has(slug) || slug.startsWith(KINESIOLOGY_SPECIALTY_PREFIX)) {
    return "KINESIOLOGY";
  }
  return null;
}

/**
 * Disciplina sugerida para una práctica según sus especialidades.
 * - Todas las que mapean apuntan a la misma → esa.
 * - Ninguna mapea (práctica de otra profesión, o sin práctica) → null.
 * - Mapean a las dos (práctica compartida) → null: es ambigua, decide el admin.
 */
export function suggestDisciplineFromSpecialties(
  specialtySlugs: readonly string[]
): Discipline | null {
  let found: Discipline | null = null;
  for (const slug of specialtySlugs) {
    const d = disciplineOfSpecialty(slug);
    if (!d) continue;
    if (found && found !== d) return null;
    found = d;
  }
  return found;
}
