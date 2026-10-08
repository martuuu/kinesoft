/**
 * SR1.0 (SR-C) — constantes, copy y zod de Salas. Lo que protege:
 *   - el espejo `RoomKind` del cliente no se desalinea del enum de Prisma (M4);
 *   - `capacity` = PROFESIONALES a la vez (SR-D1, §17.5) en el copy;
 *   - los topes del zod son los CHECK de M4 (nombre 1..60 con trim, capacidad
 *     1..50), para que el usuario vea un error legible y no un 23514.
 */
import { describe, expect, it } from "vitest";
import { RoomKind as PrismaRoomKind } from "@prisma/client";
import {
  NO_ROOM_LABEL,
  ROOM_CAPACITY_HELP,
  ROOM_CAPACITY_LABEL,
  ROOM_CAPACITY_MAX,
  ROOM_CAPACITY_MIN,
  ROOM_KIND_LABEL,
  ROOM_KINDS,
  ROOM_NAME_MAX,
  roomSummary,
} from "@/lib/rooms-constants";
import { RoomArchive, RoomCreate, RoomListQuery, RoomUpdate } from "@/lib/rooms-schemas";

describe("rooms-constants", () => {
  it("RoomKind del cliente = enum RoomKind de Prisma (M4), en el orden del select", () => {
    expect([...ROOM_KINDS].sort()).toEqual(Object.values(PrismaRoomKind).sort());
    expect(ROOM_KINDS).toEqual(["CONSULTORIO", "BOX", "GIMNASIO", "SALA"]);
    expect(ROOM_KIND_LABEL).toEqual({ CONSULTORIO: "Consultorio", BOX: "Box", GIMNASIO: "Gimnasio", SALA: "Sala" });
  });

  it("topes = CHECK de M4", () => {
    expect(ROOM_CAPACITY_MIN).toBe(1);
    expect(ROOM_CAPACITY_MAX).toBe(50);
    expect(ROOM_NAME_MAX).toBe(60);
  });

  it("copy de capacidad: profesionales, no pacientes (§17.5)", () => {
    expect(ROOM_CAPACITY_LABEL).toBe("Profesionales a la vez");
    expect(ROOM_CAPACITY_HELP).toBe("1 para un consultorio. En un gimnasio, cuántos profesionales atienden juntos.");
    expect(roomSummary({ kind: "CONSULTORIO", capacity: 1 })).toBe("Consultorio · 1 profesional a la vez");
    expect(roomSummary({ kind: "GIMNASIO", capacity: 8 })).toBe("Gimnasio · hasta 8 profesionales a la vez");
    expect(`${ROOM_CAPACITY_LABEL} ${ROOM_CAPACITY_HELP} ${roomSummary({ kind: "BOX", capacity: 3 })}`).not.toMatch(
      /paciente/i
    );
    expect(NO_ROOM_LABEL).toBe("Sin sala");
  });
});

describe("rooms-schemas", () => {
  it("RoomCreate: defaults Consultorio / 1, trim del nombre y capacidad desde string", () => {
    expect(RoomCreate.parse({ locationId: "loc", name: "  Consultorio 2 " })).toEqual({
      locationId: "loc",
      name: "Consultorio 2",
      kind: "CONSULTORIO",
      capacity: 1,
    });
    expect(RoomCreate.parse({ locationId: "loc", name: "Gimnasio", kind: "GIMNASIO", capacity: "8" }).capacity).toBe(8);
  });

  it("RoomCreate: rechaza nombre vacío o largo, capacidad fuera de 1..50 o no entera, tipo inválido", () => {
    const bad = (v: Record<string, unknown>) => RoomCreate.safeParse({ locationId: "loc", name: "X", ...v }).success;
    expect(bad({ name: "   " })).toBe(false);
    expect(bad({ name: "x".repeat(61) })).toBe(false);
    expect(bad({ name: "x".repeat(60) })).toBe(true);
    expect(bad({ capacity: 0 })).toBe(false);
    expect(bad({ capacity: 51 })).toBe(false);
    expect(bad({ capacity: 50 })).toBe(true);
    expect(bad({ capacity: 1.5 })).toBe(false);
    expect(bad({ kind: "QUIROFANO" })).toBe(false);
    expect(RoomCreate.safeParse({ name: "X" }).success).toBe(false); // sin sede
  });

  it("RoomUpdate: parcial, sin sede, y exige al menos un campo", () => {
    expect(RoomUpdate.parse({ id: "r1", capacity: "2" })).toEqual({ id: "r1", capacity: 2 });
    expect(RoomUpdate.safeParse({ id: "r1" }).success).toBe(false);
    // La sede no se cambia (FK compuesta roomId+locationId): el campo se descarta.
    expect(RoomUpdate.parse({ id: "r1", name: "B", locationId: "otra" } as never)).toEqual({ id: "r1", name: "B" });
  });

  it("RoomArchive y RoomListQuery", () => {
    expect(RoomArchive.parse({ id: " r1 " })).toEqual({ id: "r1" });
    expect(RoomArchive.safeParse({ id: "" }).success).toBe(false);
    expect(RoomListQuery.parse(undefined)).toEqual({});
    expect(RoomListQuery.parse({ includeArchived: true })).toEqual({ includeArchived: true });
  });
});
