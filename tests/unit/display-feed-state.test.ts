/**
 * TV-1k (T7, §26.4 C-TV): lógica pura del feed de la pantalla de la sala y contratos de `lib/reception-displays-types.ts`.
 * Se corre en TZ=UTC y en TZ=America/Argentina/Buenos_Aires: la hora del turno («Turno de las 10:30») y el día del feed
 * son siempre AR, y en dev AR-local un `getHours()` del host pasaría verde (AGENTS.md §3).
 *
 * El feed es lo único que llega a una pantalla que mira toda la sala: además del armado (hero / recientes / esperando)
 * se fija la whitelist estricta de claves y que ningún dato del turno fuera de nombre + inicial salga en el JSON.
 */
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  DisplayMediaDuringCall as PrismaDisplayMediaDuringCall,
  DisplayMediaKind as PrismaDisplayMediaKind,
  DisplayMediaLayout as PrismaDisplayMediaLayout,
  DisplayNameMode as PrismaDisplayNameMode,
  DisplayTheme as PrismaDisplayTheme,
} from "@prisma/client";
import {
  DISPLAY_MEDIA_DURING_CALL,
  DISPLAY_MEDIA_KINDS,
  DISPLAY_MEDIA_LAYOUTS,
  DISPLAY_NAME_MODES,
  DISPLAY_THEMES,
  DisplayFeedSchema,
  DisplayUpsertSchema,
  HERO_HOLD_MS,
  ONLINE_WINDOW_MS,
  RECENT_WINDOW_MS,
  WAITING_MAX,
  formatPairingCode,
  normalizePairingCode,
  type DisplayConfig,
  type DisplayFeed,
  type DisplayMediaDuringCall,
  type DisplayMediaKind,
  type DisplayMediaLayout,
  type DisplayNameMode,
  type DisplayTheme,
} from "@/lib/reception-displays-types";
import {
  buildDisplayFeed,
  displayLabel,
  displayStatus,
  feedKey,
  finalizeDisplayFeed,
  isNewCall,
  type DisplayFeedRow,
} from "@/lib/display-feed-state";

// 22-oct-2026 11:00 AR (= 14:00Z). AR es UTC-3 sin horario de verano.
const NOW = new Date("2026-10-22T14:00:00.000Z");
const minAgo = (m: number, s = 0) => new Date(NOW.getTime() - m * 60_000 - s * 1000);

let seq = 0;
function row(over: Partial<DisplayFeedRow> = {}): DisplayFeedRow {
  seq++;
  return {
    bookingId: `bk_${seq}`,
    startTime: new Date("2026-10-22T13:30:00.000Z"), // 10:30 AR
    status: "CONFIRMED",
    patientName: `María González ${seq}`,
    guestName: null,
    arrivedAt: minAgo(30),
    calledAt: null,
    attendingAt: null,
    room: "Consultorio 1",
    practitioner: "Lic. Ríos",
    ...over,
  };
}
const called = (m: number, over: Partial<DisplayFeedRow> = {}) => row({ calledAt: minAgo(m), ...over });

const CONFIG: DisplayConfig = {
  nameMode: "SHORT_NAME",
  theme: "DARK",
  mediaKind: "NONE",
  mediaRef: null,
  mediaLayout: "SIDE",
  mediaMuted: true,
  mediaDuringCall: "DUCK",
};

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("[TV-1k] uniones de M17 = enums de Prisma", () => {
  it("en tipo y en runtime", () => {
    expectTypeOf<DisplayNameMode>().toEqualTypeOf<PrismaDisplayNameMode>();
    expectTypeOf<DisplayTheme>().toEqualTypeOf<PrismaDisplayTheme>();
    expectTypeOf<DisplayMediaKind>().toEqualTypeOf<PrismaDisplayMediaKind>();
    expectTypeOf<DisplayMediaLayout>().toEqualTypeOf<PrismaDisplayMediaLayout>();
    expectTypeOf<DisplayMediaDuringCall>().toEqualTypeOf<PrismaDisplayMediaDuringCall>();
    expect(sorted(DISPLAY_NAME_MODES)).toEqual(sorted(Object.values(PrismaDisplayNameMode)));
    expect(sorted(DISPLAY_THEMES)).toEqual(sorted(Object.values(PrismaDisplayTheme)));
    expect(sorted(DISPLAY_MEDIA_KINDS)).toEqual(sorted(Object.values(PrismaDisplayMediaKind)));
    expect(sorted(DISPLAY_MEDIA_LAYOUTS)).toEqual(sorted(Object.values(PrismaDisplayMediaLayout)));
    expect(sorted(DISPLAY_MEDIA_DURING_CALL)).toEqual(sorted(Object.values(PrismaDisplayMediaDuringCall)));
  });

  it("el tipo de salida de DisplayFeedSchema es DisplayFeed", () => {
    expectTypeOf<ReturnType<typeof DisplayFeedSchema.parse>>().toEqualTypeOf<DisplayFeed>();
  });
});

describe("[TV-1k] código de vinculación (Crockford)", () => {
  it("normaliza espacios, guiones, minúsculas y O→0, I/L→1", () => {
    expect(normalizePairingCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizePairingCode("  ab cd  ef gh ")).toBe("ABCDEFGH");
    expect(normalizePairingCode("O0IL-1abc")).toBe("00111ABC");
  });

  it("rechaza largo distinto de 8 y la U (sin sustituto en Crockford)", () => {
    expect(normalizePairingCode("ABCDEFG")).toBeNull();
    expect(normalizePairingCode("ABCDEFGHJ")).toBeNull();
    expect(normalizePairingCode("ABCDEFGU")).toBeNull();
    expect(normalizePairingCode("ABCD*FGH")).toBeNull();
    expect(normalizePairingCode(null)).toBeNull();
  });

  it("formatea ABCD-EFGH", () => {
    expect(formatPairingCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(formatPairingCode("abc")).toBe("ABC");
  });
});

describe("[TV-1k] DisplayUpsertSchema", () => {
  const base = {
    name: " Recepción PB ",
    locationId: null,
    nameMode: "SHORT_NAME",
    theme: "DARK",
    mediaUrl: null,
    mediaLayout: "SIDE",
    mediaMuted: true,
    mediaDuringCall: "DUCK",
  } as const;

  it("recorta el nombre y acepta mediaUrl null o crudo", () => {
    const r = DisplayUpsertSchema.parse(base);
    expect(r.name).toBe("Recepción PB");
    expect(DisplayUpsertSchema.parse({ ...base, mediaUrl: "https://youtu.be/dQw4w9WgXcQ" }).mediaUrl).toBe(
      "https://youtu.be/dQw4w9WgXcQ",
    );
  });

  it("espeja el CHECK del nombre (1-60)", () => {
    expect(DisplayUpsertSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(DisplayUpsertSchema.safeParse({ ...base, name: "x".repeat(61) }).success).toBe(false);
    expect(DisplayUpsertSchema.safeParse({ ...base, nameMode: "TICKET" }).success).toBe(false);
  });
});

describe("[TV-1k] buildDisplayFeed: hero", () => {
  it("[TV-1k] el hero es el último llamado de los últimos 10 min (inclusive)", () => {
    const a = called(9, { patientName: "Laura Pérez" });
    const b = called(2, { patientName: "Tomás Kraus" });
    const f = buildDisplayFeed([a, b], { nameMode: "SHORT_NAME", now: NOW });
    expect(f.hero?.label).toBe("Tomás K.");
    expect(f.hero?.calledAt).toBe(minAgo(2).toISOString());
    expect(f.recent.map((r) => r.label)).toEqual(["Laura P."]);

    const exact = buildDisplayFeed([row({ calledAt: new Date(NOW.getTime() - HERO_HOLD_MS) })], { nameMode: "SHORT_NAME", now: NOW });
    expect(exact.hero).not.toBeNull();
  });

  it("[TV-1k] pasado el TTL no hay hero y el llamado queda en recientes", () => {
    const f = buildDisplayFeed([called(10, { patientName: "Laura Pérez" }, ), row({ calledAt: minAgo(10, 1), patientName: "Ana Ruiz" })], {
      nameMode: "SHORT_NAME",
      now: NOW,
    });
    expect(f.hero?.label).toBe("Laura P.");
    const g = buildDisplayFeed([row({ calledAt: minAgo(10, 1), patientName: "Ana Ruiz" })], { nameMode: "SHORT_NAME", now: NOW });
    expect(g.hero).toBeNull();
    expect(g.recent.map((r) => r.label)).toEqual(["Ana R."]);
  });

  it("[TV-1k] un turno cancelado o ausente no se anuncia", () => {
    const f = buildDisplayFeed([called(1, { status: "CANCELLED" }), called(2, { status: "NO_SHOW" })], { nameMode: "SHORT_NAME", now: NOW });
    expect(f.hero).toBeNull();
    expect(f.recent).toEqual([]);
  });
});

describe("[TV-1k] buildDisplayFeed: recientes", () => {
  it("[TV-1k] hasta 3, de los últimos 60 min, del más nuevo al más viejo, sin el hero", () => {
    const rows = [
      called(1, { patientName: "Hero Uno" }),
      called(20, { patientName: "Beta Dos" }),
      called(5, { patientName: "Alfa Tres" }),
      called(40, { patientName: "Gama Cuatro" }),
      called(50, { patientName: "Delta Cinco" }),
      row({ calledAt: new Date(NOW.getTime() - RECENT_WINDOW_MS - 1000), patientName: "Viejo Seis" }),
    ];
    const f = buildDisplayFeed(rows, { nameMode: "SHORT_NAME", now: NOW });
    expect(f.hero?.label).toBe("Hero U.");
    expect(f.recent.map((r) => r.label)).toEqual(["Alfa T.", "Beta D.", "Gama C."]);
  });
});

describe("[TV-1k] buildDisplayFeed: esperando", () => {
  it("[TV-1k] llegó, no llamado, no en atención, PENDING/CONFIRMED, por horario", () => {
    const at = (hhmmUtc: string) => new Date(`2026-10-22T${hhmmUtc}:00.000Z`);
    const rows = [
      row({ startTime: at("14:30"), patientName: "Tercero Tres", status: "PENDING" }),
      row({ startTime: at("13:00"), patientName: "Primero Uno" }),
      row({ startTime: at("13:30"), patientName: "Segundo Dos" }),
      row({ startTime: at("12:00"), patientName: "Sin Llegar", arrivedAt: null }),
      row({ startTime: at("12:00"), patientName: "En Atención", attendingAt: minAgo(1) }),
      row({ startTime: at("12:00"), patientName: "Ya Llamado", calledAt: minAgo(1) }),
      row({ startTime: at("12:00"), patientName: "Ya Atendido", status: "COMPLETED" }),
      row({ startTime: at("12:00"), patientName: "Cancelado Cancelado", status: "CANCELLED" }),
    ];
    const f = buildDisplayFeed(rows, { nameMode: "SHORT_NAME", now: NOW });
    expect(f.waiting.map((w) => w.label)).toEqual(["Primero U.", "Segundo D.", "Tercero T."]);
    expect(f.waitingCount).toBe(3);
    expect(f.waiting.every((w) => w.calledAt === null)).toBe(true);
  });

  it("[TV-1k] tope de 12 y el conteo total", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      row({ startTime: new Date(Date.UTC(2026, 9, 22, 12, i)), patientName: `Paciente${i} Apellido` }),
    );
    const f = buildDisplayFeed(rows, { nameMode: "SHORT_NAME", now: NOW });
    expect(f.waiting).toHaveLength(WAITING_MAX);
    expect(f.waitingCount).toBe(15);
    expect(f.waiting[0].label).toBe("Paciente0 A.");
  });
});

describe("[TV-1k] etiqueta", () => {
  it("[TV-1k] TURN_TIME = «Turno de las 10:30» en hora AR, sin nombre", () => {
    const r = row({ startTime: "2026-10-22T13:30:00.000Z", patientName: "María González" });
    expect(displayLabel(r, "TURN_TIME")).toBe("Turno de las 10:30");
    expect(displayLabel(row({ startTime: new Date("2026-10-22T02:05:00.000Z") }), "TURN_TIME")).toBe("Turno de las 23:05");
    const f = buildDisplayFeed([called(1, { patientName: "María González" })], { nameMode: "TURN_TIME", now: NOW });
    expect(f.hero?.label).toBe("Turno de las 10:30");
    expect(JSON.stringify(f)).not.toContain("María");
  });

  it("[TV-1k] partículas «de/del» no dan inicial", () => {
    expect(displayLabel(row({ patientName: "María de los Ángeles Pérez" }), "SHORT_NAME")).toBe("María Á.");
    expect(displayLabel(row({ patientName: "Juan del Valle" }), "SHORT_NAME")).toBe("Juan V.");
    expect(displayLabel(row({ patientName: "Cher" }), "SHORT_NAME")).toBe("Cher");
  });

  it("[TV-1k] guest: usa guestName; sin nombre cae a la hora del turno", () => {
    expect(displayLabel(row({ patientName: null, guestName: "Pedro Gómez" }), "SHORT_NAME")).toBe("Pedro G.");
    expect(displayLabel(row({ patientName: null, guestName: "   " }), "SHORT_NAME")).toBe("Turno de las 10:30");
    expect(displayLabel(row({ patientName: null, guestName: null }), "SHORT_NAME")).toBe("Turno de las 10:30");
  });
});

describe("[TV-1k] key e isNewCall", () => {
  it("[TV-1k] key = sha256(bookingId|calledAt) base64url, 16 caracteres", () => {
    const c = new Date("2026-10-22T13:58:00.000Z");
    const expected = createHash("sha256").update(`bk_x|${c.toISOString()}`).digest("base64url").slice(0, 16);
    expect(feedKey("bk_x", c)).toBe(expected);
    expect(feedKey("bk_x", c.toISOString())).toBe(expected);
    expect(feedKey("bk_x", null)).toBe(createHash("sha256").update("bk_x|").digest("base64url").slice(0, 16));
    // Entradas largas y multibyte (varios bloques de SHA-256): la implementación apta cliente = node:crypto.
    const long = "ñ".repeat(200) + "|" + "x".repeat(57);
    expect(feedKey(long, null)).toBe(createHash("sha256").update(`${long}|`).digest("base64url").slice(0, 16));
  });

  it("[TV-1k] un llamado nuevo del mismo turno es otra key (no hay re-llamado)", () => {
    expect(feedKey("bk_1", minAgo(5))).not.toBe(feedKey("bk_1", minAgo(1)));
  });

  it("[TV-1k] isNewCall: solo si cambió el hero; el primer feed no suena", () => {
    const f = buildDisplayFeed([called(1)], { nameMode: "SHORT_NAME", now: NOW });
    const key = f.hero!.key;
    expect(isNewCall(undefined, f)).toBe(false);
    expect(isNewCall(null, f)).toBe(true);
    expect(isNewCall("otra", f)).toBe(true);
    expect(isNewCall(key, f)).toBe(false);
    expect(isNewCall(key, { hero: null })).toBe(false);
  });
});

describe("[TV-1k] whitelist y PHI", () => {
  const leaky = {
    ...called(1, { patientName: "María González", room: "Consultorio 2" }),
    // Lo que un select descuidado del server podría traer de más: nada de esto puede salir.
    patientId: "pat_SECRETO",
    dni: "30111222",
    phone: "+5491155550000",
    serviceName: "Rehabilitación de rodilla",
    notes: "dolor lumbar crónico",
    lastName: "González",
  } as DisplayFeedRow;
  const waitingLeaky = { ...row({ patientName: "Ricardo Villalba" }), dni: "28999888" } as DisplayFeedRow;

  it("[TV-1k] finalizeDisplayFeed devuelve exactamente las claves del contrato", () => {
    const feed = finalizeDisplayFeed(
      { now: NOW, clinicName: "Kine Centro", locationName: null, config: CONFIG },
      buildDisplayFeed([leaky, waitingLeaky], { nameMode: "SHORT_NAME", now: NOW }),
    );
    expect(Object.keys(feed).sort()).toEqual(
      ["v", "serverNow", "dayKey", "clinicName", "locationName", "config", "hero", "recent", "waiting", "waitingCount"].sort(),
    );
    expect(Object.keys(feed.hero!).sort()).toEqual(["calledAt", "key", "label", "practitioner", "room"]);
    expect(Object.keys(feed.config).sort()).toEqual(Object.keys(CONFIG).sort());
    expect(feed.v).toBe(1);
    expect(feed.serverNow).toBe(NOW.toISOString());
    expect(feed.dayKey).toBe("2026-10-22");
  });

  it("[TV-1k] el día del feed es el AR (a las 23:30 AR ya es mañana en UTC)", () => {
    const late = new Date("2026-10-23T02:30:00.000Z");
    const feed = finalizeDisplayFeed({ now: late, clinicName: "K", locationName: null, config: CONFIG }, {
      hero: null,
      recent: [],
      waiting: [],
      waitingCount: 0,
    });
    expect(feed.dayKey).toBe("2026-10-22");
  });

  it("[TV-1k] ninguna PHI en el JSON: ni apellido, DNI, teléfono, servicio, notas ni ids", () => {
    const feed = finalizeDisplayFeed(
      { now: NOW, clinicName: "Kine Centro", locationName: "Sede Centro", config: CONFIG },
      buildDisplayFeed([leaky, waitingLeaky], { nameMode: "SHORT_NAME", now: NOW }),
    );
    const json = JSON.stringify(feed);
    for (const s of ["González", "Villalba", "pat_SECRETO", "30111222", "28999888", "5491155550000", "Rehabilitación", "lumbar", leaky.bookingId, waitingLeaky.bookingId]) {
      expect(json).not.toContain(s);
    }
    expect(feed.hero?.label).toBe("María G.");
    expect(feed.waiting[0].label).toBe("Ricardo V.");
  });

  it("[TV-1k] DisplayFeedSchema es strict: una clave de más en cualquier nivel falla", () => {
    const feed = finalizeDisplayFeed({ now: NOW, clinicName: "K", locationName: null, config: CONFIG }, buildDisplayFeed([called(1)], { nameMode: "SHORT_NAME", now: NOW }));
    expect(DisplayFeedSchema.safeParse(feed).success).toBe(true);
    expect(DisplayFeedSchema.safeParse({ ...feed, patientId: "x" }).success).toBe(false);
    expect(DisplayFeedSchema.safeParse({ ...feed, hero: { ...feed.hero, patientId: "x" } }).success).toBe(false);
    expect(DisplayFeedSchema.safeParse({ ...feed, config: { ...feed.config, locationId: "x" } }).success).toBe(false);
    expect(() =>
      finalizeDisplayFeed({ now: NOW, clinicName: "K", locationName: null, config: { ...CONFIG, extra: 1 } as DisplayConfig }, {
        hero: null,
        recent: [],
        waiting: [],
        waitingCount: 0,
      }),
    ).toThrow();
  });
});

describe("[TV-1k] displayStatus", () => {
  const iso = (d: Date) => d.toISOString();
  it("[TV-1k] online / offline / pairing / unpaired", () => {
    expect(displayStatus({ pairedAt: iso(minAgo(60)), lastSeenAt: iso(minAgo(1)), pairingExpiresAt: null }, NOW)).toBe("online");
    expect(
      displayStatus({ pairedAt: iso(minAgo(60)), lastSeenAt: new Date(NOW.getTime() - ONLINE_WINDOW_MS).toISOString(), pairingExpiresAt: null }, NOW),
    ).toBe("online");
    expect(
      displayStatus({ pairedAt: iso(minAgo(60)), lastSeenAt: new Date(NOW.getTime() - ONLINE_WINDOW_MS - 1).toISOString(), pairingExpiresAt: null }, NOW),
    ).toBe("offline");
    expect(displayStatus({ pairedAt: iso(minAgo(60)), lastSeenAt: null, pairingExpiresAt: null }, NOW)).toBe("offline");
    expect(displayStatus({ pairedAt: null, lastSeenAt: null, pairingExpiresAt: iso(minAgo(-5)) }, NOW)).toBe("pairing");
    expect(displayStatus({ pairedAt: null, lastSeenAt: null, pairingExpiresAt: iso(minAgo(1)) }, NOW)).toBe("unpaired");
    expect(displayStatus({ pairedAt: null, lastSeenAt: null, pairingExpiresAt: null }, NOW)).toBe("unpaired");
    // Código vivo sobre una pantalla ya vinculada (se va a mover de TV): manda el código, que es lo que el drawer muestra.
    expect(displayStatus({ pairedAt: iso(minAgo(60)), lastSeenAt: iso(minAgo(1)), pairingExpiresAt: iso(minAgo(-5)) }, NOW)).toBe("pairing");
  });
});
