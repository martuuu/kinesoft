/**
 * DIR (C-DIR4/C-DIR5/C-DIR6): lógica PURA del directorio público. Sin Prisma, sin `next/*`, sin reloj propio: la
 * importan el builder del snapshot (`lib/directory-internal.ts`), las páginas de `app/(directory)/` y los tests.
 *
 *   • `assembleDirectorySnapshot`: arma el snapshot con lo que ya leyó el builder. Vive acá (y no en el builder) para
 *     que la matriz de quién aparece, el armado de coberturas y el tamaño serializado se prueben en unit con volumen
 *     (200 consultorios × 5 profesionales) sin levantar 1.600 queries.
 *   • Filtros (GET), paginado, slug/nombreId, iniciales, ciudad normalizada.
 *   • JSON-LD: `jsonLdScript` (escape) y los dos builders (`MedicalClinic`, `Person`).
 *
 * Privacidad: lo que entra acá ya viene sin email, userId, rating ni precios (el builder no los selecciona y el tipo de
 * entrada no los tiene). La unión practitionerId → persona llega resuelta como `profilesByPractitioner`: el userId no
 * cruza esta frontera.
 */
import { AR_PROVINCES, isProvinceCode, provinceName } from "@/lib/ar-provinces";
import { HONORIFIC_OPTIONS } from "@/lib/directory-constants";
import { bookingHref } from "@/lib/public-booking-links";
import type {
  DirectoryClinic,
  DirectoryClinicProfessional,
  DirectoryClinicRef,
  DirectoryCoverage,
  DirectoryFilters,
  DirectoryLicense,
  DirectoryProfessional,
  DirectorySnapshot,
  DirectorySpecialty,
  ProvinceCode,
} from "@/lib/directory-types";

export const DIRECTORY_PAGE_SIZE = 24;

// ──────────────────────────────────────────────────────────────────────
// Texto: slug, nombreId, iniciales, ciudad
// ──────────────────────────────────────────────────────────────────────

/** Sin tildes ni diéresis («Pérez» → «Perez»), para slugs y comparaciones. La ñ pasa a n (NFD la descompone). */
function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Nombre → segmento de URL: minúsculas, sin tildes, solo [a-z0-9] separados por «-», ≤ 60. Vacío (un nombre hecho
 * solo de símbolos) → «profesional»: la URL nunca queda `/profesionales/-<id>`.
 */
export function slugifyName(name: string): string {
  const s = stripDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s || "profesional";
}

/** `/profesionales/<slugifyName(publicName)>-<profileId>`. */
export function professionalPath(publicName: string, profileId: string): string {
  return `/profesionales/${slugifyName(publicName)}-${profileId}`;
}

/** `/consultorios/<slug>`. */
export function clinicPath(slug: string): string {
  return `/consultorios/${encodeURIComponent(slug)}`;
}

/** Turnero del consultorio con el profesional preseleccionado (C-DIR7: `?pro=`): el MISMO armado que el deep link
 *  del turnero (`bookingHref`, DIR-2d), para que el formato no se desvíe entre directorio y wizard. */
export function directoryBookingHref(slug: string, practitionerId?: string | null): string {
  return bookingHref(slug, practitionerId);
}

/** Ids de perfil: cuid (minúsculas y dígitos). Lo que no tenga esa forma no se busca. */
const PROFILE_ID_RE = /^[a-z0-9]{8,40}$/;

/**
 * `<nombre>-<profileId>` → partes. El id es lo que sigue al ÚLTIMO «-» (el nombre puede tener guiones; el cuid no).
 * null = forma inválida → la página hace `notFound()`. Que el nombre no coincida con el canónico NO es error: la página
 * redirige (`permanentRedirect`) a `pro.path` (un cambio de nombre no rompe links viejos).
 */
export function parseNombreId(nombreId: string): { nameSlug: string; profileId: string } | null {
  let raw = nombreId;
  try {
    raw = decodeURIComponent(nombreId);
  } catch {
    return null;
  }
  const i = raw.lastIndexOf("-");
  const profileId = i >= 0 ? raw.slice(i + 1) : raw;
  if (!PROFILE_ID_RE.test(profileId)) return null;
  return { nameSlug: i >= 0 ? raw.slice(0, i) : "", profileId };
}

/** Iniciales para el avatar (DIR-D4: v1 sin foto): primera letra del primer y del último nombre, en mayúsculas. */
export function initials(publicName: string): string {
  const words = publicName
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toLocaleUpperCase("es-AR");
}

/** Ciudad comparable: sin tildes, minúsculas, espacios colapsados. «San Miguel de Tucumán » = «san miguel de tucuman». */
export function normalizeCity(city: string | null | undefined): string {
  return stripDiacritics(city ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// DIR-Z: antes había una copia literal del mapa acá; ahora sale de `HONORIFIC_OPTIONS` (la misma lista que valida el
// form y que refleja el CHECK de M11), así sumar un título no puede dejar al directorio mostrándolo como null.
const HONORIFIC_LABELS: Record<string, string> = Object.fromEntries(HONORIFIC_OPTIONS.map((o) => [o.value, o.label]));

/** Código del CHECK de M11 → abreviatura que se muestra. Desconocido → null (no se inventa un título). */
export function honorificLabel(code: string | null | undefined): string | null {
  return code ? HONORIFIC_LABELS[code] ?? null : null;
}

const collator = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" });

// ──────────────────────────────────────────────────────────────────────
// Armado del snapshot (C-DIR4)
// ──────────────────────────────────────────────────────────────────────

/** Perfil publicado (el builder ya filtró listed ∧ consentimiento vigente ∧ no oculto). Sin userId. */
export type DirectoryProfileInput = {
  id: string;
  publicName: string;
  honorific: string | null;
  licenseKind: string | null;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
  bio: string | null;
  licenseVerified: boolean;
};

/** Cobertura de un `Insurer` del consultorio ya resuelta contra el catálogo (`Payer`). */
export type DirectoryInsurerInput = { isParticular: boolean; name: string; payerSlug: string | null };

/** Un consultorio que ya pasó el filtro de C-DIR4 (opt-in, no oculto, `getPublicClinic` ≠ null). */
export type DirectoryClinicInput = {
  slug: string;
  name: string;
  description: string | null;
  phone: string | null;
  whatsapp: string | null;
  /** Sedes activas en el orden de `getPublicClinic` (la principal primero). */
  locations: {
    id: string;
    name: string;
    address: string | null;
    addressLine2: string | null;
    city: string | null;
    provinceCode: string | null;
  }[];
  /** `getPublicClinic(slug).practitioners` (= reservables hoy), solo los campos que usa el directorio. */
  practitioners: { id: string; locationIds?: string[]; acceptedInsurerIds?: string[] }[];
  /** insurerId → cobertura resuelta. Un id que no esté acá se ignora. */
  insurers: Record<string, DirectoryInsurerInput>;
  /** practitionerId → especialidades del catálogo (sin archivadas). */
  specialtiesByPractitioner: Record<string, DirectorySpecialty[]>;
};

export type DirectoryBuildInput = {
  builtAt: Date;
  clinics: DirectoryClinicInput[];
  /** practitionerId → perfil publicado de la persona. Sin entrada = no publicado (no aparece como profesional). */
  profilesByPractitioner: Record<string, DirectoryProfileInput>;
};

function cleanText(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

function uniqSpecialties(list: DirectorySpecialty[]): DirectorySpecialty[] {
  const by = new Map<string, DirectorySpecialty>();
  for (const s of list) if (!by.has(s.slug)) by.set(s.slug, { slug: s.slug, name: s.name });
  return [...by.values()].sort((a, b) => collator(a.name, b.name) || (a.slug < b.slug ? -1 : 1));
}

/** Clave de deduplicado: el payer del catálogo si está vinculada; si no, el nombre normalizado. */
function coverageKey(c: DirectoryCoverage): string {
  return c.payerSlug ? `p:${c.payerSlug}` : `n:${normalizeCity(c.name)}`;
}

function uniqCoverages(list: DirectoryCoverage[]): DirectoryCoverage[] {
  const by = new Map<string, DirectoryCoverage>();
  for (const c of list) if (!by.has(coverageKey(c))) by.set(coverageKey(c), { name: c.name, payerSlug: c.payerSlug });
  return [...by.values()].sort((a, b) => collator(a.name, b.name) || coverageKey(a).localeCompare(coverageKey(b)));
}

/** Coberturas + Particular de un profesional en un consultorio (`acceptedInsurerIds` del turnero). */
function coveragesOf(
  clinic: DirectoryClinicInput,
  insurerIds: string[] | undefined
): { coverages: DirectoryCoverage[]; acceptsParticular: boolean } {
  const coverages: DirectoryCoverage[] = [];
  let acceptsParticular = false;
  for (const id of insurerIds ?? []) {
    const ins = clinic.insurers[id];
    if (!ins) continue;
    if (ins.isParticular) acceptsParticular = true;
    else coverages.push({ name: ins.name, payerSlug: ins.payerSlug });
  }
  return { coverages, acceptsParticular };
}

function licenseOf(p: DirectoryProfileInput): DirectoryLicense | null {
  const number = cleanText(p.licenseNumber);
  if (!number || (p.licenseKind !== "MN" && p.licenseKind !== "MP")) return null;
  return {
    kind: p.licenseKind,
    number,
    jurisdiction: p.licenseKind === "MP" && isProvinceCode(p.licenseJurisdiction) ? p.licenseJurisdiction : null,
    // DIR-D10/D21: «verificada» SOLO si Plataforma la verificó (el trigger de M11 la borra si cambia la matrícula).
    verified: p.licenseVerified,
  };
}

function joinAddress(a: string | null, b: string | null): string | null {
  return [cleanText(a), cleanText(b)].filter(Boolean).join(", ") || null;
}

/** Orden del directorio (DIR-D8): alfabético por nombre público, empate por id (estable entre builds). */
function byPublicName<T extends { publicName: string; profileId: string }>(a: T, b: T): number {
  return collator(a.publicName, b.publicName) || (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0);
}

/**
 * Arma el snapshot. Un consultorio sin profesionales reservables no aparece (C-DIR4); uno con reservables pero sin
 * perfiles publicados SÍ aparece como página (DIR-D25) y no suma a `/profesionales`. Un profesional aparece una sola
 * vez por persona (perfil), con la unión de sus consultorios, especialidades y coberturas.
 */
export function assembleDirectorySnapshot(input: DirectoryBuildInput): DirectorySnapshot {
  type Acc = {
    profile: DirectoryProfileInput;
    clinics: DirectoryClinicRef[];
    specialties: DirectorySpecialty[];
    coverages: DirectoryCoverage[];
    acceptsParticular: boolean;
  };
  const people = new Map<string, Acc>();
  const clinics: DirectoryClinic[] = [];

  for (const c of input.clinics) {
    if (c.practitioners.length === 0) continue;
    const locations = c.locations.map((l) => ({
      name: l.name,
      address: joinAddress(l.address, l.addressLine2),
      city: cleanText(l.city),
      provinceCode: isProvinceCode(l.provinceCode) ? l.provinceCode : null,
    }));
    const locById = new Map(c.locations.map((l, i) => [l.id, locations[i]]));

    const clinicSpecialties: DirectorySpecialty[] = [];
    const clinicCoverages: DirectoryCoverage[] = [];
    let clinicParticular = false;
    const professionals: DirectoryClinicProfessional[] = [];

    for (const pr of c.practitioners) {
      const specialties = c.specialtiesByPractitioner[pr.id] ?? [];
      const cov = coveragesOf(c, pr.acceptedInsurerIds);
      clinicSpecialties.push(...specialties);
      clinicCoverages.push(...cov.coverages);
      clinicParticular ||= cov.acceptsParticular;

      const profile = input.profilesByPractitioner[pr.id];
      if (!profile) continue;
      const bookingHref = directoryBookingHref(c.slug, pr.id);
      const path = professionalPath(profile.publicName, profile.id);
      professionals.push({
        profileId: profile.id,
        path,
        publicName: profile.publicName,
        honorificLabel: honorificLabel(profile.honorific),
        initials: initials(profile.publicName),
        specialties: uniqSpecialties(specialties),
        bookingHref,
      });

      // Zona del profesional en este consultorio: su primera sede (donde tiene franjas); sin sedes, la principal.
      const loc = (pr.locationIds ?? []).map((id) => locById.get(id)).find(Boolean) ?? locations[0] ?? null;
      const ref: DirectoryClinicRef = {
        slug: c.slug,
        name: c.name,
        path: clinicPath(c.slug),
        city: loc?.city ?? null,
        provinceCode: loc?.provinceCode ?? null,
        bookingHref,
      };
      const acc = people.get(profile.id);
      if (acc) {
        acc.clinics.push(ref);
        acc.specialties.push(...specialties);
        acc.coverages.push(...cov.coverages);
        acc.acceptsParticular ||= cov.acceptsParticular;
      } else {
        people.set(profile.id, {
          profile,
          clinics: [ref],
          specialties: [...specialties],
          coverages: [...cov.coverages],
          acceptsParticular: cov.acceptsParticular,
        });
      }
    }

    clinics.push({
      slug: c.slug,
      path: clinicPath(c.slug),
      name: c.name,
      description: cleanText(c.description),
      locations,
      phone: cleanText(c.phone),
      whatsapp: cleanText(c.whatsapp),
      specialties: uniqSpecialties(clinicSpecialties),
      coverages: uniqCoverages(clinicCoverages),
      acceptsParticular: clinicParticular,
      professionals: professionals.sort(byPublicName),
      bookingHref: directoryBookingHref(c.slug),
    });
  }

  const professionals: DirectoryProfessional[] = [...people.values()]
    .map(({ profile, clinics: refs, specialties, coverages, acceptsParticular }) => ({
      profileId: profile.id,
      path: professionalPath(profile.publicName, profile.id),
      publicName: profile.publicName,
      honorificLabel: honorificLabel(profile.honorific),
      initials: initials(profile.publicName),
      license: licenseOf(profile),
      bio: cleanText(profile.bio),
      specialties: uniqSpecialties(specialties),
      coverages: uniqCoverages(coverages),
      acceptsParticular,
      clinics: refs.sort((a, b) => collator(a.name, b.name) || (a.slug < b.slug ? -1 : 1)),
    }))
    .sort(byPublicName);

  clinics.sort((a, b) => collator(a.name, b.name) || (a.slug < b.slug ? -1 : 1));
  return { version: 1, builtAt: input.builtAt.toISOString(), professionals, clinics };
}

export function findDirectoryProfessional(snapshot: DirectorySnapshot, profileId: string): DirectoryProfessional | null {
  return snapshot.professionals.find((p) => p.profileId === profileId) ?? null;
}

export function findDirectoryClinic(snapshot: DirectorySnapshot, slug: string): DirectoryClinic | null {
  return snapshot.clinics.find((c) => c.slug === slug) ?? null;
}

// ──────────────────────────────────────────────────────────────────────
// Filtros (GET) y paginado (C-DIR5)
// ──────────────────────────────────────────────────────────────────────

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * `searchParams` de `/profesionales` → filtros. Viene de cualquiera: lo que no tiene forma válida se descarta (no
 * tira, no 500). `pagina` < 1 o no numérica → 1; el tope lo pone `paginate` (fuera de rango → la última).
 */
export function parseDirectoryFilters(sp: SearchParams): DirectoryFilters {
  const especialidad = first(sp.especialidad)?.toLowerCase() ?? null;
  const cobertura = first(sp.cobertura)?.toLowerCase() ?? null;
  const provincia = first(sp.provincia)?.toUpperCase() ?? null;
  const ciudad = first(sp.ciudad);
  const pagina = Number.parseInt(first(sp.pagina) ?? "", 10);
  return {
    especialidad: especialidad && SLUG_RE.test(especialidad) ? especialidad : null,
    cobertura: cobertura && SLUG_RE.test(cobertura) ? cobertura : null,
    provincia: isProvinceCode(provincia) ? provincia : null,
    ciudad: ciudad ? ciudad.slice(0, 80) : null,
    pagina: Number.isFinite(pagina) && pagina >= 1 ? pagina : 1,
  };
}

/** Query string de los filtros (para el paginado y «sacar un filtro»). Sin filtros ni página 1 → "". */
export function directoryQuery(f: DirectoryFilters, overrides: Partial<DirectoryFilters> = {}): string {
  const m = { ...f, ...overrides };
  const qs = new URLSearchParams();
  if (m.especialidad) qs.set("especialidad", m.especialidad);
  if (m.cobertura) qs.set("cobertura", m.cobertura);
  if (m.provincia) qs.set("provincia", m.provincia);
  if (m.ciudad) qs.set("ciudad", m.ciudad);
  if (m.pagina > 1) qs.set("pagina", String(m.pagina));
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/**
 * Filtra (sin paginar). Provincia y ciudad se cumplen en el MISMO consultorio (atiende en Rosario, Santa Fe; no «en
 * algún lado de Santa Fe y en algún Rosario»). Cobertura: `particular` o un `payerSlug` del catálogo (las coberturas
 * sin vincular se muestran pero no filtran).
 */
export function filterProfessionals(
  professionals: DirectoryProfessional[],
  f: Pick<DirectoryFilters, "especialidad" | "cobertura" | "provincia" | "ciudad">
): DirectoryProfessional[] {
  const city = f.ciudad ? normalizeCity(f.ciudad) : null;
  return professionals.filter((p) => {
    if (f.especialidad && !p.specialties.some((s) => s.slug === f.especialidad)) return false;
    if (f.cobertura) {
      if (f.cobertura === "particular" ? !p.acceptsParticular : !p.coverages.some((c) => c.payerSlug === f.cobertura))
        return false;
    }
    if (f.provincia || city) {
      const ok = p.clinics.some(
        (c) => (!f.provincia || c.provinceCode === f.provincia) && (!city || normalizeCity(c.city) === city)
      );
      if (!ok) return false;
    }
    return true;
  });
}

export type DirectoryPage<T> = { items: T[]; page: number; totalPages: number; total: number };

/** Paginado en server. Página fuera de rango → la última (C-DIR5); lista vacía → página 1 de 1. */
export function paginate<T>(items: T[], page: number, size = DIRECTORY_PAGE_SIZE): DirectoryPage<T> {
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  return { items: items.slice((p - 1) * size, p * size), page: p, totalPages, total: items.length };
}

/** Opciones de los selects de `/profesionales`, de lo que hay publicado (no se ofrece un filtro que da vacío). */
export function directoryFacets(professionals: DirectoryProfessional[]): {
  specialties: DirectorySpecialty[];
  coverages: { name: string; payerSlug: string }[];
  provinces: { code: ProvinceCode; name: string }[];
} {
  const specialties = uniqSpecialties(professionals.flatMap((p) => p.specialties));
  const coverages = uniqCoverages(professionals.flatMap((p) => p.coverages)).filter(
    (c): c is { name: string; payerSlug: string } => c.payerSlug !== null
  );
  const present = new Set(professionals.flatMap((p) => p.clinics.map((c) => c.provinceCode)));
  const provinces = AR_PROVINCES.filter((p) => present.has(p.code)).map((p) => ({ code: p.code, name: p.name }));
  return { specialties, coverages, provinces };
}

// ──────────────────────────────────────────────────────────────────────
// JSON-LD (C-DIR6)
// ──────────────────────────────────────────────────────────────────────

/** JSON para `<script type="application/ld+json">`. `JSON.stringify` NO escapa `</script>`: un nombre o una bio con
 *  «</script><script>…» cerraría el bloque. Se escapan <, >, & y los separadores de línea U+2028/2029. */
export function jsonLdScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
// Uso: <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(ld) }} />

function absolute(path: string, baseUrl: string): string {
  return new URL(path, baseUrl).toString();
}

/** `MedicalClinic` de schema.org. Sin email (DIR-D15), sin precios. Los opcionales vacíos no se emiten. */
export function clinicJsonLd(clinic: DirectoryClinic, baseUrl: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "MedicalClinic",
    name: clinic.name,
    url: absolute(clinic.path, baseUrl),
    ...(clinic.description ? { description: clinic.description } : {}),
    ...(clinic.phone ? { telephone: clinic.phone } : {}),
    address: clinic.locations.map((l) => ({
      "@type": "PostalAddress",
      ...(l.address ? { streetAddress: l.address } : {}),
      ...(l.city ? { addressLocality: l.city } : {}),
      ...(l.provinceCode ? { addressRegion: provinceName(l.provinceCode) } : {}),
      addressCountry: "AR",
    })),
  };
}

/** `Person` de schema.org. **Sin** matrícula, email, foto ni rating (DIR-D21). */
export function professionalJsonLd(pro: DirectoryProfessional, baseUrl: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: pro.publicName,
    url: absolute(pro.path, baseUrl),
    ...(pro.bio ? { description: pro.bio } : {}),
    knowsAbout: pro.specialties.map((s) => s.name),
    worksFor: pro.clinics.map((c) => ({ "@type": "MedicalClinic", name: c.name, url: absolute(c.path, baseUrl) })),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Forma compacta del caché (C-DIR4, ≤ 1 MB)
// ──────────────────────────────────────────────────────────────────────

/**
 * Lo que se guarda en el data cache de Next. Por qué existe: el snapshot expandido de 200 consultorios × 5
 * profesionales con 12 coberturas medía 2,7 MB serializado (test de volumen, 16-oct), y Next 14 NO guarda una entrada
 * de más de 2 MB y no avisa: cada render volvía a pegar ~8 queries por consultorio. Lo que pesaba era lo repetido
 * (cada profesional cargaba sus coberturas y especialidades enteras, más paths, iniciales y deep links que se derivan).
 * Acá las coberturas y especialidades van una vez en una tabla y se referencian por índice, y lo derivable no se
 * guarda. `expandDirectorySnapshot(compactDirectorySnapshot(s))` es igual a `s` (test de ida y vuelta): las páginas
 * siguen viendo `DirectorySnapshot` (C-DIR3) y no se enteran.
 */
export type CompactDirectorySnapshot = {
  v: 1;
  b: string;
  /** [slug, nombre] */
  sp: [string, string][];
  /** [nombre, payerSlug] */
  cv: [string, string | null][];
  c: {
    s: string;
    n: string;
    d: string | null;
    /** [nombre, dirección, ciudad, provincia] */
    l: [string, string | null, string | null, ProvinceCode | null][];
    ph: string | null;
    wa: string | null;
    sp: number[];
    cv: number[];
    pa: boolean;
    /** [índice en `p`, practitionerId, especialidades en este consultorio] */
    pr: [number, string, number[]][];
  }[];
  p: {
    i: string;
    n: string;
    h: string | null;
    /** [tipo, número, jurisdicción, verificada] */
    li: ["MN" | "MP", string, ProvinceCode | null, boolean] | null;
    b: string | null;
    sp: number[];
    cv: number[];
    pa: boolean;
    /** [índice en `c`, practitionerId, ciudad, provincia] */
    c: [number, string, string | null, ProvinceCode | null][];
  }[];
};

/** `?pro=<id>` de un `bookingHref` del directorio (lo armó `directoryBookingHref`). */
function proOf(bookingHref: string): string {
  const q = bookingHref.indexOf("?");
  return q >= 0 ? new URLSearchParams(bookingHref.slice(q + 1)).get("pro") ?? "" : "";
}

export function compactDirectorySnapshot(s: DirectorySnapshot): CompactDirectorySnapshot {
  const sp: [string, string][] = [];
  const spIdx = new Map<string, number>();
  const specs = (list: DirectorySpecialty[]) =>
    list.map((x) => {
      let i = spIdx.get(x.slug);
      if (i === undefined) spIdx.set(x.slug, (i = sp.push([x.slug, x.name]) - 1));
      return i;
    });
  const cv: [string, string | null][] = [];
  const cvIdx = new Map<string, number>();
  const covs = (list: DirectoryCoverage[]) =>
    list.map((x) => {
      const k = `${x.payerSlug ?? ""}\u0000${x.name}`;
      let i = cvIdx.get(k);
      if (i === undefined) cvIdx.set(k, (i = cv.push([x.name, x.payerSlug]) - 1));
      return i;
    });
  const proIdx = new Map(s.professionals.map((p, i) => [p.profileId, i]));
  const clinicIdx = new Map(s.clinics.map((c, i) => [c.slug, i]));

  return {
    v: 1,
    b: s.builtAt,
    sp,
    cv,
    p: s.professionals.map((p) => ({
      i: p.profileId,
      n: p.publicName,
      h: p.honorificLabel,
      li: p.license ? [p.license.kind, p.license.number, p.license.jurisdiction, p.license.verified] : null,
      b: p.bio,
      sp: specs(p.specialties),
      cv: covs(p.coverages),
      pa: p.acceptsParticular,
      c: p.clinics.map((c) => [clinicIdx.get(c.slug) ?? -1, proOf(c.bookingHref), c.city, c.provinceCode]),
    })),
    c: s.clinics.map((c) => ({
      s: c.slug,
      n: c.name,
      d: c.description,
      l: c.locations.map((l) => [l.name, l.address, l.city, l.provinceCode]),
      ph: c.phone,
      wa: c.whatsapp,
      sp: specs(c.specialties),
      cv: covs(c.coverages),
      pa: c.acceptsParticular,
      pr: c.professionals.map((p) => [proIdx.get(p.profileId) ?? -1, proOf(p.bookingHref), specs(p.specialties)]),
    })),
  };
}

export function expandDirectorySnapshot(x: CompactDirectorySnapshot): DirectorySnapshot {
  const specs = (idx: number[]) => idx.map((i) => ({ slug: x.sp[i][0], name: x.sp[i][1] }));
  const covs = (idx: number[]) => idx.map((i) => ({ name: x.cv[i][0], payerSlug: x.cv[i][1] }));
  const professionals: DirectoryProfessional[] = x.p.map((p) => ({
    profileId: p.i,
    path: professionalPath(p.n, p.i),
    publicName: p.n,
    honorificLabel: p.h,
    initials: initials(p.n),
    license: p.li ? { kind: p.li[0], number: p.li[1], jurisdiction: p.li[2], verified: p.li[3] } : null,
    bio: p.b,
    specialties: specs(p.sp),
    coverages: covs(p.cv),
    acceptsParticular: p.pa,
    clinics: p.c
      .filter(([ci]) => x.c[ci] !== undefined)
      .map(([ci, pro, city, provinceCode]) => ({
        slug: x.c[ci].s,
        name: x.c[ci].n,
        path: clinicPath(x.c[ci].s),
        city,
        provinceCode,
        bookingHref: directoryBookingHref(x.c[ci].s, pro),
      })),
  }));
  const clinics: DirectoryClinic[] = x.c.map((c) => ({
    slug: c.s,
    path: clinicPath(c.s),
    name: c.n,
    description: c.d,
    locations: c.l.map(([name, address, city, provinceCode]) => ({ name, address, city, provinceCode })),
    phone: c.ph,
    whatsapp: c.wa,
    specialties: specs(c.sp),
    coverages: covs(c.cv),
    acceptsParticular: c.pa,
    professionals: c.pr
      .filter(([pi]) => professionals[pi] !== undefined)
      .map(([pi, pro, sp]) => {
        const p = professionals[pi];
        return {
          profileId: p.profileId,
          path: p.path,
          publicName: p.publicName,
          honorificLabel: p.honorificLabel,
          initials: p.initials,
          specialties: specs(sp),
          bookingHref: directoryBookingHref(c.s, pro),
        };
      }),
    bookingHref: directoryBookingHref(c.s),
  }));
  return { version: 1, builtAt: x.b, professionals, clinics };
}
