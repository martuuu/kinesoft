"use server";

/**
 * Perfil público POR PERSONA del directorio (DIR-2b, contrato C-DIR8; DIR-D11/D12).
 *
 * Por qué por persona y no por consultorio: el consentimiento para aparecer en un directorio público es de la persona
 * (Ley 25.326) y una persona tiene N `Practitioner` (uno por consultorio, IAM-1). La fila es única por `userId`.
 *
 * Canal: `prismaService`. `ProfessionalPublicProfile` es SERVICE_ONLY (M11: ENABLE + FORCE, cero policies): no tiene
 * `tenantId` ni hay GUC de usuario, así que `kinesoft_app` no la ve con ningún GUC. La barrera es la de las tablas de
 * 2FA: el `userId` sale SIEMPRE de la sesión verificada (`getAccessSnapshot`), nunca del input. Ninguna action
 * recibe un `userId`; si el cliente lo manda en el objeto, se ignora (no está en el tipo y no se lee).
 *
 * Gate de cada action (`resolveProfileSession`): sesión con perfil, cuenta no deshabilitada, 2FA no pendiente
 * (`required` → error: con solo la contraseña robada no se publica ni se cambia el perfil de nadie) y al menos un
 * consultorio usable donde la persona atiende (miembro clínico con `Practitioner`). No usa `getActor`: el perfil no
 * es de un consultorio (cruza todos) y `/cuenta/*` vive fuera de `(app)`.
 *
 * Consentimiento (sin `UserSecurityEvent`, C-DIR8): queda en la fila. Publicar = `listed=true` + `consentAt=now` +
 * `consentVersion` + `consentWithdrawnAt=null` en la MISMA escritura que los campos (lo publicado es lo que se
 * aceptó). Retirar = `listed=false` + `consentWithdrawnAt=now` en una escritura; el CHECK
 * `ProfessionalPublicProfile_listed_consent_check` de M11 impide en la base un `listed` sin consentimiento vigente.
 *
 * Caché: después del commit, `revalidateTag(tags.directory())`: el snapshot (`unstable_cache`, 10 min) se rearma en
 * el próximo request, así que un retiro deja de verse ahí mismo (meta de C-DIR8 / §1 del brief).
 *
 * Moderación (`hidden*`, `licenseVerified*`) NO se escribe acá: es de `lib/platform-directory.ts` (guard de escritor
 * único, `tests/unit/directory-writers.test.ts`). Cambiar la matrícula borra la verificación por el trigger de M11.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { prismaService } from "@/lib/db";
import { getAccessSnapshot } from "@/lib/session";
import { isClinicalMember } from "@/lib/roles";
import { tags } from "@/lib/cache-tags";
import { logger } from "@/lib/logger";
import { DIRECTORY_CONSENT_VERSION } from "@/lib/directory-constants";
import {
  checkConsent,
  parsePublicProfileFields,
  publicProfileStatus,
  type PublicProfileFields,
  type PublicProfileFieldsInput,
  type PublicProfileStatus,
} from "@/lib/public-profile-logic";
import type { ActionResult } from "@/lib/validation";

const NO_SESSION = "Tu sesión venció. Volvé a entrar.";
const DISABLED = "Tu cuenta está deshabilitada.";
const PENDING_2FA = "Primero terminá de verificar tu acceso.";
const NOT_PRACTITIONER = "El perfil público es para quienes atienden en al menos un consultorio.";
const SAVE_FAILED = "No pudimos guardar tu perfil público. Probá de nuevo.";
const NO_PROFILE = "Primero guardá tu perfil público.";

const PATH = "/cuenta/perfil-publico";

/** Lo que ve la persona de SU perfil (incluye el estado de moderación: es suyo). */
export type MyPublicProfile = {
  /** Para prellenar el nombre público la primera vez (nunca el email: decisión 19). */
  defaultPublicName: string;
  status: PublicProfileStatus;
  profile:
    | (PublicProfileFields & {
        consentVersion: string | null;
        consentAt: string | null;
        hiddenReason: string | null;
        licenseVerified: boolean;
      })
    | null;
};

type ProfileSession = { ok: true; userId: string; fullName: string | null } | { ok: false; error: string };

/**
 * Sesión verificada de la persona (ver cabecera). `getAccessSnapshot` es la misma foto del request que usan el gate y
 * `getActor` (token verificado; cacheada por request).
 */
async function resolveProfileSession(): Promise<ProfileSession> {
  const s = await getAccessSnapshot();
  if (!s?.profile) return { ok: false, error: NO_SESSION };
  if (s.profile.disabledAt) return { ok: false, error: DISABLED };
  if (s.twoFactor.state === "required") return { ok: false, error: PENDING_2FA };
  // Usable = aceptada, habilitada, consultorio no suspendido ni dado de baja (`usable` de la foto). Además tiene que
  // atender ahí: una Secretaria con una fila `Practitioner` vieja (antes de IAM-4a) no cuenta.
  const attends = s.usable.some((m) => m.practitionerId !== null && isClinicalMember(m));
  if (!attends) return { ok: false, error: NOT_PRACTITIONER };
  return { ok: true, userId: s.userId, fullName: s.profile.fullName };
}

/** Nombre sugerido: `fullName` si no parece un email (decisión 19); si no, vacío para que la persona lo escriba. */
function suggestedName(fullName: string | null): string {
  const n = (fullName ?? "").trim();
  return n.includes("@") ? "" : n;
}

/** Después del commit: el snapshot del directorio y la pantalla del perfil. */
function revalidateProfile(): void {
  revalidateTag(tags.directory());
  revalidatePath(PATH);
}

/**
 * Lectura del perfil propio para `/cuenta/perfil-publico`. Sin sesión válida → error (la página redirige antes).
 * Exportada desde el `"use server"` a propósito: es la del propio usuario, no anónima, y nunca recibe un id.
 */
export async function getMyPublicProfile(): Promise<ActionResult<MyPublicProfile>> {
  const ses = await resolveProfileSession();
  if (!ses.ok) return ses;
  const row = await prismaService.professionalPublicProfile.findUnique({
    where: { userId: ses.userId },
    select: {
      publicName: true,
      honorific: true,
      licenseKind: true,
      licenseNumber: true,
      licenseJurisdiction: true,
      bio: true,
      listed: true,
      consentAt: true,
      consentVersion: true,
      consentWithdrawnAt: true,
      hiddenAt: true,
      hiddenReason: true,
      licenseVerifiedAt: true,
    },
  });
  return {
    ok: true,
    data: {
      defaultPublicName: suggestedName(ses.fullName),
      status: publicProfileStatus(row),
      profile: row
        ? {
            publicName: row.publicName,
            honorific: row.honorific as PublicProfileFields["honorific"],
            licenseKind: row.licenseKind as PublicProfileFields["licenseKind"],
            licenseNumber: row.licenseNumber,
            licenseJurisdiction: row.licenseJurisdiction as PublicProfileFields["licenseJurisdiction"],
            bio: row.bio,
            consentVersion: row.consentVersion,
            consentAt: row.consentAt?.toISOString() ?? null,
            hiddenReason: row.hiddenAt ? row.hiddenReason : null,
            licenseVerified: row.licenseVerifiedAt !== null,
          }
        : null,
    },
  };
}

/**
 * Crear o editar el perfil SIN tocar la publicación: si ya estaba publicado, sigue publicado con los datos nuevos
 * (el consentimiento cubre «la presentación que cargué»; editarla no lo revoca). Si cambia la matrícula, el trigger
 * de M11 borra la verificación de Plataforma.
 */
export async function savePublicProfile(
  input: PublicProfileFieldsInput
): Promise<ActionResult<{ status: PublicProfileStatus }>> {
  const ses = await resolveProfileSession();
  if (!ses.ok) return ses;
  const parsed = parsePublicProfileFields(input ?? {});
  if (!parsed.ok) return parsed;
  try {
    const row = await prismaService.professionalPublicProfile.upsert({
      where: { userId: ses.userId },
      create: { userId: ses.userId, ...parsed.data },
      update: { ...parsed.data },
      select: { listed: true, consentAt: true, consentWithdrawnAt: true, hiddenAt: true },
    });
    revalidateProfile();
    return { ok: true, data: { status: publicProfileStatus(row) } };
  } catch (e) {
    logger.error("publicProfile.save.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: SAVE_FAILED };
  }
}

/**
 * Publicar: guarda los campos y publica en UNA escritura, con la casilla tildada y la versión vigente del texto
 * (`DIRECTORY_CONSENT_VERSION`). Volver a publicar después de un retiro estampa un consentimiento nuevo. Si
 * Plataforma lo ocultó, queda publicado pero sigue sin verse hasta que Plataforma lo muestre (`status: "hidden"`).
 */
export async function publishPublicProfile(
  input: PublicProfileFieldsInput & { consentAccepted?: unknown; consentVersion?: unknown }
): Promise<ActionResult<{ status: PublicProfileStatus }>> {
  const ses = await resolveProfileSession();
  if (!ses.ok) return ses;
  const consent = checkConsent({ accepted: input?.consentAccepted, version: input?.consentVersion });
  if (!consent.ok) return consent;
  const parsed = parsePublicProfileFields(input ?? {});
  if (!parsed.ok) return parsed;
  const now = new Date();
  const publish = {
    listed: true,
    consentAt: now,
    consentVersion: DIRECTORY_CONSENT_VERSION,
    consentWithdrawnAt: null,
  };
  try {
    const row = await prismaService.professionalPublicProfile.upsert({
      where: { userId: ses.userId },
      create: { userId: ses.userId, ...parsed.data, ...publish },
      update: { ...parsed.data, ...publish },
      select: { listed: true, consentAt: true, consentWithdrawnAt: true, hiddenAt: true },
    });
    revalidateProfile();
    return { ok: true, data: { status: publicProfileStatus(row) } };
  } catch (e) {
    logger.error("publicProfile.publish.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: SAVE_FAILED };
  }
}

/**
 * Retirar el consentimiento («Dejar de publicar»): `listed=false` y `consentWithdrawnAt=now` en una sola escritura,
 * y el tag del directorio después del commit: deja de verse en el próximo request. Los datos del perfil quedan (la
 * persona puede volver a publicar); `consentAt`/`consentVersion` quedan como registro de lo que había aceptado.
 * Idempotente: sin perfil → error; ya retirado → ok sin escribir.
 */
export async function withdrawPublicProfile(): Promise<ActionResult<{ status: PublicProfileStatus }>> {
  // Retirar NO exige atender hoy en un consultorio: quien dejó de atender tiene que poder despublicarse igual. Solo
  // sesión verificada (misma barrera de 2FA).
  const s = await getAccessSnapshot();
  if (!s?.profile) return { ok: false, error: NO_SESSION };
  if (s.twoFactor.state === "required") return { ok: false, error: PENDING_2FA };
  try {
    const res = await prismaService.professionalPublicProfile.updateMany({
      where: { userId: s.userId, OR: [{ listed: true }, { consentWithdrawnAt: null, consentAt: { not: null } }] },
      data: { listed: false, consentWithdrawnAt: new Date() },
    });
    if (res.count === 0) {
      const row = await prismaService.professionalPublicProfile.findUnique({
        where: { userId: s.userId },
        select: { listed: true, consentAt: true, consentWithdrawnAt: true, hiddenAt: true },
      });
      if (!row) return { ok: false, error: NO_PROFILE };
      return { ok: true, data: { status: publicProfileStatus(row) } };
    }
    revalidateProfile();
    return { ok: true, data: { status: "withdrawn" } };
  } catch (e) {
    logger.error("publicProfile.withdraw.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: SAVE_FAILED };
  }
}
