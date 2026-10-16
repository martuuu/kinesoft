/**
 * DIR-2a · lógica pura del directorio (C-DIR3, C-DIR4, C-DIR6) + modo (C-DIR2) + tag (C-DIR4).
 *
 * Lo que fija:
 *   - forma de los tipos públicos: `Object.keys` == la lista del contrato (un campo nuevo rompe a propósito: pasa por
 *     el revisor de privacidad de DIR-Z);
 *   - armado: quién aparece (sin perfil = no; consultorio sin reservables = no; consultorio sin publicados = página
 *     sí, `/profesionales` no), unión por persona, coberturas vinculadas/sin vincular, Particular;
 *   - tamaño: 200 consultorios × 5 profesionales con datos realistas ≤ 1 MB serializado (Next 14 no cachea > 2 MB);
 *   - JSON-LD: un `</script>` en el nombre o la bio no cierra el bloque y `JSON.parse` devuelve el texto original.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AR_PROVINCES, AR_PROVINCE_CODES, isProvinceCode, provinceName } from "@/lib/ar-provinces";
import { DIRECTORY_TAG, tags, tenantEntitlementTags } from "@/lib/cache-tags";
import { directoryMode } from "@/lib/directory-mode";
import {
  assembleDirectorySnapshot,
  clinicJsonLd,
  compactDirectorySnapshot,
  directoryFacets,
  expandDirectorySnapshot,
  directoryQuery,
  filterProfessionals,
  findDirectoryClinic,
  findDirectoryProfessional,
  honorificLabel,
  initials,
  jsonLdScript,
  normalizeCity,
  paginate,
  parseDirectoryFilters,
  parseNombreId,
  professionalJsonLd,
  slugifyName,
  type DirectoryBuildInput,
  type DirectoryClinicInput,
  type DirectoryProfileInput,
} from "@/lib/directory-logic";

const BUILT = new Date("2026-10-16T15:00:00.000Z");

function profile(id: string, over: Partial<DirectoryProfileInput> = {}): DirectoryProfileInput {
  return {
    id,
    publicName: "Ana Pérez",
    honorific: "LIC",
    licenseKind: "MP",
    licenseNumber: "1234",
    licenseJurisdiction: "S",
    bio: "Kinesióloga deportiva.",
    licenseVerified: false,
    ...over,
  };
}

function clinic(slug: string, over: Partial<DirectoryClinicInput> = {}): DirectoryClinicInput {
  return {
    slug,
    name: `Consultorio ${slug}`,
    description: "Rehabilitación.",
    phone: "341 555-0000",
    whatsapp: null,
    locations: [
      { id: `${slug}-l1`, name: "Centro", address: "Córdoba 1234", addressLine2: "Piso 2", city: "Rosario", provinceCode: "S" },
    ],
    practitioners: [{ id: `${slug}-p1`, locationIds: [`${slug}-l1`], acceptedInsurerIds: [`${slug}-part`, `${slug}-osde`] }],
    insurers: {
      [`${slug}-part`]: { isParticular: true, name: "Particular", payerSlug: null },
      [`${slug}-osde`]: { isParticular: false, name: "OSDE", payerSlug: "osde" },
    },
    specialtiesByPractitioner: { [`${slug}-p1`]: [{ slug: "deportiva", name: "Deportiva" }] },
    ...over,
  };
}

describe("[DIR-2a] texto: slug, nombreId, iniciales, ciudad, honorífico", () => {
  it("slugifyName saca tildes, símbolos y nunca queda vacío", () => {
    expect(slugifyName("María José Núñez")).toBe("maria-jose-nunez");
    expect(slugifyName("  Dr. O'Connor -- Ávila ")).toBe("dr-o-connor-avila");
    expect(slugifyName("@@@")).toBe("profesional");
    expect(slugifyName("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("parseNombreId toma el id después del último guion e ignora formas inválidas", () => {
    expect(parseNombreId("maria-jose-nunez-clx1abc2def3")).toEqual({ nameSlug: "maria-jose-nunez", profileId: "clx1abc2def3" });
    expect(parseNombreId("cualquiera-clx1abc2def3")?.profileId).toBe("clx1abc2def3");
    expect(parseNombreId("nombre-corto")).toBeNull();
    expect(parseNombreId("nombre-CLX1ABC2DEF3")).toBeNull();
    expect(parseNombreId("nombre-clx1abc2def3%")).toBeNull();
    expect(parseNombreId("")).toBeNull();
  });

  it("iniciales del primer y último nombre; ciudad comparable; honorífico conocido", () => {
    expect(initials("ana maría pérez")).toBe("AP");
    expect(initials("Ñandú")).toBe("Ñ");
    expect(initials("   ")).toBe("?");
    expect(normalizeCity("  San Miguel de  Tucumán ")).toBe("san miguel de tucuman");
    expect(honorificLabel("KLGA")).toBe("Klga.");
    expect(honorificLabel("XX")).toBeNull();
    expect(honorificLabel(null)).toBeNull();
  });
});

describe("[DIR-2a] provincias (M11)", () => {
  it("las 24 jurisdicciones coinciden con el CHECK de la migración", () => {
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20261019120000_public_directory/migration.sql"),
      "utf8"
    );
    const m = /"Location_provinceCode_check"[\s\S]*?IN\s*\(([^)]*)\)/.exec(sql);
    const fromSql = [...(m?.[1] ?? "").matchAll(/'([A-Z])'/g)].map((x) => x[1]).sort();
    expect(fromSql).toHaveLength(24);
    expect([...AR_PROVINCE_CODES].sort()).toEqual(fromSql);
    expect(new Set(AR_PROVINCES.map((p) => p.name)).size).toBe(24);
    expect(isProvinceCode("S")).toBe(true);
    expect(isProvinceCode("AR-S")).toBe(false);
    expect(provinceName("C")).toBe("Ciudad Autónoma de Buenos Aires");
    expect(provinceName("ZZ")).toBeNull();
  });
});

describe("[DIR-2a] modo y tag", () => {
  const prev = process.env.DIRECTORY_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.DIRECTORY_MODE;
    else process.env.DIRECTORY_MODE = prev;
  });

  it("directoryMode lee process.env en cada llamada; cualquier otro valor = off", () => {
    delete process.env.DIRECTORY_MODE;
    expect(directoryMode()).toBe("off");
    process.env.DIRECTORY_MODE = " Preview ";
    expect(directoryMode()).toBe("preview");
    process.env.DIRECTORY_MODE = "public";
    expect(directoryMode()).toBe("public");
    process.env.DIRECTORY_MODE = "publico";
    expect(directoryMode()).toBe("off");
  });

  it("tags.directory() es global y tenantEntitlementTags lo incluye", () => {
    expect(tags.directory()).toBe("global:directory");
    expect(DIRECTORY_TAG).toBe("global:directory");
    expect(tenantEntitlementTags("t1")).toContain("global:directory");
  });
});

describe("[DIR-2a] armado del snapshot (C-DIR4)", () => {
  it("forma de los tipos públicos (C-DIR3): un campo nuevo rompe a propósito", () => {
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [clinic("a")],
      profilesByPractitioner: { "a-p1": profile("clprofilea001") },
    });
    expect(Object.keys(s).sort()).toEqual(["builtAt", "clinics", "professionals", "version"]);
    expect(Object.keys(s.professionals[0]).sort()).toEqual(
      [
        "profileId", "path", "publicName", "honorificLabel", "initials", "license", "bio", "specialties", "coverages",
        "acceptsParticular", "clinics",
      ].sort()
    );
    expect(Object.keys(s.professionals[0].clinics[0]).sort()).toEqual(
      ["slug", "name", "path", "city", "provinceCode", "bookingHref"].sort()
    );
    expect(Object.keys(s.professionals[0].license!).sort()).toEqual(["jurisdiction", "kind", "number", "verified"]);
    expect(Object.keys(s.clinics[0]).sort()).toEqual(
      [
        "slug", "path", "name", "description", "locations", "phone", "whatsapp", "specialties", "coverages",
        "acceptsParticular", "professionals", "bookingHref",
      ].sort()
    );
    expect(Object.keys(s.clinics[0].locations[0]).sort()).toEqual(["address", "city", "name", "provinceCode"]);
    expect(Object.keys(s.clinics[0].professionals[0]).sort()).toEqual(
      ["profileId", "path", "publicName", "honorificLabel", "initials", "specialties", "bookingHref"].sort()
    );
  });

  it("arma profesional y consultorio con paths, deep link, zona, coberturas y matrícula", () => {
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [clinic("a")],
      profilesByPractitioner: { "a-p1": profile("clprofilea001", { licenseVerified: true }) },
    });
    expect(s.version).toBe(1);
    expect(s.builtAt).toBe("2026-10-16T15:00:00.000Z");
    const p = s.professionals[0];
    expect(p.path).toBe("/profesionales/ana-perez-clprofilea001");
    expect(p.honorificLabel).toBe("Lic.");
    expect(p.initials).toBe("AP");
    expect(p.license).toEqual({ kind: "MP", number: "1234", jurisdiction: "S", verified: true });
    expect(p.coverages).toEqual([{ name: "OSDE", payerSlug: "osde" }]);
    expect(p.acceptsParticular).toBe(true);
    expect(p.clinics).toEqual([
      {
        slug: "a",
        name: "Consultorio a",
        path: "/consultorios/a",
        city: "Rosario",
        provinceCode: "S",
        bookingHref: "/c/a/booking?pro=a-p1",
      },
    ]);
    const c = s.clinics[0];
    expect(c.bookingHref).toBe("/c/a/booking");
    expect(c.locations).toEqual([{ name: "Centro", address: "Córdoba 1234, Piso 2", city: "Rosario", provinceCode: "S" }]);
    expect(c.professionals.map((x) => x.bookingHref)).toEqual(["/c/a/booking?pro=a-p1"]);
    expect(findDirectoryProfessional(s, "clprofilea001")).toBe(p);
    expect(findDirectoryClinic(s, "a")).toBe(c);
    expect(findDirectoryClinic(s, "zz")).toBeNull();
  });

  it("matrícula: MN sin jurisdicción, sin número = null, jurisdicción inválida = null", () => {
    const mk = (over: Partial<DirectoryProfileInput>) =>
      assembleDirectorySnapshot({
        builtAt: BUILT,
        clinics: [clinic("a")],
        profilesByPractitioner: { "a-p1": profile("clprofilea001", over) },
      }).professionals[0].license;
    expect(mk({ licenseKind: "MN", licenseJurisdiction: null })).toEqual({
      kind: "MN", number: "1234", jurisdiction: null, verified: false,
    });
    expect(mk({ licenseKind: null, licenseNumber: null, licenseJurisdiction: null })).toBeNull();
    expect(mk({ licenseJurisdiction: "AR-S" })?.jurisdiction).toBeNull();
  });

  it("matriz: sin perfil no aparece; consultorio sin reservables no aparece; sin publicados = página sola", () => {
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [
        clinic("a"),
        clinic("vacio", { practitioners: [] }),
        clinic("sinperfil"),
      ],
      profilesByPractitioner: { "a-p1": profile("clprofilea001") },
    });
    expect(s.clinics.map((c) => c.slug).sort()).toEqual(["a", "sinperfil"]);
    expect(s.clinics.find((c) => c.slug === "sinperfil")!.professionals).toEqual([]);
    expect(s.professionals.map((p) => p.profileId)).toEqual(["clprofilea001"]);
    expect(s.professionals[0].clinics.map((c) => c.slug)).toEqual(["a"]);
  });

  it("una persona en dos consultorios = un profesional con la unión (sin duplicados)", () => {
    const b = clinic("b", {
      insurers: {
        "b-part": { isParticular: true, name: "Particular", payerSlug: null },
        "b-osde": { isParticular: false, name: "OSDE", payerSlug: "osde" },
        "b-local": { isParticular: false, name: "Mutual Local", payerSlug: null },
      },
      practitioners: [{ id: "b-p1", acceptedInsurerIds: ["b-osde", "b-local", "desconocida"] }],
      specialtiesByPractitioner: {
        "b-p1": [
          { slug: "deportiva", name: "Deportiva" },
          { slug: "neuro", name: "Neurológica" },
        ],
      },
      locations: [{ id: "b-l1", name: "Sede", address: null, addressLine2: null, city: " Córdoba ", provinceCode: "X" }],
    });
    const same = profile("clprofilea001");
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [clinic("a"), b],
      profilesByPractitioner: { "a-p1": same, "b-p1": same },
    });
    expect(s.professionals).toHaveLength(1);
    const p = s.professionals[0];
    expect(p.clinics.map((c) => [c.slug, c.city, c.provinceCode])).toEqual([
      ["a", "Rosario", "S"],
      // Sin `locationIds`: la primera sede (la principal).
      ["b", "Córdoba", "X"],
    ]);
    expect(p.specialties.map((x) => x.slug)).toEqual(["deportiva", "neuro"]);
    expect(p.coverages).toEqual([
      { name: "Mutual Local", payerSlug: null },
      { name: "OSDE", payerSlug: "osde" },
    ]);
    expect(p.acceptsParticular).toBe(true);
    // En «b» no acepta Particular: el consultorio lo refleja.
    expect(s.clinics.find((c) => c.slug === "b")!.acceptsParticular).toBe(false);
    expect(expandDirectorySnapshot(JSON.parse(JSON.stringify(compactDirectorySnapshot(s))))).toEqual(s);
  });

  it("orden alfabético es-AR sin distinguir tildes/mayúsculas; empate por profileId", () => {
    const c = clinic("a", {
      practitioners: ["p1", "p2", "p3", "p4"].map((id) => ({ id, acceptedInsurerIds: [] })),
      specialtiesByPractitioner: {},
    });
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [c],
      profilesByPractitioner: {
        p1: profile("clzzz0000001", { publicName: "Óscar Ruiz" }),
        p2: profile("clbbb0000001", { publicName: "ana Díaz" }),
        p3: profile("claaa0000001", { publicName: "Ana Diaz" }),
        p4: profile("clccc0000001", { publicName: "Néstor Paz" }),
      },
    });
    expect(s.professionals.map((p) => p.profileId)).toEqual([
      "claaa0000001", "clbbb0000001", "clccc0000001", "clzzz0000001",
    ]);
    expect(s.clinics[0].professionals.map((p) => p.profileId)).toEqual(s.professionals.map((p) => p.profileId));
  });

  it("PII: el snapshot no lleva email, userId, rating ni precios aunque la entrada traiga de más", () => {
    // Entrada «sucia» a propósito (como si el builder seleccionara de más): el armado copia campo por campo.
    const dirty = {
      builtAt: BUILT,
      clinics: [
        {
          ...clinic("a"),
          email: "consultorio@x.com",
          practitioners: [{ id: "a-p1", acceptedInsurerIds: ["a-osde"], rating: 4.9, userId: "user-secreto" }],
        },
      ],
      profilesByPractitioner: {
        "a-p1": { ...profile("clprofilea001"), userId: "user-secreto", email: "ana@x.com", priceCents: 5000 },
      },
    } as unknown as DirectoryBuildInput;
    const json = JSON.stringify(assembleDirectorySnapshot(dirty));
    expect(json).not.toMatch(/@/);
    expect(json).not.toContain("user-secreto");
    expect(json).not.toMatch(/rating|priceCents|email|userId/i);
  });

  it("volumen: 200 consultorios × 5 profesionales ≤ 1 MB serializado", () => {
    const bio = "Kinesióloga con formación en rehabilitación deportiva y traumatológica. ".repeat(5).slice(0, 350);
    const coverages = Array.from({ length: 12 }, (_, i) => i);
    const clinics: DirectoryClinicInput[] = [];
    const profiles: Record<string, DirectoryProfileInput> = {};
    for (let c = 0; c < 200; c++) {
      const slug = `consultorio-de-prueba-${c}`;
      const pids = Array.from({ length: 5 }, (_, i) => `clpractitioner${c}x${i}`);
      const insurers: DirectoryClinicInput["insurers"] = { [`${slug}-part`]: { isParticular: true, name: "Particular", payerSlug: null } };
      for (const i of coverages) insurers[`${slug}-i${i}`] = { isParticular: false, name: `Obra Social Provincial ${i}`, payerSlug: `obra-social-provincial-${i}` };
      clinics.push(
        clinic(slug, {
          name: `Centro de Kinesiología y Rehabilitación ${c}`,
          description: "Atención integral en kinesiología, rehabilitación y fisioterapia. ".repeat(4),
          practitioners: pids.map((id) => ({ id, locationIds: [`${slug}-l1`], acceptedInsurerIds: Object.keys(insurers) })),
          insurers,
          specialtiesByPractitioner: Object.fromEntries(
            pids.map((id) => [id, [{ slug: "deportiva", name: "Kinesiología deportiva" }, { slug: "trauma", name: "Traumatológica" }]])
          ),
        })
      );
      pids.forEach((id, i) => {
        profiles[id] = profile(`clprofile${c}x${i}abcdefgh`, { publicName: `María Fernanda González ${c}-${i}`, bio });
      });
    }
    const s = assembleDirectorySnapshot({ builtAt: BUILT, clinics, profilesByPractitioner: profiles });
    expect(s.professionals).toHaveLength(1000);
    expect(s.clinics).toHaveLength(200);
    // Lo que se guarda en el data cache es la forma compacta (la expandida medía 2,7 MB: Next 14 no la cachearía).
    const compact = compactDirectorySnapshot(s);
    const bytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    // Ida y vuelta por JSON (como el data cache): las páginas ven exactamente el mismo snapshot.
    expect(expandDirectorySnapshot(JSON.parse(JSON.stringify(compact)))).toEqual(s);
  });
});

describe("[DIR-2a] filtros y paginado (C-DIR5)", () => {
  it("parseDirectoryFilters descarta lo inválido y normaliza", () => {
    expect(parseDirectoryFilters({})).toEqual({ especialidad: null, cobertura: null, provincia: null, ciudad: null, pagina: 1 });
    expect(
      parseDirectoryFilters({ especialidad: "Deportiva", cobertura: ["osde", "x"], provincia: "s", ciudad: "  Rosario ", pagina: "3" })
    ).toEqual({ especialidad: "deportiva", cobertura: "osde", provincia: "S", ciudad: "Rosario", pagina: 3 });
    expect(parseDirectoryFilters({ especialidad: "<script>", provincia: "AR-S", pagina: "-2" })).toMatchObject({
      especialidad: null, provincia: null, pagina: 1,
    });
    expect(parseDirectoryFilters({ pagina: "abc" }).pagina).toBe(1);
  });

  it("directoryQuery arma la query sin vacíos ni página 1", () => {
    const f = parseDirectoryFilters({ especialidad: "deportiva", ciudad: "San Nicolás" });
    expect(directoryQuery(f)).toBe("?especialidad=deportiva&ciudad=San+Nicol%C3%A1s");
    expect(directoryQuery(f, { pagina: 2 })).toBe("?especialidad=deportiva&ciudad=San+Nicol%C3%A1s&pagina=2");
    expect(directoryQuery(parseDirectoryFilters({}))).toBe("");
  });

  it("filterProfessionals: especialidad, cobertura (payer / particular), provincia+ciudad en el mismo consultorio", () => {
    const b = clinic("b", {
      locations: [{ id: "b-l1", name: "S", address: null, addressLine2: null, city: "Córdoba", provinceCode: "X" }],
      practitioners: [{ id: "b-p1", acceptedInsurerIds: ["b-local"] }],
      insurers: { "b-local": { isParticular: false, name: "Mutual", payerSlug: null } },
      specialtiesByPractitioner: { "b-p1": [{ slug: "neuro", name: "Neuro" }] },
    });
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [clinic("a"), b],
      profilesByPractitioner: { "a-p1": profile("clprofilea001"), "b-p1": profile("clprofileb001", { publicName: "Beto" }) },
    });
    const ids = (f: Parameters<typeof filterProfessionals>[1]) => filterProfessionals(s.professionals, f).map((p) => p.profileId);
    const none = { especialidad: null, cobertura: null, provincia: null, ciudad: null };
    expect(ids(none)).toHaveLength(2);
    expect(ids({ ...none, especialidad: "neuro" })).toEqual(["clprofileb001"]);
    expect(ids({ ...none, cobertura: "osde" })).toEqual(["clprofilea001"]);
    expect(ids({ ...none, cobertura: "particular" })).toEqual(["clprofilea001"]);
    expect(ids({ ...none, provincia: "X" })).toEqual(["clprofileb001"]);
    expect(ids({ ...none, ciudad: "cordoba" })).toEqual(["clprofileb001"]);
    expect(ids({ ...none, provincia: "S", ciudad: "Córdoba" })).toEqual([]);
    const facets = directoryFacets(s.professionals);
    expect(facets.specialties.map((x) => x.slug)).toEqual(["deportiva", "neuro"]);
    expect(facets.coverages).toEqual([{ name: "OSDE", payerSlug: "osde" }]);
    expect(facets.provinces.map((p) => p.code)).toEqual(["X", "S"]);
  });

  it("paginate: de a 24, fuera de rango → la última, vacío → 1 de 1", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(paginate(items, 1)).toMatchObject({ page: 1, totalPages: 3, total: 50 });
    expect(paginate(items, 1).items).toHaveLength(24);
    expect(paginate(items, 99)).toMatchObject({ page: 3, items: [48, 49] });
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate([], 5)).toEqual({ items: [], page: 1, totalPages: 1, total: 0 });
  });
});

describe("[DIR-2a] JSON-LD (C-DIR6)", () => {
  const evil = "Ana </script><script>alert(1)</script> & <b>\u2028\u2029";

  it("jsonLdScript: el bloque renderizado no se cierra y el JSON vuelve al texto original", () => {
    const data = { name: evil, description: evil };
    const html = renderToStaticMarkup(
      createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: jsonLdScript(data) } })
    );
    const inner = html.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    expect(inner).not.toMatch(/<\/script/i);
    expect(inner).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(inner)).toEqual(data);
  });

  it("Person sin matrícula, email ni rating; MedicalClinic con dirección AR y sin email", () => {
    const s = assembleDirectorySnapshot({
      builtAt: BUILT,
      clinics: [clinic("a")],
      profilesByPractitioner: { "a-p1": profile("clprofilea001", { publicName: evil, licenseVerified: true }) },
    });
    const base = "https://kinesoft.example";
    const person = professionalJsonLd(s.professionals[0], base);
    expect(person).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: evil,
      url: `${base}${s.professionals[0].path}`,
      description: "Kinesióloga deportiva.",
      knowsAbout: ["Deportiva"],
      worksFor: [{ "@type": "MedicalClinic", name: "Consultorio a", url: `${base}/consultorios/a` }],
    });
    expect(JSON.stringify(person)).not.toMatch(/1234|license|matr|rating|email/i);

    const org = clinicJsonLd(s.clinics[0], base);
    expect(org).toEqual({
      "@context": "https://schema.org",
      "@type": "MedicalClinic",
      name: "Consultorio a",
      url: `${base}/consultorios/a`,
      description: "Rehabilitación.",
      telephone: "341 555-0000",
      address: [
        {
          "@type": "PostalAddress",
          streetAddress: "Córdoba 1234, Piso 2",
          addressLocality: "Rosario",
          addressRegion: "Santa Fe",
          addressCountry: "AR",
        },
      ],
    });
    const html = renderToStaticMarkup(
      createElement("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: jsonLdScript(person) } })
    );
    expect(html.match(/<\/script/gi)).toHaveLength(1);
  });
});
