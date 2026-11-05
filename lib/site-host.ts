/**
 * CF3 (SD-M, §30 D-CF3-11): subdominio de la sede digital, `<slug>.<SITE_ROOT_DOMAIN>`.
 *
 * Puro (sin `next/*`, sin Prisma, sin `process.env`): lo usa el middleware (Edge) y lo cubre
 * `tests/unit/site-host.test.ts`.
 *
 * Por qué existe: la regla vieja del middleware tomaba el primer label de CUALQUIER host de 3+ etiquetas como slug
 * (`kinesoft-git-develop-martuuu.vercel.app` → slug «kinesoft-git-develop-martuuu») y seteaba `x-tenant-slug`, un
 * header que nadie lee (`lib/session.ts` lo ignora a propósito). Ahora solo cuenta un host que sea EXACTAMENTE
 * `<una etiqueta>.<rootDomain>`, con la forma de slug y fuera de los reservados del onboarding. Sin `rootDomain`
 * (la variable sin setear, default de prod) todo esto está apagado y el middleware se comporta como antes.
 *
 * El subdominio solo sirve la sede (`/` → `/<slug>`) y su logo (`/logo` → `/<slug>/logo`). Todo lo demás (turnero,
 * login, app, portal) vive en el host principal: las cookies de Supabase son host-only
 * (`lib/supabase/cookie-options.ts`), así que una sesión abierta en el subdominio no existiría en el host principal
 * y viceversa. Por eso el resto de los paths salen con 308 al host principal en vez de servirse ahí.
 */
import { isValidSlug } from "./onboarding-logic";

/** Etiquetas que nunca son un consultorio aunque tengan forma de slug (también están en `RESERVED_SLUGS`). */
const NEVER_SITE_LABELS: ReadonlySet<string> = new Set(["www", "app", "api"]);

/** Hostname DNS: etiquetas a-z0-9 y guiones (sin guion en los bordes), al menos dos etiquetas. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `SITE_ROOT_DOMAIN` normalizado (minúsculas, sin espacios ni punto final) o `null` = apagado. Un valor que no es un
 * dominio, o que es (o cuelga de) `vercel.app`, también apaga: las previews de Vercel nunca son una sede.
 */
export function normalizeSiteRootDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!d || !HOSTNAME_RE.test(d)) return null;
  if (d === "vercel.app" || d.endsWith(".vercel.app")) return null;
  return d;
}

/** Host del header (`Host`) sin puerto, en minúsculas y sin punto final. */
function hostnameOf(host: string): string {
  return host.trim().toLowerCase().replace(/:\d*$/, "").replace(/\.$/, "");
}

/**
 * Slug de la sede si `host` es exactamente `<slug>.<rootDomain>` (una sola etiqueta), o `null`.
 * `rootDomain` se normaliza acá: el llamador puede pasar el valor crudo de la variable.
 */
export function siteSlugFromHost(host: string | null | undefined, rootDomain: string | null | undefined): string | null {
  const root = normalizeSiteRootDomain(rootDomain);
  if (!root || typeof host !== "string") return null;
  const h = hostnameOf(host);
  const suffix = `.${root}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  if (NEVER_SITE_LABELS.has(label) || !isValidSlug(label)) return null;
  return label;
}

export type SiteHostDecision =
  | { kind: "none" }
  | { kind: "rewrite"; slug: string; pathname: string }
  | { kind: "redirect"; slug: string; url: string };

/**
 * Qué hace el middleware con un request: `none` = camino normal (host principal o apagado); `rewrite` = servir
 * `pathname` (la sede o su logo) sin cambiar la URL del navegador; `redirect` = 308 al host principal con el mismo
 * path y query.
 *
 * `appUrl` es `NEXT_PUBLIC_APP_URL`. Si falta, no parsea, o apunta a un subdominio de sede (eso haría un loop), el
 * destino es `https://<rootDomain>`.
 */
export function siteHostDecision(input: {
  host: string | null | undefined;
  pathname: string;
  search: string;
  rootDomain: string | null | undefined;
  appUrl: string | null | undefined;
}): SiteHostDecision {
  const slug = siteSlugFromHost(input.host, input.rootDomain);
  if (!slug) return { kind: "none" };
  if (input.pathname === "/") return { kind: "rewrite", slug, pathname: `/${slug}` };
  if (input.pathname === "/logo") return { kind: "rewrite", slug, pathname: `/${slug}/logo` };
  return { kind: "redirect", slug, url: `${mainOrigin(input.appUrl, input.rootDomain)}${input.pathname}${input.search}` };
}

function mainOrigin(appUrl: string | null | undefined, rootDomain: string | null | undefined): string {
  const root = normalizeSiteRootDomain(rootDomain) as string;
  if (appUrl) {
    try {
      const u = new URL(appUrl);
      if ((u.protocol === "https:" || u.protocol === "http:") && !siteSlugFromHost(u.host, root)) return u.origin;
    } catch {
      /* cae al dominio raíz */
    }
  }
  return `https://${root}`;
}
