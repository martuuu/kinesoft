/**
 * [FC-3b] Render estático (`renderToStaticMarkup`, sin DOM) de `DiagnosisField` y `DiagnosisPicker` reales (brief T4
 * §24.7 «Diagnósticos (FC-3b)», Anexo C: orden de grupos; tope 5 y «Hacer principal»; «Crear "{texto}"»; atribución;
 * combobox). Se mockean solo las server actions (red) y `next/dynamic` (sin el runtime de Next el import diferido no
 * se resuelve: el stub deja una marca para afirmar que el picker NO viene en el SSR del campo). La interacción (teclas,
 * qué elige cada fila) está en `diagnosis-picker-logic.test.ts` con el símbolo real.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/dynamic", () => ({
  default: () => () => React.createElement("div", { "data-lazy-diagnosis-picker": "1" }),
}));
vi.mock("@/lib/diagnoses", () => ({
  searchDiagnoses: async () => null,
  getDiagnosisPickerHome: async () => null,
  toggleDiagnosisFavorite: async () => ({ ok: true, data: { favorite: true } }),
  createTenantDiagnosis: async () => ({ ok: false, error: "x" }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { DiagnosisField } from "@/components/fichas/diagnosis-field";
import { DiagnosisPicker, pickerRowStyle, type DiagnosisPickerProps } from "@/components/fichas/diagnosis-picker";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";
import { DIAGNOSIS_COPY, ICD11_SHORT_ATTRIBUTION, type DiagnosisOption, type DiagnosisSearchResult } from "@/lib/diagnoses-types";

const noop = () => {};
const opt = (kind: "icd11" | "tenant" | "kine", id: string, title: string, code: string | null = null, over: Partial<DiagnosisOption> = {}): DiagnosisOption => ({
  ref: { kind, id },
  source: kind,
  code,
  title,
  retired: false,
  favorite: false,
  ...over,
});
const text = (t: string): DiagnosisOption => ({ ref: { kind: "text", text: t }, source: "text", code: null, title: t, retired: false, favorite: false });

/** Título oficial largo (la CIE-11 los tiene así): nunca se acorta. */
const LONG_TITLE =
  "Otros trastornos especificados de los discos intervertebrales de la región lumbar con radiculopatía y afectación de las raíces nerviosas";
const ICD = opt("icd11", "icd-1", LONG_TITLE, "FA80.Y");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** HTML del elemento cuyo atributo `attr` abre en `start` (balanceando ese mismo tag). */
function elementAt(html: string, start: number): string {
  const tag = /^<([a-z]+)/.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error("sin cierre");
}
const listboxOf = (html: string) => elementAt(html, html.lastIndexOf("<", html.indexOf('role="listbox"')));

describe("[FC-3b] DiagnosisField (estático)", () => {
  it("[FC-3b] chips: «Principal» en el primero, «Hacer principal» en el resto, «Quitar» en todos y ★ salvo texto libre", () => {
    const html = renderToStaticMarkup(
      <DiagnosisField id="dx" value={[ICD, opt("tenant", "own-1", "Lumbalgia mecánica", null, { favorite: true }), text("Dolor lumbar")]} onChange={noop} />
    );
    expect(html.match(new RegExp(`>${COPY.principal}<`, "g"))).toHaveLength(1);
    expect(html.indexOf(`>${COPY.principal}<`)).toBeLessThan(html.indexOf(LONG_TITLE));
    expect(html.match(new RegExp(`>${COPY.makePrincipal}<`, "g"))).toHaveLength(2);
    expect(html.match(new RegExp(`>${COPY.remove}<`, "g"))).toHaveLength(3);
    // ★ en CIE-11 (apagada) y en el propio (prendida); el texto libre no tiene.
    expect(html.match(/aria-pressed="(true|false)"/g)).toEqual(['aria-pressed="false"', 'aria-pressed="true"']);
    // [T4-Z ZF3] nombre fijo «Favorito: …» + aria-pressed (antes el nombre cambiaba y contradecía el estado).
    expect(html).toContain(esc("Favorito: Lumbalgia mecánica"));
    expect(html).not.toContain(esc("Favorito: Dolor lumbar"));
    // [T4-Z ZF3] «Quitar» y «Hacer principal» dicen de qué chip son.
    expect(html).toContain(esc(`${COPY.remove}: Lumbalgia mecánica`));
    expect(html).toContain(esc(`${COPY.makePrincipal}: Dolor lumbar`));
  });

  it("[T4-Z ZF3] el tope de 5 se anuncia por una región `status` siempre montada", () => {
    const empty = renderToStaticMarkup(<DiagnosisField id="dx" value={[]} onChange={noop} />);
    expect(empty).toContain('<span role="status" class="k-sr-only"></span>');
    const five = [ICD, opt("tenant", "a", "A1"), opt("tenant", "b", "B1"), opt("kine", "c", "C1"), text("D1")];
    const html = renderToStaticMarkup(<DiagnosisField id="dx" value={five} onChange={noop} />);
    expect(html).toContain(`<span role="status" class="k-sr-only">${COPY.max}</span>`);
  });

  it("[FC-3b] tope 5: con 5 cargados no hay buscador y se dice el máximo", () => {
    const five = [ICD, opt("tenant", "a", "A1"), opt("tenant", "b", "B1"), opt("kine", "c", "C1"), text("D1")];
    const html = renderToStaticMarkup(<DiagnosisField id="dx" value={five} onChange={noop} />);
    expect(html).toContain(COPY.max);
    expect(html).not.toContain(`placeholder="${COPY.searchPlaceholder}"`);
    expect(html).not.toContain("data-lazy-diagnosis-picker");
  });

  it("[FC-3b] el picker NO viene en el SSR del campo: se ve el input estático con el mismo placeholder", () => {
    const html = renderToStaticMarkup(<DiagnosisField id="dx" value={[]} onChange={noop} />);
    expect(html).toContain('id="dx"');
    expect(html).toContain(`placeholder="${COPY.searchPlaceholder}"`);
    expect(html).not.toContain("data-lazy-diagnosis-picker");
    expect(html).not.toContain('role="listbox"');
  });

  it("[FC-3b] retirado: chip «Código no vigente»; ★ solo si ya era favorito (para sacarla)", () => {
    const off = renderToStaticMarkup(<DiagnosisField id="dx" value={[{ ...ICD, retired: true }]} onChange={noop} />);
    expect(off).toContain(COPY.retiredChip);
    expect(off).not.toContain("aria-pressed");
    const on = renderToStaticMarkup(<DiagnosisField id="dx" value={[{ ...ICD, retired: true, favorite: true }]} onChange={noop} />);
    expect(on).toContain('aria-pressed="true"');
  });

  it("[FC-3b] los títulos de la CIE-11 no se acortan: texto completo y wrap, sin ellipsis", () => {
    const html = renderToStaticMarkup(<DiagnosisField id="dx" value={[ICD]} onChange={noop} />);
    expect(html).toContain(LONG_TITLE);
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toMatch(/text-overflow|line-clamp|…/);
  });

  it("[FC-3b] el error del caller se anuncia (role=alert)", () => {
    const html = renderToStaticMarkup(<DiagnosisField id="dx" value={[]} onChange={noop} error={DIAGNOSIS_COPY.retired} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(esc(DIAGNOSIS_COPY.retired));
  });
});

const result = (q: string, over: Partial<DiagnosisSearchResult> = {}): DiagnosisSearchResult => ({
  query: q,
  groups: [
    { source: "icd11", label: "CIE-11 (OMS)", options: [ICD] },
    { source: "kine", label: "Kinesiología", options: [opt("kine", "k1", "Lumbalgia")] },
    { source: "tenant", label: "Propios del consultorio", options: [opt("tenant", "own-1", "Lumbalgia mecánica")] },
  ],
  canCreateOwn: true,
  icdCatalogLoaded: true,
  ...over,
});

function picker(over: Partial<DiagnosisPickerProps> = {}) {
  return renderToStaticMarkup(
    <DiagnosisPicker
      id="dxp"
      ariaLabel={COPY.label}
      selected={[]}
      home={{ favorites: [opt("icd11", "f1", "Lumbago", "ME84", { favorite: true })], recents: [opt("tenant", "r1", "Lumbalgia postural")], icdCatalogLoaded: true }}
      onHomeLoaded={noop}
      onPick={noop}
      onToggleFavorite={noop}
      initialText="lumb"
      initialOpen
      initialResult={result("lumb")}
      {...over}
    />
  );
}

describe("[FC-3b] DiagnosisPicker (diferido)", () => {
  it("[FC-3b] combobox WAI-ARIA: input con role=combobox, aria-expanded, aria-controls → listbox con opciones", () => {
    const html = picker();
    expect(html).toMatch(/<input[^>]*role="combobox"/);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-controls="dxp-list"');
    expect(html).toMatch(/id="dxp-list" role="listbox"/);
    expect(html).toContain('id="dxp-opt-0" role="option"');
    // Los títulos de grupo son de presentación: el lector no los cuenta como opciones.
    expect(html).toMatch(/role="group" aria-labelledby="dxp-grp-favorites"/);
  });

  it("[T4-Z ZF3] opción activa con fondo --sky-100 y filete; región de estado siempre montada; ★ fuera del árbol accesible", () => {
    const html = picker();
    expect(pickerRowStyle(true)).toMatchObject({ background: "var(--sky-100)", boxShadow: "inset 2px 0 0 var(--sky-700)" });
    expect(pickerRowStyle(false)).toMatchObject({ background: "transparent", boxShadow: undefined });
    expect(html).toMatch(/id="dxp-opt-0" role="option" aria-selected="false" class="k-dxp-row"[^>]*background:transparent"/);
    expect(html).toContain('role="status" class="k-sr-only" data-testid="diagnosis-picker-live"');
    expect(html).toMatch(/<button[^>]*class="k-dxp-star"[^>]*aria-hidden="true"[^>]*aria-label="Favorito: Lumbago"/);
    expect(html).toContain("@media (pointer: coarse) { .k-dxp-row { min-height: 44px;");
    expect(html).toMatch(/data-testid="icd-attribution" style="[^"]*color:var\(--navy-500\)/);
  });

  it("[FC-3b] orden de grupos en pantalla: Favoritos · Recientes · Del consultorio · Kinesiología · CIE-11 · pie", () => {
    const html = picker();
    const order = [...html.matchAll(/data-group="([a-z0-9]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["favorites", "recents", "tenant", "kine", "icd11", "footer"]);
  });

  it('[FC-3b] «Crear "{texto}" como diagnóstico propio» y «Usar como texto libre» al final', () => {
    const html = picker();
    const create = html.indexOf(esc(COPY.createOwn("lumb")));
    expect(create).toBeGreaterThan(-1);
    expect(html.indexOf(esc(COPY.asFreeText("lumb")))).toBeGreaterThan(create);
    expect(picker({ initialResult: result("lumb", { canCreateOwn: false }) })).not.toContain(esc(COPY.createOwn("lumb")));
  });

  it("[FC-3b] atribución «CIE-11 © OMS · CC BY-ND 3.0 IGO» visible y FUERA del listbox", () => {
    const html = picker();
    expect(ICD11_SHORT_ATTRIBUTION).toBe("CIE-11 © OMS · CC BY-ND 3.0 IGO");
    expect(html).toContain(esc(ICD11_SHORT_ATTRIBUTION));
    expect(listboxOf(html)).not.toContain(esc(ICD11_SHORT_ATTRIBUTION));
    expect(listboxOf(html)).toContain(LONG_TITLE);
  });

  it("[FC-3b] catálogo CIE-11 vacío → `catalogEmpty` (y no la atribución)", () => {
    const html = picker({ initialResult: result("lumb", { groups: [], icdCatalogLoaded: false }) });
    expect(html).toContain(esc(DIAGNOSIS_COPY.catalogEmpty));
    expect(html).not.toContain(esc(ICD11_SHORT_ATTRIBUTION));
  });

  it("[FC-3b] títulos de la CIE-11 completos, con wrap y sin ellipsis", () => {
    const html = listboxOf(picker());
    expect(html).toContain(LONG_TITLE);
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toMatch(/text-overflow|line-clamp|white-space:nowrap|…/);
  });

  it("[FC-3b] favorito retirado: «Código no vigente · Sacar de favoritos», sin ★ para prender", () => {
    const html = picker({
      initialText: "",
      initialResult: null,
      home: { favorites: [opt("icd11", "old", "Lumbago viejo", "ME00", { favorite: true, retired: true })], recents: [], icdCatalogLoaded: true },
    });
    expect(html).toContain(`${COPY.retiredChip} · ${COPY.favoriteOff}`);
    expect(listboxOf(html)).not.toContain("aria-pressed");
  });

  it("[FC-3b] lo ya elegido no se ofrece", () => {
    const html = picker({ selected: [ICD] });
    expect(listboxOf(html)).not.toContain(LONG_TITLE);
  });

  it("[FC-3b] cerrado: aria-expanded=false y sin listbox", () => {
    const html = picker({ initialOpen: false });
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="listbox"');
  });
});
