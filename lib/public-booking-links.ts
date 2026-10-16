/**
 * Links al turnero público (DIR-2d, C-DIR7). Puro: lo usan la página del turnero (redirect del alias) y el
 * directorio (`bookingHref` de cada profesional/consultorio).
 *
 * Por qué existe: el redirect del slug viejo (BO2-D) armaba `/c/<vigente>/booking` a mano y perdía la query; un deep
 * link del directorio `?pro=<practitionerId>` caía en el turnero sin el profesional elegido.
 */

/** `/c/<slug>/booking`, o `…?pro=<practitionerId>` para entrar con el profesional elegido. */
export function bookingHref(slug: string, practitionerId?: string | null): string {
  const base = `/c/${encodeURIComponent(slug)}/booking`;
  return practitionerId ? `${base}?pro=${encodeURIComponent(practitionerId)}` : base;
}

/**
 * `path` + la query recibida (los `searchParams` de una página de Next), re-serializada con `URLSearchParams`:
 * conserva los repetidos en orden (`?a=1&a=2`) y descarta `undefined`. Sin parámetros devuelve `path` tal cual (sin
 * `?` colgando, para que el redirect sin query siga siendo el de siempre).
 */
export function withSearchParams(
  path: string,
  searchParams: Record<string, string | string[] | undefined> | null | undefined
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) qs.append(key, v);
    else qs.append(key, value);
  }
  const s = qs.toString();
  if (!s) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${s}`;
}
