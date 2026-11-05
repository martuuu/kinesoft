import "server-only";
/**
 * CF3 (SD-K, §30 D-CF3-9/D-CF3-10): loader de la sede digital `/<slug>`. UNA entrada de data cache global
 * (`clinic-site:snapshot:v3`; v2 = CF3 SD-U suma paleta y horarios por profesional; v3 = CF3b PH-S suma `photoUrl` por
 * profesional, que sale de `getPublicClinic` sin sentencias nuevas; tags `global:directory` + `global:sites`, 10 min) con todas las sedes publicables y sus
 * alias; la página (W4), el sitemap y el redirect de `/consultorios/<slug>` leen de acá y filtran en memoria.
 *
 * Por qué así (molde de `lib/directory-internal.ts`):
 *   • `import "server-only"` y NO `"use server"`: un export de `"use server"` es invocable como action anónima desde
 *     cualquier cliente. El snapshot no es un endpoint.
 *   • UNA entrada global y no una por slug: `/<slug>` es el primer nivel del sitio, así que cualquier URL basura
 *     (`/wp-admin`, `/xyz123`) cae en la página. Con una entrada por slug cada basura distinta sería una entrada de
 *     cache y ≈ 10 queries contra la base; acá es un lookup en memoria. El slug se valida ANTES de leer el cache.
 *   • Quién es reservable lo decide `getPublicClinic` (la misma regla que el turnero y el directorio, DIR-D14): switch
 *     EV0, acceso BO2-D, membresía aceptada, rol clínico, sin suspender, switch por profesional, ≥ 1 servicio enabled
 *     + PUBLIC. Lo que la sede suma (precios por profesional, `showPublicPrice`, OS, logo, frase) se lee acá.
 *   • Canal service (BYPASSRLS): visitante anónimo, sin Actor. Cada query filtra a mano por los tenants que ya pasaron
 *     el gate (`siteEnabled` ∧ superficies públicas abiertas).
 *   • Sin cookies ni headers: dentro de `unstable_cache` una lectura dinámica rompe el ISR de la página.
 *   • Los `select` no traen email (ni `publicEmail`), notas, WhatsApp ni teléfono de profesionales, ni userId. Lo que
 *     igual entrara lo descarta `assembleClinicSite`, que copia campo por campo al DTO cerrado.
 */
import { unstable_cache } from "next/cache";
// No-Actor surface (sede pública, anónima) → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import { DIRECTORY_TAG } from "@/lib/cache-tags";
import { getPublicClinic } from "@/lib/public-booking";
import {
  PUBLIC_BOOKING_SWITCH_SELECT,
  isPublicTurneroOpen,
  publicSurfacesOpenFor,
} from "@/lib/public-booking-internal";
import { RESERVED_SLUGS } from "@/lib/onboarding-logic";
import { toARDateKey } from "@/lib/datetime-ar";
import { publicOpeningRanges, type OpeningRange } from "@/lib/opening-hours-summary";
import {
  CLINIC_SITES_TAG,
  assembleClinicSite,
  compactClinicSite,
  isSiteSlugShape,
  lookupClinicSite,
  siteSlugsOf,
  type ClinicSiteInsurerInput,
} from "@/lib/clinic-site-logic";
import type { ClinicSiteLookup, ClinicSiteSnapshot } from "@/lib/clinic-site-types";

export { CLINIC_SITES_TAG };

/** Sedes resueltas en paralelo por tanda: 4 × ~8 queries de `getPublicClinic` no acapara el pool del canal service. */
const SITE_BATCH = 4;

async function mapInBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Arma el snapshot SIN caché. Lo usan `getClinicSiteSnapshot` y el test de integración (función real). */
export async function buildClinicSiteSnapshot(now: Date = new Date()): Promise<ClinicSiteSnapshot> {
  // 1. Opt-in del consultorio (D-CF3-10, nace apagado) + acceso (suspendido/baja cierran todo lo público, BO2-D).
  const candidates = await prisma.tenant.findMany({
    where: { siteEnabled: true },
    select: {
      id: true,
      slug: true,
      name: true,
      palette: true,
      // SD-U: red de seguridad del motor para el profesional sin franjas (como `getPublicClinic`).
      businessHoursStart: true,
      businessHoursEnd: true,
      siteTagline: true,
      publicDescription: true,
      phone: true,
      whatsapp: true,
      logoStorageKey: true,
      logoUpdatedAt: true,
      ...PUBLIC_BOOKING_SWITCH_SELECT,
    },
    orderBy: { slug: "asc" },
  });
  // Un slug reservado tiene la sede tapada por una ruta fija de la app (`pre.M22.reservedSlugs`): no se publica ni va
  // al sitemap (sería una URL que muestra otra cosa).
  const tenants = candidates.filter(
    (t) => isSiteSlugShape(t.slug) && !RESERVED_SLUGS.has(t.slug) && publicSurfacesOpenFor(t, now)
  );
  if (tenants.length === 0) return { version: 1, builtAt: now.toISOString(), sites: [], aliases: {} };

  // 2. Reservables = `getPublicClinic` (null con el turnero apagado: la sede igual existe, sin profesionales).
  const clinics = await mapInBatches(tenants, SITE_BATCH, async (t) =>
    isPublicTurneroOpen(t, now) ? getPublicClinic(t.slug) : null
  );
  const tenantIds = tenants.map((t) => t.id);
  const practitionerIds = clinics.flatMap((c) => c?.practitioners.map((p) => p.id) ?? []);

  // 3. Lo que la sede suma al turnero, en 7 queries para todas las sedes. `tenantId` a mano: canal sin RLS.
  const [locations, insurers, particulars, pros, prices, aliases, schedules] = await Promise.all([
    prisma.location.findMany({
      where: { tenantId: { in: tenantIds }, active: true },
      select: { tenantId: true, name: true, address: true, addressLine2: true, city: true, province: true },
      // Mismo orden que `getPublicClinic`: la principal primero.
      orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    // OS activas, sin montos. Nombre del catálogo si está vinculada y vigente (como el directorio).
    prisma.insurer.findMany({
      where: { tenantId: { in: tenantIds }, active: true, isParticular: false },
      select: { id: true, tenantId: true, name: true, payer: { select: { name: true, archivedAt: true } } },
    }),
    // Copago de Particular, aunque la fila esté inactiva: la misma lectura que `getParticularCopagoCents` (AUDIT §5.5).
    prisma.insurer.findMany({
      where: { tenantId: { in: tenantIds }, isParticular: true },
      select: { tenantId: true, copagoCents: true },
    }),
    practitionerIds.length
      ? prisma.practitioner.findMany({
          where: { id: { in: practitionerIds }, tenantId: { in: tenantIds } },
          select: { id: true, showPublicPrice: true },
        })
      : [],
    practitionerIds.length
      ? prisma.practitionerService.findMany({
          where: { practitionerId: { in: practitionerIds }, tenantId: { in: tenantIds }, priceCents: { not: null } },
          select: { practitionerId: true, serviceId: true, priceCents: true },
        })
      : [],
    // `TenantSlugAlias` es SERVICE_ONLY (BO2-D): el slug viejo redirige a la sede vigente.
    prisma.tenantSlugAlias.findMany({ where: { tenantId: { in: tenantIds } }, select: { slug: true, tenantId: true } }),
    // SD-U («Quién atiende cada día»): TODAS las franjas de los reservables (también de sedes inactivas y con cualquier
    // vigencia), como `getPublicClinic`: «tiene alguna franja» decide la red de seguridad. Solo día y horario: sin sede,
    // sala ni nada del profesional.
    practitionerIds.length
      ? prisma.practitionerSchedule.findMany({
          where: { tenantId: { in: tenantIds }, practitionerId: { in: practitionerIds } },
          select: {
            practitionerId: true,
            dow: true,
            startMin: true,
            endMin: true,
            validFrom: true,
            validUntil: true,
            location: { select: { active: true } },
          },
        })
      : [],
  ]);
  const today = toARDateKey(now);

  const showPublicPrice: Record<string, boolean> = Object.fromEntries(pros.map((p) => [p.id, p.showPublicPrice]));
  const practitionerPrices: Record<string, number> = {};
  for (const r of prices) if (r.priceCents != null) practitionerPrices[`${r.practitionerId}:${r.serviceId}`] = r.priceCents;
  const slugById = new Map(tenants.map((t) => [t.id, t.slug]));

  const sites = tenants.map((t, i) => {
    const practitionerHours: Record<string, OpeningRange[]> = {};
    for (const p of clinics[i]?.practitioners ?? []) {
      practitionerHours[p.id] = publicOpeningRanges({
        practitionerIds: [p.id],
        rows: schedules
          .filter((r) => r.practitionerId === p.id)
          .map((r) => ({ ...r, locationActive: r.location.active })),
        tenant: t,
      });
    }
    const tenantInsurers: ClinicSiteInsurerInput[] = insurers
      .filter((x) => x.tenantId === t.id)
      .map((x) => ({
        id: x.id,
        name: x.payer && x.payer.archivedAt === null ? x.payer.name : x.name,
        isParticular: false,
      }));
    return compactClinicSite(
      assembleClinicSite({
        tenant: {
          slug: t.slug,
          name: t.name,
          palette: t.palette,
          siteTagline: t.siteTagline,
          publicDescription: t.publicDescription,
          phone: t.phone,
          whatsapp: t.whatsapp,
          logoStorageKey: t.logoStorageKey,
          logoUpdatedAt: t.logoUpdatedAt,
        },
        clinic: clinics[i],
        locations: locations.filter((l) => l.tenantId === t.id),
        insurers: tenantInsurers,
        showPublicPrice,
        practitionerPrices,
        particularCopagoCents: particulars.find((p) => p.tenantId === t.id)?.copagoCents ?? null,
        practitionerHours,
        today,
      })
    );
  });

  const aliasMap: Record<string, string> = {};
  for (const a of aliases) {
    const target = slugById.get(a.tenantId);
    if (target && isSiteSlugShape(a.slug)) aliasMap[a.slug] = target;
  }
  return { version: 1, builtAt: now.toISOString(), sites, aliases: aliasMap };
}

/**
 * Entrada del data cache. La invalidan `revalidateTag(DIRECTORY_TAG)` (todo lo que cambia quién es reservable, vía
 * `tenantEntitlementTags` y los escritores del directorio) y `revalidateTag(CLINIC_SITES_TAG)` (lo propio de la sede),
 * siempre DESPUÉS del commit. Sin revalidar, a los 10 minutos.
 */
const getClinicSiteSnapshotCached = unstable_cache(
  async () => buildClinicSiteSnapshot(),
  // v3 (CF3b PH-S): la forma compacta suma `photoUrl`; una entrada v2 vieja no lo trae.
  ["clinic-site:snapshot:v3"],
  { tags: [DIRECTORY_TAG, CLINIC_SITES_TAG], revalidate: 600 }
);

/**
 * Sede pública por slug: el DTO cerrado, `{ redirectTo }` (alias viejo o mayúsculas → `permanentRedirect`) o null
 * (404 estático): inexistente, `siteEnabled` apagado, consultorio suspendido/de baja o slug reservado.
 * La forma del slug se valida antes de tocar el cache.
 */
export async function getClinicSite(slug: string): Promise<ClinicSiteLookup> {
  if (typeof slug !== "string" || !isSiteSlugShape(slug.toLowerCase())) return null;
  return lookupClinicSite(await getClinicSiteSnapshotCached(), slug);
}

/** Slugs de las sedes publicadas, para `app/sitemap.ts` (D-CF3-10: prendida = indexable y en el sitemap). */
export async function listEnabledSiteSlugs(): Promise<string[]> {
  return siteSlugsOf(await getClinicSiteSnapshotCached());
}
