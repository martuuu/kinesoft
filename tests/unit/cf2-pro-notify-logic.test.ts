/**
 * [CF2 · T-SE] Piezas puras del aviso al profesional por un turno online (plan §29, D-CF2-11):
 * `lib/booking-pro-notify-logic.ts`.
 *
 * Por qué importa: el push se ve en la pantalla bloqueada del celular del profesional (la puede leer cualquiera que
 * lo tenga en la mano), así que el cuerpo NO lleva el nombre del paciente; el mail lleva solo «Juan P.». Y la hora sale
 * en hora argentina aunque el server corra en UTC (Vercel): un turno de las 23:30 AR es 02:30 UTC del día siguiente,
 * y con el día del host el aviso diría «mar 3/11 02:30» y el link abriría la agenda del día equivocado.
 * Correr con TZ=UTC (y TZ=America/Argentina/Buenos_Aires): el resultado tiene que ser el mismo.
 */
import { describe, it, expect } from "vitest";
import {
  patientShortName,
  bookingAgendaUrl,
  bookingWhenAR,
  bookingPushPayload,
} from "@/lib/booking-pro-notify-logic";

describe("[CF2-SE] patientShortName", () => {
  it("[CF2-SE10] nombre + inicial del apellido con punto («Juan P.»)", () => {
    expect(patientShortName("Juan", "Pérez")).toBe("Juan P.");
  });

  it("[CF2-SE11] solo el primer nombre y la inicial del primer apellido; mayúscula y espacios normalizados", () => {
    expect(patientShortName("  juan pablo ", " pérez  gómez")).toBe("juan P.");
    expect(patientShortName("María José", "de la Fuente")).toBe("María D.");
    expect(patientShortName("Iñaki", "ñandú")).toBe("Iñaki Ñ.");
  });

  it("[CF2-SE12] faltantes: sin apellido → solo el nombre; sin nombre → la inicial; nada → «Paciente»", () => {
    expect(patientShortName("Juan", "")).toBe("Juan");
    expect(patientShortName("Juan", null)).toBe("Juan");
    expect(patientShortName("", "Pérez")).toBe("P.");
    expect(patientShortName(null, undefined)).toBe("Paciente");
    expect(patientShortName("   ", "  ")).toBe("Paciente");
  });

  it("[CF2-SE13] saca controles y saltos (el nombre lo escribe el paciente en el turnero)", () => {
    expect(patientShortName("Juan\nBcc: x@y.z", "Pérez")).toBe("Juan P.");
    expect(patientShortName("Ju\u0000an", "\tPérez")).toBe("Ju P.");
  });
});

describe("[CF2-SE] bookingAgendaUrl", () => {
  it("[CF2-SE14] día válido → agenda de ese día en la vista del día", () => {
    expect(bookingAgendaUrl("2026-11-09")).toBe("/agenda?date=2026-11-09&view=timeline");
  });

  it("[CF2-SE15] clave que no es YYYY-MM-DD → /agenda pelada (nunca un parámetro inyectado)", () => {
    expect(bookingAgendaUrl("2026-11-09&view=list")).toBe("/agenda");
    expect(bookingAgendaUrl("")).toBe("/agenda");
    expect(bookingAgendaUrl("09/11/2026")).toBe("/agenda");
  });
});

describe("[CF2-SE] bookingWhenAR", () => {
  it("[CF2-SE16] «lun 9/11» y «10:30» en hora argentina", () => {
    expect(bookingWhenAR(new Date("2026-11-09T13:30:00.000Z"))).toEqual({
      dayKey: "2026-11-09",
      dayLabel: "lun 9/11",
      time: "10:30",
    });
  });

  it("[CF2-SE17] borde 23:30 AR = 02:30 UTC del día siguiente: sigue siendo el día AR", () => {
    expect(bookingWhenAR(new Date("2026-11-03T02:30:00.000Z"))).toEqual({
      dayKey: "2026-11-02",
      dayLabel: "lun 2/11",
      time: "23:30",
    });
  });

  it("[CF2-SE18] medianoche AR y días con tilde (mié, sáb)", () => {
    expect(bookingWhenAR(new Date("2026-11-04T03:00:00.000Z"))).toEqual({
      dayKey: "2026-11-04",
      dayLabel: "mié 4/11",
      time: "00:00",
    });
    expect(bookingWhenAR(new Date("2026-12-05T12:05:00.000Z")).dayLabel).toBe("sáb 5/12");
  });
});

describe("[CF2-SE] bookingPushPayload", () => {
  it("[CF2-SE19] título fijo, cuerpo «lun 9/11 · 10:30 · {Consultorio}», link al día en la agenda", () => {
    expect(
      bookingPushPayload({ tenantName: "Kinesio Sur", scheduledFor: new Date("2026-11-09T13:30:00.000Z") }),
    ).toEqual({
      title: "Nuevo turno online",
      body: "lun 9/11 · 10:30 · Kinesio Sur",
      url: "/agenda?date=2026-11-09&view=timeline",
    });
  });

  it("[CF2-SE20] borde 23:30 AR en TZ=UTC: cuerpo y link con el día AR", () => {
    const p = bookingPushPayload({ tenantName: "Kinesio Sur", scheduledFor: new Date("2026-11-03T02:30:00.000Z") });
    expect(p.body).toBe("lun 2/11 · 23:30 · Kinesio Sur");
    expect(p.url).toBe("/agenda?date=2026-11-02&view=timeline");
  });

  it("[CF2-SE21] con bookingId: tag estable por turno (un reintento del webhook reemplaza el aviso, no lo duplica)", () => {
    const p = bookingPushPayload({
      tenantName: "Kinesio Sur",
      scheduledFor: new Date("2026-11-09T13:30:00.000Z"),
      bookingId: "bk_123",
    });
    expect(p.tag).toBe("booking-bk_123");
  });

  it("[CF2-SE22] nombre del consultorio con saltos o muy largo: una línea, recortado; vacío → sin el último tramo", () => {
    const long = bookingPushPayload({ tenantName: `Centro\n${"x".repeat(200)}`, scheduledFor: new Date("2026-11-09T13:30:00.000Z") });
    expect(long.body.startsWith("lun 9/11 · 10:30 · Centro x")).toBe(true);
    expect(long.body).not.toMatch(/\n/);
    expect(long.body.length).toBeLessThanOrEqual(120);
    const empty = bookingPushPayload({ tenantName: "  ", scheduledFor: new Date("2026-11-09T13:30:00.000Z") });
    expect(empty.body).toBe("lun 9/11 · 10:30");
  });

  it("[CF2-SE23] la firma no recibe datos del paciente: el payload no tiene más claves que las del contrato", () => {
    const p = bookingPushPayload({ tenantName: "K", scheduledFor: new Date("2026-11-09T13:30:00.000Z"), bookingId: "b" });
    expect(Object.keys(p).sort()).toEqual(["body", "tag", "title", "url"]);
  });
});
