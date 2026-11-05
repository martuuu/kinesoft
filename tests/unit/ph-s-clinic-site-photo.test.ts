/**
 * CF3b PH-S · la foto del profesional en el DTO público de la sede (`assembleClinicSite` → compacto → expandido, como
 * el data cache). Símbolos reales, módulo puro.
 */
import { describe, expect, it } from "vitest";
import { assembleClinicSite, compactClinicSite, expandClinicSite, sitePhotoUrl } from "@/lib/clinic-site-logic";
import { clinicSiteSchema } from "@/lib/clinic-site-types";
import { publicProPhotoUrl } from "@/lib/user-photo-logic";

const AT = new Date("2026-11-05T13:00:00.000Z");
const OK_URL = publicProPhotoUrl("pro-aaaaaaaa", AT)!;

function input(photoUrl: string | null | undefined) {
  return {
    tenant: {
      slug: "tmp",
      name: "TMP",
      siteTagline: null,
      publicDescription: null,
      phone: null,
      whatsapp: null,
      logoStorageKey: null,
      logoUpdatedAt: null,
    },
    clinic: {
      openingSummary: null,
      practitioners: [{ id: "pro-aaaaaaaa", name: "Ana", specialty: null, licenseNumber: null, acceptedInsurerIds: [], photoUrl }],
      services: [
        {
          id: "svc-1",
          name: "Kinesiología",
          durationMin: 45,
          priceCents: 0,
          practitionerId: "pro-aaaaaaaa",
          practitionerIds: ["pro-aaaaaaaa"],
          durationByPractitioner: { "pro-aaaaaaaa": 45 },
        },
      ],
    },
    locations: [],
    insurers: [],
    showPublicPrice: {},
    practitionerPrices: {},
    particularCopagoCents: null,
  };
}

describe("[PH-S-c] foto en la sede", () => {
  it("[PH-S-c1] la URL de la ruta pública pasa y sobrevive compactar/expandir por JSON; ausente → null", () => {
    for (const [given, want] of [
      [OK_URL, OK_URL],
      [null, null],
      [undefined, null],
    ] as const) {
      const site = assembleClinicSite(input(given));
      expect(site.practitioners[0].photoUrl).toBe(want);
      const back = expandClinicSite(JSON.parse(JSON.stringify(compactClinicSite(site))));
      expect(back).toEqual(site);
      expect(() => clinicSiteSchema.parse(back)).not.toThrow();
    }
  });

  it("[PH-S-c2] cualquier otra URL (avatarUrl de Google, otra persona, sin versión, con algo pegado) no se publica", () => {
    for (const bad of [
      "https://lh3.googleusercontent.com/a/foto",
      publicProPhotoUrl("pro-bbbbbbbb", AT)!,
      "/api/public/pro-photo/pro-aaaaaaaa",
      `${OK_URL}&x=1`,
      "/api/me/photo?v=1",
      "javascript:alert(1)",
    ]) {
      expect(sitePhotoUrl("pro-aaaaaaaa", bad), bad).toBeNull();
      expect(assembleClinicSite(input(bad)).practitioners[0].photoUrl, bad).toBeNull();
    }
  });
});
