/**
 * [SR-U1] Configuración › Sedes › Salas: render estático (`renderToStaticMarkup`,
 * sin jsdom) de la sección y del form reales, más los helpers puros del
 * borrador, del orden (Subir/Bajar) y de los bloqueos de archivo. Se mockean
 * solo las server actions (red) y `next/navigation`; nunca el componente bajo
 * test. TZ=UTC (no hay fechas, pero es la regla del repo).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/dynamic", () => ({
  // El disclosure carga RoomsSection con dynamic(); acá se resuelve sincrónico
  // para poder afirmar que, cerrado, no se monta.
  default: () =>
    function DynamicMock() {
      return <div data-testid="rooms-section-dynamic" />;
    },
}));
vi.mock("@/lib/locations", () => ({
  archiveLocation: async () => ({ ok: true, data: undefined }),
  createLocation: async () => ({ ok: true, data: { id: "x" } }),
  restoreLocation: async () => ({ ok: true, data: undefined }),
  setPrimaryLocation: async () => ({ ok: true, data: undefined }),
  updateLocation: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/rooms", () => ({
  createRoom: async () => ({ ok: true, data: { id: "x" } }),
  updateRoom: async () => ({ ok: true, data: undefined }),
  archiveRoom: async () => ({ ok: true, data: undefined }),
  restoreRoom: async () => ({ ok: true, data: undefined }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import {
  ROOMS_COPY,
  RoomArchiveBlockers,
  RoomForm,
  RoomsSection,
  emptyRoomDraft,
  moveRoomPatches,
  roomArchiveBlockerItems,
  roomCountText,
  roomDraftFromRow,
  roomDraftToPayload,
  roomScheduleText,
  roomsOfLocation,
  validateRoomDraft,
} from "@/components/configuracion/panels/rooms-section";
import { LocationsPanel } from "@/components/configuracion/panels/locations-panel";
import type { LocationRow } from "@/lib/locations-schemas";
import { ROOM_CAPACITY_HELP, ROOM_CAPACITY_LABEL } from "@/lib/rooms-constants";
import { RoomCreate } from "@/lib/rooms-schemas";
import type { RoomRow } from "@/lib/rooms-types";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const room = (o: Partial<RoomRow> & { id: string; name: string }): RoomRow => ({
  locationId: "loc-1",
  kind: "CONSULTORIO",
  capacity: 1,
  active: true,
  sortOrder: 0,
  scheduleCount: 0,
  ...o,
});

const ROOMS: RoomRow[] = [
  room({ id: "r2", name: "Consultorio 2", sortOrder: 1, scheduleCount: 3 }),
  room({ id: "r1", name: "Consultorio 1", sortOrder: 0, scheduleCount: 1 }),
  room({ id: "g", name: "Gimnasio", kind: "GIMNASIO", capacity: 8, sortOrder: 2 }),
  room({ id: "old", name: "Box viejo", kind: "BOX", active: false, sortOrder: 3 }),
  room({ id: "otra", name: "De otra sede", locationId: "loc-2" }),
];

describe("[SR-U1] lista de salas de una sede", () => {
  it("muestra cada sala activa con tipo, profesionales a la vez y franjas, en orden de sortOrder", () => {
    const html = render(<RoomsSection locationId="loc-1" locationName="Centro" rooms={ROOMS} />);
    const t = text(html);
    expect(t).toContain(ROOMS_COPY.title);
    expect(t).toContain(ROOMS_COPY.lead);
    expect(t).toContain("Nueva sala");
    expect(t).toContain("Consultorio 2");
    expect(t).toContain("Consultorio · 1 profesional a la vez");
    expect(t).toContain("Gimnasio · hasta 8 profesionales a la vez");
    expect(t).toContain("Sin franjas asignadas");
    expect(t).toContain("1 franja asignada");
    expect(t).toContain("3 franjas asignadas");
    // Orden: sortOrder, no el del array.
    expect(t.indexOf("Consultorio 1")).toBeLessThan(t.indexOf("Consultorio 2"));
    expect(t.indexOf("Consultorio 2")).toBeLessThan(t.indexOf("Gimnasio ·"));
    // Ni la archivada (va plegada) ni la de otra sede.
    expect(t).not.toContain("Box viejo");
    expect(t).not.toContain("De otra sede");
  });

  it("Subir/Bajar con aria que nombra la sala; la primera no sube y la última no baja", () => {
    const html = render(<RoomsSection locationId="loc-1" locationName="Centro" rooms={ROOMS} />);
    expect(html).toContain('aria-label="Subir Consultorio 2"');
    expect(html).toContain('aria-label="Bajar Consultorio 2"');
    expect(html).not.toContain('aria-label="Subir Consultorio 1"');
    expect(html).not.toContain('aria-label="Bajar Gimnasio"');
    expect(html).toContain('aria-label="Archivar Consultorio 2"');
  });

  it("estado vacío con su copy", () => {
    const html = render(<RoomsSection locationId="loc-9" locationName="Norte" rooms={ROOMS} />);
    expect(text(html)).toContain(
      "Esta sede todavía no tiene salas. Cargalas si querés saber quién atiende dónde."
    );
    expect(text(html)).not.toContain("Ver archivadas");
  });

  it("'Ver archivadas (N)' plegado solo si la sede tiene archivadas", () => {
    const html = render(<RoomsSection locationId="loc-1" locationName="Centro" rooms={ROOMS} />);
    expect(text(html)).toContain("Ver archivadas (1)");
    expect(html).toMatch(/aria-expanded="false"[^>]*>Ver archivadas/);
    const sinArch = render(
      <RoomsSection locationId="loc-1" locationName="Centro" rooms={ROOMS.filter((r) => r.active)} />
    );
    expect(text(sinArch)).not.toContain("archivadas");
  });

  it("roomsOfLocation separa activas y archivadas de esa sede, por (sortOrder, nombre)", () => {
    const { active, archived } = roomsOfLocation(ROOMS, "loc-1");
    expect(active.map((r) => r.id)).toEqual(["r1", "r2", "g"]);
    expect(archived.map((r) => r.id)).toEqual(["old"]);
  });

  it("textos de conteo", () => {
    expect(roomScheduleText(0)).toBe("Sin franjas asignadas");
    expect(roomScheduleText(1)).toBe("1 franja asignada");
    expect(roomScheduleText(3)).toBe("3 franjas asignadas");
    expect(roomCountText(0)).toBe("Sin salas");
    expect(roomCountText(1)).toBe("1 sala");
    expect(roomCountText(4)).toBe("4 salas");
  });
});

describe("[SR-U1] Subir/Bajar (sortOrder vía updateRoom)", () => {
  const active = roomsOfLocation(ROOMS, "loc-1").active; // r1(0), r2(1), g(2)

  it("subir intercambia con la anterior y solo parchea lo que cambia", () => {
    expect(moveRoomPatches(active, "r2", -1)).toEqual([
      { id: "r2", sortOrder: 0 },
      { id: "r1", sortOrder: 1 },
    ]);
  });

  it("bajar la última o subir la primera no hace nada", () => {
    expect(moveRoomPatches(active, "g", 1)).toEqual([]);
    expect(moveRoomPatches(active, "r1", -1)).toEqual([]);
    expect(moveRoomPatches(active, "nope", 1)).toEqual([]);
  });

  it("con sortOrder repetidos (o con huecos) renumera 0..n-1 para que el cambio se vea", () => {
    const dup = [
      room({ id: "a", name: "A", sortOrder: 5 }),
      room({ id: "b", name: "B", sortOrder: 5 }),
      room({ id: "c", name: "C", sortOrder: 9 }),
    ];
    expect(moveRoomPatches(dup, "c", -1)).toEqual([
      { id: "a", sortOrder: 0 },
      { id: "c", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });
});

describe("[SR-U1] bloqueos de archivo", () => {
  it("los 3 conteos con su camino, en singular y plural", () => {
    expect(roomArchiveBlockerItems({ activeSchedules: 2, futureBookings: 1, futureExceptions: 3 })).toEqual([
      { n: 2, text: "franjas de horario. Cambiales la sala en Profesionales › Horarios." },
      { n: 1, text: "turno a futuro. Cambiales la sala desde la agenda." },
      { n: 3, text: "días con horario especial. Editalos en Profesionales › Excepciones." },
    ]);
    expect(roomArchiveBlockerItems({ activeSchedules: 1, futureBookings: 0, futureExceptions: 1 })).toEqual([
      { n: 1, text: "franja de horario. Cambiales la sala en Profesionales › Horarios." },
      { n: 1, text: "día con horario especial. Editalos en Profesionales › Excepciones." },
    ]);
  });

  it("render: título y los 3 renglones; sin conteos muestra el error del server", () => {
    const html = render(
      <RoomArchiveBlockers
        error="x"
        blockers={{ activeSchedules: 2, futureBookings: 5, futureExceptions: 1 }}
        onDismiss={() => {}}
      />
    );
    const t = text(html);
    expect(t).toContain("Todavía no se puede archivar. Tiene:");
    expect(t).toContain("2 franjas de horario. Cambiales la sala en Profesionales › Horarios.");
    expect(t).toContain("5 turnos a futuro. Cambiales la sala desde la agenda.");
    expect(t).toContain("1 día con horario especial. Editalos en Profesionales › Excepciones.");
    expect(t).toContain("Entendido");
    const sin = text(render(<RoomArchiveBlockers error="No pudimos archivar la sala." onDismiss={() => {}} />));
    expect(sin).toContain("No pudimos archivar la sala.");
    expect(sin).not.toContain("Tiene:");
  });
});

describe("[SR-U1] form de sala", () => {
  it("campos en orden: Nombre, Tipo, Profesionales a la vez (con su ayuda); alta con defaults", () => {
    const html = render(<RoomForm draft={emptyRoomDraft()} errors={{}} />);
    const t = text(html);
    const iName = t.indexOf("Nombre");
    const iKind = t.indexOf("Tipo");
    const iCap = t.indexOf(ROOM_CAPACITY_LABEL);
    expect(iName).toBeGreaterThan(-1);
    expect(iName).toBeLessThan(iKind);
    expect(iKind).toBeLessThan(iCap);
    expect(t).toContain(ROOM_CAPACITY_HELP);
    expect(html).toContain('placeholder="Ej.: Consultorio 2"');
    for (const k of ["Consultorio", "Box", "Gimnasio", "Sala"]) expect(html).toContain(`>${k}</option>`);
    expect(html).toMatch(/name="capacity"[^>]*value="1"|value="1"[^>]*name="capacity"/);
    expect(html).toMatch(/min="1"/);
    expect(html).toMatch(/max="50"/);
    // "Pacientes a la vez" del relevamiento quedó reemplazado por §17.5.
    expect(t).not.toContain("Pacientes a la vez");
  });

  it("edición precarga la sala y muestra el error de nombre tomado en el campo", () => {
    const d = roomDraftFromRow(room({ id: "g", name: "Gimnasio", kind: "GIMNASIO", capacity: 8 }));
    expect(d).toEqual({ name: "Gimnasio", kind: "GIMNASIO", capacity: "8" });
    const html = render(
      <RoomForm draft={d} errors={{ name: "Ya hay una sala activa con ese nombre en esta sede." }} />
    );
    expect(html).toContain('value="Gimnasio"');
    expect(html).toMatch(/<option value="GIMNASIO"[^>]*selected=""/);
    expect(html).not.toMatch(/<option value="CONSULTORIO"[^>]*selected=""/);
    expect(text(html)).toContain("Ya hay una sala activa con ese nombre en esta sede.");
  });
});

describe("[SR-U1] validación pura del borrador", () => {
  const ok = { name: "Consultorio 2", kind: "CONSULTORIO" as const, capacity: "1" };

  it("borrador válido → sin errores; el payload pasa el zod real del server", () => {
    expect(validateRoomDraft(ok)).toEqual({});
    const p = roomDraftToPayload({ ...ok, name: "  Box 1 ", capacity: " 3 " });
    expect(p).toEqual({ name: "Box 1", kind: "CONSULTORIO", capacity: 3 });
    expect(RoomCreate.safeParse({ locationId: "loc-1", ...p }).success).toBe(true);
  });

  it("nombre vacío o de solo espacios", () => {
    expect(validateRoomDraft({ ...ok, name: "" }).name).toBe("Poné un nombre.");
    expect(validateRoomDraft({ ...ok, name: "   " }).name).toBe("Poné un nombre.");
  });

  it("nombre de más de 60", () => {
    expect(validateRoomDraft({ ...ok, name: "x".repeat(61) }).name).toBe("Máximo 60 caracteres.");
    expect(validateRoomDraft({ ...ok, name: "x".repeat(60) }).name).toBeUndefined();
  });

  it("capacity entera entre 1 y 50", () => {
    const msg = "Tiene que ser un número entero entre 1 y 50.";
    for (const c of ["0", "51", "", "abc", "1.5", "-2"]) {
      expect(validateRoomDraft({ ...ok, capacity: c }).capacity, c).toBe(msg);
    }
    for (const c of ["1", "50", " 8 "]) {
      expect(validateRoomDraft({ ...ok, capacity: c }).capacity, c).toBeUndefined();
    }
  });
});

describe("[SR-U1] LocationsPanel: línea 'N salas' y disclosure", () => {
  const loc = (id: string, name: string, isPrimary = false): LocationRow => ({
      id,
      name,
      isPrimary,
      active: true,
      address: null,
      addressLine2: null,
      city: null,
      province: null,
      postalCode: null,
      phone: null,
      sortOrder: 0,
      scheduleCount: 2,
  });

  it("cada sede activa dice cuántas salas ACTIVAS tiene y ofrece el disclosure cerrado", () => {
    const html = render(
      <LocationsPanel locations={[loc("loc-1", "Centro", true), loc("loc-9", "Norte")]} rooms={ROOMS} />
    );
    const t = text(html);
    expect(t).toContain("2 franjas de horario · 3 salas"); // Centro: 3 activas (la archivada no cuenta)
    expect(t).toContain("2 franjas de horario · Sin salas"); // Norte
    expect(html).toContain('aria-label="Ver salas de Centro"');
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="rooms-of-loc-1"/);
    // Cerrado: la sección (dynamic) no se monta.
    expect(html).not.toContain("rooms-section-dynamic");
  });

  it("sin la prop rooms (compat) muestra 'Sin salas'", () => {
    const t = text(render(<LocationsPanel locations={[loc("loc-1", "Centro", true)]} />));
    expect(t).toContain("Sin salas");
  });
});
