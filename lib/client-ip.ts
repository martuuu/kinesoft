/**
 * IP del cliente para rate-limit y contexto de request (A3a-S-rl).
 *
 * Antes el mismo `x-forwarded-for?.split(",")[0].trim()` estaba copiado en 6
 * lugares con fallbacks distintos ("anon", "unknown", undefined) — la misma IP
 * caía en buckets distintos según la superficie y un header basura (vacío,
 * con espacios, de 4 kB) terminaba tal cual dentro de la clave de Redis.
 *
 * - Vercel **pisa** `x-forwarded-for` con la IP real del cliente (no se puede
 *   inyectar desde afuera); la primera entrada es el cliente. `x-real-ip` es
 *   el mismo dato y queda como segundo intento (otros proxies / local).
 * - Solo se aceptan caracteres de IPv4/IPv6 y hasta 45 chars (largo máximo de
 *   una IPv6 textual): cualquier otra cosa cae al fallback para que el valor
 *   no pueda fabricar claves arbitrarias (`:` extra, espacios, etc. no rompen
 *   nada en Redis, pero sí inflan la cardinalidad del Map en memoria).
 *
 * Puro y sin `next/headers`: recibe el `Headers` (o `headers()` de Next, que
 * expone el mismo `get`) para poder testearlo y usarlo en route handlers.
 */
type HeaderGetter = { get(name: string): string | null };

const IP_RE = /^[0-9A-Fa-f.:]{2,45}$/;

export function clientIp(h: HeaderGetter): string;
export function clientIp(h: HeaderGetter, fallback: null): string | null;
export function clientIp(h: HeaderGetter, fallback: string | null = "unknown"): string | null {
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff && IP_RE.test(xff)) return xff;
  const real = h.get("x-real-ip")?.trim();
  if (real && IP_RE.test(real)) return real;
  return fallback;
}
