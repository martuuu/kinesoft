import "server-only";
/**
 * ES4 S24e · «Ejercicios» del portal: lectura de los ejercicios del plan del paciente, por allowlist.
 *
 * Por qué así (brief ES4 §4 S24e y §6):
 *   - Canal `prismaService` (BYPASSRLS, sin Actor): la ÚNICA barrera es el par `tenantId` + `patientId` que viene de
 *     `requirePortalPatient` (vínculo por userId). Toda query lleva los dos; nunca un id que mande el cliente.
 *   - Plan mostrado = el mismo que el resto del portal (ES4-D5): el ACTIVE más reciente por `startDate`, con
 *     `createdAt` e `id` de desempate. Además sin archivar: un plan archivado no es «tu plan».
 *   - Solo sesiones vivas (`archivedAt: null`: archivar una sesión no renumera, pero la sesión ya no es parte del plan)
 *     y solo `kind = EXERCISE`: las maniobras (`MANUAL_THERAPY`) las hace el profesional, no son tarea para la casa, y
 *     su nombre describe el tratamiento.
 *   - `select` explícito, nunca `include`: no viajan `Session.notes`, `SessionExercise.notes` (notas del kine),
 *     `TreatmentProgram.notes`, precios ni el `videoUrl` crudo (puede ser cualquier link que pegó el profesional).
 *   - Media (ES4-D6):
 *       · ejercicio GLOBAL (Plataforma) → su primera media firmada por `signExerciseMedia(id, { ttlSeconds: 600 })`
 *         (10 min: la página es `force-dynamic`, cada visita firma de nuevo; una URL que se filtra vence rápido);
 *       · ejercicio PROPIO del consultorio → no tiene media subida (la carga es de Plataforma y `signExerciseMedia`
 *         solo firma globales): solo su `videoUrl` si es YouTube, como embed nocookie;
 *       · cualquier otra cosa (otro link, ejercicio de un tercer consultorio, firma fallida) → `null`.
 *     La firma NO decide si el paciente puede ver el ejercicio (lo dice el propio `signExerciseMedia`): lo decide este
 *     módulo, que solo resuelve media de ejercicios que están en una sesión viva del plan mostrado.
 */
// Superficie del paciente, sin Actor: canal service (BYPASSRLS). Ver lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { signExerciseMedia, youtubeId } from "@/lib/exercise-media-internal";
import type { PortalExerciseDTO, PortalExercisesDTO } from "@/lib/portal-exercises-types";
import type { ExerciseMediaType, Prisma } from "@prisma/client";

/** El par que sale de `requirePortalPatient` (PortalPatientRef). */
export type PortalExercisesScope = { tenantId: string; patientId: string };

/** TTL de las URLs firmadas del portal (brief §4 S24e). */
export const PORTAL_MEDIA_TTL_SECONDS = 600;

type PortalMedia = PortalExerciseDTO["media"];

/** Lo mínimo del ejercicio para decidir la media. `videoUrl` se lee acá y no sale nunca en el DTO. */
type ExerciseMediaInput = {
  id: string;
  tenantId: string | null;
  videoUrl: string | null;
  media: { id: string; type: ExerciseMediaType }[];
};

const EXERCISE_SELECT = {
  id: true,
  name: true,
  durationSeconds: true,
  instructions: true,
  videoUrl: true,
  tenantId: true,
  // La primera media por orden alcanza: el portal muestra una sola por ejercicio.
  media: { orderBy: [{ order: "asc" }, { createdAt: "asc" }], take: 1, select: { id: true, type: true } },
} satisfies Prisma.ExerciseSelect;

/** Plan que ve el paciente (ES4-D5). Una sola fuente para el listado y para la resolución de media. */
function currentProgramArgs(scope: PortalExercisesScope) {
  return {
    where: { patientId: scope.patientId, tenantId: scope.tenantId, status: "ACTIVE", archivedAt: null },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
  } satisfies Prisma.TreatmentProgramFindFirstArgs;
}

/** Los ids de YouTube son `[A-Za-z0-9_-]`: cualquier otra cosa no se interpola en la URL del iframe. */
const YT_ID = /^[A-Za-z0-9_-]{6,32}$/;

function youtubeEmbed(url: string | null): PortalMedia {
  if (!url) return null;
  const id = youtubeId(url);
  return id && YT_ID.test(id) ? { kind: "youtube", url: `https://www.youtube-nocookie.com/embed/${id}` } : null;
}

const KIND_OF: Record<ExerciseMediaType, "image" | "video" | "youtube"> = {
  IMAGE: "image",
  GIF: "image",
  VIDEO: "video",
  YOUTUBE: "youtube",
};

async function mediaFor(ex: ExerciseMediaInput, tenantId: string): Promise<PortalMedia> {
  if (ex.tenantId === null) {
    const first = ex.media[0];
    if (first) {
      const url = await signExerciseMedia(first.id, { ttlSeconds: PORTAL_MEDIA_TTL_SECONDS });
      if (url) return { kind: KIND_OF[first.type], url };
    }
    // Global sin media subida (o con la firma caída): el link de YouTube de la ficha, si lo hay.
    return youtubeEmbed(ex.videoUrl);
  }
  // Ejercicio de un TERCER consultorio en una sesión de este (no debería existir: el picker valida el tenant): nada.
  if (ex.tenantId !== tenantId) return null;
  return youtubeEmbed(ex.videoUrl);
}

/**
 * Ejercicios del plan del paciente, agrupados por sesión viva (orden por `index`, ejercicios por `order`).
 * `null` si no hay plan ACTIVE o si ninguna sesión viva tiene ejercicios (la página muestra el vacío).
 * NO mira módulos: el gate (`planes` ∧ `ejercicios`) lo hace `lib/portal-exercises.ts` antes de llamar.
 */
export async function loadPortalExercises(scope: PortalExercisesScope): Promise<PortalExercisesDTO> {
  const program = await prisma.treatmentProgram.findFirst({
    ...currentProgramArgs(scope),
    select: {
      title: true,
      sessions: {
        where: { archivedAt: null },
        orderBy: { index: "asc" },
        select: {
          index: true,
          scheduledFor: true,
          exercises: {
            where: { exercise: { kind: "EXERCISE" } },
            orderBy: { order: "asc" },
            select: { sets: true, reps: true, exercise: { select: EXERCISE_SELECT } },
          },
        },
      },
    },
  });
  if (!program) return null;

  // El mismo ejercicio suele repetirse en todas las sesiones: se resuelve (y se firma) una vez por request.
  const mediaCache = new Map<string, Promise<PortalMedia>>();
  const mediaOnce = (ex: ExerciseMediaInput) => {
    let p = mediaCache.get(ex.id);
    if (!p) {
      p = mediaFor(ex, scope.tenantId);
      mediaCache.set(ex.id, p);
    }
    return p;
  };

  const sessions = await Promise.all(
    program.sessions
      .filter((s) => s.exercises.length > 0)
      .map(async (s) => ({
        index: s.index,
        date: s.scheduledFor.toISOString(),
        exercises: await Promise.all(
          s.exercises.map(
            async (se): Promise<PortalExerciseDTO> => ({
              name: se.exercise.name,
              sets: se.sets,
              reps: se.reps,
              durationSeconds: se.exercise.durationSeconds,
              instructions: se.exercise.instructions,
              media: await mediaOnce(se.exercise),
            })
          )
        ),
      }))
  );
  if (sessions.length === 0) return null;
  return { programTitle: program.title, sessions };
}

/**
 * Media de UN ejercicio, solo si está en una sesión viva del plan que ve el paciente (como `kind = EXERCISE`).
 * Fuera de eso → `null`: un ejercicio del catálogo, de otro plan o de otro paciente no se firma por el portal.
 * Es la misma regla que aplica `loadPortalExercises` (que ya filtra por la query); expuesta para el test y para un
 * futuro visor que pida la media de a una.
 */
export async function resolvePortalExerciseMedia(scope: PortalExercisesScope, exerciseId: string): Promise<PortalMedia> {
  if (typeof exerciseId !== "string" || exerciseId.length === 0) return null;
  const program = await prisma.treatmentProgram.findFirst({ ...currentProgramArgs(scope), select: { id: true } });
  if (!program) return null;
  const row = await prisma.sessionExercise.findFirst({
    where: {
      exerciseId,
      exercise: { kind: "EXERCISE" },
      session: { programId: program.id, archivedAt: null, program: { tenantId: scope.tenantId, patientId: scope.patientId } },
    },
    select: { exercise: { select: EXERCISE_SELECT } },
  });
  return row ? mediaFor(row.exercise, scope.tenantId) : null;
}
