/**
 * [FC-3b] Lógica pura del selector de diagnósticos (`components/fichas/diagnosis-picker-logic.ts`, brief T4 §24.7
 * «Diagnósticos (FC-3b)», Anexo C): orden de grupos; tope 5 y «Hacer principal»; «Crear "{texto}"»; combobox
 * (navegación por teclado); `snapshotToOption` que marca `retired` (handoff de FC-3k/FC-2a) y el favorito retirado
 * que solo sirve para sacarle la ★ (handoff de FC-2c).
 *
 * Por qué en un módulo puro: los render tests del repo son `renderToStaticMarkup` en node (sin DOM), así que lo que
 * decide QUÉ se ve y QUÉ hace cada tecla vive acá y se testea con el símbolo real; el componente solo lo pinta.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSES_MAX,
  DIAGNOSIS_COPY,
  type DiagnosisOption,
  type DiagnosisPickerHome,
  type DiagnosisSearchResult,
  type DiagnosisSnapshot,
} from "@/lib/diagnoses-types";
import {
  addDiagnosis,
  applyFavorite,
  buildPickerModel,
  diagnosisOptionKey,
  makePrincipal,
  nextActiveIndex,
  removeDiagnosis,
  snapshotToOption,
} from "@/components/fichas/diagnosis-picker-logic";

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

const LUMB_ICD = opt("icd11", "icd-1", "Lumbalgia", "ME84.2");
const LUMB_OWN = opt("tenant", "own-1", "Lumbalgia mecánica");
const LUMB_KINE = opt("kine", "kine-1", "Lumbalgia");
const FAV = opt("icd11", "icd-9", "Lumbago con ciática", "ME84.20", { favorite: true });
const REC = opt("tenant", "own-2", "Lumbalgia postural");

const home = (over: Partial<DiagnosisPickerHome> = {}): DiagnosisPickerHome => ({ favorites: [FAV], recents: [REC], icdCatalogLoaded: true, ...over });
const result = (q: string, over: Partial<DiagnosisSearchResult> = {}): DiagnosisSearchResult => ({
  query: q,
  // El server ya los manda en este orden; se desordenan a propósito para fijar que el orden es del modelo.
  groups: [
    { source: "icd11", label: "CIE-11 (OMS)", options: [LUMB_ICD, { ...FAV }] },
    { source: "kine", label: "Kinesiología", options: [LUMB_KINE] },
    { source: "tenant", label: "Propios del consultorio", options: [LUMB_OWN, { ...REC }] },
  ],
  canCreateOwn: true,
  icdCatalogLoaded: true,
  ...over,
});

describe("[FC-3b] orden de grupos", () => {
  it("[FC-3b] Favoritos · Recientes · Del consultorio · Kinesiología · CIE-11, sin repetir ni lo ya elegido", () => {
    const m = buildPickerModel({ text: "lumb", home: home(), result: result("lumb"), selected: [LUMB_KINE] });
    expect(m.groups.map((g) => g.id)).toEqual(["favorites", "recents", "tenant", "icd11"]);
    // FAV y REC aparecen una sola vez (en su grupo de arriba); LUMB_KINE ya está elegido → Kinesiología queda vacía.
    const keys = m.groups.flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
    expect(m.groups.find((g) => g.id === "tenant")!.items.map((i) => i.key)).toEqual(["tenant:own-1"]);
    expect(m.groups.find((g) => g.id === "icd11")!.items.map((i) => i.key)).toEqual(["icd11:icd-1"]);
  });

  it("[FC-3b] con Kinesiología disponible va entre Del consultorio y CIE-11", () => {
    const m = buildPickerModel({ text: "lumb", home: home(), result: result("lumb"), selected: [] });
    expect(m.groups.map((g) => g.id)).toEqual(["favorites", "recents", "tenant", "kine", "icd11"]);
    expect(m.groups.find((g) => g.id === "favorites")!.label).toBe("Favoritos");
    expect(m.groups.find((g) => g.id === "recents")!.label).toBe("Recientes");
  });

  it("[FC-3b] sin texto: solo favoritos y recientes (la portada)", () => {
    const m = buildPickerModel({ text: "", home: home(), result: null, selected: [] });
    expect(m.groups.map((g) => g.id)).toEqual(["favorites", "recents"]);
    expect(m.footer).toEqual([]);
  });

  it("[FC-3b] con texto, favoritos y recientes se filtran con el mismo ranking que el server (sin tildes)", () => {
    const m = buildPickerModel({ text: "ciatica", home: home(), result: null, selected: [] });
    expect(m.groups.map((g) => g.id)).toEqual(["favorites"]);
  });

  it("[FC-3b] un resultado de otra consulta (respuesta vieja) no se mezcla: «Buscando…»", () => {
    const m = buildPickerModel({ text: "lumbalgia", home: home({ favorites: [], recents: [] }), result: result("lu"), selected: [] });
    expect(m.groups).toEqual([]);
    expect(m.status).toBe("searching");
  });

  it("[FC-3b] la lista plana sigue el orden visual: grupos y después el pie", () => {
    const m = buildPickerModel({ text: "lumbalgia", home: home({ favorites: [], recents: [] }), result: result("lumbalgia"), selected: [] });
    expect(m.flat.map((i) => i.key)).toEqual([
      ...m.groups.flatMap((g) => g.items.map((i) => i.key)),
      ...m.footer.map((i) => i.key),
    ]);
    expect(m.flat.at(-1)!.type).toBe("text");
  });
});

describe("[FC-3b] favorito retirado y ★", () => {
  it("[FC-3b] un favorito CIE-11 retirado no se elige: su acción es sacarle la ★", () => {
    const retired = opt("icd11", "icd-old", "Lumbago (versión anterior)", "ME84.9", { favorite: true, retired: true });
    const m = buildPickerModel({ text: "", home: home({ favorites: [retired] }), result: null, selected: [] });
    const item = m.groups[0].items[0];
    expect(item.type === "option" && item.action).toBe("unfavorite");
  });

  it("[FC-3b] applyFavorite prende (arriba de todo) y apaga en la portada", () => {
    const on = applyFavorite(home(), LUMB_ICD, true)!;
    expect(on.favorites.map(diagnosisOptionKey)).toEqual(["icd11:icd-1", "icd11:icd-9"]);
    expect(on.favorites[0].favorite).toBe(true);
    const off = applyFavorite(on, FAV, false)!;
    expect(off.favorites.map(diagnosisOptionKey)).toEqual(["icd11:icd-1"]);
    expect(applyFavorite(null, FAV, true)).toBeNull();
  });

  it("[FC-3b] los overrides de ★ se reflejan en las opciones del modelo", () => {
    const m = buildPickerModel({
      text: "lumbalgia",
      home: home({ favorites: [], recents: [] }),
      result: result("lumbalgia"),
      selected: [],
      favoriteOverrides: new Map([["icd11:icd-1", true]]),
    });
    const icd = m.groups.find((g) => g.id === "icd11")!.items[0];
    expect(icd.type === "option" && icd.option.favorite).toBe(true);
  });
});

describe("[FC-3b] tope 5 y «Hacer principal»", () => {
  const five = [LUMB_ICD, LUMB_OWN, LUMB_KINE, FAV, REC];

  it(`[FC-3b] hasta ${DIAGNOSES_MAX}: el sexto se rechaza con el copy del server`, () => {
    const r = addDiagnosis(five, text("Cervicalgia"));
    expect(r).toEqual({ ok: false, error: DIAGNOSIS_COPY.tooMany });
    const ok = addDiagnosis(five.slice(0, 4), text("Cervicalgia"));
    expect(ok.ok && ok.next.length).toBe(5);
  });

  it("[FC-3b] el mismo diagnóstico dos veces no se duplica (texto libre sin distinguir tildes ni mayúsculas)", () => {
    const r = addDiagnosis([text("Cervicalgía")], text("  cervicalgia "));
    expect(r.ok && r.next.length).toBe(1);
  });

  it("[FC-3b] un CIE-11 retirado no se agrega", () => {
    expect(addDiagnosis([], { ...LUMB_ICD, retired: true })).toEqual({ ok: false, error: DIAGNOSIS_COPY.retired });
  });

  it("[FC-3b] «Hacer principal» lo pasa primero y conserva el orden del resto; «Quitar» lo saca", () => {
    expect(makePrincipal(five, 3).map(diagnosisOptionKey)).toEqual(["icd11:icd-9", "icd11:icd-1", "tenant:own-1", "kine:kine-1", "tenant:own-2"]);
    expect(makePrincipal(five, 0)).toEqual(five);
    expect(removeDiagnosis(five, 0).map(diagnosisOptionKey)[0]).toBe("tenant:own-1");
  });
});

describe('[FC-3b] «Crear "{texto}"»', () => {
  it("[FC-3b] con permiso y texto válido: «Crear» y «Usar como texto libre», en ese orden, al final", () => {
    const m = buildPickerModel({ text: "Síndrome X", home: null, result: result("Síndrome X", { groups: [] }), selected: [] });
    expect(m.footer.map((i) => i.type)).toEqual(["create", "text"]);
    expect(m.footer[0].type === "create" && m.footer[0].text).toBe("Síndrome X");
    expect(m.status).toBe("no-results");
  });

  it("[FC-3b] sin permiso de crear: solo texto libre", () => {
    const m = buildPickerModel({ text: "Síndrome X", home: null, result: result("Síndrome X", { groups: [], canCreateOwn: false }), selected: [] });
    expect(m.footer.map((i) => i.type)).toEqual(["text"]);
  });

  it("[FC-3b] si ya hay un propio con ese nombre no se ofrece crearlo (el server lo rechazaría)", () => {
    const m = buildPickerModel({ text: "lumbalgia MECANICA", home: null, result: result("lumbalgia MECANICA"), selected: [] });
    expect(m.footer.map((i) => i.type)).toEqual(["text"]);
  });

  it("[FC-3b] menos de 2 o más de 120 caracteres: sin pie", () => {
    expect(buildPickerModel({ text: "a", home: null, result: null, selected: [] }).footer).toEqual([]);
    expect(buildPickerModel({ text: "x".repeat(121), home: null, result: null, selected: [] }).footer).toEqual([]);
  });

  it("[FC-3b] el texto libre ya elegido no se vuelve a ofrecer", () => {
    const m = buildPickerModel({ text: "Cervicalgia", home: null, result: result("Cervicalgia", { groups: [], canCreateOwn: false }), selected: [text("cervicalgia")] });
    expect(m.footer).toEqual([]);
  });
});

describe("[FC-3b] combobox", () => {
  it("[FC-3b] flechas con vuelta, Home/End, sin opciones → -1", () => {
    expect(nextActiveIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextActiveIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextActiveIndex(-1, "ArrowUp", 3)).toBe(2);
    expect(nextActiveIndex(1, "Home", 3)).toBe(0);
    expect(nextActiveIndex(1, "End", 3)).toBe(2);
    expect(nextActiveIndex(1, "ArrowDown", 0)).toBe(-1);
  });

  it("[FC-3b] catálogo CIE-11 vacío: el modelo lo dice (el componente muestra `catalogEmpty`)", () => {
    const m = buildPickerModel({ text: "", home: home({ icdCatalogLoaded: false }), result: null, selected: [] });
    expect(m.icdCatalogLoaded).toBe(false);
    const m2 = buildPickerModel({ text: "lumb", home: home(), result: result("lumb", { icdCatalogLoaded: false }), selected: [] });
    expect(m2.icdCatalogLoaded).toBe(false);
  });
});

describe("[FC-3b] snapshotToOption", () => {
  const snap = (over: Partial<DiagnosisSnapshot>): DiagnosisSnapshot => ({
    v: 1,
    source: "icd11",
    refId: "icd-1",
    code: "ME84.2",
    title: "Lumbalgia",
    uri: "http://id.who.int/icd/release/11/mms/1",
    release: "2025-01",
    ...over,
  });

  it("[FC-3b] marca `retired` si el id está entre los retirados; si no, false", () => {
    expect(snapshotToOption(snap({}), { retiredRefIds: new Set(["icd-1"]) }).retired).toBe(true);
    expect(snapshotToOption(snap({})).retired).toBe(false);
    expect(snapshotToOption(snap({}))).toEqual({ ref: { kind: "icd11", id: "icd-1" }, source: "icd11", code: "ME84.2", title: "Lumbalgia", retired: false, favorite: false });
  });

  it("[FC-3b] texto libre o sin refId → ref de texto (el server lo re-congela igual)", () => {
    expect(snapshotToOption(snap({ source: "text", refId: null, code: null, title: "Dolor" })).ref).toEqual({ kind: "text", text: "Dolor" });
    expect(snapshotToOption(snap({ source: "tenant", refId: null })).ref).toEqual({ kind: "text", text: "Lumbalgia" });
  });

  it("[FC-3b] un propio o de Kinesiología nunca sale retirado (el set es de CIE-11)", () => {
    expect(snapshotToOption(snap({ source: "tenant", refId: "icd-1" }), { retiredRefIds: new Set(["icd-1"]) }).retired).toBe(false);
  });

  it("[FC-3b] marca la ★ con las claves de favoritos", () => {
    expect(snapshotToOption(snap({}), { favoriteKeys: new Set(["icd11:icd-1"]) }).favorite).toBe(true);
  });
});
