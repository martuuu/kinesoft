/**
 * [CF2-SL] /sala: filtro de sede compartido con la agenda (D-CF2-5, brief A.2).
 *
 * - SL1: paridad del predicado de /sala con `matchesLocation` de la agenda (la regla es una sola).
 * - SL2: el filtro solo existe con ≥2 sedes y una sede guardada que no está = «todas».
 * - SL3: recorte de filas y salas; sin sede, la MISMA referencia (las caras memoizan por identidad).
 * - SL4: guardar la sede va a `updateAgendaViewPrefs({ locationId })` en silencio (la red es lo único mockeado).
 * - SL5: bundle: nada del first load de /sala importa `lib/agenda-client-state.ts` y el selector no entra a él.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateAgendaViewPrefs } = vi.hoisted(() => ({ updateAgendaViewPrefs: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs }));

import { matchesLocation } from "@/lib/agenda-client-state";
import { atSalaLocation, salaLocationScope, scopeSalaRooms, scopeSalaRows } from "@/lib/sala-location-filter";
import { persistSalaLocation, SALA_OTHER_DAY_HREF } from "@/components/sala/sala-location";

const LOCS = [
  { id: "a", name: "Centro", isPrimary: true },
  { id: "b", name: "Norte", isPrimary: false },
];

describe("[CF2-SL1] paridad con matchesLocation", () => {
  it("misma respuesta en toda la grilla turno × filtro × principal", () => {
    const rowValues: Array<string | null | undefined> = [undefined, null, "a", "b"];
    for (const rowLoc of rowValues)
      for (const filter of [null, "a", "b"])
        for (const primary of [null, "a"]) {
          const row = rowLoc === undefined ? {} : { locationId: rowLoc };
          expect(atSalaLocation(row, filter, primary), JSON.stringify({ rowLoc, filter, primary })).toBe(
            matchesLocation(row, filter, primary)
          );
        }
  });
});

describe("[CF2-SL2] alcance", () => {
  it("con 0 o 1 sede no hay filtro", () => {
    expect(salaLocationScope([], "a")).toBeNull();
    expect(salaLocationScope([LOCS[0]], "a")).toBeNull();
  });
  it("con ≥2: la guardada si existe; si no, todas; la principal sale de isPrimary", () => {
    expect(salaLocationScope(LOCS, "b")).toEqual({ locations: LOCS, locationId: "b", primaryLocationId: "a" });
    expect(salaLocationScope(LOCS, "archivada")?.locationId).toBeNull();
    expect(salaLocationScope(LOCS, null)?.locationId).toBeNull();
    expect(salaLocationScope(LOCS.map((l) => ({ ...l, isPrimary: false })), null)?.primaryLocationId).toBeNull();
  });
});

describe("[CF2-SL3] recorte de lo que ven las caras", () => {
  const rows = [
    { id: "1", locationId: null }, // principal (a)
    { id: "2", locationId: "a" },
    { id: "3", locationId: "b" },
    { id: "4" }, // sin el campo: no se esconde
  ];
  it("Norte: sus turnos + los de sede desconocida; Centro: también los null (principal)", () => {
    const norte = salaLocationScope(LOCS, "b");
    expect(scopeSalaRows(rows, norte).map((r) => r.id)).toEqual(["3", "4"]);
    expect(scopeSalaRows(rows, salaLocationScope(LOCS, "a")).map((r) => r.id)).toEqual(["1", "2", "4"]);
  });
  it("sin sede elegida (o una sola sede) devuelve la misma referencia", () => {
    expect(scopeSalaRows(rows, salaLocationScope(LOCS, null))).toBe(rows);
    expect(scopeSalaRows(rows, null)).toBe(rows);
    const rooms = [{ id: "r1", locationId: "a" }];
    expect(scopeSalaRooms(rooms, null)).toBe(rooms);
  });
  it("salas: las de la sede elegida; las sin locationId no se esconden", () => {
    const rooms = [{ id: "r1", locationId: "a" }, { id: "r2", locationId: "b" }, { id: "r3" }];
    expect(scopeSalaRooms(rooms, salaLocationScope(LOCS, "b")).map((r) => r.id)).toEqual(["r2", "r3"]);
  });
});

describe("[CF2-SL4] guardar la sede", () => {
  beforeEach(() => updateAgendaViewPrefs.mockReset());
  it("usa la action de la agenda con { locationId } (null = todas)", async () => {
    updateAgendaViewPrefs.mockResolvedValue({ ok: true, data: {} });
    await persistSalaLocation("b");
    await persistSalaLocation(null);
    expect(updateAgendaViewPrefs.mock.calls).toEqual([[{ locationId: "b" }], [{ locationId: null }]]);
  });
  it("en silencio: ni un ok:false ni un rechazo de red tiran", async () => {
    updateAgendaViewPrefs.mockResolvedValueOnce({ ok: false, error: "x" });
    await expect(persistSalaLocation("b")).resolves.toBeUndefined();
    updateAgendaViewPrefs.mockRejectedValueOnce(new Error("offline"));
    await expect(persistSalaLocation("b")).resolves.toBeUndefined();
  });
  it("«¿Otro día?» va a la Recepción de la agenda", () => {
    expect(SALA_OTHER_DAY_HREF).toBe("/agenda?view=reception");
  });
});

describe("[CF2-SL5] bundle de /sala", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  it("ni el filtro, ni el contexto, ni SalaClient importan el estado de la agenda", () => {
    for (const f of [
      "lib/sala-location-filter.ts",
      "components/sala/sala-location-context.ts",
      "components/sala/sala-location.tsx",
      "components/sala/sala-client.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/from\s+"@\/lib\/agenda-client-state"/);
    }
  });
  it("SalaClient trae solo el contexto: el selector y el link viajan en los chunks de las caras", () => {
    const src = read("components/sala/sala-client.tsx");
    expect(src).toContain('from "./sala-location-context"');
    expect(src).not.toMatch(/from\s+"\.\/sala-location"/);
    expect(read("components/sala/sala-location-context.ts")).not.toMatch(/from\s+"next\/link"/);
  });
  it("el filtro es puro: sin imports de valor", () => {
    expect(read("lib/sala-location-filter.ts")).not.toMatch(/^import\s+(?!type\b)/m);
  });
});
