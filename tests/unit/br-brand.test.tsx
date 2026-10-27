/**
 * [BR-*] Renombre a la marca nueva (PV Q5, §27 · brief «D · BR»). Cierre BR-Z (27-oct).
 *
 * Qué fija cada bloque y por qué:
 *  - [BR-1] (el `it.fails` del brief: «la marca vieja = 0 en el código que corre») lo cubre el guard ESTRICTO de
 *    `tests/unit/brand-literal.test.ts`, en verde.
 *  - [BR-2] las tres constantes de `lib/brand.ts` son el contrato del brief (el resto del código las importa).
 *  - [BR-3] manifests: el `short_name` es lo que el SO muestra debajo del ícono y corta a ~12 caracteres.
 *  - [BR-4] `statement_descriptor` de Mercado Pago: ASCII y ≤22, o MP lo rechaza o lo deforma en el resumen de la tarjeta.
 *  - [BR-5] mails: pie «marca · bajada» sin la vertical, y el remitente «X vía marca» entero en 64 aunque el consultorio
 *    tenga un nombre largo (con la marca larga el sufijo come 23 caracteres).
 *  - [BR-6] títulos: el root pone `%s · marca`; una página que además pegaba la marca a mano quedaba con la marca dos
 *    veces («Cobros · <marca> · <marca>»): BR-Z lo encontró en 19 archivos que BR-a..BR-c1 no tocaron porque ya
 *    usaban `BRAND_NAME` (no el literal viejo).
 *  - [BR-7] `KineLogo`: wordmark en dos spans armado con `BRAND_NAME`; `markOnly` sin texto (sidebar colapsado, mobile).
 *  - [BR-9] identificadores que JAMÁS se renombran (cookies, claves HMAC, locks, roles, cache del SW, UID del ICS):
 *    renombrarlos cerraría sesiones, invalidaría firmas o dejaría datos huérfanos. Se afirma que SIGUEN en el código.
 *
 * Se testea el símbolo real (manifest, ruta del manifest de /tv, `statementDescriptorFrom`, el puerto SaaS contra el MP
 * falso, las plantillas de mail, `composeFrom`, la metadata del root, `KineLogo`). Solo se mockean las fuentes de
 * `next/font` (no corren fuera de Next) y la red (el MP falso).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_NAME, BRAND_SHORT_NAME, BRAND_TAGLINE } from "@/lib/brand";
import manifest from "@/app/manifest";
import { GET as tvManifestGET } from "@/app/(display)/tv/manifest/route";
import { statementDescriptorFrom, STATEMENT_DESCRIPTOR_MAX } from "@/lib/mp-connect/preference";
import { createChargeCheckout } from "@/lib/mercadopago-saas";
import { fakeMpGetPreference } from "@/lib/mp-connect/fake-mp";
import { installSaasFakeMp, type InstalledSaasFakeMp } from "../helpers/mp-saas-fake";
import { BRAND_FOOTER, passwordResetEmail, welcomeEmail } from "@/lib/email/templates";
import { composeFrom, FROM_NAME_MAX, FROM_NAME_SUFFIX } from "@/lib/email/transport";
import { KineLogo } from "@/components/ui/kine-logo";

vi.mock("@/lib/fonts", () => ({ onest: { variable: "f-onest" }, jetbrains: { variable: "f-jetbrains" } }));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const ASCII_DESCRIPTOR = /^[A-Za-z0-9 ]+$/;

describe("[BR-2] constantes de la marca", () => {
  it("BRAND_NAME / BRAND_SHORT_NAME / BRAND_TAGLINE son las del brief", () => {
    expect(BRAND_NAME).toBe("Consultorio Online");
    expect(BRAND_SHORT_NAME).toBe("Consultorio");
    expect(BRAND_TAGLINE).toBe("Gestión para consultorios de salud");
    // La bajada ya no es solo de kinesiología: la marca es para cualquier consultorio.
    expect(BRAND_TAGLINE).not.toMatch(/kinesiolog|osteopat/i);
  });
});

describe("[BR-3] manifests", () => {
  it("app: name = BRAND_NAME, short_name = BRAND_SHORT_NAME (≤12)", () => {
    const m = manifest();
    expect(m.name).toBe(BRAND_NAME);
    expect(m.short_name).toBe(BRAND_SHORT_NAME);
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
  });

  it("/tv: nombre con la marca y short_name ≤12", async () => {
    const res = tvManifestGET();
    const body = (await res.json()) as { name: string; short_name: string };
    expect(body.name).toContain(BRAND_NAME);
    expect(body.short_name.length).toBeGreaterThan(0);
    expect(body.short_name.length).toBeLessThanOrEqual(12);
  });
});

describe("[BR-4] descriptores de Mercado Pago (ASCII ≤22)", () => {
  let fake: InstalledSaasFakeMp;
  beforeEach(() => {
    fake = installSaasFakeMp();
  });
  afterEach(() => fake.uninstall());

  it("statementDescriptorFrom(BRAND_NAME): la marca entera, ASCII y ≤22", () => {
    const d = statementDescriptorFrom(BRAND_NAME);
    expect(STATEMENT_DESCRIPTOR_MAX).toBe(22);
    expect(d).toMatch(ASCII_DESCRIPTOR);
    expect(d.length).toBeLessThanOrEqual(22);
    expect(d).toBe(BRAND_NAME); // la marca de Q5 ya es ASCII y entra (18): no se corta
  });

  it("checkout del turnero viejo (lib/mercadopago.ts) pasa la marca por el mismo saneo", () => {
    expect(read("lib/mercadopago.ts")).toMatch(/statement_descriptor:\s*statementDescriptorFrom\(BRAND_NAME\)/);
  });

  it("checkout de la cuota SaaS (createChargeCheckout contra el MP falso): descriptor ASCII ≤22 en el body", async () => {
    const r = await createChargeCheckout({
      tenantId: "tenant-br",
      chargeId: "charge-br",
      title: `${BRAND_NAME} · cargo de noviembre`,
      amountCents: 2_500_000,
      payerEmail: "titular@consultorio.test",
      idempotencyKey: "br-4",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = String(fakeMpGetPreference(r.data.preferenceId)!.body.statement_descriptor);
    expect(d).toMatch(ASCII_DESCRIPTOR);
    expect(d.length).toBeLessThanOrEqual(22);
    expect(d).toBe(statementDescriptorFrom(BRAND_NAME));
  });
});

describe("[BR-5] mails", () => {
  it("pie `${BRAND_NAME} · ${BRAND_TAGLINE}` en html y texto, sin «kinesiología y osteopatía»", () => {
    expect(BRAND_FOOTER).toBe(`${BRAND_NAME} · ${BRAND_TAGLINE}`);
    for (const m of [passwordResetEmail({ url: "https://app.example/r" }), welcomeEmail({ tenantName: "Kine Sur", url: "https://app.example/w" })]) {
      expect(m.text.trimEnd().endsWith(BRAND_FOOTER)).toBe(true);
      expect(m.html).toMatch(new RegExp(`<strong[^>]*>${BRAND_NAME}</strong> · ${BRAND_TAGLINE}`));
      expect(`${m.html} ${m.text}`).not.toMatch(/kinesiología y osteopatía/i);
    }
  });

  it("From «X vía marca»: sufijo fijo y display-name ≤64 aunque el consultorio tenga un nombre largo", () => {
    expect(FROM_NAME_SUFFIX).toBe(` vía ${BRAND_NAME}`);
    const base = `${BRAND_NAME} <no-reply@mail.example>`;
    expect(composeFrom(base, "Kine Sur")).toBe(`Kine Sur vía ${BRAND_NAME} <no-reply@mail.example>`);
    for (const name of ["Centro Integral de Kinesiología y Rehabilitación Deportiva del Sur Bonaerense", "A".repeat(200)]) {
      const from = composeFrom(base, name);
      const display = from.slice(0, from.lastIndexOf(" <")).replace(/^"|"$/g, "");
      expect(display.length, from).toBeLessThanOrEqual(FROM_NAME_MAX);
      expect(FROM_NAME_MAX).toBe(64);
      expect(display.endsWith(FROM_NAME_SUFFIX), from).toBe(true);
      expect(display).toContain("…");
      expect(from.endsWith("<no-reply@mail.example>")).toBe(true);
    }
  });
});

// ── [BR-6] títulos ──────────────────────────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/^(page|layout)\.tsx?$/.test(name)) out.push(relative(ROOT, abs).split(sep).join("/"));
  }
  return out;
}

/** `title: "…"` / `title: \`…\`` como string plano (no `{ absolute }` ni `{ default, template }`). */
const PLAIN_TITLE = /\btitle:\s*(`[^`]*`|"[^"]*")/g;
const metaSource = (src: string) => /export (const metadata|(async )?function generateMetadata)/.test(src);

describe("[BR-6] títulos de página", () => {
  it("root: title.default = BRAND_NAME y template `%s · ${BRAND_NAME}`", async () => {
    const { metadata } = await import("@/app/layout");
    expect(metadata.title).toEqual({ default: BRAND_NAME, template: `%s · ${BRAND_NAME}` });
    expect(metadata.applicationName).toBe(BRAND_NAME);
  });

  const files = walk(join(ROOT, "app"));
  const src = new Map(files.map((f) => [f, read(f)]));

  it("ninguna página ni layout de app/** tiene la marca vieja en su metadata", () => {
    const bad = files.filter((f) => metaSource(src.get(f)!) && /KineSoft|Kinesoft/.test(src.get(f)!));
    expect(bad).toEqual([]);
  });

  it("ningún título plano repite la marca que ya agrega el template del root", () => {
    // Next (resolve-metadata): un layout con `title` string plano resetea el template para sus hijos; uno sin `title`
    // lo hereda. Se recorre la cadena de layouts de cada archivo con esa misma regla.
    const resetsTemplate = (layout: string) => {
      const s = src.get(layout);
      return !!s && metaSource(s) && PLAIN_TITLE.test(s) && ((PLAIN_TITLE.lastIndex = 0), true);
    };
    const templateActive = (file: string): boolean => {
      let dir = dirname(file);
      if (file.endsWith("/layout.tsx")) dir = dirname(dir); // el propio layout usa el template de su padre
      for (; dir !== "app" && dir !== "."; dir = dirname(dir)) {
        if (resetsTemplate(`${dir}/layout.tsx`)) return false;
      }
      return true; // el root define el template
    };
    const doubled: string[] = [];
    for (const f of files) {
      const s = src.get(f)!;
      if (f === "app/layout.tsx" || !metaSource(s) || !templateActive(f)) continue;
      for (const m of s.matchAll(PLAIN_TITLE)) {
        if (/\$\{BRAND_NAME\}|BRAND_NAME/.test(m[1])) doubled.push(`${f}: ${m[0]}`);
      }
    }
    expect(doubled, "Poné solo el nombre de la página: el template del root agrega la marca").toEqual([]);
    // Anti-false-green: el escaneo vio las páginas que BR-Z corrigió.
    expect(src.get("app/(app)/cobros/page.tsx")).toMatch(/title: "Cobros"/);
    expect(files.length).toBeGreaterThan(80);
  });
});

describe("[BR-7] KineLogo", () => {
  it("con wordmark: dos spans «primera palabra» + «resto», texto = BRAND_NAME, glifo Sello C", () => {
    const html = renderToStaticMarkup(<KineLogo />);
    const [lead, ...rest] = BRAND_NAME.split(" ");
    expect(html).toMatch(new RegExp(`>${lead} <span[^>]*>${rest.join(" ")}</span></span>`));
    expect(html.replace(/<[^>]+>/g, "")).toBe(BRAND_NAME);
    expect(html).toContain('d="M30.88 14.17 A12 12 0 1 0 30.88 33.83"');
    expect(html).toContain('fill="var(--lime-300)"');
    expect(html).not.toMatch(/KineSoft|Kinesoft/);
  });

  it("markOnly: solo la baldosa, sin texto", () => {
    const html = renderToStaticMarkup(<KineLogo markOnly size={32} />);
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
    expect(html).toContain("<svg");
    expect(html).not.toContain(BRAND_NAME.split(" ")[0]);
  });
});

describe("[BR-9] identificadores preservados (JAMÁS se renombran)", () => {
  const cases: Array<[string, string, string]> = [
    // [archivo, literal exacto, por qué no se toca]
    ["lib/supabase/session-mode.ts", '"kine_session_mode"', "cookie: renombrarla desloguea a todos"],
    ["lib/idle-logout.ts", '"kine_idle"', "cookie del cierre por inactividad"],
    ["lib/active-tenant-cookie.ts", '"kine_tenant"', "cookie del consultorio activo"],
    ["lib/two-factor-cookie.ts", '"kine_2fa"', "cookie firmada de 2FA"],
    ["lib/two-factor-cookie.ts", '"kine_stepup"', "cookie de step-up"],
    ["lib/support-session-internal.ts", '"kine_support"', "cookie de acceso de soporte"],
    ["lib/reception-displays-types.ts", '"kine_tv"', "cookie de la pantalla vinculada"],
    ["lib/recovery-cookie.ts", '"ks_recovery"', "cookie del link de recuperación"],
    ["lib/two-factor-cookie.ts", '"kinesoft:two-factor:v1"', "clave HMAC: cambiarla invalida las cookies firmadas"],
    ["lib/secret-box.ts", "kinesoft:secret-box:v1|", "AAD del secret-box: cambiarla no deja descifrar lo guardado"],
    ["lib/display-pairing-internal.ts", '"kinesoft:tv-pair:v1"', "clave HMAC del emparejamiento de la TV"],
    ["lib/idle-logout-internal.ts", "`kinesoft:idle:v1:${sessionId}`", "namespace del hash de inactividad"],
    ["lib/mp-connect/account-client.ts", "`kinesoft-pref-${ext}`", "idempotencia de MP: un prefijo nuevo duplicaría preferencias"],
    ["lib/realtime-token-internal.ts", '"kinesoft-realtime"', "iss/purpose del token de realtime (lo verifica la policy)"],
    ["components/layout/tweaks-context.tsx", '"kinesoft:tweaks"', "localStorage: se perderían las preferencias"],
    ["app/(app)/layout.tsx", '"kinesoft:tweaks"', "el script sin flash lee la misma clave"],
    ["public/sw.js", '"ks-sw-v2"', "cache del service worker"],
    ["prisma/roles.local.sql", "kinesoft_app", "rol de Postgres de la app"],
    ["prisma/roles.supabase.sql", "kinesoft_app", "rol de Postgres de la app en prod"],
    ["prisma/roles.supabase.sql", "kinesoft_service", "rol de servicio en prod"],
    ["lib/bookings-export-internal.ts", "`UID:${b.id}@kinesoft`", "UID del ICS: cambiarlo duplica los turnos en el calendario"],
  ];
  it.each(cases)("%s conserva %s (%s)", (file, literal) => {
    expect(read(file)).toContain(literal);
  });

  it("los literales preservados no usan BRAND_NAME (un rename futuro no los arrastra)", () => {
    expect(read("lib/two-factor-cookie.ts")).not.toMatch(/update\([^)]*BRAND_NAME/);
    expect(read("lib/secret-box.ts")).not.toMatch(/BRAND_NAME/);
    expect(read("public/sw.js")).not.toMatch(/Consultorio/);
  });
});
