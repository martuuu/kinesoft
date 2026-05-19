"use server";

/**
 * Patient files — Archivos tab on the EHR.
 *
 * Storage strategy:
 *  - **Supabase Storage** when `NEXT_PUBLIC_SUPABASE_URL` is configured.
 *    Files land in the `patient-files` bucket under `<tenantId>/<patientId>/<fileId>`.
 *  - **Local stub** otherwise — only metadata is persisted. Download/view
 *    is disabled, but the table flow (list / add metadata / delete) is
 *    exercised end-to-end so the UI can be developed without S3.
 *
 * The DB row is the source of truth for visibility; deleting the row
 * also removes the underlying object.
 */
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { PatientFileCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import type { ActionResult } from "@/lib/validation";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const BUCKET = "patient-files";

export type PatientFileRow = {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  category: PatientFileCategory;
  description: string | null;
  createdAt: Date;
  hasDownload: boolean;
};

function storageEnabled() {
  return !!(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

export async function listPatientFiles(patientId: string): Promise<PatientFileRow[]> {
  const actor = await getActor();
  const rows = await prisma.patientFile.findMany({
    where: { patientId, tenantId: actor.tenantId },
    orderBy: { createdAt: "desc" },
  });
  const haveStorage = storageEnabled();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    category: r.category,
    description: r.description,
    createdAt: r.createdAt,
    hasDownload: haveStorage && !r.storageKey.startsWith("stub:"),
  }));
}

/**
 * Upload accepts a FormData with `file` (a Blob) + metadata. Server
 * action so it streams through `next-server` without an extra round
 * trip.
 */
export async function uploadPatientFile(
  patientId: string,
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const owned = await prisma.patient.findFirst({
    where: { id: patientId, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!owned) return { ok: false, error: "Paciente no encontrado." };

  const file = formData.get("file");
  const category = (formData.get("category") as PatientFileCategory) ?? PatientFileCategory.OTHER;
  const description = (formData.get("description") as string | null) || undefined;
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Adjuntá un archivo." };
  }
  if (file.size > 25 * 1024 * 1024) {
    return { ok: false, error: "El archivo no puede superar 25 MB." };
  }

  const id = randomBytes(12).toString("hex");
  let storageKey = `stub:${id}`;

  if (storageEnabled()) {
    const supabase = getSupabaseServerClient();
    const ext = (file.name.split(".").pop() ?? "bin").toLowerCase();
    storageKey = `${actor.tenantId}/${patientId}/${id}.${ext}`;
    const buf = new Uint8Array(await file.arrayBuffer());
    const { error } = await supabase.storage.from(BUCKET).upload(storageKey, buf, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (error) return { ok: false, error: "No pudimos subir el archivo." };
  }

  const row = await prisma.patientFile.create({
    data: {
      tenantId: actor.tenantId,
      patientId,
      uploaderId: actor.userId ?? undefined,
      name: file.name,
      mime: file.type || "application/octet-stream",
      sizeBytes: file.size,
      storageKey,
      category,
      description,
    },
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patientFile.upload",
    entity: "PatientFile",
    entityId: row.id,
    payload: { name: row.name, sizeBytes: row.sizeBytes, category },
  });

  revalidatePath(`/pacientes/${patientId}`);
  return { ok: true, data: { id: row.id } };
}

export async function deletePatientFile(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const row = await prisma.patientFile.findFirst({
    where: { id, tenantId: actor.tenantId },
  });
  if (!row) return { ok: false, error: "Archivo no encontrado." };

  if (storageEnabled() && !row.storageKey.startsWith("stub:")) {
    const supabase = getSupabaseServerClient();
    await supabase.storage.from(BUCKET).remove([row.storageKey]);
  }

  await prisma.patientFile.delete({ where: { id } });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patientFile.delete",
    entity: "PatientFile",
    entityId: id,
  });
  revalidatePath(`/pacientes/${row.patientId}`);
  return { ok: true, data: undefined };
}

/** Server-side signed download URL — short-lived (10 min). */
export async function getDownloadUrl(id: string): Promise<ActionResult<{ url: string }>> {
  const actor = await getActor();
  const row = await prisma.patientFile.findFirst({
    where: { id, tenantId: actor.tenantId },
  });
  if (!row) return { ok: false, error: "Archivo no encontrado." };
  if (!storageEnabled() || row.storageKey.startsWith("stub:")) {
    return { ok: false, error: "Storage no configurado en este entorno." };
  }
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storageKey, 600);
  if (error || !data?.signedUrl) {
    return { ok: false, error: "No pudimos generar el link." };
  }
  return { ok: true, data: { url: data.signedUrl } };
}
