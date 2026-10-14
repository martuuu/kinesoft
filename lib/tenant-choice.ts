import "server-only";
/**
 * Elección del consultorio activo (IAM-3a, contrato C-IAM7; lo consume el selector del sidebar de IAM-3b).
 *
 * Decisión 6 de Martin (14-oct): un mismo usuario puede ser profesional en varios consultorios y, **cada vez que
 * inicia sesión con más de un consultorio usable, la app le pregunta a cuál entrar**. El login borra la cookie
 * `kine_tenant` (`/api/auth/sign-in`), así que después de cada login `needsChoice` es true hasta que elige; el
 * layout de la app lo manda a `/elegir-consultorio`.
 *
 * Server-only y no `"use server"`: exporta tipos y lo llaman las actions de cada pantalla
 * (`app/elegir-consultorio/choose-action.ts`, y la del selector de 3b), que son las que pueden escribir cookies.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import type { Role, TenantVertical } from "@prisma/client";
// Preferencia del usuario, no dato del consultorio (UserPreferences no tiene RLS: está en el allowlist del guard,
// `tenantId` es un puntero mutable). Mismo canal que la lectura de `loadAccessMemberships`; filtro = la sesión.
import { prismaService } from "@/lib/db";
import { ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_COOKIE_OPTIONS } from "@/lib/active-tenant-cookie";
import { isUsableMembership } from "@/lib/access-logic";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { ForbiddenError, UnauthenticatedError, getAccessSnapshot, loadAccessMemberships } from "@/lib/session";
import { logger } from "@/lib/logger";
import { safeNext } from "@/lib/safe-next";

export type TenantOption = { tenantId: string; name: string; slug: string; role: Role; vertical: TenantVertical };

/**
 * Consultorios a los que puede entrar la sesión (solo membresías USABLES: aceptadas, sin `disabledAt` y con
 * `Practitioner` si el rol es clínico; desde IAM-4a la Secretaria y Facturación no lo necesitan), cuál es el activo y si hay que preguntar.
 *
 * `needsChoice` = hay 2+ opciones y la cookie no apunta a una de ellas. El `UserPreferences.tenantId` NO evita la
 * pregunta (decisión 6: se pregunta en cada login); solo decide a cuál entra `getActor` mientras tanto (una action
 * que llega sin cookie, p. ej. desde otra pestaña).
 *
 * Sin sesión: sin opciones, sin activo, sin pregunta (el gate manda al login por su lado).
 */
export async function getTenantChoiceState(): Promise<{
  options: TenantOption[];
  activeTenantId: string | null;
  needsChoice: boolean;
}> {
  const s = await getAccessSnapshot();
  if (!s) return { options: [], activeTenantId: null, needsChoice: false };
  const options = s.usable
    .map<TenantOption>((m) => ({
      tenantId: m.tenantId,
      name: m.tenant.name,
      slug: m.tenant.slug,
      role: m.role,
      vertical: m.tenant.vertical,
    }))
    // Orden estable para la pantalla y el selector: por nombre (no por el orden de la query).
    .sort((a, b) => a.name.localeCompare(b.name, "es") || (a.tenantId < b.tenantId ? -1 : 1));
  return {
    options,
    activeTenantId: s.state.kind === "ok" ? s.state.tenantId : null,
    needsChoice: options.length >= 2 && !s.cookieValid,
  };
}

const TenantIdInput = z.string().trim().min(1).max(64);

/**
 * Deja `tenantId` como consultorio activo: valida que sea una membresía USABLE de la sesión (la cookie que llega
 * del cliente nunca se confía, y esta es la única que la escribe a pedido), setea la cookie httpOnly y persiste
 * `UserPreferences.tenantId` (el preferido de `chooseActiveTenant` cuando no hay cookie).
 *
 * Tira `UnauthenticatedError` sin sesión y `ForbiddenError` si el consultorio no es suyo o no es usable. Solo
 * desde una server action o un route handler (en un server component `cookies().set` tira).
 */
export async function setActiveTenant(tenantId: string): Promise<void> {
  const parsed = TenantIdInput.safeParse(tenantId);
  if (!parsed.success) throw new ForbiddenError("tenant_not_usable");
  const user = await getVerifiedSessionUser();
  if (!user) throw new UnauthenticatedError("no_session");

  // Lectura fresca (no la foto del request): entre que se pintó la pantalla y el click, lo pudieron suspender.
  const { memberships } = await loadAccessMemberships(user.id);
  const target = memberships.find((m) => m.tenantId === parsed.data);
  if (!target || !isUsableMembership(target)) {
    logger.warn("session.tenant.choose.refused", { userId: user.id, tenantId: parsed.data });
    throw new ForbiddenError("tenant_not_usable");
  }

  cookies().set(ACTIVE_TENANT_COOKIE, parsed.data, ACTIVE_TENANT_COOKIE_OPTIONS);
  await prismaService.userPreferences.upsert({
    where: { userId: user.id },
    create: { userId: user.id, tenantId: parsed.data },
    update: { tenantId: parsed.data },
  });
  logger.info("session.tenant.choose", { userId: user.id, tenantId: parsed.data });
}

/**
 * Destino después de elegir: `safeNext` (sin open redirect) y nunca de vuelta a la pantalla de elección ni a las
 * de salida del gate (volver ahí después de elegir no tiene sentido y se ve como un bucle).
 */
export function safeChoiceNext(raw: string | null | undefined): string {
  const next = safeNext(raw, "/dashboard");
  return /^\/(elegir-consultorio|sin-acceso|onboarding|login)(?:[/?#]|$)/.test(next) ? "/dashboard" : next;
}

/**
 * Borra la cookie del consultorio activo (login y logout, IAM-3a). Mismas opciones que al escribirla (un borrado
 * con otro `path` no pisa la cookie). No toca `UserPreferences.tenantId`: ese es el preferido para cuando no hay
 * cookie, no lo que fuerza la pregunta. Nunca tira (en un server component no se pueden escribir cookies).
 */
export function clearActiveTenantCookie(): void {
  try {
    cookies().set(ACTIVE_TENANT_COOKIE, "", { ...ACTIVE_TENANT_COOKIE_OPTIONS, maxAge: 0 });
  } catch {
    // Solo desde un server component; los llamadores son route handlers.
  }
}
