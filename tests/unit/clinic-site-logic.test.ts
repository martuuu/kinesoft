/**
 * CF3 (SD-K) · lógica pura de la sede digital `/<slug>` (D-CF3-3, D-CF3-9, D-CF3-10).
 *
 * Lo que fija:
 *   - DTO cerrado: el fixture de entrada trae email, notas, WhatsApp y teléfono del profesional y el email público del
 *     consultorio; el resultado pasa `clinicSiteSchema` (`.strict()`, sin claves extra) y no contiene ninguno;
 *   - precio: `particularQuoteCents` por profesional; null con `showPublicPrice=false` o si da $0;
 *   - profesional sin servicios del turnero → fuera; turnero cerrado → sede sin profesionales;
 *   - lookup: slug vigente, alias → redirect, mayúsculas → redirect, alias a una sede apagada → null, prototipo;
 *   - tamaño del snapshot (Next 14 no guarda entradas > 2 MB y no avisa) y JSON-LD escapado.
 */
import { describe, expect, it } from "vitest";
import { jsonLdScript } from "@/lib/directory-logic";
import {
  CLINIC_SITES_TAG,
  assembleClinicSite,
  clinicSiteJsonLd,
  compactClinicSite,
  expandClinicSite,
  isSiteSlugShape,
  locationMapsUrl,
  lookupClinicSite,
  type ClinicSiteClinicInput,
  type ClinicSiteInput,
} from "@/lib/clinic-site-logic";
import { clinicSiteSchema, type ClinicSiteSnapshot } from "@/lib/clinic-site-types";

const LOGO_AT = new Date("2026-11-01T12:00:00.000Z");

/** Entrada con basura privada pegada (como si alguien hiciera spread de una fila Prisma completa). */
function input(over: Partial<ClinicSiteInput> = {}): ClinicSiteInput {
  const leakyPro = (id: string, name: string, acceptedInsurerIds: string[]) =>
    ({
      id,
      name,
      specialty: " Kinesiología deportiva ",
      licenseNumber: "MN 1234",
      acceptedInsurerIds,
      email: `${id}@privado.test`,
      contactWhatsapp: "5493410000001",
      phone: "3410000001",
      notes: "nota interna del profesional",
      userId: `user-${id}`,
    }) as ClinicSiteClinicInput["practitioners"][number];
  return {
    tenant: {
      slug: "tmp",
      name: "TMP Kinesiología",
      siteTagline: "  Rehabilitación en Rosario ",
      publicDescription: "Kinesiología y osteopatía.",
      phone: "3415550000",
      whatsapp: "5493415550000",
      logoStorageKey: "tenant/logo.png",
      logoUpdatedAt: LOGO_AT,
      ...({ publicEmail: "contacto@tmp.test", notes: "nota interna" } as object),
    },
    clinic: {
      openingSummary: "Lun a vie 8 a 19",
      practitioners: [leakyPro("pro-a", "Ana Pérez", ["os-1", "part"]), leakyPro("pro-b", "Beto Ruiz", ["part"])],
      services: [
        {
          id: "svc-1",
          name: "Kinesiología",
          durationMin: 45,
          priceCents: 900_000,
          practitionerId: null,
          practitionerIds: ["pro-a", "pro-b"],
          durationByPractitioner: { "pro-a": 45, "pro-b": 60 },
        },
        {
          id: "svc-2",
          name: "Osteopatía",
          durationMin: 60,
          priceCents: 1_200_000,
          practitionerId: "pro-a",
          practitionerIds: ["pro-a"],
          durationByPractitioner: { "pro-a": 60 },
        },
      ],
    },
    locations: [
      { name: "Centro", address: "Córdoba 1234", addressLine2: "2.º B", city: "Rosario", province: "Santa Fe" },
      { name: "Sin dirección", address: null, addressLine2: null, city: null, province: null },
    ],
    insurers: [
      { id: "part", name: "Particular", isParticular: true },
      { id: "os-1", name: "OSDE", isParticular: false },
      { id: "os-2", name: "Swiss Medical", isParticular: false }, // nadie la acepta
    ],
    showPublicPrice: { "pro-a": true, "pro-b": true },
    practitionerPrices: { "pro-a:svc-1": 1_500_000 },
    particularCopagoCents: 800_000,
    ...over,
  };
}

describe("[CF3-SDK] assembleClinicSite", () => {
  it("[CF3-SDK1] DTO cerrado: pasa el schema strict y no filtra email, notas ni contacto de profesionales", () => {
    const site = assembleClinicSite(input());
    expect(() => clinicSiteSchema.parse(site)).not.toThrow();
    const json = JSON.stringify(site);
    expect(json).not.toContain("@");
    expect(json).not.toContain("5493410000001");
    expect(json).not.toContain("3410000001");
    expect(json).not.toContain("nota interna");
    expect(json).not.toMatch(/"(email|publicEmail|notes|userId|contactWhatsapp|phone)":"[^"]*privado/);
    expect(Object.keys(site).sort()).toEqual(
      [
        "bookingUrl", "contact", "coverages", "description", "locations", "logoUrl", "name", "online", "openingSummary",
        "palette", "practitioners", "slug", "tagline",
      ].sort()
    );
    expect(Object.keys(site.practitioners[0]).sort()).toEqual(
      // CF3b PH-S: + `photoUrl` (revisión de privacidad: opt-in por consultorio, solo la ruta pública; [PH-S-c1]).
      ["bookingUrl", "hours", "id", "license", "name", "photoUrl", "services", "specialty"].sort()
    );
  });

  it("[CF3-SDK2] contenido: contacto del consultorio, logo con versión, sedes con mapa, OS aceptadas, links ?pro=", () => {
    const site = assembleClinicSite(input());
    expect(site.tagline).toBe("Rehabilitación en Rosario");
    expect(site.logoUrl).toBe(`/tmp/logo?v=${LOGO_AT.getTime()}`);
    expect(site.contact).toEqual({ phone: "3415550000", whatsapp: "5493415550000" });
    expect(site.locations[0]).toEqual({
      name: "Centro",
      address: "Córdoba 1234, 2.º B",
      city: "Rosario",
      province: "Santa Fe",
      mapsUrl: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Córdoba 1234, 2.º B, Rosario, Santa Fe, Argentina"),
    });
    expect(site.locations[1].mapsUrl).toBeNull();
    expect(site.coverages).toEqual(["OSDE"]); // sin Particular ni la que no acepta nadie
    expect(site.bookingUrl).toBe("/c/tmp/booking");
    expect(site.practitioners.map((p) => p.bookingUrl)).toEqual(["/c/tmp/booking?pro=pro-a", "/c/tmp/booking?pro=pro-b"]);
    expect(site.practitioners[0].specialty).toBe("Kinesiología deportiva");
    expect(site.online).toEqual({ bookingOpen: true });
    expect(site.openingSummary).toBe("Lun a vie 8 a 19");
  });

  it("[CF3-SDK3] precio: el del profesional, si no Particular; duración por profesional", () => {
    const site = assembleClinicSite(input());
    const [ana, beto] = site.practitioners;
    expect(ana.services).toEqual([
      { id: "svc-1", name: "Kinesiología", durationMin: 45, priceCents: 1_500_000 }, // precio propio
      { id: "svc-2", name: "Osteopatía", durationMin: 60, priceCents: 800_000 }, // cae a Particular
    ]);
    expect(beto.services).toEqual([{ id: "svc-1", name: "Kinesiología", durationMin: 60, priceCents: 800_000 }]);
  });

  it("[CF3-SDK4] precio oculto con showPublicPrice=false (aunque tenga precio propio) y null si da $0", () => {
    const hidden = assembleClinicSite(input({ showPublicPrice: { "pro-a": false, "pro-b": true } }));
    expect(hidden.practitioners[0].services.every((s) => s.priceCents === null)).toBe(true);
    expect(JSON.stringify(hidden.practitioners[0])).not.toContain("1500000");
    expect(hidden.practitioners[1].services[0].priceCents).toBe(800_000);

    // Particular nace en $0 (tenant-bootstrap): sin precio propio, no se muestra «$0».
    const zero = assembleClinicSite(input({ particularCopagoCents: 0 }));
    expect(zero.practitioners[0].services.map((s) => s.priceCents)).toEqual([1_500_000, null]);
    // Sin fila Particular: el precio del servicio.
    const none = assembleClinicSite(input({ particularCopagoCents: null }));
    expect(none.practitioners[1].services[0].priceCents).toBe(900_000);
  });

  it("[CF3-SDK5] profesional sin servicios del turnero queda fuera; turnero cerrado = sede sin profesionales", () => {
    const base = input();
    const noSvc = assembleClinicSite({
      ...base,
      clinic: { ...base.clinic!, services: base.clinic!.services.filter((s) => s.id === "svc-2") },
    });
    expect(noSvc.practitioners.map((p) => p.id)).toEqual(["pro-a"]);

    const closed = assembleClinicSite(input({ clinic: null }));
    expect(closed.practitioners).toEqual([]);
    expect(closed.online).toEqual({ bookingOpen: false });
    expect(closed.openingSummary).toBeNull();
    expect(closed.coverages).toEqual(["OSDE", "Swiss Medical"]); // sin turnero: las activas del consultorio
    expect(() => clinicSiteSchema.parse(closed)).not.toThrow();
  });

  it("[CF3-SDK6] sin logo, frase vacía y sin contacto → null", () => {
    const base = input();
    const site = assembleClinicSite({
      ...base,
      tenant: { ...base.tenant, logoStorageKey: null, siteTagline: "   ", phone: null, whatsapp: "" },
    });
    expect(site.logoUrl).toBeNull();
    expect(site.tagline).toBeNull();
    expect(site.contact).toEqual({ phone: null, whatsapp: null });
  });

  it("el schema strict rechaza una clave extra (anti-false-green del test de forma)", () => {
    const site = assembleClinicSite(input());
    expect(() => clinicSiteSchema.parse({ ...site, email: "x@y.z" })).toThrow();
    expect(() =>
      clinicSiteSchema.parse({ ...site, practitioners: [{ ...site.practitioners[0], whatsapp: "549" }] })
    ).toThrow();
  });
});

describe("[CF3-SDK] lookupClinicSite", () => {
  const site = assembleClinicSite(input());
  const snap: ClinicSiteSnapshot = {
    version: 1,
    builtAt: "2026-11-05T00:00:00.000Z",
    sites: [compactClinicSite(site)],
    aliases: { "tmp-viejo": "tmp", "apagada-vieja": "apagada" },
  };

  it("[CF3-SDK7] slug vigente → sede; alias → redirect; mayúsculas → redirect", () => {
    expect(lookupClinicSite(snap, "tmp")).toEqual(site);
    expect(lookupClinicSite(snap, "tmp-viejo")).toEqual({ redirectTo: "tmp" });
    expect(lookupClinicSite(snap, "TMP")).toEqual({ redirectTo: "tmp" });
    expect(lookupClinicSite(snap, "TMP-Viejo")).toEqual({ redirectTo: "tmp" });
  });

  it("[CF3-SDK8] apagada / inexistente / alias a una sede apagada / forma inválida / prototipo → null", () => {
    expect(lookupClinicSite(snap, "apagada")).toBeNull();
    expect(lookupClinicSite(snap, "apagada-vieja")).toBeNull();
    expect(lookupClinicSite(snap, "no-existe")).toBeNull();
    expect(lookupClinicSite(snap, "../etc")).toBeNull();
    expect(lookupClinicSite(snap, "")).toBeNull();
    expect(lookupClinicSite(snap, "constructor")).toBeNull();
    expect(lookupClinicSite(snap, "__proto__")).toBeNull();
    expect(lookupClinicSite(snap, "a".repeat(81))).toBeNull();
  });

  it("forma del slug", () => {
    expect(isSiteSlugShape("tmp")).toBe(true);
    expect(isSiteSlugShape("t")).toBe(true);
    expect(isSiteSlugShape("-tmp")).toBe(false);
    expect(isSiteSlugShape("tmp/logo")).toBe(false);
    expect(isSiteSlugShape("Tmp")).toBe(false);
  });
});

describe("[CF3-SDK] JSON-LD, tag y tamaño", () => {
  it("[CF3-SDK9] MedicalClinic con canonical /<slug>, sin email ni precios; un </script> no cierra el bloque", () => {
    const base = input();
    const site = assembleClinicSite({ ...base, tenant: { ...base.tenant, name: "Evil </script><script>alert(1)</script>" } });
    const ld = clinicSiteJsonLd(site, "https://consultorio-online.com");
    expect(ld).toMatchObject({
      "@type": "MedicalClinic",
      url: "https://consultorio-online.com/tmp",
      telephone: "3415550000",
      logo: `https://consultorio-online.com/tmp/logo?v=${LOGO_AT.getTime()}`,
      potentialAction: { "@type": "ReserveAction", target: "https://consultorio-online.com/c/tmp/booking" },
    });
    const html = jsonLdScript(ld);
    expect(html).not.toContain("</script>");
    expect(JSON.parse(html).name).toBe("Evil </script><script>alert(1)</script>");
    expect(html).not.toMatch(/email|priceCents|@privado/);
    const closed = clinicSiteJsonLd(assembleClinicSite(input({ clinic: null })), "https://consultorio-online.com");
    expect(closed).not.toHaveProperty("potentialAction");
  });

  it("tag propio global", () => {
    expect(CLINIC_SITES_TAG).toBe("global:sites");
  });

  it("locationMapsUrl sin dirección ni ciudad → null; con solo ciudad, busca la ciudad", () => {
    expect(locationMapsUrl({ address: null, city: null, province: "Santa Fe" })).toBeNull();
    expect(locationMapsUrl({ address: null, city: "Rosario", province: null })).toContain(encodeURIComponent("Rosario, Argentina"));
  });

  it("[CF3-SDK10] 200 sedes × 5 profesionales × 10 servicios serializadas < 1,5 MB (Next 14 no cachea > 2 MB)", () => {
    const pros = Array.from({ length: 5 }, (_, i) => ({
      id: `c${"x".repeat(23)}${i}`,
      name: `Profesional Apellido Largo ${i}`,
      specialty: "Kinesiología y fisiatría deportiva",
      licenseNumber: "MP 123456",
      acceptedInsurerIds: ["os-1"],
    }));
    const services = Array.from({ length: 10 }, (_, i) => ({
      id: `c${"s".repeat(23)}${i}`,
      name: `Servicio de rehabilitación número ${i}`,
      durationMin: 45,
      priceCents: 1_234_500,
      practitionerId: null,
      practitionerIds: pros.map((p) => p.id),
      durationByPractitioner: Object.fromEntries(pros.map((p) => [p.id, 45])),
    }));
    const base = input();
    const sites = Array.from({ length: 200 }, (_, i) =>
      assembleClinicSite({
        ...base,
        tenant: { ...base.tenant, slug: `consultorio-${i}`, publicDescription: "x".repeat(800), siteTagline: "y".repeat(120) },
        clinic: { openingSummary: "Lun a vie 8 a 19 · Sáb 9 a 13", practitioners: pros, services },
      })
    );
    const bytes = Buffer.byteLength(JSON.stringify({ version: 1, builtAt: "", sites: sites.map(compactClinicSite), aliases: {} }));
    expect(bytes).toBeLessThan(1_000_000);
  });

  it("[CF3-SDK11] compactar y expandir (pasando por JSON, como el cache) devuelve el mismo DTO", () => {
    for (const site of [assembleClinicSite(input()), assembleClinicSite(input({ clinic: null }))]) {
      const back = expandClinicSite(JSON.parse(JSON.stringify(compactClinicSite(site))));
      expect(back).toEqual(site);
      expect(() => clinicSiteSchema.parse(back)).not.toThrow();
    }
  });
});
