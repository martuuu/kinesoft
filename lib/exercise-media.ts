"use server";

/**
 * Exercise media (VIDEO / IMAGE / GIF uploads + YOUTUBE links) — platform
 * superadmin only. Uploads reuse the lib/files.ts pattern: a dedicated Supabase
 * bucket, MIME allow-list, size cap and a local-stub fallback when storage isn't
 * configured (dev). Media rows are global catalog content (`ExerciseMedia`, no
 * tenantId) written via `prismaService`.
 *
 * S02m (fuga E0): este archivo es `"use server"`, así que TODA export es una
 * action invocable por RPC. Acá vivía `resolveMediaUrl(type, url)`, que firmaba
 * cualquier clave del bucket sin sesión. Este archivo ya no exporta ningún
 * firmador (lo fija `tests/integration/storage-service-role.test.ts`): la firma
 * vive en `lib/exercise-media-internal.ts` (server-only, por `mediaId`) y el
 * Storage va por service role (`lib/storage-internal.ts`).
 */
import { randomBytes } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import type { ExerciseMediaType } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import { isStorageConfigured, storageRemove, storageUpload } from "@/lib/storage-internal";
import { EXERCISE_MEDIA_BUCKET as BUCKET, youtubeId } from "@/lib/exercise-media-internal";
import type { ActionResult } from "@/lib/validation";

const SAFE_EXT_RE = /^[a-z0-9]{1,5}$/;
const ALLOWED_MIME = new Set<string>([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function revalidateFor(slug?: string) {
  if (slug) revalidatePath(`/biblioteca/${slug}`);
  revalidatePath("/plataforma/ejercicios");
  revalidatePath("/biblioteca");
  revalidatePath("/terapia-manual");
  revalidateTag(cacheTags.catalog());
}

export async function addExerciseMedia(formData: FormData): Promise<ActionResult<{ id: string }>> {
  const actor = await requireSuperAdmin();
  const exerciseId = String(formData.get("exerciseId") ?? "");
  const rawType = String(formData.get("type") ?? "");
  const caption = (String(formData.get("caption") ?? "").trim() || null) as string | null;
  if (!["VIDEO", "IMAGE", "GIF", "YOUTUBE"].includes(rawType)) {
    return { ok: false, error: "Tipo de media inválido." };
  }
  const type = rawType as ExerciseMediaType;

  const ex = await prismaService.exercise.findFirst({
    where: { id: exerciseId, tenantId: null },
    select: { id: true, slug: true },
  });
  if (!ex) return { ok: false, error: "Ejercicio global no encontrado." };

  const id = randomBytes(12).toString("hex");
  let url: string;
  // Clave subida a Storage en esta llamada: si después falla el INSERT de la
  // fila, se borra para no dejar un objeto huérfano que ninguna fila referencia.
  let uploadedKey: string | null = null;

  if (type === "YOUTUBE") {
    const link = String(formData.get("url") ?? "").trim();
    if (!youtubeId(link)) return { ok: false, error: "Link de YouTube inválido." };
    url = link;
  } else {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Adjuntá un archivo." };
    if (file.size > 50 * 1024 * 1024) return { ok: false, error: "El archivo no puede superar 50 MB." };
    const mime = (file.type || "application/octet-stream").toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return { ok: false, error: "Tipo de archivo no permitido." };
    if (isStorageConfigured()) {
      const raw = (file.name.split(".").pop() ?? "bin").toLowerCase();
      const ext = SAFE_EXT_RE.test(raw) ? raw : "bin";
      url = `exercises/${exerciseId}/${id}.${ext}`;
      const buf = new Uint8Array(await file.arrayBuffer());
      const up = await storageUpload(BUCKET, url, buf, mime);
      if (!up.ok) return { ok: false, error: "No pudimos subir el archivo." };
      uploadedKey = url;
    } else {
      url = `stub:${id}`;
    }
  }

  let row: { id: string };
  try {
    const last = await prismaService.exerciseMedia.findFirst({
      where: { exerciseId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    row = await prismaService.exerciseMedia.create({
      data: { id, exerciseId, type, url, caption, order: (last?.order ?? -1) + 1 },
      select: { id: true },
    });
  } catch (e) {
    // Best-effort: si el remove también falla queda logueado en storage.failed.
    if (uploadedKey) await storageRemove(BUCKET, [uploadedKey]);
    throw e;
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.exercise.media.add",
    entity: "ExerciseMedia",
    entityId: row.id,
    payload: { exerciseId, type },
  });
  revalidateFor(ex.slug);
  return { ok: true, data: { id: row.id } };
}

export async function deleteExerciseMedia(id: string): Promise<ActionResult> {
  const actor = await requireSuperAdmin();
  const media = await prismaService.exerciseMedia.findUnique({
    where: { id },
    select: { id: true, type: true, url: true, exercise: { select: { slug: true } } },
  });
  if (!media) return { ok: false, error: "Media no encontrada." };
  if (media.type !== "YOUTUBE" && !media.url.startsWith("stub:")) {
    // supabase-js no tira: antes el `{ error }` se ignoraba y se borraba la fila,
    // dejando el objeto huérfano en el bucket. Si Storage falla (o no está
    // configurado en un entorno que tiene uploads reales), la fila queda y el
    // superadmin reintenta. Mismo criterio que `deletePatientFile`.
    const rm = await storageRemove(BUCKET, [media.url]);
    if (!rm.ok) return { ok: false, error: "No pudimos borrar el archivo. Probá de nuevo." };
  }
  await prismaService.exerciseMedia.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "admin.exercise.media.delete",
    entity: "ExerciseMedia",
    entityId: id,
  });
  revalidateFor(media.exercise.slug);
  return { ok: true, data: undefined };
}

export async function reorderExerciseMedia(
  exerciseId: string,
  orderedIds: string[],
): Promise<ActionResult> {
  await requireSuperAdmin();
  const ex = await prismaService.exercise.findFirst({
    where: { id: exerciseId, tenantId: null },
    select: { slug: true },
  });
  if (!ex) return { ok: false, error: "Ejercicio global no encontrado." };
  await prismaService.$transaction(
    orderedIds.map((id, i) =>
      prismaService.exerciseMedia.updateMany({ where: { id, exerciseId }, data: { order: i } }),
    ),
  );
  revalidateFor(ex.slug);
  return { ok: true, data: undefined };
}
