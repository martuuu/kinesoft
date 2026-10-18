/**
 * OPS-1a · avisos del diagnóstico de mail sobre el remitente (`lib/email/diagnose-logic.ts`, lo usa
 * `scripts/diagnose-email.ts`).
 *
 * Por qué: las causas probables del rechazo de Resend en prod (plan §21.3 · 1a) son de configuración y se ven sin
 * mandar nada: un `EMAIL_FROM` de un dominio distinto del verificado, un `EMAIL_FROM` vacío que cae al default
 * `kinesoft.app` (no verificado: 403 por mail) o un remitente mal pegado. El script solo mira el remitente que ya
 * resuelve el código (`resolveBaseFrom`); nunca abre `.env*`.
 */
import { describe, it, expect } from "vitest";
import { emailFromWarnings, baseDomainOf, expectedEmailDomain } from "@/lib/email/diagnose-logic";
import { DEFAULT_EMAIL_FROM } from "@/lib/email/transport";

const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

describe("[OPS-1a] baseDomainOf", () => {
  it("[OPS-1a] dominio registrable con los segundos niveles de .ar y compañía", () => {
    expect(baseDomainOf("mail.kinesoft.com.ar")).toBe("kinesoft.com.ar");
    expect(baseDomainOf("app.kinesoft.com.ar")).toBe("kinesoft.com.ar");
    expect(baseDomainOf("kinesoft.app")).toBe("kinesoft.app");
    expect(baseDomainOf("send.mail.ejemplo.io")).toBe("ejemplo.io");
    expect(baseDomainOf("Ejemplo.COM.")).toBe("ejemplo.com");
  });
});

describe("[OPS-1a] expectedEmailDomain", () => {
  it("[OPS-1a] --expect-domain manda (exacto); si no, el host de la URL pública (por dominio base)", () => {
    expect(expectedEmailDomain({ expectDomain: "mail.kinesoft.com.ar", appUrl: "https://app.otra.com" })).toEqual({
      domain: "mail.kinesoft.com.ar",
      exact: true,
    });
    expect(expectedEmailDomain({ expectDomain: undefined, appUrl: "https://app.kinesoft.com.ar/x" })).toEqual({
      domain: "app.kinesoft.com.ar",
      exact: false,
    });
  });
  it("[OPS-1a] URL local o inválida → sin dominio esperado", () => {
    expect(expectedEmailDomain({ expectDomain: undefined, appUrl: "http://localhost:3000" })).toBeNull();
    expect(expectedEmailDomain({ expectDomain: "", appUrl: "basura" })).toBeNull();
  });
});

describe("[OPS-1a] emailFromWarnings", () => {
  it("[OPS-1a] EMAIL_FROM vacío fuera de Production → cae al default no verificado", () => {
    const ws = emailFromWarnings({ EMAIL_FROM: "" }, null);
    expect(codes(ws)).toContain("from_default");
    expect(ws.find((w) => w.code === "from_default")!.text).toContain(DEFAULT_EMAIL_FROM);
  });

  it("[OPS-1a] EMAIL_FROM vacío en Production → no sale nada", () => {
    expect(codes(emailFromWarnings({ VERCEL_ENV: "production" }, null))).toEqual(["from_missing"]);
  });

  it("[OPS-1a] dominio distinto del verificado (por dominio base, derivado de la URL)", () => {
    const ws = emailFromWarnings(
      { EMAIL_FROM: "KineSoft <no-reply@kinesoft.app>" },
      { domain: "app.kinesoft.com.ar", exact: false }
    );
    expect(codes(ws)).toEqual(["from_domain_mismatch"]);
    expect(ws[0].text).toContain("kinesoft.app");
    expect(ws[0].text).toContain("kinesoft.com.ar");
  });

  it("[OPS-1a] subdominio de mail del mismo dominio base que la app → sin aviso", () => {
    expect(emailFromWarnings({ EMAIL_FROM: "KineSoft <no-reply@mail.kinesoft.com.ar>" }, { domain: "app.kinesoft.com.ar", exact: false })).toEqual([]);
  });

  it("[OPS-1a] con --expect-domain la comparación es exacta (Resend verifica el subdominio, no el base)", () => {
    expect(codes(emailFromWarnings({ EMAIL_FROM: "no-reply@kinesoft.com.ar" }, { domain: "mail.kinesoft.com.ar", exact: true }))).toEqual([
      "from_domain_mismatch",
    ]);
    expect(emailFromWarnings({ EMAIL_FROM: "no-reply@MAIL.kinesoft.com.ar" }, { domain: "mail.kinesoft.com.ar", exact: true })).toEqual([]);
  });

  it("[OPS-1a] remitente mal pegado (sin @ o con espacios en la casilla) → from_malformed", () => {
    expect(codes(emailFromWarnings({ EMAIL_FROM: "KineSoft no-reply" }, null))).toEqual(["from_malformed"]);
    expect(codes(emailFromWarnings({ EMAIL_FROM: "KineSoft <no reply@kinesoft.com.ar>" }, null))).toEqual(["from_malformed"]);
  });

  it("[OPS-1a] comillas o coma pegadas al copiar → aviso (la app las limpia, pero conviene corregir la variable)", () => {
    expect(codes(emailFromWarnings({ EMAIL_FROM: '"KineSoft <no-reply@mail.kinesoft.com.ar>",' }, null))).toEqual(["from_cleaned"]);
  });

  it("[OPS-1a] los avisos nunca citan la key", () => {
    const ws = emailFromWarnings({ EMAIL_FROM: "", RESEND_API_KEY: "re_SECRETO" }, { domain: "app.kinesoft.com.ar", exact: false });
    expect(JSON.stringify(ws)).not.toContain("SECRETO");
  });
});
