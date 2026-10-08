/**
 * SR-U3: filtro de sala (radiogroup de selección única) y toggle de modo con N
 * opciones. Render sin jsdom (`renderToStaticMarkup`); las flechas se prueban
 * con el helper puro `nextRadioValue` (tests/unit/agenda-client-state.test.ts)
 * y acá se afirma lo que el teclado necesita en el DOM: un solo `tabIndex=0`
 * (roving tabindex) y `data-*` para enfocar el siguiente.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomFilter } from "@/components/agenda/room-filter";
import { AGENDA_MODE_OPTIONS, ModeToggle } from "@/components/agenda/mode-toggle";
import type { RoomOption } from "@/lib/rooms-types";

const r = (id: string, name: string, over: Partial<RoomOption> = {}): RoomOption => ({
  id,
  locationId: "L1",
  name,
  kind: "CONSULTORIO",
  capacity: 1,
  ...over,
});
const noop = () => {};
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RoomFilter", () => {
  it("con 0 o 1 sala no dibuja nada (sin salas = agenda de hoy)", () => {
    expect(renderToStaticMarkup(<RoomFilter rooms={[]} value={null} onChange={noop} />)).toBe("");
    expect(renderToStaticMarkup(<RoomFilter rooms={[r("R1", "Consultorio 1")]} value={null} onChange={noop} />)).toBe("");
  });

  it("con 2+ salas: radiogroup con Todas, cada sala y Sin sala", () => {
    const html = renderToStaticMarkup(
      <RoomFilter rooms={[r("R1", "Consultorio 1"), r("R2", "Gimnasio", { kind: "GIMNASIO" })]} value={null} onChange={noop} />
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Filtrar por sala"');
    expect(count(html, 'role="radio"')).toBe(4);
    const iTodas = html.indexOf("Todas las salas");
    const iR1 = html.indexOf("Consultorio 1");
    const iR2 = html.indexOf("Gimnasio");
    const iNone = html.indexOf("Sin sala");
    expect(iTodas).toBeGreaterThan(-1);
    expect(iTodas < iR1 && iR1 < iR2 && iR2 < iNone).toBe(true);
    // "Todas" marcada y única tabulable
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*data-room="all"/);
    expect(count(html, 'tabindex="0"')).toBe(1);
  });

  it("valor elegido: esa sala marcada; none = Sin sala", () => {
    const rooms = [r("R1", "Consultorio 1"), r("R2", "Consultorio 2")];
    const h1 = renderToStaticMarkup(<RoomFilter rooms={rooms} value="R2" onChange={noop} />);
    expect(h1).toMatch(/aria-checked="true" tabindex="0"[^>]*data-room="R2"/);
    expect(count(h1, 'aria-checked="true"')).toBe(1);
    expect(h1).toMatch(/aria-checked="false" tabindex="-1"[^>]*data-room="all"/);
    const hn = renderToStaticMarkup(<RoomFilter rooms={rooms} value="none" onChange={noop} />);
    expect(count(hn, 'aria-checked="true"')).toBe(1);
    expect(hn).toMatch(/aria-checked="true" tabindex="0"[^>]*data-room="none"/);
  });

  it("un valor que no está en la lista (sala ajena/archivada) se ve como Todas", () => {
    const html = renderToStaticMarkup(
      <RoomFilter rooms={[r("R1", "A"), r("R2", "B")]} value="R9" onChange={noop} />
    );
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*data-room="all"/);
  });

  it("conteos opcionales: en el texto y en el aria", () => {
    const rooms = [r("R1", "Consultorio 1"), r("R2", "Gimnasio")];
    const sin = renderToStaticMarkup(<RoomFilter rooms={rooms} value={null} onChange={noop} />);
    expect(sin).not.toContain("turno");
    const con = renderToStaticMarkup(
      <RoomFilter rooms={rooms} value={null} onChange={noop} counts={{ R1: 3, R2: 1, none: 0 }} />
    );
    expect(con).toContain('aria-label="Consultorio 1, 3 turnos"');
    expect(con).toContain('aria-label="Gimnasio, 1 turno"');
    expect(con).toContain('aria-label="Sin sala, 0 turnos"');
    expect(con).toContain('aria-label="Todas las salas, 4 turnos"');
  });

  it("[SRZ-FX2a B1] 'Todas las salas' muestra el total real (`total`), no la suma de las opciones", () => {
    // Con "Todas las sedes" hay turnos en salas de otra sede (o de una sala
    // archivada hoy) que no tienen opción propia: igual están en pantalla.
    const rooms = [r("R1", "Consultorio 1"), r("R2", "Gimnasio")];
    const html = renderToStaticMarkup(
      <RoomFilter rooms={rooms} value={null} onChange={noop} counts={{ R1: 3, R2: 1, none: 0 }} total={12} />
    );
    expect(html).toContain('aria-label="Todas las salas, 12 turnos"');
    expect(html).toMatch(/data-room="all"[^>]*>.*?>12<\/span>/);
  });
});

describe("ModeToggle (N opciones)", () => {
  it("sin options: las 2 de siempre (no regresión)", () => {
    const html = renderToStaticMarkup(<ModeToggle mode="day" onChange={noop} />);
    expect(count(html, 'role="radio"')).toBe(2);
    expect(html).toContain("Por día");
    expect(html).toContain("Por profesional");
    expect(html).not.toContain("Por sala");
    expect(count(html, 'tabindex="0"')).toBe(1);
  });

  it('con 3 opciones: "Por sala" con su hint, marcado y tabulable', () => {
    const options = [AGENDA_MODE_OPTIONS.day, AGENDA_MODE_OPTIONS.practitioner, AGENDA_MODE_OPTIONS.room];
    const html = renderToStaticMarkup(<ModeToggle mode="room" options={options} onChange={noop} />);
    expect(count(html, 'role="radio"')).toBe(3);
    expect(html).toContain("Por sala");
    expect(html).toContain('title="Una columna por sala"');
    expect(count(html, 'aria-checked="true"')).toBe(1);
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*data-mode="room"/);
  });

  it("con 2 opciones Día/Sala (un profesional con salas)", () => {
    const html = renderToStaticMarkup(
      <ModeToggle mode="day" options={[AGENDA_MODE_OPTIONS.day, AGENDA_MODE_OPTIONS.room]} onChange={noop} />
    );
    expect(count(html, 'role="radio"')).toBe(2);
    expect(html).not.toContain("Por profesional");
    expect(html).toMatch(/aria-checked="true"[^>]*tabindex="0"[^>]*data-mode="day"/);
  });

  it("modo que no está entre las opciones: el primero queda tabulable (el grupo nunca sale del Tab)", () => {
    const html = renderToStaticMarkup(
      <ModeToggle mode="room" options={[AGENDA_MODE_OPTIONS.day, AGENDA_MODE_OPTIONS.practitioner]} onChange={noop} />
    );
    expect(count(html, 'aria-checked="true"')).toBe(0);
    expect(count(html, 'tabindex="0"')).toBe(1);
    expect(html).toMatch(/tabindex="0"[^>]*data-mode="day"/);
  });
});
