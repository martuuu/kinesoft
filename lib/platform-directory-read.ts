import "server-only";
/**
 * /plataforma/directorio · lectura para moderar (DIR-2c, plan §20.10; C-DIR9 «lista de consultorios publicados y
 * perfiles, filtros, ocultar con motivo, verificar matrícula»). La consume la página de DIR-3e; no es una server
 * action (sin "use server": no tiene por qué ser invocable con un POST desde el browser).
 *
 * Seguridad (invariantes del gate de BO):
 *  - `requirePlatformAdmin("platform.read")` en CADA export, primero: todo va por el canal service (BYPASSRLS), y
 *    `ProfessionalPublicProfile` es SERVICE_ONLY (M11: el rol app no la ve).
 *  - Sin PHI: `Tenant`, `ProfessionalPublicProfile` y `Practitioner → Tenant` (dónde atiende la persona). Nada de
 *    pacientes, turnos ni historia clínica.
 *  - Sin email: el directorio no los usa (DIR-D15) y el superadmin identifica a la persona por su nombre público y
 *    su `userId` (link a /plataforma/usuarios/<id>, que sí muestra el mail con su propia barrera).
 *  - DTO con lista cerrada de campos, armado campo por campo (nunca spread de la fila): el test de integración fija
 *    las claves.
 *
 * Lo que se lista: los consultorios que el Titular publicó o que Plataforma ocultó (los demás no son asunto del
 * directorio) y todos los perfiles creados (también los no publicados: el superadmin ve quién retiró el
 * consentimiento). Tope de filas por lista (`PLATFORM_DIRECTORY_LIMIT`) con aviso de truncado: no hay paginado en v1
 * (un directorio de cientos de filas se recorre con el filtro).
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { escapeLike } from "@/lib/email-match";

export const PLATFORM_DIRECTORY_LIMIT = 200;

export type PlatformDirectoryStatusFilter = "todos" | "publicados" | "ocultos" | "sin_verificar";

export type PlatformDirectoryQueryInput = { q?: string | null; estado?: string | null };

export type PlatformDirectoryModeration = { at: string; reason: string } | null;

export type PlatformDirectoryClinicRow = {
  tenantId: string;
  name: string;
  slug: string;
  /** El switch del Titular (C-DIR8): Plataforma no lo toca, solo oculta encima. */
  directoryListed: boolean;
  directoryListedAt: string | null;
  /** El directorio necesita el turnero prendido (C-DIR4); se muestra para explicar por qué no aparece. */
  publicBookingEnabled: boolean;
  tenantStatus: string;
  hasDescription: boolean;
  hidden: PlatformDirectoryModeration;
};

export type PlatformDirectoryProfileRow = {
  profileId: string;
  /** Para el link a /plataforma/usuarios/<id>; nunca sale a una superficie pública. */
  userId: string;
  publicName: string;
  /** Código (LIC | KLGO | KLGA | DR | DRA). */
  honorific: string | null;
  license: { kind: string; number: string; jurisdiction: string | null; verifiedAt: string | null } | null;
  listed: boolean;
  consentAt: string | null;
  consentVersion: string | null;
  consentWithdrawnAt: string | null;
  hidden: PlatformDirectoryModeration;
  /** Consultorios donde la persona tiene `Practitioner` (dónde atiende), por nombre. */
  clinics: { tenantId: string; name: string; slug: string }[];
  updatedAt: string;
};

export type PlatformDirectoryView = {
  filters: { q: string; estado: PlatformDirectoryStatusFilter };
  clinics: PlatformDirectoryClinicRow[];
  profiles: PlatformDirectoryProfileRow[];
  /** Hay más filas que el tope: afinar el filtro. */
  truncated: { clinics: boolean; profiles: boolean };
};

const ESTADOS = ["todos", "publicados", "ocultos", "sin_verificar"] as const;

// Tolerante: viene de la query string de la página; un valor raro cae al default en vez de romper.
const Query = z.object({
  q: z.preprocess((v) => (typeof v === "string" ? v.trim().slice(0, 100) : ""), z.string()),
  estado: z.preprocess((v) => (typeof v === "string" && (ESTADOS as readonly string[]).includes(v) ? v : "todos"), z.enum(ESTADOS)),
});

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function moderation(at: Date | null, reason: string | null): PlatformDirectoryModeration {
  return at ? { at: at.toISOString(), reason: reason ?? "" } : null;
}

function clinicWhere(q: string, estado: PlatformDirectoryStatusFilter): Prisma.TenantWhereInput | null {
  const base: Prisma.TenantWhereInput[] = [{ OR: [{ directoryListed: true }, { directoryHiddenAt: { not: null } }] }];
  if (estado === "publicados") base.push({ directoryListed: true, directoryHiddenAt: null });
  else if (estado === "ocultos") base.push({ directoryHiddenAt: { not: null } });
  else if (estado === "sin_verificar") return null; // la verificación es de la matrícula: no aplica a consultorios
  if (q) {
    const like = escapeLike(q);
    base.push({ OR: [{ name: { contains: like, mode: "insensitive" } }, { slug: { contains: like, mode: "insensitive" } }] });
  }
  return { AND: base };
}

function profileWhere(q: string, estado: PlatformDirectoryStatusFilter): Prisma.ProfessionalPublicProfileWhereInput {
  const base: Prisma.ProfessionalPublicProfileWhereInput[] = [];
  if (estado === "publicados") base.push({ listed: true, hiddenAt: null });
  else if (estado === "ocultos") base.push({ hiddenAt: { not: null } });
  // Cola de verificación: lo que hoy se ve (o se vería al levantar la moderación) con matrícula sin verificar.
  else if (estado === "sin_verificar") base.push({ listed: true, licenseNumber: { not: null }, licenseVerifiedAt: null });
  if (q) base.push({ publicName: { contains: escapeLike(q), mode: "insensitive" } });
  return base.length ? { AND: base } : {};
}

/** Consultorios y perfiles del directorio, con su estado de moderación. */
export async function getPlatformDirectory(raw: PlatformDirectoryQueryInput = {}): Promise<PlatformDirectoryView> {
  await requirePlatformAdmin("platform.read");
  const { q, estado } = Query.parse({ q: raw.q, estado: raw.estado });
  const cw = clinicWhere(q, estado);

  const [tenants, profiles] = await Promise.all([
    cw
      ? prismaService.tenant.findMany({
          where: cw,
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            publicBookingEnabled: true,
            directoryListed: true,
            directoryListedAt: true,
            directoryHiddenAt: true,
            directoryHiddenReason: true,
            publicDescription: true,
          },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: PLATFORM_DIRECTORY_LIMIT + 1,
        })
      : Promise.resolve([]),
    prismaService.professionalPublicProfile.findMany({
      where: profileWhere(q, estado),
      select: {
        id: true,
        userId: true,
        publicName: true,
        honorific: true,
        licenseKind: true,
        licenseNumber: true,
        licenseJurisdiction: true,
        licenseVerifiedAt: true,
        listed: true,
        consentAt: true,
        consentVersion: true,
        consentWithdrawnAt: true,
        hiddenAt: true,
        hiddenReason: true,
        updatedAt: true,
      },
      orderBy: [{ publicName: "asc" }, { id: "asc" }],
      take: PLATFORM_DIRECTORY_LIMIT + 1,
    }),
  ]);

  const profileRows = profiles.slice(0, PLATFORM_DIRECTORY_LIMIT);
  // Dónde atiende cada persona: una sola query para toda la página (sin N+1).
  const practitioners = profileRows.length
    ? await prismaService.practitioner.findMany({
        where: { userId: { in: profileRows.map((p) => p.userId) } },
        select: { userId: true, tenant: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ tenant: { name: "asc" } }, { tenantId: "asc" }],
      })
    : [];
  const clinicsByUser = new Map<string, { tenantId: string; name: string; slug: string }[]>();
  for (const pr of practitioners) {
    const list = clinicsByUser.get(pr.userId) ?? [];
    list.push({ tenantId: pr.tenant.id, name: pr.tenant.name, slug: pr.tenant.slug });
    clinicsByUser.set(pr.userId, list);
  }

  return {
    filters: { q, estado },
    clinics: tenants.slice(0, PLATFORM_DIRECTORY_LIMIT).map((t) => ({
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      directoryListed: t.directoryListed,
      directoryListedAt: iso(t.directoryListedAt),
      publicBookingEnabled: t.publicBookingEnabled,
      tenantStatus: t.status,
      hasDescription: !!t.publicDescription?.trim(),
      hidden: moderation(t.directoryHiddenAt, t.directoryHiddenReason),
    })),
    profiles: profileRows.map((p) => ({
      profileId: p.id,
      userId: p.userId,
      publicName: p.publicName,
      honorific: p.honorific,
      license:
        p.licenseKind && p.licenseNumber
          ? {
              kind: p.licenseKind,
              number: p.licenseNumber,
              jurisdiction: p.licenseJurisdiction,
              verifiedAt: iso(p.licenseVerifiedAt),
            }
          : null,
      listed: p.listed,
      consentAt: iso(p.consentAt),
      consentVersion: p.consentVersion,
      consentWithdrawnAt: iso(p.consentWithdrawnAt),
      hidden: moderation(p.hiddenAt, p.hiddenReason),
      clinics: clinicsByUser.get(p.userId) ?? [],
      updatedAt: p.updatedAt.toISOString(),
    })),
    truncated: { clinics: tenants.length > PLATFORM_DIRECTORY_LIMIT, profiles: profiles.length > PLATFORM_DIRECTORY_LIMIT },
  };
}
