"use server";

/**
 * CF3b CT-L (M23 `cf3_co_titular`, decisión de Martin del 05-nov): la matrícula de la PERSONA, opcional, como dato de
 * seguridad. La carga cada profesional en Configuración › «Mi agenda» (sección «Matrícula») y la ve SOLO el Titular
 * principal en Usuarios antes de dar «Co-titular» (lectura: `listTeamMembersInTx`, lib/invitations-read.ts). No se
 * publica (no es la del directorio ni la de «Mis fichas»: ver la cabecera de `lib/user-license-logic.ts`).
 *
 * Canal: `prismaService`, como la 2FA y el perfil público. Es una superficie SIN Actor de consultorio: la matrícula es
 * de la persona y cruza todos sus consultorios, así que no hay `tenantId` para `runWithRls`; y el evento va a
 * `UserSecurityEvent`, que es SERVICE_ONLY (M8). `UserProfile` no tiene RLS: la barrera es que el `userId` sale SIEMPRE
 * de la sesión verificada (`getAccessSnapshot`, la misma foto del gate y de `getActor`). Ninguna action recibe un
 * `userId`; si el cliente lo manda en el objeto, zod lo descarta.
 *
 * Gate (`resolveLicenseSession`): sesión con perfil, cuenta no deshabilitada y 2FA no pendiente (con solo la contraseña
 * robada no se cambia un dato de seguridad). Cargar o cambiar exige además atender en al menos un consultorio usable
 * (miembro clínico con `Practitioner`, como el perfil público); BORRAR no: quien dejó de atender (le cambiaron el rol a
 * Secretaria, se fue del consultorio) tiene que poder sacar su dato.
 *
 * Rate limit liviano (20 cada 10 min por usuario): es un formulario de un campo; el tope frena un script que use el
 * endpoint para llenar el registro de seguridad de eventos.
 */
import { revalidatePath } from "next/cache";
import { prismaService } from "@/lib/db";
import { getAccessSnapshot } from "@/lib/session";
import { isClinicalMember } from "@/lib/roles";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { ownLicenseInTx, writeOwnLicenseInTx } from "@/lib/user-license-internal";
import { parseUserLicenseInput, USER_LICENSE_COPY as COPY, type UserLicenseView } from "@/lib/user-license-logic";
import { setOwnLicenseSchema, type SetOwnLicenseInput } from "@/lib/user-license-schemas";
import type { ActionResult } from "@/lib/validation";

const MIN = 60_000;
const SET_LIMIT = { limit: 20, windowMs: 10 * MIN };

type LicenseSession = { ok: true; userId: string; attends: boolean } | { ok: false; error: string };

async function resolveLicenseSession(): Promise<LicenseSession> {
  const s = await getAccessSnapshot();
  if (!s?.profile) return { ok: false, error: COPY.noSession };
  if (s.profile.disabledAt) return { ok: false, error: COPY.disabled };
  if (s.twoFactor.state === "required") return { ok: false, error: COPY.pending2fa };
  // Usable = aceptada, habilitada, consultorio no suspendido ni dado de baja (`usable` de la foto). Una Secretaria con
  // una fila `Practitioner` vieja (antes de IAM-4a) no cuenta.
  const attends = s.usable.some((m) => m.practitionerId !== null && isClinicalMember(m));
  return { ok: true, userId: s.userId, attends };
}

/** La matrícula propia (null = no cargó) y cuándo cambió. Nunca recibe un id. */
export async function getOwnLicense(): Promise<ActionResult<UserLicenseView>> {
  const ses = await resolveLicenseSession();
  if (!ses.ok) return ses;
  const view = await ownLicenseInTx(prismaService, ses.userId);
  if (!view) return { ok: false, error: COPY.noSession };
  return { ok: true, data: view };
}

/**
 * Carga, cambia o borra (los tres null) la matrícula propia. Errores por campo (`kind`, `number`, `jurisdiction`) con el
 * copy de `parseUserLicenseInput`. Sin cambio real → `ok` sin escribir ni dejar evento.
 */
export async function setOwnLicense(input: SetOwnLicenseInput): Promise<ActionResult<UserLicenseView>> {
  const ses = await resolveLicenseSession();
  if (!ses.ok) return ses;
  const rl = await rateLimit(`license:set:${ses.userId}`, SET_LIMIT);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const shape = setOwnLicenseSchema.safeParse(input ?? {});
  if (!shape.success) return { ok: false, error: COPY.invalid };
  const parsed = parseUserLicenseInput(shape.data);
  if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: parsed.fieldErrors };
  if (parsed.data !== null && !ses.attends) return { ok: false, error: COPY.notPractitioner };

  let res: Awaited<ReturnType<typeof writeOwnLicenseInTx>>;
  try {
    res = await prismaService.$transaction((tx) => writeOwnLicenseInTx(tx, ses.userId, parsed.data));
  } catch (err) {
    // 23514 (un CHECK de M23 que el parser no espejó) u otra falla de la base: copy propio, el detalle al log (sin el
    // número: es un dato personal).
    logger.warn("user_license.save_failed", { userId: ses.userId, code: (err as { code?: string })?.code ?? "unknown" });
    return { ok: false, error: COPY.saveFailed };
  }
  if (!res) return { ok: false, error: COPY.noSession };
  // «Mi agenda» y Usuarios leen la matrícula en el loader de /configuracion.
  if (res.changed) revalidatePath("/configuracion");
  return { ok: true, data: res.view };
}
