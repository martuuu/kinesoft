/**
 * DIR-3b · guard «directorio sin PII» (§20.14, brief DIR §1 y C-DIR5/C-DIR6) contra Postgres real.
 *
 * Renderiza las TRES páginas reales de `app/(directory)/` (y su `generateMetadata` si la exportan) sobre una fixture
 * efímera, con el snapshot REAL (`getDirectorySnapshot` → `buildDirectorySnapshot` → `getPublicClinic`, canal service).
 * Solo `next/cache` está mockeado (setup de integración, pass-through). Anti-false-green: la fixture SIEMBRA cada dato
 * prohibido con un valor reconocible (emails de las personas y el público del consultorio, userIds, `rating` 4.9, un
 * precio $ 7.777,77, un paciente con nombre y DNI, el nombre de un profesional reservable SIN perfil publicado) y el
 * test afirma que ninguno aparece en el HTML ni en la metadata, mientras que lo público SÍ aparece (si la página
 * rindiera vacía, los "no contiene" serían verdes de mentira).
 *
 * JSON-LD (C-DIR6): el nombre público y la bio llevan `</script><script>alert(1)</script>` y U+2028: el bloque
 * `application/ld+json` no puede cerrarse antes de tiempo y su contenido tiene que parsear al texto original.
 * El «@» de `@context`/`@type` del JSON-LD es lo único que se tolera: fuera de esos bloques el HTML no lleva ni un «@».
 *
 * Las páginas son de DIR-3a (misma ola): se cargan por path (`loadPage`) para no acoplar el tipado de este archivo a
 * su firma. Si una no existe, el test falla con el path faltante (no se saltea: un guard que se saltea es verde de
 * mentira).
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { getDirectorySnapshot } from "@/lib/directory-internal";
import { clinicPath, professionalPath } from "@/lib/directory-logic";

// La config de integración compila JSX con el transform clásico (`React.createElement`): como en portal-exercises,
// se expone React como global para renderizar las páginas reales. Solo afecta a este proceso de test.
(globalThis as { React?: typeof React }).React = React;

const RUN = process.env.INTEGRATION === "1";
const CONSENT = "2026-10-v1";

// ── Carga y render de server components ──────────────────────────────────────────────────────────────────────────

type PageModule = {
  default: (props: { params: Record<string, string>; searchParams: Record<string, string | string[] | undefined> }) => unknown;
  generateMetadata?: (props: {
    params: Record<string, string>;
    searchParams: Record<string, string | string[] | undefined>;
  }) => unknown;
};

/** Paths del contrato C-DIR5 (dueño: DIR-3a). */
const PAGES = {
  list: "app/(directory)/profesionales/page",
  professional: "app/(directory)/profesionales/[nombreId]/page",
  clinic: "app/(directory)/consultorios/[slug]/page",
} as const;

async function loadPage(rel: string): Promise<PageModule> {
  try {
    return (await import(/* @vite-ignore */ `@/${rel}`)) as PageModule;
  } catch (err) {
    throw new Error(`[DIR-3b] no se pudo cargar ${rel}.tsx (¿DIR-3a todavía no la escribió?): ${String(err)}`);
  }
}

/**
 * `renderToStaticMarkup` (React 18) no resuelve componentes async anidados: se resuelven antes, recorriendo el árbol.
 * Un componente función se ejecuta solo si es async o si se puede llamar fuera del render (los que usan hooks —
 * componentes de cliente— tiran y quedan como elemento para que los renderice React).
 */
async function resolveTree(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (node && typeof (node as Promise<unknown>).then === "function") return resolveTree(await (node as Promise<ReactNode>));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: ReactNode }>;
  const type = el.type as unknown;
  if (typeof type === "function" && !(type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
    let out: unknown;
    try {
      out = (type as (p: unknown) => unknown)(el.props);
    } catch (err) {
      if (isNextControlFlow(err)) throw err;
      out = undefined; // hooks fuera del render: lo renderiza React
    }
    if (out !== undefined) return resolveTree(out as ReactNode);
  }
  if (el.props && "children" in el.props && el.props.children !== undefined) {
    return cloneElement(el, undefined, await resolveTree(el.props.children));
  }
  return el;
}

function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest === "NEXT_NOT_FOUND" || digest.startsWith("NEXT_REDIRECT"));
}

async function renderPage(
  rel: string,
  params: Record<string, string>,
  searchParams: Record<string, string | string[] | undefined> = {}
): Promise<{ html: string; metadata: unknown }> {
  const mod = await loadPage(rel);
  const metadata = mod.generateMetadata ? await mod.generateMetadata({ params, searchParams }) : null;
  const tree = await resolveTree((await mod.default({ params, searchParams })) as ReactNode);
  return { html: renderToStaticMarkup(tree as ReactElement), metadata };
}

/** Corre la página y devuelve el digest de control de flujo de Next (404/redirect), o null si renderizó. */
async function controlFlow(rel: string, params: Record<string, string>): Promise<string | null> {
  try {
    await renderPage(rel, params);
    return null;
  } catch (err) {
    if (isNextControlFlow(err)) return (err as { digest: string }).digest;
    throw err;
  }
}

const LD_RE = /<script type="application\/ld\+json"(?:[^>]*)>([\s\S]*?)<\/script>/g;

function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(LD_RE)].map((m) => m[1]);
}

// ── Suite ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)("[DIR-3b] directorio sin PII (3 rutas reales, C-DIR5/C-DIR6)", () => {
  let db: PrismaClient;
  const s = uniqueSuffix();
  const tenants: EphemeralTenant[] = [];
  let T: EphemeralTenant;
  let profileId = "";
  let withdrawnProfileId = "";
  let withdrawnName = "";
  const prevMode = process.env.DIRECTORY_MODE;
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  const XSS = "</script><script>alert(1)</script>";
  const LS = " ";
  const publicName = `Ana ${s} ${XSS}`;
  const bio = `Kinesióloga deportiva ${s}.${LS}Segunda línea ${XSS}`;
  const PUBLIC_EMAIL = `contacto-${s}@consultorio.test`;
  const PATIENT_FIRST = `Pacientesecreto${s}`;
  const PATIENT_DNI = `DNI${s}`;
  const UNPUBLISHED_NAME = `Sinperfil ${s}`;
  const PRICE_CENTS = 777777; // $ 7.777,77
  const PRICE_STRINGS = ["777777", "7.777,77", "7777,77", "7777.77"];
  const userIds: string[] = [];

  beforeAll(async () => {
    if (!RUN) return;
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
    db = ownerClient();

    T = await createEphemeralTenant(db);
    tenants.push(T);
    userIds.push(T.userId);
    await db.tenant.update({
      where: { id: T.tenantId },
      data: {
        name: `Kine Centro ${s}`,
        directoryListed: true,
        directoryListedAt: new Date(),
        publicDescription: `Rehabilitación ${s}.`,
        phone: "3415550000",
        whatsapp: "5493415550000",
        publicEmail: PUBLIC_EMAIL,
      },
    });
    await db.practitioner.update({ where: { id: T.practitionerId }, data: { rating: 4.9 } });
    await db.service.update({ where: { id: T.serviceId }, data: { priceCents: PRICE_CENTS } });
    await db.location.create({
      data: {
        tenantId: T.tenantId, name: "Sede Centro", address: "Córdoba 1234", city: "Rosario",
        province: "Santa Fe", provinceCode: "S", isPrimary: true,
      },
    });
    await addPatient(db, T, { firstName: PATIENT_FIRST, lastName: "Oculto", documentId: PATIENT_DNI, email: `pac-${s}@mail.test` });

    profileId = (
      await db.professionalPublicProfile.create({
        data: {
          userId: T.userId, publicName, honorific: "LIC", licenseKind: "MN", licenseNumber: "12345", bio,
          listed: true, consentAt: new Date(), consentVersion: CONSENT,
        },
        select: { id: true },
      })
    ).id;

    // Reservable en el turnero pero SIN perfil publicado: su nombre no puede aparecer en la página del consultorio.
    const unp = await addPractitioner(db, T);
    userIds.push(unp.userId);
    await db.userProfile.update({ where: { id: unp.userId }, data: { fullName: UNPUBLISHED_NAME } });
    await db.service.create({
      data: { tenantId: T.tenantId, practitionerId: unp.practitionerId, name: `Sesión ${s}`, durationMin: 30, priceCents: PRICE_CENTS },
    });

    // Reservable con consentimiento RETIRADO: su página da 404 (DIR-D23).
    const wd = await addPractitioner(db, T);
    userIds.push(wd.userId);
    await db.service.create({
      data: { tenantId: T.tenantId, practitionerId: wd.practitionerId, name: `Sesión W ${s}`, durationMin: 30, priceCents: PRICE_CENTS },
    });
    withdrawnName = `Retirada ${s}`;
    withdrawnProfileId = (
      await db.professionalPublicProfile.create({
        data: {
          userId: wd.userId, publicName: withdrawnName, listed: false,
          consentAt: new Date(), consentVersion: CONSENT, consentWithdrawnAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!RUN) return;
    if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
    else process.env.DIRECTORY_MODE = prevMode;
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    for (const t of tenants) await t.cleanup();
    await db.$disconnect();
  });

  afterEach(() => usePassthroughUnstableCache());

  const proPath = () => professionalPath(publicName, profileId);
  const nombreId = () => proPath().slice("/profesionales/".length);

  /** Lo prohibido (brief §1): emails, userIds, rating, precios, pacientes, un no publicado, el email del consultorio. */
  function expectNoPii(text: string, where: string) {
    for (const u of userIds) {
      expect(text, `${where}: userId ${u}`).not.toContain(u);
      expect(text, `${where}: email de ${u}`).not.toContain(`${u}@test.local`);
    }
    expect(text, `${where}: email público del consultorio`).not.toContain(PUBLIC_EMAIL);
    expect(text, `${where}: rating`).not.toMatch(/rating/i);
    expect(text, `${where}: valor del rating`).not.toContain("4.9");
    for (const p of PRICE_STRINGS) expect(text, `${where}: precio ${p}`).not.toContain(p);
    expect(text, `${where}: paciente`).not.toContain(PATIENT_FIRST);
    expect(text, `${where}: DNI de paciente`).not.toContain(PATIENT_DNI);
    expect(text, `${where}: profesional sin perfil`).not.toContain(UNPUBLISHED_NAME);
    expect(text, `${where}: perfil retirado`).not.toContain(withdrawnName);
    expect(text, `${where}: priceCents`).not.toContain("priceCents");
  }

  /** HTML: sin PII, sin «@» fuera del JSON-LD, y cada bloque JSON-LD cerrado donde corresponde y parseable. */
  function checkHtml(html: string, where: string): unknown[] {
    expectNoPii(html, where);
    const blocks = jsonLdBlocks(html);
    const withoutLd = html.replace(LD_RE, "");
    expect(withoutLd, `${where}: «@» fuera del JSON-LD`).not.toContain("@");
    // El XSS del nombre/bio nunca sale crudo: ni como tag ni dentro del JSON-LD.
    expect(html, `${where}: <script>alert sin escapar`).not.toContain("<script>alert(1)");
    const parsed = blocks.map((b) => {
      expect(b.toLowerCase(), `${where}: </script dentro del JSON-LD`).not.toContain("</script");
      expect(b, `${where}: U+2028 crudo en JSON-LD`).not.toContain(LS);
      const v = JSON.parse(b) as unknown;
      // El único «@» tolerado en el JSON-LD es el de las claves de schema.org: ningún valor con forma de email.
      expect(JSON.stringify(v), `${where}: email en JSON-LD`).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);
      expectNoPii(JSON.stringify(v), `${where} (JSON-LD)`);
      return v;
    });
    return parsed;
  }

  /** `thin`: lista filtrada; DIR-3a la marca `index: false, follow: true` en public (duplica la lista, no se indexa). */
  function checkMetadata(metadata: unknown, where: string, mode: "preview" | "public", opts: { thin?: boolean } = {}) {
    if (metadata == null) return;
    const text = JSON.stringify(metadata);
    expectNoPii(text, `${where} (metadata)`);
    expect(text, `${where} (metadata): email`).not.toMatch(/[^\s"@]+@[^\s"@]+\.[a-z]{2,}/i);
    const robots = (metadata as { robots?: unknown }).robots;
    if (mode === "preview") {
      // C-DIR2 / DIR-D22: preview = noindex, nofollow.
      expect(robots, `${where}: robots en preview`).toMatchObject({ index: false, follow: false });
    } else if (opts.thin) {
      expect(robots, `${where}: filtrada en public`).toMatchObject({ follow: true });
    } else if (robots && typeof robots === "object") {
      expect((robots as { index?: boolean }).index, `${where}: indexable en public`).not.toBe(false);
    }
  }

  it("el snapshot real trae la fixture (precondición: si no, los «no contiene» de abajo no prueban nada)", async () => {
    const snap = await getDirectorySnapshot();
    expect(snap.professionals.some((p) => p.profileId === profileId)).toBe(true);
    expect(snap.professionals.some((p) => p.profileId === withdrawnProfileId)).toBe(false);
    expect(snap.clinics.some((c) => c.slug === T.slug)).toBe(true);
    expectNoPii(JSON.stringify(snap.professionals.filter((p) => p.profileId === profileId)), "snapshot");
  });

  for (const mode of ["preview", "public"] as const) {
    describe(`DIRECTORY_MODE=${mode}`, () => {
      beforeAll(() => {
        process.env.DIRECTORY_MODE = mode;
      });

      it("/profesionales: lista a Ana sin PII", async () => {
        // Filtro por provincia de la sede de la fixture: achica la lista a lo de esta suite y sus vecinas de Santa Fe.
        const { html, metadata } = await renderPage(PAGES.list, {}, { provincia: "S", ciudad: "Rosario" });
        expect(html).toContain(proPath());
        expect(html).toContain(`Ana ${s}`);
        checkHtml(html, `${mode} /profesionales`);
        checkMetadata(metadata, `${mode} /profesionales`, mode, { thin: true });
        // Sin filtros: la metadata de la lista (la que va al sitemap) es indexable solo en public.
        const bare = await loadPage(PAGES.list);
        if (bare.generateMetadata) checkMetadata(await bare.generateMetadata({ params: {}, searchParams: {} }), `${mode} /profesionales sin filtros`, mode);
      });

      it("/profesionales/[nombreId]: bio, matrícula, deep link; JSON-LD Person parseable y sin matrícula", async () => {
        const { html, metadata } = await renderPage(PAGES.professional, { nombreId: nombreId() });
        expect(html).toContain(`Ana ${s}`);
        expect(html).toContain(`Kinesióloga deportiva ${s}.`);
        expect(html).toContain("12345"); // DIR-D21: la matrícula SÍ va en el HTML
        expect(html).toContain(`/c/${T.slug}/booking?pro=${T.practitionerId}`);
        const ld = checkHtml(html, `${mode} perfil`);
        const person = ld.find((x) => (x as { "@type"?: string })["@type"] === "Person") as
          | { name: string; description?: string }
          | undefined;
        expect(person, "JSON-LD Person").toBeDefined();
        // Ida y vuelta: el escape no altera el texto (C-DIR6).
        expect(person!.name).toBe(publicName);
        expect(person!.description).toBe(bio);
        // DIR-D21: nunca matrícula en JSON-LD.
        expect(JSON.stringify(person)).not.toContain("12345");
        checkMetadata(metadata, `${mode} perfil`, mode);
      });

      it("/consultorios/[slug]: descripción, sede, teléfono, solo el perfil publicado; JSON-LD MedicalClinic", async () => {
        const { html, metadata } = await renderPage(PAGES.clinic, { slug: T.slug });
        expect(html).toContain(`Kine Centro ${s}`);
        expect(html).toContain(`Rehabilitación ${s}.`);
        expect(html).toContain("Córdoba 1234");
        expect(html).toContain(proPath());
        expect(html).toContain(`/c/${T.slug}/booking`);
        const ld = checkHtml(html, `${mode} consultorio`);
        const clinic = ld.find((x) => (x as { "@type"?: string })["@type"] === "MedicalClinic") as
          | { name: string; url: string }
          | undefined;
        expect(clinic, "JSON-LD MedicalClinic").toBeDefined();
        expect(clinic!.name).toBe(`Kine Centro ${s}`);
        expect(clinic!.url.endsWith(clinicPath(T.slug))).toBe(true);
        checkMetadata(metadata, `${mode} consultorio`, mode);
      });

      it("perfil con consentimiento retirado → 404 (DIR-D23)", async () => {
        const id = professionalPath(withdrawnName, withdrawnProfileId).slice("/profesionales/".length);
        expect(await controlFlow(PAGES.professional, { nombreId: id })).toBe("NEXT_NOT_FOUND");
      });
    });
  }

  it("DIRECTORY_MODE=off → las 3 rutas 404", async () => {
    process.env.DIRECTORY_MODE = "off";
    expect(await controlFlow(PAGES.list, {})).toBe("NEXT_NOT_FOUND");
    expect(await controlFlow(PAGES.professional, { nombreId: nombreId() })).toBe("NEXT_NOT_FOUND");
    expect(await controlFlow(PAGES.clinic, { slug: T.slug })).toBe("NEXT_NOT_FOUND");
  });
});
