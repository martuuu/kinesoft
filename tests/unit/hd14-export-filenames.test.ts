import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * [HD-14] Nombre de archivo de los exports con el día AR, no el del host.
 *
 * `GET /api/pacientes/export` armaba `pacientes-${new Date().toISOString().slice(0, 10)}.csv`: en Vercel (UTC) un
 * export de las 21:00-23:59 AR salía con la fecha de mañana. Se corre el handler REAL; se mockea la sesión (cookie),
 * el rate limit y el armado del CSV/ICS (DB). Corre en TZ=UTC (`npm test`), donde el bug se ve.
 *
 * `GET /api/agenda/export`: `from` siempre es una medianoche AR (03:00 UTC), así que `toISOString().slice(0, 10)`
 * daba el mismo día; se pasa a `toARDateKey(from)` para que no dependa de esa casualidad. Ese caso queda fijado con
 * `it` (no hay bug que dar vuelta).
 */
const actor = vi.hoisted(() => ({ tenantId: "t-hd14", userId: "u-hd14", support: null as unknown }));
vi.mock("@/lib/session", () => ({ tryGetActor: async () => actor }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
// [ZF1b] Los exports leen primero el estado de inactividad (cookies). Sin cookies = sesión persistente, como antes.
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("@/lib/patients-export-internal", () => ({ exportPatientsCsv: async () => "id,nombre\n" }));
const icsCalls = vi.hoisted(() => [] as Array<{ from: Date; to: Date }>);
vi.mock("@/lib/bookings-export-internal", () => ({
  exportBookingsIcs: async (_a: unknown, range: { from: Date; to: Date }) => {
    icsCalls.push(range);
    return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
  },
}));

import { GET as exportPatients } from "@/app/api/pacientes/export/route";
import { GET as exportAgenda } from "@/app/api/agenda/export/route";

const filenameOf = (res: Response) => /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1];

beforeEach(() => {
  icsCalls.length = 0;
  // Solo `Date`: los timers reales siguen andando (el handler es async).
  vi.useFakeTimers({ toFake: ["Date"] });
  // Martes 27-oct 23:30 AR = miércoles 28-oct 02:30 UTC.
  vi.setSystemTime(new Date("2026-10-27T23:30:00-03:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[HD-14] nombres de export con el día AR", () => {
  it("[HD-14] pacientes: a las 23:30 AR el CSV lleva el día AR, no el de mañana UTC", async () => {
    const res = await exportPatients(new Request("http://localhost/api/pacientes/export"));
    expect(res.status).toBe(200);
    expect(filenameOf(res)).toBe("pacientes-2026-10-27.csv");
  });

  it("[HD-14] agenda: sin rango, el ICS lleva el lunes AR de la semana (no se corre con el host)", async () => {
    const res = await exportAgenda(new Request("http://localhost/api/agenda/export"));
    expect(res.status).toBe(200);
    expect(filenameOf(res)).toBe("agenda-2026-10-26.ics");
    expect(icsCalls[0].from.toISOString()).toBe("2026-10-26T03:00:00.000Z");
  });

  it("[HD-14] agenda: con ?from el ICS lleva ese día AR", async () => {
    const res = await exportAgenda(new Request("http://localhost/api/agenda/export?from=2026-10-27&to=2026-10-31"));
    expect(res.status).toBe(200);
    expect(filenameOf(res)).toBe("agenda-2026-10-27.ics");
  });
});
