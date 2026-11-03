/**
 * [CF2 · D-CF2-5] Filtro de sede de /sala, compartido con la agenda (`agendaPrefs.locationId`).
 *
 * Por qué un módulo aparte y no `matchesLocation` de `lib/agenda-client-state.ts`: ese módulo es el estado entero de
 * la agenda (vistas, filtros, salas, chips) y `/sala` lo bajaría en su first load solo por un predicado de 3 líneas
 * (meta del brief: ≤ +0,5 kB). La regla es la MISMA y lo fija un test de paridad (`tests/unit/cf2-sala-location.test.ts`):
 * si una cambia sin la otra, el test se rompe.
 */

export type SalaLocationOption = { id: string; name: string; isPrimary: boolean };

/** Sede elegida (`null` = todas) y la principal (para los turnos con `locationId` null). */
export type SalaLocationScope = {
  locations: ReadonlyArray<SalaLocationOption>;
  locationId: string | null;
  primaryLocationId: string | null;
};

/**
 * ¿El turno es de la sede? Paridad con `matchesLocation`: `locationId` null en el turno = sede principal; sin el
 * campo (proyección vieja) no se esconde: no se saca a un paciente de la sala por no saber dónde es.
 */
export function atSalaLocation(
  b: { locationId?: string | null },
  locationId: string | null,
  primaryLocationId: string | null
): boolean {
  if (!locationId || b.locationId === undefined) return true;
  return (b.locationId ?? primaryLocationId) === locationId;
}

/**
 * El filtro existe solo con ≥2 sedes (D-CF2-5): con una, `null` (sin selector, sin filtro). Una sede guardada que ya
 * no está (archivada, de otra cuenta) se trata como «todas», igual que la agenda al leer `agendaPrefs.locationId`.
 */
export function salaLocationScope(
  locations: ReadonlyArray<SalaLocationOption>,
  savedLocationId: string | null
): SalaLocationScope | null {
  if (locations.length < 2) return null;
  const locationId = savedLocationId && locations.some((l) => l.id === savedLocationId) ? savedLocationId : null;
  return { locations, locationId, primaryLocationId: locations.find((l) => l.isPrimary)?.id ?? null };
}

/**
 * Lo que ven las caras con una sede elegida: turnos (y entradas del escritorio) de esa sede y sus salas. Sin sede
 * devuelve los MISMOS arrays (identidad: los `useMemo` de las caras no recalculan). Las salas sin `locationId`
 * (catálogo viejo) no se esconden. Con «Todas las sedes» quedan todas las salas, como hasta CF2 (la agenda usa la
 * principal en «Por sala», D4; en /sala eso escondería columnas que hoy se ven).
 */
export function scopeSalaRows<T extends { locationId?: string | null }>(
  rows: ReadonlyArray<T>,
  scope: SalaLocationScope | null
): ReadonlyArray<T> {
  if (!scope?.locationId) return rows;
  const { locationId, primaryLocationId } = scope;
  return rows.filter((r) => atSalaLocation(r, locationId, primaryLocationId));
}

export function scopeSalaRooms<R extends { locationId?: string }>(
  rooms: ReadonlyArray<R>,
  scope: SalaLocationScope | null
): ReadonlyArray<R> {
  if (!scope?.locationId) return rooms;
  return rooms.filter((r) => r.locationId === undefined || r.locationId === scope.locationId);
}
