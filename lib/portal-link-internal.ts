import "server-only";
/**
 * Vinculación de la identidad de portal con la ficha (`Patient.userId`). Extraído de la ruta del callback en IAM-0a
 * para poder testear la función REAL contra Postgres: un route handler de Next solo puede exportar los verbos HTTP y
 * la config.
 *
 * Desde ES4 (S24a) el vínculo ES la autorización del portal (`lib/portal-identity-internal.ts` resuelve por
 * (tenantId, userId) y nunca por email), así que este archivo es el ÚNICO lookup por email con fines de vínculo (el
 * otro, `resolvePortalLinkTarget`, solo decide a quién mandarle un link; ES4-D3).
 *
 * Reglas de auto-vínculo (PD-15, §14.8 E3): se vincula solo si TODAS:
 *   - email verificado (lo chequea el caller y se vuelve a chequear acá): una identidad sin verificar nunca se
 *     vincula a PHI;
 *   - no es staff (A3b, AUDIT §5.22): con Membership en cualquier consultorio no se vincula;
 *   - hay EXACTAMENTE una ficha con ese email (normalizado, sin distinguir mayúsculas) en ESE consultorio;
 *   - esa ficha no tiene `userId`.
 * 0 fichas → `no_patient`; más de una → `ambiguous` («Pedile a tu consultorio que te invite»). Hasta ES4, con dos
 * fichas del mismo email (familia que comparte el mail; el único (tenantId, email) distingue mayúsculas) se vinculaba
 * «la más vieja»: la cuenta del hijo podía quedar atada a la ficha de la madre sin que nadie lo decidiera. Ahora eso
 * lo resuelve la invitación del consultorio (token, `/portal/vincular`), que apunta a UNA ficha.
 *
 * Escritura: `linkPatientCas`, un CAS que exige count 1. Antes era `update({ where: { id } })` después de leer: una
 * ficha tomada por otra cuenta entre la lectura y la escritura se pisaba (toma de ficha), y el P2002 de
 * (tenantId, userId) salía como 500 del callback.
 *
 * IAM-0a: match de email EXACTO. Con `equals` + `mode: "insensitive"` el email iba pelado a un `ILIKE` y
 * `jpere_@hotmail.com` (verificado) se vinculaba a la ficha de `jperez@hotmail.com`. Filtro escapado + `sameEmail`.
 * IAM-3c: el log de rechazo no lleva el email (alcanza con slug y motivo).
 */
// Callback de auth sin Actor; el consultorio sale del slug y se escribe Patient/PatientTenantLink → canal service
// (BYPASSRLS). Ver lib/db.ts#prismaService. Por eso cada where lleva el tenantId explícito.
import { Prisma } from "@prisma/client";
import { prismaService as prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";

export type PortalLinkOutcome =
  | "linked"
  | "already"
  | "no_tenant"
  | "unverified"
  | "staff"
  | "no_patient"
  | "ambiguous" // >1 ficha con ese email exacto en el consultorio → pedir invitación
  | "linked_elsewhere"
  | "conflict"; // CAS count 0 o P2002 (ya tiene otra ficha en ese consultorio)

type LinkUser = { id: string; email: string | null | undefined; emailVerified: boolean };

/**
 * CAS único del portal. Exige count === 1. Lo usan el auto-vínculo y /portal/vincular. Captura P2002 → "conflict".
 *
 * SQL equivalente (literal PLANES §12):
 *   UPDATE "Patient" SET "userId"=$me WHERE id=$p AND "tenantId"=$t AND ("userId" IS NULL OR "userId"=$me) → count 1
 *   + upsert PatientTenantLink (como hoy).
 *
 * «already» = la ficha ya era de esta cuenta: no se reescribe la fila (cada login la tocaría y `Patient.updatedAt`
 * es el optimistic lock del lado consultorio: le daría «alguien la modificó» a la Secretaria que la está editando).
 * El único caso en que se escribe es el que efectivamente vincula, y ese va por el CAS con count 1.
 */
export async function linkPatientCas(o: {
  userId: string;
  tenantId: string;
  patientId: string;
}): Promise<"linked" | "already" | "conflict"> {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.patient.findFirst({
        where: { id: o.patientId, tenantId: o.tenantId },
        select: { userId: true },
      });
      // Inexistente o de otro consultorio (las FK saltean RLS: el par se valida acá) → nada que vincular.
      if (!current) return "conflict" as const;
      let outcome: "linked" | "already";
      if (current.userId === o.userId) {
        outcome = "already";
      } else {
        // ES4-Z (M1): una ficha ARCHIVADA de esta cuenta en el consultorio (archivada antes de que archivar
        // desvinculara) ocupa el único (tenantId, userId) y haría P2002. Se libera acá, en la misma tx del vínculo.
        await tx.patient.updateMany({
          where: { tenantId: o.tenantId, userId: o.userId, archivedAt: { not: null }, NOT: { id: o.patientId } },
          data: { userId: null },
        });
        const { count } = await tx.patient.updateMany({
          where: {
            id: o.patientId,
            tenantId: o.tenantId,
            OR: [{ userId: null }, { userId: o.userId }],
          },
          data: { userId: o.userId },
        });
        // count 0 = otra cuenta la tomó entre la lectura (del caller o la de arriba) y este write.
        if (count !== 1) return "conflict" as const;
        outcome = "linked";
      }
      await tx.patientTenantLink.upsert({
        where: { patientId_tenantId: { patientId: o.patientId, tenantId: o.tenantId } },
        create: { patientId: o.patientId, tenantId: o.tenantId },
        update: {},
      });
      return outcome;
    });
  } catch (err) {
    // P2002 de `Patient_tenantId_userId_key`: la cuenta ya tiene OTRA ficha en este consultorio. Antes subía como 500
    // del callback (AUDIT `portal-userid-unique-500`). El upsert del link no puede chocar (es upsert).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "conflict";
    throw err;
  }
}

export async function linkPortalPatientOnCallback(user: LinkUser, tenantSlug: string): Promise<PortalLinkOutcome> {
  if (!user.email || !user.emailVerified) return "unverified";
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true } });
  const isStaff = !!(await prisma.membership.findFirst({
    where: { userId: user.id },
    select: { id: true },
  }));
  if (tenant && isStaff) {
    logger.warn("portal.link.refused", { tenantSlug, reason: "identity_is_staff" });
    return "staff";
  }
  if (!tenant) return "no_tenant";
  // Ya vinculada a ESTA cuenta en este consultorio (el único (tenantId, userId) no admite una segunda ficha):
  // nada que hacer, y sin escribir.
  const already = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, userId: user.id, archivedAt: null },
    select: { id: true },
  });
  if (already) return "already";
  const candidates = await prisma.patient.findMany({
    // ES4-Z (M1): las archivadas no son candidatas (el portal no las muestra) ni cuentan para `ambiguous`.
    where: { tenantId: tenant.id, email: emailEqualsFilter(user.email), archivedAt: null },
    select: { id: true, userId: true, email: true },
  });
  const exact = candidates.filter((c) => sameEmail(c.email, user.email));
  if (exact.length === 0) return "no_patient";
  // PD-15: exactamente UNA ficha con ese email en el consultorio. Con dos (aunque una esté libre) no se adivina cuál
  // es la de esta persona: lo decide el consultorio con la invitación.
  if (exact.length > 1) {
    logger.warn("portal.link.refused", { tenantSlug, reason: "ambiguous" });
    return "ambiguous";
  }
  const patient = exact[0];
  if (patient.userId != null) {
    // Nunca se re-vincula una ficha de otra identidad (anti-takeover, AUDIT §5.8).
    logger.warn("portal.link.refused", { tenantSlug, reason: "patient already linked to a different identity" });
    return "linked_elsewhere";
  }
  const r = await linkPatientCas({ userId: user.id, tenantId: tenant.id, patientId: patient.id });
  if (r === "conflict") logger.warn("portal.link.refused", { tenantSlug, reason: "conflict" });
  return r;
}

const PORTAL_TENANT_RE = /^\/portal\/c\/([a-z0-9-]{1,64})(?:[/?#]|$)/;

/**
 * Vínculo al iniciar sesión (Google por `/auth/callback`, magic link por `/auth/confirm`). Solo actúa si el destino
 * es el portal:
 *   - `/portal/c/<slug>` → ese consultorio;
 *   - `/portal` (o cualquier otra ruta del portal) → cada consultorio con una ficha de ese email EXACTO;
 *   - `/portal/vincular…` → nada: vincula la página, con el token de la invitación (que apunta a UNA ficha).
 * Cualquier otro destino (staff que entra al dashboard) no vincula nada.
 * Las reglas (PD-15, AUDIT §5.8) las aplica `linkPortalPatientOnCallback` por consultorio. Nunca tira: un vínculo que
 * falla no puede dejar sin entrar.
 */
export async function linkPortalPatientsOnSignIn(user: LinkUser, next: string): Promise<PortalLinkOutcome[]> {
  if (!user.email || !user.emailVerified) return [];
  const path = next.startsWith("/") ? next : "";
  if (path !== "/portal" && !path.startsWith("/portal/") && !path.startsWith("/portal?")) return [];
  if (path === "/portal/vincular" || /^\/portal\/vincular(?:[/?#]|$)/.test(path)) return [];
  try {
    const m = PORTAL_TENANT_RE.exec(path);
    let slugs: string[];
    if (m) {
      slugs = [m[1]];
    } else {
      const rows = await prisma.patient.findMany({
        where: { email: emailEqualsFilter(user.email) },
        select: { email: true, tenant: { select: { slug: true } } },
      });
      slugs = Array.from(new Set(rows.filter((r) => sameEmail(r.email, user.email)).map((r) => r.tenant.slug)));
    }
    const out: PortalLinkOutcome[] = [];
    for (const slug of slugs) out.push(await linkPortalPatientOnCallback(user, slug));
    return out;
  } catch (err) {
    logger.warn("portal.link.failed", { error: err instanceof Error ? err.name : "unknown" });
    return [];
  }
}
