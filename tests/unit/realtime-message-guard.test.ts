/**
 * PF1.0-a · C-PF3: el guard TS puro del mensaje realtime (`lib/realtime-message-guard.ts`) tiene que decir EXACTAMENTE
 * lo mismo que el schema zod (`lib/realtime-events-schema.ts`) para cualquier entrada.
 *
 * Por qué importa: el payload llega por broadcast (no confiable). Si el guard fuera más permisivo que zod, un mensaje
 * forjado con una clave extra (p. ej. un nombre de paciente) pasaría al cliente; si fuera más estricto, la agenda
 * dejaría de re-pedir ante mensajes legítimos. El corpus cubre: válidos (completos y mínimos, cada kind, colapsos,
 * `prev` con y sin sala, bisiestos), cada campo inválido por separado, tipos cruzados, claves extra (propias y
 * heredadas), objetos que no son «objeto» para zod (array, Date, Map, thenable), `null`, strings largos y getters
 * hostiles. Se compara contra el schema REAL (no contra un valor esperado escrito a mano).
 */
import { describe, expect, it } from "vitest";
import { RealtimeAgendaMessageSchema } from "@/lib/realtime-events-schema";
import {
  REALTIME_KINDS,
  isRealtimeAgendaMessage,
  parseRealtimeAgendaMessage,
} from "@/lib/realtime-message-guard";
import { buildRealtimeMessages, availabilityMessage } from "@/lib/realtime-events";
import { parseIncoming } from "@/lib/realtime-client-state";

const AT = "2026-10-15T13:45:00.000Z";
const ok = { v: 1, kind: "booking", bookingId: "b1", practitionerId: "p1", day: "2026-10-15", at: AT } as const;
const id64 = "x".repeat(64);
const id65 = "x".repeat(65);

/** [descripción, entrada] */
const CORPUS: Array<[string, () => unknown]> = [
  // ── válidos ──
  ["completo", () => ({ ...ok })],
  ["mínimo (sin bookingId)", () => ({ v: 1, kind: "booking", practitionerId: "p1", day: "2026-10-15", at: AT })],
  ...REALTIME_KINDS.map((k): [string, () => unknown] => [`kind ${k}`, () => ({ ...ok, kind: k })]),
  ["colapso del consultorio (practitionerId y day null)", () => ({ v: 1, kind: "booking", practitionerId: null, day: null, at: AT })],
  ["roomId null", () => ({ ...ok, roomId: null })],
  ["roomId string", () => ({ ...ok, roomId: "r1" })],
  ["roomId undefined explícito", () => ({ ...ok, roomId: undefined })],
  ["bookingId undefined explícito", () => ({ ...ok, bookingId: undefined })],
  ["prev sin sala", () => ({ ...ok, prev: { practitionerId: "p2", day: "2026-10-14" } })],
  ["prev con sala null", () => ({ ...ok, prev: { practitionerId: "p2", day: "2026-10-14", roomId: null } })],
  ["prev con sala", () => ({ ...ok, prev: { practitionerId: "p2", day: "2026-10-14", roomId: "r9" } })],
  ["prev undefined explícito", () => ({ ...ok, prev: undefined })],
  ["ids de 64", () => ({ ...ok, bookingId: id64, practitionerId: id64, roomId: id64 })],
  ["at sin fracción", () => ({ ...ok, at: "2026-10-15T13:45:00Z" })],
  ["at sin segundos", () => ({ ...ok, at: "2026-10-15T13:45Z" })],
  ["at con fracción larga", () => ({ ...ok, at: "2026-10-15T13:45:00.123456789Z" })],
  ["at 29-feb bisiesto", () => ({ ...ok, at: "2028-02-29T00:00:00Z" })],
  ["day con formato pero fecha imposible (zod solo mira el patrón)", () => ({ ...ok, day: "2026-13-45" })],
  ["Object.create(null)", () => Object.assign(Object.create(null), ok)],
  ["instancia de clase", () => Object.assign(new (class Msg {})(), ok)],
  // ── cada campo inválido ──
  ["v 2", () => ({ ...ok, v: 2 })],
  ["v '1'", () => ({ ...ok, v: "1" })],
  ["sin v", () => ({ kind: "booking", practitionerId: "p1", day: "2026-10-15", at: AT })],
  ["kind desconocido", () => ({ ...ok, kind: "patient" })],
  ["kind en mayúsculas", () => ({ ...ok, kind: "BOOKING" })],
  ["kind número", () => ({ ...ok, kind: 1 })],
  ["sin kind", () => ({ v: 1, practitionerId: "p1", day: "2026-10-15", at: AT })],
  ["bookingId vacío", () => ({ ...ok, bookingId: "" })],
  ["bookingId de 65", () => ({ ...ok, bookingId: id65 })],
  ["bookingId null", () => ({ ...ok, bookingId: null })],
  ["bookingId número", () => ({ ...ok, bookingId: 7 })],
  ["sin practitionerId (nullable no es optional)", () => ({ v: 1, kind: "booking", day: "2026-10-15", at: AT })],
  ["practitionerId undefined", () => ({ ...ok, practitionerId: undefined })],
  ["practitionerId vacío", () => ({ ...ok, practitionerId: "" })],
  ["practitionerId de 65", () => ({ ...ok, practitionerId: id65 })],
  ["sin day", () => ({ v: 1, kind: "booking", practitionerId: "p1", at: AT })],
  ["day dd/mm/aaaa", () => ({ ...ok, day: "15/10/2026" })],
  ["day ISO con hora", () => ({ ...ok, day: "2026-10-15T00:00:00Z" })],
  ["day con salto de línea final", () => ({ ...ok, day: "2026-10-15\n" })],
  ["day con dígitos no ASCII", () => ({ ...ok, day: "٢٠٢٦-١٠-١٥" })],
  ["roomId vacío", () => ({ ...ok, roomId: "" })],
  ["roomId número", () => ({ ...ok, roomId: 3 })],
  ["prev null", () => ({ ...ok, prev: null })],
  ["prev sin day", () => ({ ...ok, prev: { practitionerId: "p2" } })],
  ["prev practitionerId null", () => ({ ...ok, prev: { practitionerId: null, day: "2026-10-14" } })],
  ["prev con clave extra", () => ({ ...ok, prev: { practitionerId: "p2", day: "2026-10-14", notes: "x" } })],
  ["prev array", () => ({ ...ok, prev: [] })],
  ["prev day inválido", () => ({ ...ok, prev: { practitionerId: "p2", day: "ayer" } })],
  ["sin at", () => ({ v: 1, kind: "booking", practitionerId: "p1", day: "2026-10-15" })],
  ["at 'ayer'", () => ({ ...ok, at: "ayer" })],
  ["at con offset", () => ({ ...ok, at: "2026-10-15T10:45:00-03:00" })],
  ["at sin Z", () => ({ ...ok, at: "2026-10-15T13:45:00" })],
  ["at 29-feb no bisiesto", () => ({ ...ok, at: "2026-02-29T00:00:00Z" })],
  ["at hora 24", () => ({ ...ok, at: "2026-10-15T24:00:00Z" })],
  ["at con espacio", () => ({ ...ok, at: "2026-10-15 13:45:00Z" })],
  ["at Date", () => ({ ...ok, at: new Date(AT) })],
  ["at número", () => ({ ...ok, at: Date.parse(AT) })],
  // ── claves extra (.strict()) ──
  ["clave extra con PHI", () => ({ ...ok, patientName: "María" })],
  ["clave extra undefined (zod la cuenta igual)", () => ({ ...ok, extra: undefined })],
  ["clave extra heredada (for…in)", () => Object.assign(Object.create({ leaked: 1 }), ok)],
  ["__proto__ como clave propia", () => JSON.parse(`{"v":1,"kind":"booking","practitionerId":"p1","day":"2026-10-15","at":"${AT}","__proto__":{"x":1}}`)],
  // ── no-objetos y objetos que zod no trata como objeto ──
  ["null", () => null],
  ["undefined", () => undefined],
  ["string", () => "x"],
  ["string JSON del mensaje", () => JSON.stringify(ok)],
  ["número", () => 1],
  ["booleano", () => true],
  ["array con el mensaje", () => [ok]],
  ["Date", () => new Date()],
  ["Map", () => new Map(Object.entries(ok))],
  ["thenable con los campos", () => ({ ...ok, then: () => {}, catch: () => {} })],
  ["función", () => Object.assign(() => {}, ok)],
  ["string larguísimo como day", () => ({ ...ok, day: "2".repeat(100_000) })],
];

function zodSays(x: unknown): boolean {
  try {
    return RealtimeAgendaMessageSchema.safeParse(x).success;
  } catch {
    return false;
  }
}

describe("[PF1.0-a] guard de realtime ≡ schema zod (C-PF3)", () => {
  it("el corpus tiene ≥ 40 casos y mezcla válidos e inválidos", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    const valid = CORPUS.filter(([, mk]) => zodSays(mk())).length;
    expect(valid).toBeGreaterThanOrEqual(15);
    expect(CORPUS.length - valid).toBeGreaterThanOrEqual(25);
  });

  for (const [name, mk] of CORPUS) {
    it(`${name}: guard === schema.safeParse().success`, () => {
      const x = mk();
      expect(isRealtimeAgendaMessage(x)).toBe(zodSays(x));
    });
  }

  it("parse devuelve una copia igual a `safeParse().data` (o null cuando zod rechaza)", () => {
    for (const [name, mk] of CORPUS) {
      const x = mk();
      const z = RealtimeAgendaMessageSchema.safeParse(x);
      const g = parseRealtimeAgendaMessage(x);
      if (!z.success) {
        expect(g, name).toBeNull();
        continue;
      }
      expect(g, name).toEqual(z.data);
      // Copia nueva: nadie aguas abajo sostiene el payload crudo ni su prototipo.
      expect(g, name).not.toBe(x);
      expect(Object.getPrototypeOf(g), name).toBe(Object.prototype);
    }
  });

  it("un getter hostil no tira: cuenta como inválido (el canal no es confiable)", () => {
    const hostile = { ...ok };
    Object.defineProperty(hostile, "kind", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(isRealtimeAgendaMessage(hostile)).toBe(false);
    expect(parseRealtimeAgendaMessage(hostile)).toBeNull();
    expect(parseIncoming(hostile)).toBeNull();
  });

  it("lo que arma el publisher pasa el guard (los dos lados del canal siguen hablando el mismo idioma)", () => {
    const now = new Date(AT);
    const msgs = buildRealtimeMessages(
      [
        { bookingId: "b1", practitionerId: "p1", scheduledFor: now, roomId: "r1", prev: { practitionerId: "p2", scheduledFor: now, roomId: null } },
        { bookingId: "b2", practitionerId: "p1", scheduledFor: now, kind: "reception" },
      ] as Parameters<typeof buildRealtimeMessages>[0],
      now
    );
    msgs.push(availabilityMessage({ practitionerId: null, day: null }, now));
    for (const m of msgs) {
      expect(isRealtimeAgendaMessage(m)).toBe(true);
      expect(zodSays(m)).toBe(true);
    }
  });

  it("el cliente (`parseIncoming`) usa el guard: mismo veredicto que zod en todo el corpus", () => {
    for (const [name, mk] of CORPUS) {
      const x = mk();
      expect(parseIncoming(x) !== null, name).toBe(zodSays(x));
    }
  });
});
