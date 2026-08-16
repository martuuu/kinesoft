"use server";

/**
 * Exercise media (VIDEO / IMAGE / GIF uploads + YOUTUBE links) — platform
 * superadmin only. Uploads reuse the lib/files.ts pattern: a dedicated Supabase
 * bucket, MIME allow-list, size cap, signed download URLs, and a local-stub
 * fallback when storage isn't configured (dev). Media rows are global catalog
 * content (`ExerciseMedia`, no tenantId) written via `prismaService`.
 */
import { randomBytes } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import type { ExerciseMediaType } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/session";
import { audit } from "@/lib/audit";
import { tags as cacheTags } from "@/lib/cache-tags";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/validation";

const BUCKET = "exercise-media";
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

function storageEnabled() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function revalidateFor(slug?: string) {
  if (slug) revalidatePath(`/biblioteca/${slug}`);
  revalidatePath("/plataforma/ejercicios");
  revalidatePath("/biblioteca");
  revalidatePath("/terapia-manual");
  revalidateTag(cacheTags.catalog());
}

/** youtube.com/watch?v=ID | youtu.be/ID | /embed/ID → the video id, else null. */
function youtubeId(url: string): string | null {
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
 * Resolve a media row's stored `url` into something renderable:
 *   - YOUTUBE → privacy-enhanced nocookie embed URL (null if unparseable)
 *   - upload  → 1-hour signed URL (or the raw stub key in dev)
 * Server-only helper for the reader.
 */
export async function resolveMediaUrl(
  type: ExerciseMediaType,
  url: string,
): Promise<string | null> {
  if (type === "YOUTUBE") {
    const id = youtubeId(url);
    return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (!storageEnabled() || url.startsWith("stub:")) return null;
  const supabase = getSupabaseServerClient();
  const { data } = await supabase.storage.from(BUCKET).createSignedUrl(url, 3600);
  return data?.signedUrl ?? null;
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
    if (storageEnabled()) {
      const supabase = getSupabaseServerClient();
      const raw = (file.name.split(".").pop() ?? "bin").toLowerCase();
      const ext = SAFE_EXT_RE.test(raw) ? raw : "bin";
      url = `exercises/${exerciseId}/${id}.${ext}`;
      const buf = new Uint8Array(await file.arrayBuffer());
      const { error } = await supabase.storage.from(BUCKET).upload(url, buf, {
        contentType: mime,
        upsert: false,
      });
      if (error) return { ok: false, error: "No pudimos subir el archivo." };
    } else {
      url = `stub:${id}`;
    }
  }

  const last = await prismaService.exerciseMedia.findFirst({
    where: { exerciseId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const row = await prismaService.exerciseMedia.create({
    data: { id, exerciseId, type, url, caption, order: (last?.order ?? -1) + 1 },
    select: { id: true },
  });
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
  if (media.type !== "YOUTUBE" && storageEnabled() && !media.url.startsWith("stub:")) {
    const supabase = getSupabaseServerClient();
    await supabase.storage.from(BUCKET).remove([media.url]);
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
