/**
 * OPS-1a · avisos sobre el remitente para `scripts/diagnose-email.ts`. PURO: el env entra por parámetro.
 *
 * Por qué existe: Resend rechazaba los mails de prod y las causas probables (plan §21.3 · 1a) se ven sin mandar nada:
 *  - `EMAIL_FROM` de un dominio distinto del verificado en Resend (403 `validation_error`);
 *  - `EMAIL_FROM` vacía fuera de Production → cae a `DEFAULT_EMAIL_FROM` (`kinesoft.app`, que no está verificado:
 *    con Resend es un 403 por mail); en Production directamente no sale nada (`no_from`);
 *  - remitente mal pegado (sin `@`, espacios en la casilla) → 422;
 *  - comillas o coma pegadas al copiar a Vercel (la app las limpia en `resolveBaseFrom`, pero conviene corregirlas).
 *
 * Solo mira el remitente que ya resuelve el código (`resolveBaseFrom` sobre el env del PROCESO): nunca abre `.env*`
 * ni mira la key. El dominio «verificado esperado» lo da `--expect-domain` (comparación exacta: Resend verifica el
 * dominio o subdominio puntual que cargaste) o, si no, el host de la URL pública (`--url` / NEXT_PUBLIC_APP_URL),
 * comparado por dominio base: la app vive en `app.dominio` y los mails salen de `mail.dominio`, y eso está bien.
 */
import { DEFAULT_EMAIL_FROM, fromAddress, isLocalHost, isProductionEnv, normalizeEmailAddress, resolveBaseFrom, type EnvLike } from "@/lib/email/transport";

export type EmailFromWarningCode = "from_missing" | "from_default" | "from_malformed" | "from_cleaned" | "from_domain_mismatch";
export type EmailFromWarning = { code: EmailFromWarningCode; text: string };
export type ExpectedEmailDomain = { domain: string; exact: boolean };

/** Segundos niveles bajo un ccTLD (`com.ar`, `gob.ar`, `co.uk`…): el dominio registrable lleva tres etiquetas. */
const CC_SECOND_LEVEL = new Set(["com", "net", "org", "gob", "gov", "edu", "co", "ac", "mil", "int", "tur"]);

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function cleanHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Dominio registrable aproximado (`mail.kinesoft.com.ar` → `kinesoft.com.ar`). Heurística sin la Public Suffix List
 * (sería una dependencia nueva): alcanza para decir «este remitente es de otro dominio», que es lo que se diagnostica.
 */
export function baseDomainOf(host: string): string {
  const labels = cleanHost(host).split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && CC_SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** El dominio contra el que comparar el remitente, o null si no hay uno confiable (URL local o inválida). */
export function expectedEmailDomain(opts: { expectDomain: string | undefined; appUrl: string | undefined }): ExpectedEmailDomain | null {
  const explicit = cleanHost(opts.expectDomain ?? "");
  if (explicit && HOST_RE.test(explicit)) return { domain: explicit, exact: true };
  try {
    const host = cleanHost(new URL(opts.appUrl ?? "").hostname);
    if (!host || isLocalHost(host) || !HOST_RE.test(host)) return null;
    return { domain: host, exact: false };
  } catch {
    return null;
  }
}

function domainOfAddress(addr: string): string | null {
  const at = addr.lastIndexOf("@");
  return at > 0 ? cleanHost(addr.slice(at + 1)) : null;
}

export function emailFromWarnings(env: EnvLike, expected: ExpectedEmailDomain | null): EmailFromWarning[] {
  const raw = env.EMAIL_FROM?.trim() ?? "";
  if (!raw) {
    return isProductionEnv(env)
      ? [{ code: "from_missing", text: "EMAIL_FROM está vacía: en Production no sale ningún mail (reason no_from)." }]
      : [
          {
            code: "from_default",
            text: `EMAIL_FROM está vacía: se usa el default ${DEFAULT_EMAIL_FROM} (lib/email/transport.ts). Ese dominio no está verificado en Resend: con Resend cada mail da 403.`,
          },
        ];
  }

  const base = resolveBaseFrom(env) ?? raw;
  const out: EmailFromWarning[] = [];
  const addr = fromAddress(base);
  if (!normalizeEmailAddress(addr)) {
    return [{ code: "from_malformed", text: "EMAIL_FROM no tiene una casilla válida (esperado `Nombre <casilla@dominio>`): Resend contesta 422." }];
  }
  if (base !== raw) {
    out.push({ code: "from_cleaned", text: "EMAIL_FROM tiene comillas o una coma pegadas: la app las limpia, pero corregí la variable." });
  }

  const fromDomain = domainOfAddress(addr);
  if (expected && fromDomain) {
    const same = expected.exact ? fromDomain === expected.domain : baseDomainOf(fromDomain) === baseDomainOf(expected.domain);
    if (!same) {
      const want = expected.exact ? expected.domain : baseDomainOf(expected.domain);
      out.push({
        code: "from_domain_mismatch",
        text: expected.exact
          ? `El remitente es de ${fromDomain} y el dominio verificado esperado es ${want}: Resend solo acepta el dominio exacto que verificaste (403).`
          : `El remitente es de ${fromDomain} y la app vive en ${want}: si el dominio verificado en Resend es el de la app, cada mail da 403. Confirmalo con --expect-domain <dominio verificado>.`,
      });
    }
  }
  return out;
}
