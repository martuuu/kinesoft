/**
 * CF3 (SD-K, §30 D-CF3-9/D-CF3-10): contrato de datos de la sede digital pública `/<slug>`.
 *
 * Es el ÚNICO payload que la página de la sede (W4) le pasa al HTML: un DTO cerrado. Por qué cerrado (`.strict()` en
 * el schema de abajo, que usan los tests): la sede es una superficie anónima e indexable; un campo que se cuele por
 * spread (email del profesional, su WhatsApp, notas, userId) queda publicado y en el cache de Google. D-CF3-9 lo dice
 * literal: nunca el WhatsApp de un profesional ni el email de nadie. Un campo nuevo acá pasa por revisión de privacidad.
 *
 * Solo tipos y el schema (zod no arrastra nada al cliente si la página importa con `import type`).
 */
import { z } from "zod";
import { ALL_PALETTES } from "@/lib/brand-palettes";

const service = z
  .object({
    id: z.string(),
    name: z.string(),
    durationMin: z.number().int().positive(),
    /** Lo que paga un particular con este profesional (`particularQuoteCents`). null = no se muestra: el profesional
     *  apagó `showPublicPrice` (D-CF3-3) o el resultado es $0 (Particular nace en $0: «$0» confundiría). */
    priceCents: z.number().int().positive().nullable(),
  })
  .strict();

/**
 * CF3 (SD-U): una franja semanal del profesional, ya unida por día y vigente hoy (día AR del armado del snapshot).
 * Sale de las mismas franjas que ofrece el turnero (`publicOpeningRanges`, con su red de seguridad); no es PHI: es el
 * horario en que el profesional toma turnos, que el turnero ya muestra al elegirlo. Sin sede ni sala (v1).
 */
const weeklyRange = z
  .object({
    /** 0 = domingo … 6 = sábado (el `dow` de `PractitionerSchedule`). */
    dow: z.number().int().min(0).max(6),
    startMin: z.number().int().min(0).max(1440),
    endMin: z.number().int().min(0).max(1440),
  })
  .strict();

const practitioner = z
  .object({
    id: z.string(),
    name: z.string(),
    specialty: z.string().nullable(),
    license: z.string().nullable(),
    /** `/c/<slug>/booking?pro=<id>`: «Sacar turno con X». */
    bookingUrl: z.string(),
    services: z.array(service),
    /** CF3 (SD-U): «Quién atiende cada día». Lunes primero, por hora de inicio. Vacío = sin franjas vigentes. */
    hours: z.array(weeklyRange),
    /**
     * CF3b PH-S (M24, contrato FOTO): `/api/public/pro-photo/<id>?v=<ms>` (la de `getPublicClinic`) SOLO con el opt-in
     * de este consultorio (`Practitioner.showPhotoPublic`) y una foto subida; null = iniciales. Revisión de privacidad:
     * es la imagen de la persona, opt-in explícito (Ley 25.326), nunca `avatarUrl` de Google/Facebook.
     */
    photoUrl: z.string().nullable(),
  })
  .strict();

/**
 * CF3 (SD-U): paletas de `Tenant.palette` que la sede sabe pintar (`[data-palette]` de globals.css). BR-P: son TODAS
 * las de `lib/brand-palettes.ts` (las generales + las de marca, hoy «tmp»): la de marca la asigna Plataforma y la sede
 * y el turnero de ese consultorio la pintan como cualquier otra.
 */
export const SITE_PALETTES = ALL_PALETTES;
export type SitePalette = (typeof SITE_PALETTES)[number];

const location = z
  .object({
    name: z.string(),
    /** Calle y piso/depto unidos («Córdoba 1234, 2.º B»). */
    address: z.string().nullable(),
    city: z.string().nullable(),
    province: z.string().nullable(),
    /** Link de búsqueda de Google Maps (sin embed ni API key). null = la sede no tiene dirección ni ciudad. */
    mapsUrl: z.string().nullable(),
  })
  .strict();

export const clinicSiteSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    /** `Tenant.palette` validada (un valor desconocido cae a `sky`): el color del consultorio en la sede. */
    palette: z.enum(SITE_PALETTES),
    tagline: z.string().nullable(),
    description: z.string().nullable(),
    /** `/<slug>/logo?v=<logoUpdatedAt ms>` (ruta pública de SD-S) o null sin logo. */
    logoUrl: z.string().nullable(),
    /** Del consultorio (`Tenant.phone/whatsapp`). Nunca el email ni datos de un profesional. */
    contact: z.object({ phone: z.string().nullable(), whatsapp: z.string().nullable() }).strict(),
    locations: z.array(location),
    openingSummary: z.string().nullable(),
    /** Obras sociales (sin Particular, sin montos), nombre del catálogo si está vinculada. */
    coverages: z.array(z.string()),
    /** `/c/<slug>/booking`. */
    bookingUrl: z.string(),
    /** Reservables hoy en el turnero (misma regla que `getPublicClinic`). Vacío con el turnero cerrado. */
    practitioners: z.array(practitioner),
    online: z.object({ bookingOpen: z.boolean() }).strict(),
  })
  .strict();

export type ClinicSite = z.infer<typeof clinicSiteSchema>;
export type ClinicSitePractitioner = ClinicSite["practitioners"][number];
export type ClinicSiteService = ClinicSitePractitioner["services"][number];
export type ClinicSiteLocation = ClinicSite["locations"][number];
export type ClinicSiteWeeklyRange = ClinicSitePractitioner["hours"][number];

/** El slug pedido es un alias viejo (o una variante en mayúsculas): la página hace `permanentRedirect`. */
export type ClinicSiteRedirect = { redirectTo: string };

/** `getClinicSite`: la sede, un redirect, o null (= 404 estático). */
export type ClinicSiteLookup = ClinicSite | ClinicSiteRedirect | null;

/**
 * Una sede en la forma COMPACTA del cache: los servicios una sola vez por sede y, por profesional, tuplas
 * `[índice del servicio, duración, precio|null]` y las franjas como `[dow, inicio, fin]`; el `bookingUrl` se rearma del
 * slug. Por qué: el data cache de Next 14
 * no guarda entradas de más de 2 MB y no avisa (el directorio ya lo sufrió); la expandida medía 1,7 MB con 200 sedes ×
 * 5 profesionales × 10 servicios (lo fija `tests/unit/clinic-site-logic.test.ts`).
 */
export type CompactClinicSite = Omit<ClinicSite, "practitioners" | "bookingUrl"> & {
  services: { id: string; name: string }[];
  practitioners: (Omit<ClinicSitePractitioner, "services" | "bookingUrl" | "hours"> & {
    s: [number, number, number | null][];
    /** `hours` como tuplas `[dow, startMin, endMin]` (SD-U): 200 sedes × 5 profesionales × ~8 franjas. */
    h: [number, number, number][];
  })[];
};

/** Entrada del data cache: TODAS las sedes publicables + sus alias (alias → slug vigente). Solo JSON. */
export type ClinicSiteSnapshot = {
  version: 1;
  builtAt: string;
  sites: CompactClinicSite[];
  aliases: Record<string, string>;
};
