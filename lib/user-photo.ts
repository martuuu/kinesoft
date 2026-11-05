"use server";

/**
 * CF3b PH-S (M24 `cf3_practitioner_photo`, pedido de Martin del 05-nov): cada persona sube SU foto, que es su avatar en
 * la app y, con el opt-in de cada consultorio, sale en el turnero y la sede (contrato FOTO de wip-20/cf3-handoffs.md).
 *
 * Dos canales a propósito:
 *   - `uploadOwnPhoto` / `removeOwnPhoto`: la foto es de la PERSONA (`UserProfile`, una para todos sus consultorios), sin
 *     `tenantId` para `runWithRls` → `prismaService`, como la matrícula (lib/user-license.ts) y la 2FA. La barrera es
 *     que el `userId` sale SIEMPRE de la sesión verificada (`getAccessSnapshot`): ninguna action recibe un id; un
 *     `userId` que venga en el FormData se ignora.
 *   - `setOwnShowPhotoPublic`: el opt-in es del PROFESIONAL en el consultorio activo (`Practitioner.showPhotoPublic`) →
 *     `getActor` → `where: { id, tenantId }` a mano → `runWithRls` + audit en la tx (molde de `setOwnShowPublicPrice`).
 *
 * Gate de la persona (`resolvePhotoSession`): sesión con perfil, cuenta no deshabilitada y 2FA no pendiente. Subir pide
 * además al menos una membresía USABLE (la foto solo se ve dentro de un consultorio: sin esto, cualquier alta suelta
 * tendría 1 MB de Storage gratis); borrar no (quien se fue de todos sus consultorios tiene que poder sacar su foto).
 *
 * Orden de la subida (C-FC9, como el logo y la firma de lib/practice-assets.ts): sesión → rate limit → chequeo de los
 * bytes (PNG/JPEG por magic bytes, ≤ 1 MB, ≤ 2048 px) → limpieza de metadatos (EXIF/GPS: la foto se publica) → upload
 * con clave nueva → tx (`FOR UPDATE` + UNA escritura de las dos columnas) → DESPUÉS del commit se borra el objeto viejo.
 * Si la tx falla se borra el NUEVO; si falla el borrado del viejo queda un huérfano en un bucket privado (logueado).
 *
 * Registro: cada cambio deja `photo.updated` / `photo.removed` en `UserSecurityEvent` («Seguridad de la cuenta»), en la
 * MISMA tx de la escritura (`writeOwnPhotoInTx`, CF3 ZF4a): la foto sale en páginas públicas y la persona tiene que
 * poder ver si alguien con su sesión la cambió. Sin `AuditEvent`: ese registro es por consultorio y la foto es de la
 * persona; el opt-in público, que sí es del consultorio, se audita (`setOwnShowPhotoPublic`).
 *
 * Post-commit (CF3 ZF5, B): se revalida SOLO lo que muestra esta foto.
 *   - Las superficies públicas de los consultorios donde la persona la publica (`publicSlugs`, de la misma lectura
 *     bloqueante de la tx: 0 sentencias más): `/<slug>`, `/c/<slug>/booking` y el snapshot global de las sedes
 *     (`CLINIC_SITES_TAG`; el del directorio comparte la entrada por `DIRECTORY_TAG`). Sin opt-in en ningún lado no
 *     se toca ningún cache público. Antes era `revalidatePath("/", "layout")`, que tiraba el cache de TODAS las páginas
 *     de TODOS los consultorios por cada foto de cualquiera.
 *   - En la app, el avatar del shell lo cambia al toque «Tu foto» (`UserPhotoProvider`, sin esperar al server) y el
 *     layout lo lee fresco en la próxima carga (foto de acceso, sin cache). `/configuracion` se revalida para que
 *     «Mi agenda» (la página desde donde se sube) se vuelva a pintar con la URL nueva.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getAccessSnapshot, getActor } from "@/lib/session";
import { auditInTx } from "@/lib/audit";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { CLINIC_SITES_TAG, DIRECTORY_TAG } from "@/lib/cache-tags";
import { isStorageConfigured, storageRemove, storageUpload } from "@/lib/storage-internal";
import { readImageInfo } from "@/lib/file-sniff";
import { writeOwnPhotoInTx, type WriteOwnPhotoResult } from "@/lib/user-photo-internal";
import {
  USER_PHOTO_BUCKET as BUCKET,
  USER_PHOTO_COPY as COPY,
  USER_PHOTO_LIMITS,
  USER_PHOTO_UPLOAD_RATE_LIMIT,
  checkUserPhoto,
  nextPhotoStamp,
  ownPhotoUrl,
  stripImageMetadata,
  userPhotoKey,
} from "@/lib/user-photo-logic";
import type { ActionResult } from "@/lib/validation";

type PhotoSession = { ok: true; userId: string; hasUsable: boolean } | { ok: false; error: string };

async function resolvePhotoSession(): Promise<PhotoSession> {
  const s = await getAccessSnapshot();
  if (!s?.profile) return { ok: false, error: COPY.noSession };
  if (s.profile.disabledAt) return { ok: false, error: COPY.disabled };
  if (s.twoFactor.state === "required") return { ok: false, error: COPY.pending2fa };
  return { ok: true, userId: s.userId, hasUsable: s.usable.length > 0 };
}

/** Una cuenta para subir y borrar: el reemplazo en bucle es lo que llena Storage y el log. */
async function photoRateLimit(userId: string): Promise<string | null> {
  const rl = await rateLimit(`user-photo:write:${userId}`, USER_PHOTO_UPLOAD_RATE_LIMIT);
  return rl.ok ? null : rateLimitedMessage(rl.retryAfterMs);
}

/** Post-commit de subir/borrar (ver la cabecera): `/configuracion` y, solo si la foto sale en alguno, lo público. */
function revalidatePhotoSurfaces(publicSlugs: readonly string[]): void {
  revalidatePath("/configuracion");
  if (publicSlugs.length === 0) return;
  revalidateTag(CLINIC_SITES_TAG);
  revalidateTag(DIRECTORY_TAG);
  for (const slug of publicSlugs) {
    revalidatePath(`/${slug}`);
    revalidatePath(`/c/${slug}/booking`);
  }
}

/**
 * Sube (o reemplaza) la foto propia. FormData con el campo `file` (PNG o JPEG, ≤ 1 MB; el cliente ya la reduce a
 * 512 × 512 con canvas). Devuelve la URL del avatar con la versión nueva (`/api/me/photo?v=<ms>`).
 */
export async function uploadOwnPhoto(form: FormData): Promise<ActionResult<{ photoUrl: string }>> {
  const ses = await resolvePhotoSession();
  if (!ses.ok) return ses;
  if (!ses.hasUsable) return { ok: false, error: COPY.noMembership };
  const limited = await photoRateLimit(ses.userId);
  if (limited) return { ok: false, error: limited };

  const file = form instanceof FormData ? form.get("file") : null;
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: COPY.missing };
  // Tope antes de leer el archivo a memoria (el chequeo lo repite sobre los bytes reales).
  if (file.size > USER_PHOTO_LIMITS.maxBytes) return { ok: false, error: COPY.format };
  const raw = new Uint8Array(await file.arrayBuffer());
  const checked = checkUserPhoto(raw, file.type);
  if (!checked.ok) return checked;
  // Sin metadatos ni bytes de más; si la estructura está rota no se sube nada. La imagen limpia se vuelve a leer: lo
  // que se guarda es lo que se validó.
  const bytes = stripImageMetadata(raw, checked.mime);
  const info = bytes ? readImageInfo(bytes) : null;
  if (!bytes || !info || info.mime !== checked.mime || info.width !== checked.width || info.height !== checked.height) {
    return { ok: false, error: COPY.fake };
  }
  if (!isStorageConfigured()) return { ok: false, error: COPY.noStorage };

  const key = userPhotoKey(ses.userId, randomBytes(12).toString("hex"), checked.ext);
  if (!key) {
    // Un id de Supabase es un UUID: esto no pasa salvo una fila rota. Nunca la clave en el log.
    logger.warn("user_photo.bad_user_id", { userId: ses.userId });
    return { ok: false, error: COPY.saveFailed };
  }
  const up = await storageUpload(BUCKET, key, bytes, checked.mime);
  if (!up.ok) return { ok: false, error: COPY.saveFailed };

  const now = new Date();
  let res: WriteOwnPhotoResult;
  try {
    res = await prismaService.$transaction((tx) =>
      writeOwnPhotoInTx(tx, ses.userId, { key, stampFrom: (prev) => nextPhotoStamp(prev, now) })
    );
  } catch (err) {
    // La fila no cambió: el objeto nuevo no lo referencia nadie. 23514 (un CHECK de M24 que la app no espejó) u otra
    // falla de la base: copy propio, el código al log.
    await storageRemove(BUCKET, [key]);
    logger.warn("user_photo.save_failed", { userId: ses.userId, code: (err as { code?: string })?.code ?? "unknown" });
    return { ok: false, error: COPY.saveFailed };
  }
  if (!res || !res.at) {
    await storageRemove(BUCKET, [key]);
    return { ok: false, error: COPY.noSession };
  }
  // Después del commit: el viejo ya no lo referencia ninguna fila.
  if (res.oldKey && res.oldKey !== key) await storageRemove(BUCKET, [res.oldKey]);
  revalidatePhotoSurfaces(res.publicSlugs);
  return { ok: true, data: { photoUrl: ownPhotoUrl(res.at)! } };
}

/** Saca la foto propia (las dos columnas a null) y borra el objeto después del commit. Sin foto → ok sin escribir. */
export async function removeOwnPhoto(): Promise<ActionResult> {
  const ses = await resolvePhotoSession();
  if (!ses.ok) return ses;
  const limited = await photoRateLimit(ses.userId);
  if (limited) return { ok: false, error: limited };
  let res: WriteOwnPhotoResult;
  try {
    res = await prismaService.$transaction((tx) => writeOwnPhotoInTx(tx, ses.userId, null));
  } catch (err) {
    logger.warn("user_photo.remove_failed", { userId: ses.userId, code: (err as { code?: string })?.code ?? "unknown" });
    return { ok: false, error: COPY.removeFailed };
  }
  if (!res) return { ok: false, error: COPY.noSession };
  if (!res.changed) return { ok: true, data: undefined };
  if (res.oldKey && isStorageConfigured()) await storageRemove(BUCKET, [res.oldKey]);
  revalidatePhotoSurfaces(res.publicSlugs);
  return { ok: true, data: undefined };
}

/**
 * Opt-in de la foto en el turnero y la sede de ESTE consultorio (el activo). Solo el profesional propio
 * (`actor.practitionerId`, nunca un input); el soporte no. Prenderlo sin foto subida es válido: no publica nada hasta
 * que haya una (la app publica solo con flag Y foto).
 */
export async function setOwnShowPhotoPublic(
  ...args: Parameters<typeof setOwnShowPhotoPublicImpl>
): ReturnType<typeof setOwnShowPhotoPublicImpl> {
  return withReadOnlyResult(() => setOwnShowPhotoPublicImpl(...args));
}

async function setOwnShowPhotoPublicImpl(show: boolean): Promise<ActionResult<{ showPhotoPublic: boolean }>> {
  const actor = await getActor();
  if (actor.support) return { ok: false, error: COPY.supportDenied };
  // Narrow a una variable (guard IAM-4a: nunca `id: actor.practitionerId` crudo, que con null compilaría a IS NULL).
  const practitionerId = actor.practitionerId;
  if (!practitionerId) return { ok: false, error: COPY.ownOnly };
  // Booleano real: un «"false"» truthy lo dejaría prendido creyendo que se apagó.
  const parsed = z.boolean().safeParse(show);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const to = parsed.data;
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const [prev] = await tx.$queryRaw<{ showPhotoPublic: boolean }[]>`
      SELECT "showPhotoPublic" FROM "Practitioner"
       WHERE "id" = ${practitionerId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`;
    if (!prev) return "notFound" as const;
    if (prev.showPhotoPublic === to) return "same" as const;
    await tx.practitioner.updateMany({ where: { id: practitionerId, tenantId: actor.tenantId }, data: { showPhotoPublic: to } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.public_photo",
      entity: "Practitioner",
      entityId: practitionerId,
      payload: { from: prev.showPhotoPublic, to },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: COPY.notFound };
  if (res === "changed") {
    revalidatePath("/configuracion");
    revalidatePath(`/c/${actor.tenantSlug}/booking`);
    revalidatePath(`/${actor.tenantSlug}`);
    revalidateTag(CLINIC_SITES_TAG);
    revalidateTag(DIRECTORY_TAG);
  }
  return { ok: true, data: { showPhotoPublic: to } };
}
