/**
 * OPS-1d · guard de marca: el literal «KineSoft» vive en `lib/brand.ts` (`BRAND_NAME`) y en ningún archivo nuevo.
 *
 * Por qué: el rename de marca (plan §21.3 · OPS-4, OPS-D4; default «Consultorio Online») es cambiar `BRAND_NAME` y
 * barrer lo viejo. Sin un guard, cada sesión que escribe copy suma otro «KineSoft» a mano y el barrido no termina
 * nunca. Este test es un RATCHET por archivo:
 *  - un archivo que no está en `ALLOW` no puede tener el literal (lo nuevo usa `BRAND_NAME`);
 *  - un archivo de `ALLOW` no puede tener MÁS apariciones que su techo;
 *  - si tiene MENOS, el test pide bajar el techo a lo que quedó (así lo que se barrió no vuelve). Con 0, se borra la
 *    entrada. El rename (otra sesión, después) lleva todo a 0 y `ALLOW` queda vacío.
 * Nadie sube un techo ni agrega una entrada: para un caso legítimo nuevo, se usa `BRAND_NAME`.
 *
 * Qué NO cuenta, a propósito (la búsqueda distingue mayúsculas):
 *  - identificadores en minúscula que NO se renombran con la marca: cookies `kine_*` (renombrarlas desloguea a todos),
 *    roles de Postgres `kinesoft_app` / `kinesoft_service` y locks `kinesoft:*` (viven en la base de prod), claves de
 *    localStorage `kinesoft.*` / `kine_*` (se perderían las preferencias guardadas), el nombre de la base y del
 *    proyecto (`kinesoft` en docker-compose, package.json, Supabase), dominios `kinesoft.app` / `kinesoft.com.ar`;
 *  - `tests/**`: fixtures y nombres de test que citan la marca como dato (incluido este archivo);
 *  - `prisma/migrations/**`: historia inmutable (una migración aplicada no se edita: cambia el checksum);
 *  - `.docs/`, AGENTS.md, `.env.example`, `design_source/`: documentación e historia, no se rinden en la app.
 *
 * Alcance: lo que corre o se sirve (`app`, `components`, `lib`, `hooks`, `scripts`, `public`, `prisma` sin
 * migraciones) y `lib/brand.ts` excluido. Baseline del 18-oct (OPS-1d): 242 apariciones en 113 archivos.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const LITERAL = "KineSoft";
const SCAN_ROOTS = ["app", "components", "lib", "hooks", "scripts", "public", "prisma"];
const SKIP_DIRS = new Set(["node_modules", "migrations", ".next"]);
const EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".json", ".sql", ".prisma", ".webmanifest", ".html", ".svg", ".txt"];
const SOURCE_OF_TRUTH = "lib/brand.ts";

/**
 * Techos congelados (archivo → máximo de apariciones). Solo pueden BAJAR.
 */
const ALLOW: Record<string, number> = {
  // ── Copy, metadata, mails y textos que ve el usuario (o el remitente): el barrido del rename pasa por acá y los
  //    cambia por `BRAND_NAME`. Incluye los que además lo citan en comentarios.
  "app/(app)/agenda/page.tsx": 1,
  "app/(app)/biblioteca/page.tsx": 1,
  "app/(app)/configuracion/page.tsx": 1,
  "app/(app)/dashboard/page.tsx": 1,
  "app/(app)/diagnostico/page.tsx": 1,
  "app/(app)/pacientes/[id]/imprimir/page.tsx": 1,
  "app/(app)/pacientes/[id]/page.tsx": 1,
  "app/(app)/pacientes/page.tsx": 1,
  "app/(app)/planes/[discipline]/page.tsx": 2,
  "app/(app)/planes/page.tsx": 1,
  "app/(app)/sala/page.tsx": 1,
  "app/(app)/seguimiento/[sessionId]/page.tsx": 2,
  "app/(app)/seguimiento/page.tsx": 1,
  "app/(app)/terapia-manual/page.tsx": 1,
  "app/(booking)/c/[slug]/booking/page.tsx": 1,
  "app/(directory)/not-found.tsx": 1,
  "app/(platform)/plataforma/auditoria/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/actividad/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/ciclo-de-vida/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/equipo/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/facturacion/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/[id]/suscripcion/page.tsx": 1,
  "app/(platform)/plataforma/consultorios/page.tsx": 2,
  "app/(platform)/plataforma/directorio/page.tsx": 1,
  "app/(platform)/plataforma/facturacion/page.tsx": 1,
  "app/(platform)/plataforma/page.tsx": 1,
  "app/(platform)/plataforma/precios/page.tsx": 1,
  "app/(platform)/plataforma/salud/page.tsx": 1,
  "app/(platform)/plataforma/sistema/page.tsx": 1,
  "app/(platform)/plataforma/tags/page.tsx": 1,
  "app/(platform)/plataforma/usuarios/[id]/page.tsx": 1,
  "app/(platform)/plataforma/usuarios/page.tsx": 2,
  "app/cuenta-desactivada/page.tsx": 2,
  "app/cuenta/seguridad/page.tsx": 1,
  "app/elegir-consultorio/page.tsx": 1,
  "app/globals.css": 1,
  "app/invite/[token]/activate-form.tsx": 1,
  "app/invite/[token]/page.tsx": 4,
  "app/mantenimiento/page.tsx": 2,
  "app/not-found.tsx": 1,
  "app/onboarding/page.tsx": 1,
  "app/plataforma-mfa/configurar/page.tsx": 1,
  "app/plataforma-mfa/verificar/page.tsx": 2,
  "app/sin-acceso/page.tsx": 2,
  "app/suspendido/page.tsx": 2,
  "app/verificar-acceso/page.tsx": 1,
  "components/account/security-settings.tsx": 2,
  "components/account/two-factor-challenge.tsx": 1,
  "components/booking/booking-result.module.css": 3,
  "components/booking/public-booking-wizard.tsx": 3,
  "components/configuracion/panels/billing-panel.tsx": 1,
  "components/configuracion/panels/general-panel.tsx": 1,
  "components/configuracion/panels/support-access-panel.tsx": 1,
  "components/configuracion/panels/support-messages-panel.tsx": 2,
  "components/layout/access-banner.tsx": 2,
  "components/plataforma/health/health-logic.ts": 1,
  "components/plataforma/tenants/tenant-lifecycle.tsx": 1,
  "components/plataforma/users/auth-only-card.tsx": 1,
  "components/plataforma/users/user-actions.tsx": 5,
  "components/ui/kine-logo.tsx": 1,
  "lib/arrival-alert-state.ts": 3,
  "lib/bookings-export-internal.ts": 1,
  "lib/email/templates-account.ts": 16,
  "lib/email/templates-billing.ts": 3,
  "lib/email/templates-support.ts": 6,
  "lib/email/templates.ts": 66,
  "lib/email/transport.ts": 7,
  "lib/email/types.ts": 2,
  "lib/invite-activation-internal.ts": 2,
  "lib/mercadopago.ts": 1,
  "lib/mfa-port.ts": 1,
  "lib/platform-mfa-actions.ts": 1,
  "lib/saas-billing-view.ts": 1,
  "lib/tenant-access.ts": 1,
  "lib/two-factor.ts": 1,
  "scripts/diagnose-auth.ts": 1,
  "scripts/seed-santiago.ts": 1,
  // ── Solo en comentarios (historia del porqué, «KineSoft no tiene…»). No se ven en la app; el rename los ajusta o
  //    los reescribe sin la marca.
  "app/(auth)/login/page.tsx": 1,
  "app/invite/[token]/invite-state.ts": 1,
  "app/sitemap.ts": 1,
  "components/booking/booking-unavailable.tsx": 2,
  "components/booking/public-booking.module.css": 1,
  "components/configuracion/configuracion-client.tsx": 1,
  "components/layout/tweaks-panel.tsx": 1,
  "lib/capabilities.ts": 1,
  "lib/datetime-ar.ts": 1,
  "lib/email/index.ts": 1,
  "lib/email/mailpit.ts": 1,
  "lib/env.ts": 3,
  "lib/identity/auth-admin.ts": 1,
  "lib/motion.ts": 1,
  "lib/patients.ts": 1,
  "lib/platform-support.ts": 1,
  "lib/safe-next.ts": 1,
  "lib/supabase/cookie-options.ts": 1,
  "lib/support-threads-internal.ts": 1,
  "lib/tab-title.ts": 1,
  "lib/team-internal.ts": 1,
  "lib/tenant-export-logic.ts": 1,
  "prisma/roles.local.sql": 1,
  "prisma/roles.supabase.sql": 1,
  "prisma/schema.prisma": 1,
  "prisma/seed.ts": 1,
  "public/sw.js": 1,
  "scripts/diagnose-email.ts": 1,
};

function scan(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs);
        continue;
      }
      if (!EXTS.some((e) => name.endsWith(e))) continue;
      const rel = relative(ROOT, abs).split(sep).join("/");
      if (rel === SOURCE_OF_TRUTH) continue;
      const n = readFileSync(abs, "utf8").split(LITERAL).length - 1;
      if (n > 0) out.set(rel, n);
    }
  };
  for (const r of SCAN_ROOTS) walk(join(ROOT, r));
  return out;
}

describe("[OPS-1d] guard de marca: «KineSoft» solo en lib/brand.ts y en la allowlist que baja", () => {
  const found = scan();

  it("[OPS-1d] lib/brand.ts sigue siendo la fuente (BRAND_NAME)", () => {
    expect(readFileSync(join(ROOT, SOURCE_OF_TRUTH), "utf8")).toMatch(/export const BRAND_NAME = "/);
  });

  it("[OPS-1d] ningún archivo nuevo usa el literal (usá BRAND_NAME de lib/brand.ts)", () => {
    const fresh = [...found.keys()].filter((f) => !(f in ALLOW));
    expect(fresh, `Archivos con «${LITERAL}» fuera de la allowlist: importá BRAND_NAME de @/lib/brand`).toEqual([]);
  });

  it("[OPS-1d] ningún archivo de la allowlist suma apariciones", () => {
    const grew = Object.entries(ALLOW)
      .filter(([f, max]) => (found.get(f) ?? 0) > max)
      .map(([f, max]) => `${f}: ${found.get(f)} > ${max}`);
    expect(grew, "El techo no sube: usá BRAND_NAME").toEqual([]);
  });

  it("[OPS-1d] ratchet: si un archivo bajó, el techo baja con él (0 → se borra la entrada)", () => {
    const shrank = Object.entries(ALLOW)
      .filter(([f, max]) => (found.get(f) ?? 0) < max)
      .map(([f]) => `${f}: bajá el techo a ${found.get(f) ?? 0}`);
    expect(shrank).toEqual([]);
  });
});
