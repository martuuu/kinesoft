import "server-only";
/**
 * DIR (C-DIR4): snapshot del directorio público. UNA entrada de data cache global (`directory:snapshot:v1`, tag
 * `global:directory`, 10 min) con todos los consultorios y perfiles publicados; las tres rutas de `app/(directory)/`
 * leen de acá y filtran en memoria.
 *
 * Por qué así:
 *   • `import "server-only"` y NO `"use server"`: un archivo `"use server"` es invocable como action anónima desde
 *     cualquier cliente (lo es `getPublicClinic`, `lib/public-booking.ts:1`). El snapshot no se expone como endpoint.
 *   • Quién es reservable se decide con `getPublicClinic` (DIR-D14): la MISMA regla que el turnero (switch EV0,
 *     acceso BO2-D, membresía aceptada, rol clínico, sin suspender, switch por profesional, ≥ 1 servicio PUBLIC). Si
 *     el turnero cambia, el directorio lo sigue sin drift. Costo ≈ 8 queries por consultorio listado cada 10 min.
 *   • Canal service (BYPASSRLS): no hay Actor (visitante anónimo) y `ProfessionalPublicProfile` es SERVICE_ONLY
 *     (DIR-D12). Por eso cada query de abajo filtra a mano por los tenants que ya pasaron el filtro.
 *   • Sin cookies ni headers: dentro de `unstable_cache` una lectura dinámica rompe el ISR de las rutas (riesgo 2 del
 *     brief). `getPublicClinic` tampoco lee headers (solo los rate limits de las otras actions del turnero).
 *   • El `userId` se usa SOLO para unir practitioner → perfil y no sale de este archivo: a la lógica pura le llega
 *     `profilesByPractitioner` (practitionerId → perfil sin userId). Los `select` no traen email, rating ni precios.
 */
import { unstable_cache } from "next/cache";
// No-Actor surface (directorio público, anónimo) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { DIRECTORY_TAG } from "@/lib/cache-tags";
import { getPublicClinic } from "@/lib/public-booking";
import {
  assembleDirectorySnapshot,
  compactDirectorySnapshot,
  expandDirectorySnapshot,
  type DirectoryClinicInput,
  type DirectoryInsurerInput,
  type DirectoryProfileInput,
} from "@/lib/directory-logic";
import type { DirectorySnapshot, DirectorySpecialty } from "@/lib/directory-types";

/** Consultorios resueltos en paralelo por tanda: 4 × ~8 queries no acapara el pool del canal service. */
const CLINIC_BATCH = 4;

async function mapInBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Arma el snapshot SIN caché. Lo usan `getDirectorySnapshot` y los tests (el de integración prueba esta función real
 * contra la base, con `next/cache` mockeado en el setup).
 */
export async function buildDirectorySnapshot(now: Date = new Date()): Promise<DirectorySnapshot> {
  // 1. Opt-in del consultorio y moderación de Plataforma (M11).
  const tenants = await prisma.tenant.findMany({
    where: { directoryListed: true, directoryHiddenAt: null },
    select: { id: true, slug: true, publicDescription: true, phone: true, whatsapp: true },
    orderBy: { slug: "asc" },
  });

  // 2. Turnero abierto + ≥ 1 profesional reservable = `getPublicClinic` (misma regla, DIR-D14).
  const resolved = (
    await mapInBatches(tenants, CLINIC_BATCH, async (t) => {
      const clinic = await getPublicClinic(t.slug);
      return clinic && clinic.practitioners.length > 0 ? { tenant: t, clinic } : null;
    })
  ).filter((r): r is NonNullable<typeof r> => r !== null);
  if (resolved.length === 0) return assembleDirectorySnapshot({ builtAt: now, clinics: [], profilesByPractitioner: {} });

  const tenantIds = resolved.map((r) => r.tenant.id);
  const practitionerIds = resolved.flatMap((r) => r.clinic.practitioners.map((p) => p.id));
  const insurerIds = [...new Set(resolved.flatMap((r) => r.clinic.practitioners.flatMap((p) => p.acceptedInsurerIds ?? [])))];
  const locationIds = resolved.flatMap((r) => (r.clinic.locations ?? []).map((l) => l.id));

  const [owners, specialtyRows, insurerRows, locationRows] = await Promise.all([
    // 3. practitioner → persona: UNA query (C-DIR4). `tenantId` a mano: el canal service no tiene RLS.
    prisma.practitioner.findMany({
      where: { id: { in: practitionerIds }, tenantId: { in: tenantIds } },
      select: { id: true, userId: true },
    }),
    // Especialidades del catálogo global, sin archivadas.
    prisma.practitionerSpecialty.findMany({
      where: { practitionerId: { in: practitionerIds }, tenantId: { in: tenantIds }, specialty: { archivedAt: null } },
      select: { practitionerId: true, specialty: { select: { slug: true, name: true } } },
    }),
    // Coberturas: el nombre del catálogo si está vinculada (y vigente); si no, el del consultorio. Sin montos.
    prisma.insurer.findMany({
      where: { id: { in: insurerIds }, tenantId: { in: tenantIds } },
      select: {
        id: true,
        name: true,
        isParticular: true,
        payer: { select: { slug: true, name: true, archivedAt: true } },
      },
    }),
    // `getPublicClinic` no trae `provinceCode` (M11); se completa acá sin tocar el turnero.
    prisma.location.findMany({
      where: { id: { in: locationIds }, tenantId: { in: tenantIds } },
      select: { id: true, provinceCode: true },
    }),
  ]);

  // 4. Perfiles publicados: listed ∧ consentimiento vigente ∧ no oculto (el CHECK de M11 ya ata listed ⇒ consent;
  //    se repite acá porque es la regla de privacidad y no se delega en un CHECK que un día alguien relaja).
  const userIds = [...new Set(owners.map((o) => o.userId))];
  const profiles = userIds.length
    ? await prisma.professionalPublicProfile.findMany({
        where: {
          userId: { in: userIds },
          listed: true,
          consentAt: { not: null },
          consentVersion: { not: null },
          consentWithdrawnAt: null,
          hiddenAt: null,
          // DIR-Z (revisor A, M2): un usuario deshabilitado por Plataforma no puede entrar a retirarse; sale solo.
          user: { disabledAt: null },
        },
        select: {
          id: true,
          userId: true,
          publicName: true,
          honorific: true,
          licenseKind: true,
          licenseNumber: true,
          licenseJurisdiction: true,
          bio: true,
          licenseVerifiedAt: true,
        },
      })
    : [];
  const profileByUser = new Map<string, DirectoryProfileInput>(
    profiles.map(({ userId, licenseVerifiedAt, ...p }) => [userId, { ...p, licenseVerified: licenseVerifiedAt !== null }])
  );
  const profilesByPractitioner: Record<string, DirectoryProfileInput> = {};
  for (const o of owners) {
    const profile = profileByUser.get(o.userId);
    if (profile) profilesByPractitioner[o.id] = profile;
  }

  const specialtiesByPractitioner: Record<string, DirectorySpecialty[]> = {};
  for (const r of specialtyRows) (specialtiesByPractitioner[r.practitionerId] ??= []).push(r.specialty);

  const insurers: Record<string, DirectoryInsurerInput> = {};
  for (const i of insurerRows) {
    const payer = i.payer && i.payer.archivedAt === null ? i.payer : null;
    insurers[i.id] = { isParticular: i.isParticular, name: payer?.name ?? i.name, payerSlug: payer?.slug ?? null };
  }
  const provinceByLocation = new Map(locationRows.map((l) => [l.id, l.provinceCode]));

  const clinics: DirectoryClinicInput[] = resolved.map(({ tenant, clinic }) => ({
    slug: clinic.slug,
    name: clinic.name,
    description: tenant.publicDescription,
    phone: tenant.phone,
    whatsapp: tenant.whatsapp,
    locations: (clinic.locations ?? []).map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      addressLine2: l.addressLine2,
      city: l.city,
      provinceCode: provinceByLocation.get(l.id) ?? null,
    })),
    practitioners: clinic.practitioners.map((p) => ({
      id: p.id,
      locationIds: p.locationIds,
      acceptedInsurerIds: p.acceptedInsurerIds,
    })),
    insurers,
    specialtiesByPractitioner,
  }));

  return assembleDirectorySnapshot({ builtAt: now, clinics, profilesByPractitioner });
}

/**
 * Entrada del data cache (C-DIR4): la forma COMPACTA (`compactDirectorySnapshot`). Lo invalidan
 * `revalidateTag(tags.directory())` después del commit de cada escritor del directorio y todo lo que pasa por
 * `tenantEntitlementTags`. ≤ 1 MB serializado con 200 consultorios × 5 profesionales: el data cache de Next 14 no
 * guarda entradas de más de 2 MB y no avisa (la expandida medía 2,7 MB; lo fija el test de volumen de
 * `tests/unit/directory-logic.test.ts`).
 */
const getCompactDirectorySnapshot = unstable_cache(
  async () => compactDirectorySnapshot(await buildDirectorySnapshot()),
  ["directory:snapshot:v1"],
  { tags: [DIRECTORY_TAG], revalidate: 600 }
);

/** Snapshot del directorio para las páginas: cacheado (10 min / tag) y expandido en memoria (C-DIR3). */
export async function getDirectorySnapshot(): Promise<DirectorySnapshot> {
  return expandDirectorySnapshot(await getCompactDirectorySnapshot());
}
