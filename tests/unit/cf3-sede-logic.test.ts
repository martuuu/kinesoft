/**
 * CF3 (SD-U) · lógica pura de la página de la sede `/<slug>` sobre el DTO de SD-K (D-CF3-9, Anexo R «Sede digital»).
 *
 * Lo que fija:
 *   - paleta: `Tenant.palette` validada (desconocida → sky), viaja por el cache compacto;
 *   - horario por profesional (`weeklyHoursOf`): vigencias contra el día AR, une solapadas, lunes primero, descarta
 *     basura; la red de seguridad del motor llega resuelta por `publicOpeningRanges` (se prueba la composición);
 *   - «Horarios» (`siteWeekTable`): unión de los reservables, 7 días, «Cerrado»; null sin franjas;
 *   - «Quién atiende cada día» (`siteWhoByDay`): solo días con alguien, por hora de inicio, iniciales;
 *   - el DTO con horarios sigue cerrado (schema strict) y el snapshot sigue lejos de 2 MB.
 */
import { describe, expect, it } from "vitest";
import {
  assembleClinicSite,
  compactClinicSite,
  expandClinicSite,
  hoursLabel,
  personInitials,
  siteClosedDays,
  sitePalette,
  siteWeekTable,
  siteWhoByDay,
  weeklyHoursOf,
  type ClinicSiteInput,
} from "@/lib/clinic-site-logic";
import { publicOpeningRanges, type OpeningRange } from "@/lib/opening-hours-summary";
import { clinicSiteSchema } from "@/lib/clinic-site-types";

const r = (dow: number, s: number, e: number, validFrom: string | null = null, validUntil: string | null = null): OpeningRange => ({
  dow,
  startMin: s * 60,
  endMin: e * 60,
  validFrom,
  validUntil,
});

function input(over: Partial<ClinicSiteInput> = {}): ClinicSiteInput {
  return {
    tenant: {
      slug: "tmp",
      name: "TMP",
      palette: "mint",
      siteTagline: null,
      publicDescription: null,
      phone: null,
      whatsapp: null,
      logoStorageKey: null,
      logoUpdatedAt: null,
    },
    clinic: {
      openingSummary: "Lun a sáb",
      practitioners: [
        { id: "tomas", name: "Lic. Tomás Paredes", specialty: null, licenseNumber: null, acceptedInsurerIds: [] },
        { id: "mariana", name: "Mariana Pérez", specialty: null, licenseNumber: null, acceptedInsurerIds: [] },
      ],
      services: [
        {
          id: "svc",
          name: "Sesión",
          durationMin: 45,
          priceCents: 0,
          practitionerId: null,
          practitionerIds: ["tomas", "mariana"],
        },
      ],
    },
    locations: [],
    insurers: [],
    showPublicPrice: {},
    practitionerPrices: {},
    particularCopagoCents: null,
    practitionerHours: {
      // Tomás: lun/mié/vie mañana; mar/jue tarde.
      tomas: [r(1, 8, 14), r(3, 8, 14), r(5, 8, 14), r(2, 14, 20), r(4, 14, 20)],
      // Mariana: lun/mié tarde; mar/jue/sáb mañana; una franja vencida el domingo.
      mariana: [r(1, 15, 20), r(3, 15, 20), r(2, 9, 13), r(4, 9, 13), r(6, 9, 13), r(0, 9, 13, null, "2026-10-31")],
    },
    today: "2026-11-05",
    ...over,
  };
}

describe("[CF3-SDU] paleta", () => {
  it("[CF3-SDU1] Tenant.palette validada: conocida pasa, desconocida/vacía → sky; sobrevive al cache compacto", () => {
    expect(sitePalette("coral")).toBe("coral");
    expect(sitePalette("rojo")).toBe("sky");
    expect(sitePalette(null)).toBe("sky");
    expect(sitePalette("__proto__")).toBe("sky");
    const site = assembleClinicSite(input());
    expect(site.palette).toBe("mint");
    const back = expandClinicSite(JSON.parse(JSON.stringify(compactClinicSite(site))));
    expect(back).toEqual(site);
    const t = input().tenant;
    expect(assembleClinicSite(input({ tenant: { ...t, palette: "<script>" } })).palette).toBe("sky");
  });
});

describe("[CF3-SDU] horario por profesional", () => {
  it("[CF3-SDU2] vigencias contra el día AR, une solapadas y contiguas, lunes primero, descarta basura", () => {
    const out = weeklyHoursOf(
      [
        r(0, 9, 12), // domingo: va al final
        r(1, 8, 12),
        r(1, 11, 14), // pisa → 8 a 14
        r(1, 14, 15), // toca → 8 a 15
        r(2, 9, 13, "2026-11-06"), // empieza mañana
        r(3, 9, 13, null, "2026-11-04"), // venció ayer
        r(4, 9, 13, "2026-11-05", "2026-11-05"), // vigente solo hoy
        { dow: 7, startMin: 0, endMin: 60, validFrom: null, validUntil: null }, // dow inválido
        { dow: 5, startMin: 600, endMin: 600, validFrom: null, validUntil: null }, // vacía
        { dow: 6, startMin: -30, endMin: 1500, validFrom: null, validUntil: null }, // se recorta a 0..1440
      ],
      "2026-11-05"
    );
    expect(out).toEqual([
      { dow: 1, startMin: 480, endMin: 900 },
      { dow: 4, startMin: 540, endMin: 780 },
      { dow: 6, startMin: 0, endMin: 1440 },
      { dow: 0, startMin: 540, endMin: 720 },
    ]);
    // Sin `today` no filtra vigencias (no inventa un reloj).
    expect(weeklyHoursOf([r(2, 9, 13, "2099-01-01")], null)).toEqual([{ dow: 2, startMin: 540, endMin: 780 }]);
  });

  it("[CF3-SDU3] profesional sin franjas: la red de seguridad del motor (lun a sáb, horario del consultorio)", () => {
    const ranges = publicOpeningRanges({
      practitionerIds: ["p"],
      rows: [],
      tenant: { businessHoursStart: 9, businessHoursEnd: 18 },
    });
    const out = weeklyHoursOf(ranges, "2026-11-05");
    expect(out.map((x) => x.dow)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.every((x) => x.startMin === 540 && x.endMin === 1080)).toBe(true);
  });

  it("[CF3-SDU4] el DTO con horarios sigue cerrado (strict) y ausente = sin horario", () => {
    const site = assembleClinicSite(input());
    expect(() => clinicSiteSchema.parse(site)).not.toThrow();
    expect(site.practitioners.find((p) => p.id === "mariana")!.hours.some((h) => h.dow === 0)).toBe(false); // vencida
    const none = assembleClinicSite(input({ practitionerHours: undefined }));
    expect(none.practitioners.every((p) => p.hours.length === 0)).toBe(true);
    expect(siteWeekTable(none)).toBeNull();
    expect(siteWhoByDay(none)).toEqual([]);
    expect(() =>
      clinicSiteSchema.parse({ ...site, practitioners: [{ ...site.practitioners[0], hours: [{ dow: 1, startMin: 0, endMin: 60, roomId: "x" }] }] })
    ).toThrow();
  });
});

describe("[CF3-SDU] lo que pinta la página", () => {
  const site = assembleClinicSite(input());

  it("[CF3-SDU5] «Horarios»: 7 filas lunes a domingo, unión de profesionales, «Cerrado»", () => {
    const table = siteWeekTable(site)!;
    expect(table.map((d) => d.day)).toEqual(["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]);
    expect(table.map((d) => d.label)).toEqual([
      "8 a 14 y 15 a 20 h",
      "9 a 13 y 14 a 20 h",
      "8 a 14 y 15 a 20 h",
      "9 a 13 y 14 a 20 h",
      "8 a 14 h",
      "9 a 13 h",
      "Cerrado",
    ]);
  });

  it("[CF3-SDU6] «Quién atiende cada día»: días con alguien, por hora de inicio, con iniciales; días cerrados", () => {
    const days = siteWhoByDay(site);
    expect(days.map((d) => d.short)).toEqual(["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]);
    expect(days[0].slots).toEqual([
      { practitionerId: "tomas", name: "Lic. Tomás Paredes", initials: "TP", label: "8 a 14 h" },
      { practitionerId: "mariana", name: "Mariana Pérez", initials: "MP", label: "15 a 20 h" },
    ]);
    expect(days[1].slots.map((s) => s.practitionerId)).toEqual(["mariana", "tomas"]);
    expect(days[4].slots.map((s) => s.practitionerId)).toEqual(["tomas"]);
    expect(siteClosedDays(days)).toEqual(["Domingo"]);
  });

  it("hoursLabel e iniciales", () => {
    expect(hoursLabel([{ startMin: 510, endMin: 750 }])).toBe("8:30 a 12:30 h");
    expect(hoursLabel([])).toBe("Cerrado");
    expect(personInitials("Lic. Ana María Pérez")).toBe("AP");
    expect(personInitials("Dra. Lucía")).toBe("L");
    expect(personInitials("  ")).toBe("");
  });

  it("[CF3-SDU7] 200 sedes × 5 profesionales × 10 servicios × 8 franjas: snapshot < 1,2 MB", () => {
    const pros = Array.from({ length: 5 }, (_, i) => ({
      id: `c${"x".repeat(23)}${i}`,
      name: `Profesional Apellido Largo ${i}`,
      specialty: "Kinesiología y fisiatría deportiva",
      licenseNumber: "MP 123456",
      acceptedInsurerIds: [],
    }));
    const services = Array.from({ length: 10 }, (_, i) => ({
      id: `c${"s".repeat(23)}${i}`,
      name: `Servicio de rehabilitación número ${i}`,
      durationMin: 45,
      priceCents: 1_234_500,
      practitionerId: null,
      practitionerIds: pros.map((p) => p.id),
    }));
    const hours = [r(1, 8, 12), r(1, 15, 20), r(2, 8, 12), r(3, 8, 12), r(3, 15, 20), r(4, 8, 12), r(5, 8, 12), r(6, 9, 13)];
    const base = input();
    const sites = Array.from({ length: 200 }, (_, i) =>
      compactClinicSite(
        assembleClinicSite({
          ...base,
          tenant: { ...base.tenant, slug: `consultorio-${i}`, publicDescription: "x".repeat(800), siteTagline: "y".repeat(120) },
          clinic: { openingSummary: "Lun a vie 8 a 19", practitioners: pros, services },
          practitionerHours: Object.fromEntries(pros.map((p) => [p.id, hours])),
        })
      )
    );
    expect(sites[0].practitioners[0].h).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, builtAt: "", sites, aliases: {} }))).toBeLessThan(1_200_000);
  });
});
