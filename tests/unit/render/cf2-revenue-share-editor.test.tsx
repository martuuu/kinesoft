import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * [CF2-PU4] Configuración → Profesionales → «Reparto» (CF2 §29 P.3; decisión 4 + D-CF2-18).
 *
 * Render real (`renderToStaticMarkup`: no hay jsdom, así que el cuerpo se renderiza con los datos ya cargados, que es
 * lo que hace `RevenueShareEditor` después de `listRevenueShares`) y la lógica pura del formulario. Se mockean solo
 * las server actions (red) y `next/navigation`/`next/cache`. Fechas: el archivo corre con TZ=UTC y los instantes se
 * esperan en hora AR (15:40 AR = 18:40Z).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/revenue-share", () => ({
  listRevenueShares: async () => ({ ok: true, data: { rules: [], receivers: [] } }),
  setRevenueShare: async () => ({ ok: true, data: { id: "x" } }),
  endRevenueShare: async () => ({ ok: true, data: null }),
}));
vi.mock("@/lib/practitioner-schedule", () => ({
  setPractitionerBookingCap: async () => ({ ok: true, data: undefined }),
  setPractitionerAgendaRules: async () => ({ ok: true, data: undefined }),
  getPractitionerSchedule: async () => null,
  savePractitionerWeek: async () => ({ ok: true, data: { version: null } }),
  listExceptions: async () => ({ ok: true, data: [] }),
  upsertException: async () => ({ ok: true, data: { id: "x" } }),
  deleteException: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

import {
  RevenueShareEditorBody,
  formatShareInstant,
  isRevenueShareDraftDirty,
  openRuleSentence,
  receiverOptionsFor,
  revenueShareDraftFrom,
  revenueShareFormInput,
  REVENUE_SHARE_EDITOR_COPY,
} from "@/components/configuracion/panels/practitioners/revenue-share-editor";
import { PractitionerPanel } from "@/components/configuracion/panels/practitioners/practitioner-panel";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import {
  REVENUE_SHARE_COPY,
  SHARE_GRAPH_ERROR_COPY,
  type RevenueShareListView,
  type RevenueShareRuleView,
} from "@/lib/revenue-share-types";

const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);

const NOW = new Date("2026-11-02T20:00:00.000Z");
const ALL = { manual: true, online: true, insurer: true } as const;

const rule = (over: Partial<RevenueShareRuleView>): RevenueShareRuleView => ({
  id: "r1",
  giverPractitionerId: "p1",
  giverName: "Juan Gómez",
  receiverPractitionerId: "p2",
  receiverName: "Ana Pérez",
  shareBps: 2000,
  sources: ALL,
  effectiveFrom: "2026-11-02T18:40:00.000Z",
  effectiveTo: null,
  createdByName: "Juan Gómez",
  closedByName: null,
  ...over,
});

const OPEN = rule({});
const OLD = rule({
  id: "r0",
  shareBps: 1250,
  sources: { manual: true, online: false, insurer: false },
  effectiveFrom: "2025-12-01T12:00:00.000Z",
  effectiveTo: "2026-11-02T18:40:00.000Z",
});
const FROM_P3 = rule({
  id: "r9",
  giverPractitionerId: "p3",
  giverName: "Laura Ruiz",
  receiverPractitionerId: "p2",
  receiverName: "Ana Pérez",
  shareBps: 1050,
  sources: { manual: false, online: true, insurer: false },
  effectiveFrom: "2026-10-30T13:05:00.000Z",
});
const RECEIVERS = [
  { practitionerId: "p1", name: "Juan Gómez" },
  { practitionerId: "p2", name: "Ana Pérez" },
  { practitionerId: "p3", name: "Laura Ruiz" },
];
const DATA: RevenueShareListView = { rules: [OPEN, FROM_P3, OLD], receivers: RECEIVERS };

const body = (practitionerId: string, data: RevenueShareListView, extra: { readOnly?: boolean } = {}) =>
  wrap(
    <RevenueShareEditorBody
      practitionerId={practitionerId}
      practitionerName={RECEIVERS.find((r) => r.practitionerId === practitionerId)?.name ?? "X"}
      data={data}
      onReload={() => {}}
      now={NOW}
      {...extra}
    />
  );

describe("[CF2-PU4] formulario del reparto (puro)", () => {
  it("[CF2-PU4-1] fechas en hora AR (TZ=UTC del host no importa) y con año solo si no es el de hoy", () => {
    expect(formatShareInstant("2026-11-02T18:40:00.000Z", NOW)).toBe("02/11 15:40");
    // 01:30Z del 3/11 = 22:30 AR del 2/11: el día es el de AR, no el UTC.
    expect(formatShareInstant("2026-11-03T01:30:00.000Z", NOW)).toBe("02/11 22:30");
    expect(formatShareInstant("2025-12-01T12:00:00.000Z", NOW)).toBe("01/12/2025 09:00");
    expect(openRuleSentence(OPEN, NOW)).toBe(
      "Destina 20% a Ana Pérez · Copagos cobrados en el consultorio, Cobros online, Obra social · desde 02/11 15:40"
    );
  });

  it("[CF2-PU4-2] borrador: vacío con las 3 fuentes; con vigente, su % para editar y sus fuentes", () => {
    expect(revenueShareDraftFrom(null)).toEqual({ pct: "", receiverId: "", sources: ALL });
    expect(revenueShareDraftFrom(OLD)).toEqual({
      pct: "12,5",
      receiverId: "p2",
      sources: { manual: true, online: false, insurer: false },
    });
  });

  it("[CF2-PU4-3] dirty: el mismo % escrito distinto no cuenta; receptor o fuente sí", () => {
    const base = revenueShareDraftFrom(OPEN);
    expect(isRevenueShareDraftDirty(base, base)).toBe(false);
    expect(isRevenueShareDraftDirty({ ...base, pct: "20,0" }, base)).toBe(false);
    expect(isRevenueShareDraftDirty({ ...base, pct: "20 %" }, base)).toBe(false);
    expect(isRevenueShareDraftDirty({ ...base, pct: "21" }, base)).toBe(true);
    expect(isRevenueShareDraftDirty({ ...base, pct: "abc" }, base)).toBe(true);
    expect(isRevenueShareDraftDirty({ ...base, receiverId: "p3" }, base)).toBe(true);
    expect(isRevenueShareDraftDirty({ ...base, sources: { ...ALL, insurer: false } }, base)).toBe(true);
  });

  it("[CF2-PU4-4] % inválido, sin receptor y sin fuentes → cada error en su campo", () => {
    const r = revenueShareFormInput(
      { pct: "100,5", receiverId: "", sources: { manual: false, online: false, insurer: false } },
      { giverPractitionerId: "p3", rules: [] }
    );
    expect(r).toEqual({
      ok: false,
      errors: [
        { field: "pct", error: REVENUE_SHARE_COPY.invalidPct },
        { field: "receiver", error: REVENUE_SHARE_EDITOR_COPY.noReceiver },
        { field: "sources", error: REVENUE_SHARE_COPY.noSources },
      ],
    });
    for (const pct of ["", "0", "-5", "12,345", "1.000"]) {
      const bad = revenueShareFormInput({ pct, receiverId: "p1", sources: ALL }, { giverPractitionerId: "p3", rules: [] });
      expect(bad.ok, pct).toBe(false);
    }
  });

  it("[CF2-PU4-5] grafo (D-CF2-18): mutuo y cadena se frenan antes de mandar", () => {
    const sources = ALL;
    // p2 recibe de p1: no puede destinarle a p1 (mutuo) ni a p3 (cadena: ya recibe).
    expect(revenueShareFormInput({ pct: "10", receiverId: "p1", sources }, { giverPractitionerId: "p2", rules: [OPEN] })).toEqual({
      ok: false,
      errors: [{ field: "receiver", error: SHARE_GRAPH_ERROR_COPY.mutual }],
    });
    expect(revenueShareFormInput({ pct: "10", receiverId: "p3", sources }, { giverPractitionerId: "p2", rules: [OPEN] })).toEqual({
      ok: false,
      errors: [{ field: "form", error: SHARE_GRAPH_ERROR_COPY.giverReceives }],
    });
    // p3 → p1, pero p1 ya destina a p2: cadena por el receptor.
    expect(revenueShareFormInput({ pct: "10", receiverId: "p1", sources }, { giverPractitionerId: "p3", rules: [OPEN] })).toEqual({
      ok: false,
      errors: [{ field: "receiver", error: SHARE_GRAPH_ERROR_COPY.receiverGives }],
    });
    expect(revenueShareFormInput({ pct: "10", receiverId: "p3", sources }, { giverPractitionerId: "p3", rules: [] })).toEqual({
      ok: false,
      errors: [{ field: "receiver", error: SHARE_GRAPH_ERROR_COPY.self }],
    });
  });

  it("[CF2-PU4-6] válido: payload de `SetRevenueShareSchema` con el CAS de la vigente (o null)", () => {
    const sources = { manual: true, online: false, insurer: true };
    expect(
      revenueShareFormInput({ pct: " 15,5 ", receiverId: "p3", sources }, { giverPractitionerId: "p1", rules: [OPEN, OLD] })
    ).toEqual({
      ok: true,
      input: { giverPractitionerId: "p1", receiverPractitionerId: "p3", sharePct: "15,5", sources, expectedOpenId: "r1" },
    });
    const first = revenueShareFormInput({ pct: "20", receiverId: "p1", sources }, { giverPractitionerId: "p3", rules: [] });
    expect(first.ok && first.input.expectedOpenId).toBe(null);
  });

  it("[CF2-PU4-7] receptores: sin él mismo; la vigente con un receptor que ya no puede recibir se mantiene", () => {
    expect(receiverOptionsFor(RECEIVERS, "p1", null).map((o) => o.practitionerId)).toEqual(["p2", "p3"]);
    const gone = rule({ receiverPractitionerId: "p9", receiverName: "Ex Colega" });
    expect(receiverOptionsFor(RECEIVERS, "p1", gone).at(-1)).toEqual({
      practitionerId: "p9",
      name: "Ex Colega",
      unavailable: true,
    });
  });
});

describe("[CF2-PU4] RevenueShareEditorBody", () => {
  it("[CF2-PU4-8] con vigente: la frase, el formulario cargado, «Dejar de destinar» e historial", () => {
    const h = body("p1", DATA);
    const t = text(h);
    expect(h).toContain("data-revenue-share-editor");
    expect(t).toContain(
      "Destina 20% a Ana Pérez · Copagos cobrados en el consultorio, Cobros online, Obra social · desde 02/11 15:40"
    );
    expect(h).toMatch(/<input[^>]*type="text"[^>]*inputMode="decimal"[^>]*value="20"/);
    // El select: sin él mismo (p1), con p2 elegido.
    const select = h.match(/<select[^>]*>[\s\S]*?<\/select>/)?.[0] ?? "";
    expect(select).not.toContain('value="p1"');
    expect(select).toMatch(/<option value="p2" selected="">Ana Pérez<\/option>/);
    // Fuentes con fieldset/legend y las 3 casillas.
    expect(h).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Sobre qué cobros<\/legend>/);
    expect((h.match(/type="checkbox"/g) ?? []).length).toBe(3);
    expect(t).toContain("Dejar de destinar");
    expect(t).toContain("Guardar desde ahora");
    // Historial: vigente arriba, la cerrada con su intervalo (con año, es de 2025).
    expect(h).toContain("data-rs-history");
    expect(t).toContain("12,5% a Ana Pérez · Copagos cobrados en el consultorio");
    expect(t).toContain("del 01/12/2025 09:00 al 02/11 15:40");
    expect(t).toContain("Vigente");
    // Los labels apuntan a sus controles.
    expect(h).toContain('for="rs-p1-pct"');
    expect(h).toContain('id="rs-p1-pct"');
    expect(h).toContain('for="rs-p1-receiver"');
  });

  it("[CF2-PU4-9] el que recibe: «Recibe de» de solo lectura y sin formulario (no puede destinar)", () => {
    const h = body("p2", DATA);
    const t = text(h);
    expect(t).toContain("No destina un porcentaje a nadie.");
    expect(h).toContain("data-rs-received");
    expect(t).toContain("Juan Gómez le destina 20% · Copagos cobrados en el consultorio, Cobros online, Obra social · desde 02/11 15:40");
    expect(t).toContain("Laura Ruiz le destina 10,5% · Cobros online · desde 30/10 10:05");
    expect(h).not.toContain("data-rs-form");
    expect(t).toContain(SHARE_GRAPH_ERROR_COPY.giverReceives);
  });

  it("[CF2-PU4-10] sin reglas: formulario vacío, las 3 fuentes marcadas, sin «Dejar de destinar» ni historial", () => {
    const h = body("p3", { rules: [], receivers: RECEIVERS });
    const t = text(h);
    expect(h).toContain("data-rs-form");
    expect((h.match(/type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(3);
    expect(t).not.toContain("Dejar de destinar");
    expect(h).not.toContain("data-rs-history");
    expect(t).toContain("Nadie le destina un porcentaje.");
    // Sin cambios, el botón de guardar arranca deshabilitado.
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Guardar desde ahora/);
  });

  it("[CF2-PU4-11] único profesional: no hay a quién destinar; soporte (readOnly) ve sin formulario", () => {
    expect(text(body("p1", { rules: [], receivers: [RECEIVERS[0]] }))).toContain(
      "No hay otro profesional activo del consultorio que pueda recibir."
    );
    const ro = body("p1", DATA, { readOnly: true });
    expect(ro).not.toContain("data-rs-form");
    expect(text(ro)).toContain("Destina 20% a Ana Pérez");
    expect(ro).toContain("data-rs-history");
  });
});

describe("[CF2-PU4] sub-pestaña «Reparto» en el panel", () => {
  const ROW = {
    practitionerId: "p1",
    name: "Juan Gómez",
    summary: "Lun-Vie 08:00-19:00",
    isFallback: false,
    rangeCount: 5,
    locationIds: [],
  };

  it("[CF2-PU4-12] solo con `tenant.sensitive`", () => {
    expect(tabs(wrap(<PractitionerPanel summary={[ROW]} locations={[]} />))).not.toContain("Reparto");
    expect(tabs(wrap(<PractitionerPanel summary={[ROW]} locations={[]} sensitive={false} />))).not.toContain("Reparto");
    expect(tabs(wrap(<PractitionerPanel summary={[ROW]} locations={[]} sensitive />))).toContain("Reparto");
  });
});
