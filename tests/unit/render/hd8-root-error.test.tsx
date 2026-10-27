/**
 * [HD-8] Boundary de error raíz (`app/error.tsx`).
 *
 * Por qué: había `error.tsx` por grupo ((app), (auth), (booking), (portal), (platform), onboarding, /tv, /invite) y
 * `global-error.tsx`, pero ningún boundary entre el layout raíz y los segmentos sueltos (`/cuenta/*`, `/sin-acceso`,
 * `/suspendido`, `/verificar-acceso`, `/elegir-consultorio`, `/plataforma-mfa`, la landing…). Un throw ahí caía en
 * `global-error`, que reemplaza el documento entero (sin `globals.css` ni fuentes). Con `app/error.tsx` el error queda
 * dentro del layout raíz, en el mismo `AuthShell centered` que `/invite/[token]/error.tsx`.
 *
 * Render real (sin jsdom): `RootError`, `AuthShell` y `RouteError` son los de prod; no se mockea nada.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import RootError from "@/app/error";
import { ROOT, forbiddenReach, fmtViolations, type SpecCache } from "@/tests/helpers/import-graph";

const h1s = (html: string) => html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
const text = (s: string) => s.replace(/<[^>]+>/g, "").trim();
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("[HD-8] error raíz", () => {
  const err = Object.assign(new Error("PrismaClientKnownRequestError: tenant 1234 secreto"), { digest: "dg-hd8-42" });
  const html = renderToStaticMarkup(<RootError error={err} reset={() => {}} />);

  it("[HD-8] dentro de AuthShell centered, con una sola h1 (la del error) dentro de <main>", () => {
    expect(html).toContain('data-variant="centered"');
    const found = h1s(html);
    expect(found, html).toHaveLength(1);
    expect(text(found[0] ?? "")).toBe("Algo salió mal");
    expect(html).toMatch(/<main id="main"[^>]*>[\s\S]*<h1[\s\S]*<\/main>/);
    expect(html).not.toMatch(/<h2[^>]*>/);
  });

  it("[HD-8] botón de reintentar y role=alert", () => {
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Reintentar<\/button>/);
    expect(html).toContain('role="alert"');
  });

  it("[HD-8] no muestra el mensaje del error; sí el digest para cruzarlo con el log", () => {
    expect(html).not.toContain("secreto");
    expect(html).not.toContain("Prisma");
    expect(html).toContain("dg-hd8-42");
  });

  it("[HD-8] sin digest no pinta «Código»", () => {
    const plain = renderToStaticMarkup(<RootError error={new Error("x")} reset={() => {}} />);
    expect(plain).not.toContain("Código");
  });

  it("[HD-8] es client component y reporta con kind «route» (vía RouteError)", () => {
    const code = src("app/error.tsx");
    expect(code).toMatch(/^"use client";/);
    expect(code).toMatch(/kind="route"/);
    expect(code).toMatch(/headingAs="h1"/);
  });

  it("[HD-8] no arrastra framer, lib/motion*, UIProviders, toast, confirm, drawer ni modal (C-F3.5)", () => {
    const cache: SpecCache = new Map();
    const v = forbiddenReach(
      "app/error.tsx",
      {
        isForbiddenFile: (f) =>
          [
            "lib/motion.ts",
            "lib/motion-features.ts",
            "components/providers/ui-providers.tsx",
            "components/ui/toast.tsx",
            "components/ui/confirm-dialog.tsx",
            "components/ui/drawer.tsx",
            "components/ui/modal.tsx",
          ].includes(f),
        forbiddenPackages: ["framer-motion"],
      },
      cache
    );
    expect(v, fmtViolations(v)).toEqual([]);
  });
});
