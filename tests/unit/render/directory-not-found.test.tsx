import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import DirectoryNotFound, { metadata } from "@/app/(directory)/not-found";
import DirectoryLayout from "@/app/(directory)/layout";
import * as proPage from "@/app/(directory)/profesionales/[nombreId]/page";
import * as clinicPage from "@/app/(directory)/consultorios/[slug]/page";

/**
 * DIR-Z-F1: 404 del grupo del directorio. Bug que lo motiva: en `next start` el `notFound()` de una ficha ISR
 * (`/consultorios/<no listado>`, `/profesionales/<inexistente>`) pintaba `app/not-found.tsx`, que lee la cookie de
 * sesión → «Page changed from static to dynamic at runtime, reason: cookies» → 500. El 404 del grupo tiene que ser
 * estático: ni sesión, ni cookies, ni headers (directo). El smoke en runtime es `scripts/smoke-directory.mjs`.
 */
const ENV_KEY = "DIRECTORY_MODE";
let prev: string | undefined;
beforeEach(() => {
  prev = process.env[ENV_KEY];
});
afterEach(() => {
  if (prev === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prev;
});

const hrefOf = (html: string, label: string) =>
  html.match(new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${label}</a>`))?.[1] ?? null;

describe("[DIR-Z-F1] app/(directory)/not-found.tsx", () => {
  it("las fichas ISR son force-static: el not-found del ROOT (que lee la cookie) se evalúa en todo render y sin esto da 500", () => {
    for (const mod of [proPage, clinicPage]) {
      expect(mod.dynamic).toBe("force-static");
      expect(mod.revalidate).toBe(600);
    }
  });

  it("no lee sesión, cookies ni headers (lo que hacía 500 en una ficha ISR)", () => {
    const src = readFileSync(join(process.cwd(), "app/(directory)/not-found.tsx"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    expect(src).not.toMatch(/session-user|getSessionUser|next\/headers|cookies\(|headers\(|searchParams|async function/);
  });

  it("noindex", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("preview/public: «No encontramos ese perfil» con CTA a /profesionales y al inicio, dentro del marco del directorio", () => {
    process.env[ENV_KEY] = "preview";
    const html = renderToStaticMarkup(
      <DirectoryLayout>
        <DirectoryNotFound />
      </DirectoryLayout>
    );
    expect(html).toContain("No encontramos ese perfil");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(hrefOf(html, "Ver profesionales")).toBe("/profesionales");
    expect(hrefOf(html, "Ir al inicio")).toBe("/");
    expect(html).toContain('data-surface="directorio"');
  });

  it("off: 404 genérico, sin el marco ni nada que nombre al directorio", () => {
    process.env[ENV_KEY] = "off";
    const html = renderToStaticMarkup(
      <DirectoryLayout>
        <DirectoryNotFound />
      </DirectoryLayout>
    );
    expect(html).toContain("No encontramos esta página");
    expect(hrefOf(html, "Ir al inicio")).toBe("/");
    expect(html).not.toContain('data-surface="directorio"');
    expect(html).not.toMatch(/profesionales|directorio|perfil/i);
  });
});
