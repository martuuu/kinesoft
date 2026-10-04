import "server-only";

/**
 * Firmador de media de ejercicios (S02m, fuga E0).
 *
 * El bug: `resolveMediaUrl(type, url)` vivía en `lib/exercise-media.ts`, un
 * archivo `"use server"`, así que era una server action invocable por RPC
 * **sin sesión** que firmaba (1 h) **cualquier** clave del bucket que mandara el
 * cliente. Con el action-id (está en un chunk público) cualquiera podía bajar
 * objetos del Storage adivinando o filtrando claves.
 *
 * Ahora:
 *  - Este módulo es server-only (no es una action: no tiene action-id).
 *  - Se firma por `mediaId`: la clave sale de la FILA de `ExerciseMedia`, nunca
 *    de un parámetro del cliente.
 *  - Solo media de ejercicios del catálogo GLOBAL (`tenantId: null`), que es lo
 *    único que escribe `addExerciseMedia`. Si en C1 aparece media de ejercicios
 *    de un tenant, hay que agregar el scoping por tenant acá antes de usarla.
 *  - NO decide si el actor puede ver el ejercicio (plan-gating, ejercicios del
 *    plan del paciente en el portal): eso lo hace el caller antes de pedir la
 *    firma (`getExercise` en el lector, S24e en el portal).
 */
import { prismaService } from "@/lib/db";
import { storageSign } from "@/lib/storage-internal";

export const EXERCISE_MEDIA_BUCKET = "exercise-media" as const;

/** TTL por defecto: 1 h, como el lector de antes (un video largo hace range
 *  requests contra la misma URL; con menos se corta a mitad de reproducción). */
const DEFAULT_TTL_SECONDS = 3600;

/** youtube.com/watch?v=ID | youtu.be/ID | /embed/ID | /shorts/ID → el id, si no null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = u.pathname.match(/^\/(embed|shorts)\/([^/?]+)/);
      if (m) return m[2];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * URL renderizable de una media por su id:
 *   - YOUTUBE → embed nocookie (null si el link no parsea);
 *   - upload  → URL firmada con service role (`ttlSeconds`, 60–3600);
 *   - stub de dev, id inexistente, ejercicio no global o error de Storage → null
 *     (el lector muestra el placeholder; el error ya quedó logueado).
 */
export async function signExerciseMedia(
  mediaId: string,
  opts?: { ttlSeconds?: number },
): Promise<string | null> {
  if (typeof mediaId !== "string" || mediaId.length === 0) return null;
  const row = await prismaService.exerciseMedia.findFirst({
    where: { id: mediaId, exercise: { tenantId: null } },
    select: { type: true, url: true },
  });
  if (!row) return null;
  if (row.type === "YOUTUBE") {
    const id = youtubeId(row.url);
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (row.url.startsWith("stub:")) return null;
  const signed = await storageSign(EXERCISE_MEDIA_BUCKET, row.url, opts?.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  return signed.ok ? signed.data : null;
}
