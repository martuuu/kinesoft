/**
 * Lógica pura del turnero público (B5.6). Vive fuera del componente
 * (`components/booking/public-booking-wizard.tsx`, "use client") para poder
 * testearla sin DOM (tests/unit/public-wizard-state.test.ts).
 *
 * Fuente de verdad: `getPublicClinic` (B3.2). Los campos de B3.2 son
 * opcionales en el tipo (`practitionerIds`, `durationByPractitioner`,
 * `locationIds`, `acceptedInsurerIds`, `locations`, `insurers`): si faltan,
 * caemos al comportamiento previo (filtro por `practitionerId`, sin filtros
 * de sede/cobertura) en vez de esconder todo.
 */
import { addDays } from "@/lib/availability/day";
import type { PublicClinic, PublicFirstSlot, PublicLocation } from "@/lib/public-booking-types";

type Practitioner = PublicClinic["practitioners"][number];
type Service = PublicClinic["services"][number];

/** Filtros opcionales del paso 1. null = sin filtro ("todas"). */
export type WizardFilters = {
  insurerId: string | null;
  locationId: string | null;
};

// ─── Servicios por profesional ─────────────────────────────────────────

/** Quiénes ofrecen el servicio online. Sin `practitionerIds` (payload viejo)
 *  devuelve null = "no sabemos" y el llamador usa el filtro legacy. */
function offeredBy(s: Service): string[] | null {
  return s.practitionerIds ?? null;
}

/** ¿El profesional ofrece este servicio online? */
export function serviceOfferedBy(s: Service, practitionerId: string): boolean {
  const ids = offeredBy(s);
  // Compat: antes de B3.2 el filtro era `practitionerId === elegido || null`.
  if (!ids) return s.practitionerId === practitionerId || s.practitionerId === null;
  return ids.includes(practitionerId);
}

/** Servicios que ofrece ese profesional. Reemplaza el filtro por
 *  `s.practitionerId`, que con 3+ profesionales mostraba a un tercero un
 *  servicio que no da (horarios vacíos y submit rechazado). */
export function servicesForPractitioner(clinic: PublicClinic, practitionerId: string): Service[] {
  return clinic.services.filter((s) => serviceOfferedBy(s, practitionerId));
}

/** Servicios para "cualquier profesional": los que ofrece al menos uno de
 *  los profesionales que pasan los filtros. */
export function servicesForAny(clinic: PublicClinic, filters: WizardFilters): Service[] {
  const pros = filterPractitioners(clinic, filters);
  return clinic.services.filter((s) => pros.some((p) => serviceOfferedBy(s, p.id)));
}

/** Duración efectiva: override del profesional (`PractitionerService`) o la
 *  del servicio. Sin profesional (modo "cualquiera") = la del servicio. */
export function durationFor(s: Service, practitionerId: string | null): number {
  if (practitionerId) {
    const d = s.durationByPractitioner?.[practitionerId];
    if (typeof d === "number" && d > 0) return d;
  }
  return s.durationMin;
}

// ─── Filtros de cobertura y sede ───────────────────────────────────────

/** Sin cobertura elegida, o sin dato (payload viejo) = acepta. */
export function practitionerAcceptsInsurer(p: Practitioner, insurerId: string | null): boolean {
  if (!insurerId || !p.acceptedInsurerIds) return true;
  return p.acceptedInsurerIds.includes(insurerId);
}

/** Sin sede elegida, o sin dato = atiende. */
export function practitionerAtLocation(p: Practitioner, locationId: string | null): boolean {
  if (!locationId || !p.locationIds) return true;
  return p.locationIds.includes(locationId);
}

export function filterPractitioners(clinic: PublicClinic, filters: WizardFilters): Practitioner[] {
  return clinic.practitioners.filter(
    (p) => practitionerAcceptsInsurer(p, filters.insurerId) && practitionerAtLocation(p, filters.locationId)
  );
}

/** Sedes activas (la principal primero, como las manda el server). */
export function clinicLocations(clinic: PublicClinic): PublicLocation[] {
  return clinic.locations ?? [];
}

/** Elegir sede solo tiene sentido con más de una. */
export function hasMultipleLocations(clinic: PublicClinic): boolean {
  return clinicLocations(clinic).length > 1;
}

/** Opciones de "¿Con qué cobertura venís?": Particular primero y después
 *  las obras sociales por nombre. Vacío si el consultorio solo atiende
 *  particular (no hay nada que filtrar). Nunca lleva montos. */
export function coverageOptions(clinic: PublicClinic): { id: string; name: string; isParticular: boolean }[] {
  const all = clinic.insurers ?? [];
  if (!all.some((i) => !i.isParticular)) return [];
  const particular = all.filter((i) => i.isParticular);
  const rest = all.filter((i) => !i.isParticular).sort((a, b) => a.name.localeCompare(b.name, "es"));
  return [...particular, ...rest];
}

/** Sedes donde atiende un profesional, en el orden del consultorio. */
export function locationsForPractitioner(clinic: PublicClinic, practitionerId: string): PublicLocation[] {
  const p = clinic.practitioners.find((x) => x.id === practitionerId);
  const locs = clinicLocations(clinic);
  if (!p?.locationIds) return locs;
  return locs.filter((l) => p.locationIds!.includes(l.id));
}

/** "Av. Siempre Viva 742, Piso 2 · Rosario" (lo que haya). */
export function formatLocationAddress(l: PublicLocation): string {
  const street = [l.address, l.addressLine2].filter(Boolean).join(", ");
  const place = [l.city, l.province].filter(Boolean).join(", ");
  return [street, place].filter(Boolean).join(" · ");
}

export function findLocation(clinic: PublicClinic, locationId: string | null | undefined): PublicLocation | null {
  if (!locationId) return null;
  return clinicLocations(clinic).find((l) => l.id === locationId) ?? null;
}

/**
 * Qué selección sobrevive a un cambio de filtros: si el profesional elegido
 * ya no pasa los filtros se limpia (y con él servicio y horario, que
 * dependen de él); si el servicio dejó de ofrecerse, se limpia el servicio.
 */
export function reconcileSelection(
  clinic: PublicClinic,
  filters: WizardFilters,
  sel: { practitionerId: string | null; serviceId: string | null }
): { practitionerId: string | null; serviceId: string | null } {
  let { practitionerId, serviceId } = sel;
  if (practitionerId && !filterPractitioners(clinic, filters).some((p) => p.id === practitionerId)) {
    practitionerId = null;
  }
  if (serviceId) {
    const pool = practitionerId
      ? servicesForPractitioner(clinic, practitionerId)
      : servicesForAny(clinic, filters);
    if (!pool.some((s) => s.id === serviceId)) serviceId = null;
  }
  return { practitionerId, serviceId };
}

// ─── Idempotencia por instancia (AUDIT §5, A2b-S-pub) ──────────────────

/** Firma de un intento: si cambia profesional, servicio u horario es OTRO
 *  turno y lleva key nueva (el server rechaza una key reusada con otros
 *  datos). Un doble click o reintento tras error de MP reusan la misma. */
export function attemptSignature(sel: {
  practitionerId: string;
  serviceId: string;
  slotISO: string;
}): string {
  return `${sel.practitionerId}|${sel.serviceId}|${sel.slotISO}`;
}

export type Attempt = { sig: string; key: string };

/** Devuelve el intento vigente para `sig`: el mismo si la firma no cambió,
 *  o uno nuevo con `mintKey()` si cambió. */
export function nextAttempt(prev: Attempt | null, sig: string, mintKey: () => string): Attempt {
  if (prev && prev.sig === sig) return prev;
  return { sig, key: mintKey() };
}

// ─── "Cualquier profesional" ───────────────────────────────────────────

/** Input de `findFirstPublicSlot` desde el estado del wizard (sin claves
 *  undefined: el schema las acepta, pero así el payload queda limpio). */
export function firstSlotQuery(args: {
  tenantSlug: string;
  serviceId: string;
  filters: WizardFilters;
  fromDate?: string;
}): { tenantSlug: string; serviceId: string; insurerId?: string; locationId?: string; fromDate?: string } {
  const q: { tenantSlug: string; serviceId: string; insurerId?: string; locationId?: string; fromDate?: string } = {
    tenantSlug: args.tenantSlug,
    serviceId: args.serviceId,
  };
  if (args.filters.insurerId) q.insurerId = args.filters.insurerId;
  if (args.filters.locationId) q.locationId = args.filters.locationId;
  if (args.fromDate) q.fromDate = args.fromDate;
  return q;
}

export type WizardSelection = {
  practitionerId: string;
  dateISO: string;
  slotISO: string;
  slotLocationId: string | null;
};

/** El primer turno libre se convierte en una selección concreta: a partir
 *  de acá se reserva igual que eligiendo profesional y horario a mano. */
export function selectionFromFirstSlot(first: PublicFirstSlot): WizardSelection {
  return {
    practitionerId: first.practitionerId,
    dateISO: first.date,
    slotISO: first.iso,
    slotLocationId: first.locationId ?? null,
  };
}

/**
 * Al pasar a "Tus datos": si eligió una obra social y el campo está vacío,
 * lo precargamos con su nombre (Particular no se precarga). Nunca pisa lo
 * que ya escribió el paciente o vino del prefill.
 */
export function coverageInsurerPrefill(
  current: string,
  clinic: PublicClinic,
  insurerId: string | null
): string {
  if (current.trim() || !insurerId) return current;
  const ins = (clinic.insurers ?? []).find((i) => i.id === insurerId);
  if (!ins || ins.isParticular) return current;
  return ins.name;
}

/** Día siguiente a una clave AR "YYYY-MM-DD" (aritmética de calendario del
 *  motor: no depende del huso del navegador). Tira si la clave es inválida. */
export function nextDayKey(dayKey: string): string {
  return addDays(dayKey, 1);
}
