"use server";

/**
 * «Entrar como soporte» / «Salir de soporte» (BO2-E, C-BO9, plan §19.5; decisión 3 de Martin) y la lista
 * «Accesos de soporte» de Configuración. La lógica vive en `lib/support-session-internal.ts` (server-only): acá solo
 * el orden de cada action.
 *
 * - `startSupport`: `requirePlatformAdmin("support.start")` (riesgo high + rate limit; MFA en BO4: **el soporte no
 *   se despliega sin BO4**, escribe en Configuración) → zod → `startSupportSession`.
 * - `endSupport`: `requirePlatformAdmin()` → `endSupportSession("exit")`. El logout lo cierra por su cuenta
 *   (`app/api/auth/sign-out/route.ts`).
 * - `listSupportSessionsForTenant`: es del lado del CONSULTORIO (la ve el OWNER/ADMIN en Configuración), no de
 *   Plataforma: `requireCapability("tenant.admin")` + `runWithRls` (M7 le dio a `SupportSession` una policy SELECT por
 *   tenant justo para esto). Desvío del invariante «un `requirePlatformAdmin` por export de lib/platform-*»: el prompt
 *   de BO2-E la pone en este archivo; el guard de BO-Z la tiene que exceptuar (o BO3-F la mueve a un archivo del
 *   consultorio).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { requireCapability } from "@/lib/authz";
import { ForbiddenError } from "@/lib/session";
import { isVercelProduction, platformMfaEnforcement } from "@/lib/env";
import { runWithRls } from "@/lib/rls";
import {
  SUPPORT_REASON_MAX,
  SUPPORT_REASON_MIN,
  SupportSessionError,
  endSupportSession,
  startSupportSession,
  toSupportSessionRow,
  type SupportSessionRow,
} from "@/lib/support-session-internal";
import type { ActionResult } from "@/lib/validation";

/** BO-Z (B3). No se exporta: un archivo "use server" solo exporta funciones async. */
const SUPPORT_NEEDS_MFA_MESSAGE = "Activá la verificación en dos pasos de Plataforma para entrar como soporte.";

const StartSupportInput = z.object({
  tenantId: z.string().trim().min(1).max(64),
  reason: z
    .string()
    .trim()
    .min(SUPPORT_REASON_MIN, `Contá el motivo (mínimo ${SUPPORT_REASON_MIN} caracteres).`)
    .max(SUPPORT_REASON_MAX, `El motivo puede tener hasta ${SUPPORT_REASON_MAX} caracteres.`),
});

export async function startSupport(
  tenantId: string,
  reason: string
): Promise<ActionResult<{ sessionId: string; redirectTo: string }>> {
  const actor = await requirePlatformAdmin("support.start");
  // BO-Z (B3, decisión aplicada; Martin confirma): el soporte ESCRIBE en Configuración de un consultorio ajeno. En
  // Production no se abre con `PLATFORM_MFA_ENFORCEMENT` apagado: con una sesión de superadmin robada (sin TOTP) se
  // entraba igual. Fuera de Production (preview, local) sigue permitido para probar el flujo antes de enrolarse.
  if (isVercelProduction() && platformMfaEnforcement() !== "enforce") {
    return { ok: false, error: SUPPORT_NEEDS_MFA_MESSAGE };
  }
  const parsed = StartSupportInput.safeParse({ tenantId, reason });
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos", fieldErrors };
  }
  try {
    const { sessionId } = await startSupportSession({ actor, tenantId: parsed.data.tenantId, reason: parsed.data.reason });
    // El shell de la app cambia de consultorio: que el próximo render no use el árbol cacheado del propio.
    revalidatePath("/", "layout");
    return { ok: true, data: { sessionId, redirectTo: "/dashboard" } };
  } catch (err) {
    if (err instanceof SupportSessionError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function endSupport(): Promise<ActionResult<{ redirectTo: string }>> {
  await requirePlatformAdmin();
  await endSupportSession("exit");
  revalidatePath("/", "layout");
  return { ok: true, data: { redirectTo: "/plataforma" } };
}

/** «Accesos de soporte» del consultorio activo, del más reciente al más viejo (las abiertas primero no: por fecha). */
export async function listSupportSessionsForTenant(): Promise<SupportSessionRow[]> {
  const { actor } = await requireCapability("tenant.admin", "Solo OWNER/ADMIN ven los accesos de soporte.");
  // BO-Z (C3): la lista es del CONSULTORIO (quién entró, cuándo y por qué). Un superadmin como soporte no la lee:
  // vería los motivos y los mails de los otros accesos de Plataforma. Hoy SUPPORT_CAPS no trae `tenant.admin`; esto
  // es explícito para que un cambio de capacidades no la abra por accidente.
  if (actor.support) throw new ForbiddenError("Solo OWNER/ADMIN ven los accesos de soporte.");
  const rows = await runWithRls(actor.tenantId, (tx) =>
    tx.supportSession.findMany({
      where: { tenantId: actor.tenantId },
      orderBy: { startedAt: "desc" },
      take: 100,
      select: {
        id: true,
        reason: true,
        startedAt: true,
        endedAt: true,
        endedReason: true,
        superadmin: { select: { email: true } },
      },
    })
  );
  return rows.map(toSupportSessionRow);
}
