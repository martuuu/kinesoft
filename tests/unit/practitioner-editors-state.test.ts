/**
 * lib/practitioner-editors-state (B3.5 CFG-UI-2) — la lógica pura detrás de
 * los editores de servicios y coberturas por profesional. Lo visual (tabla vs
 * cards, foco, toasts) va por QA manual.
 */
import { describe, it, expect } from "vitest";
import {
  applyBulk,
  draftToInput,
  filterPayers,
  formatLead,
  initialPayerSelection,
  isDraftDirty,
  isPayerSelectionDirty,
  joinLead,
  payerIdsForSave,
  rowToDraft,
  togglePayer,
  type ServiceDraft,
} from "@/lib/practitioner-editors-state";
import {
  PractitionerServiceInput,
  type PractitionerPayerRow,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";

const baseRow: PractitionerServiceRow = {
  serviceId: "svc_1",
  serviceName: "Kinesiología",
  serviceColor: null,
  serviceDurationMin: 45,
  serviceMaxConcurrent: 3,
  serviceOwnerPractitionerId: null,
  hasRow: false,
  enabled: true,
  durationMin: null,
  visibility: "PUBLIC",
  minLeadMinutes: null,
  maxLeadDays: null,
  concurrencyOverride: false,
  maxConcurrent: null,
  notifyOnBooking: false,
};

const draft = (over: Partial<ServiceDraft> = {}): ServiceDraft => ({
  ...rowToDraft(baseRow),
  ...over,
});

describe("rowToDraft / draftToInput", () => {
  it("fila sin overrides → todo hereda (null), y el server acepta el payload", () => {
    const r = draftToInput(rowToDraft(baseRow));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toEqual({
      enabled: true,
      durationMin: null,
      visibility: "PUBLIC",
      minLeadMinutes: null,
      maxLeadDays: null,
      concurrencyOverride: false,
      maxConcurrent: null,
      notifyOnBooking: false,
    });
    const parsed = PractitionerServiceInput.parse(r.input);
    expect(parsed.durationMin).toBeNull();
    expect(parsed.maxConcurrent).toBeNull();
  });

  it("ida y vuelta de una fila con overrides conserva los valores", () => {
    const row: PractitionerServiceRow = {
      ...baseRow,
      hasRow: true,
      durationMin: 60,
      visibility: "PRIVATE",
      minLeadMinutes: 150,
      maxLeadDays: 30,
      concurrencyOverride: true,
      maxConcurrent: 2,
      notifyOnBooking: true,
    };
    const d = rowToDraft(row);
    expect(d.leadHours).toBe("2");
    expect(d.leadMinutes).toBe("30");
    const r = draftToInput(d);
    expect(r.ok && r.input).toMatchObject({
      durationMin: 60,
      visibility: "PRIVATE",
      minLeadMinutes: 150,
      maxLeadDays: 30,
      concurrencyOverride: true,
      maxConcurrent: 2,
      notifyOnBooking: true,
    });
  });

  it("override con «sin límite» → maxConcurrent null (ilimitado)", () => {
    const row = { ...baseRow, concurrencyOverride: true, maxConcurrent: null };
    const d = rowToDraft(row);
    expect(d.concurrencyUnlimited).toBe(true);
    const r = draftToInput(d);
    expect(r.ok && r.input.maxConcurrent).toBeNull();
    expect(r.ok && r.input.concurrencyOverride).toBe(true);
  });

  it("override apagado no manda el número del input (sin cupo fantasma)", () => {
    const r = draftToInput(draft({ concurrencyOverride: false, maxConcurrent: "7" }));
    expect(r.ok && r.input.maxConcurrent).toBeNull();
  });

  it("sin override, el input del cupo arranca con el cupo del servicio", () => {
    expect(rowToDraft(baseRow).maxConcurrent).toBe("3");
  });

  it.each([
    ["3", "Entre 5 y 480 minutos."],
    ["485", "Entre 5 y 480 minutos."],
    ["47", "Va de a 5 minutos."],
    ["4.5", "Poné minutos enteros."],
    ["-5", "Poné minutos enteros."],
  ])("duración %s → error", (v, msg) => {
    const r = draftToInput(draft({ durationMin: v }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.durationMin).toBe(msg);
  });

  it("duración en los bordes (5 y 480) es válida", () => {
    expect(draftToInput(draft({ durationMin: "5" })).ok).toBe(true);
    expect(draftToInput(draft({ durationMin: "480" })).ok).toBe(true);
  });

  it("anticipación: minutos > 59, basura y más de 30 días → error", () => {
    const a = draftToInput(draft({ leadHours: "1", leadMinutes: "75" }));
    expect(!a.ok && a.errors.minLead).toBe("Los minutos van de 0 a 59.");
    const b = draftToInput(draft({ leadHours: "x" }));
    expect(!b.ok && b.errors.minLead).toBeTruthy();
    const c = draftToInput(draft({ leadHours: String(30 * 24 + 1) }));
    expect(!c.ok && c.errors.minLead).toBe("Máximo 30 días de anticipación.");
    const ok = draftToInput(draft({ leadHours: String(30 * 24), leadMinutes: "" }));
    expect(ok.ok && ok.input.minLeadMinutes).toBe(30 * 24 * 60);
  });

  it("anticipación 0 h 0 min = 0 (no hereda), vacío = null (hereda)", () => {
    const zero = draftToInput(draft({ leadHours: "0", leadMinutes: "0" }));
    expect(zero.ok && zero.input.minLeadMinutes).toBe(0);
    const empty = draftToInput(draft({ leadHours: "", leadMinutes: "" }));
    expect(empty.ok && empty.input.minLeadMinutes).toBeNull();
  });

  it("horizonte: > 730 días → error; 0 es válido", () => {
    const r = draftToInput(draft({ maxLeadDays: "731" }));
    expect(!r.ok && r.errors.maxLeadDays).toBe("Máximo 730 días.");
    expect(draftToInput(draft({ maxLeadDays: "0" })).ok).toBe(true);
  });

  it("cupo propio: vacío, 0 y > 50 → error", () => {
    const on = { concurrencyOverride: true, concurrencyUnlimited: false };
    const a = draftToInput(draft({ ...on, maxConcurrent: "" }));
    expect(!a.ok && a.errors.maxConcurrent).toBe("Poné un cupo o marcá «Sin límite».");
    const b = draftToInput(draft({ ...on, maxConcurrent: "0" }));
    expect(!b.ok && b.errors.maxConcurrent).toBe("Entre 1 y 50.");
    const c = draftToInput(draft({ ...on, maxConcurrent: "51" }));
    expect(!c.ok && c.errors.maxConcurrent).toBe("Entre 1 y 50.");
  });
});

describe("joinLead / formatLead", () => {
  it("combina horas y minutos; uno vacío cuenta como 0", () => {
    expect(joinLead("2", "")).toBe(120);
    expect(joinLead("", "30")).toBe(30);
    expect(joinLead("", "")).toBeNull();
  });
  it("formatea", () => {
    expect(formatLead(null)).toBe("la del turnero");
    expect(formatLead(45)).toBe("45 min");
    expect(formatLead(120)).toBe("2 h");
    expect(formatLead(150)).toBe("2 h 30 min");
  });
});

describe("isDraftDirty", () => {
  it("escribir y borrar → limpio", () => {
    const base = rowToDraft(baseRow);
    expect(isDraftDirty(draft({ durationMin: "60" }), base)).toBe(true);
    expect(isDraftDirty(draft({ durationMin: "" }), base)).toBe(false);
  });
  it("equivalencias semánticas no ensucian (02 = 2; 1 h = 60 min)", () => {
    const base = draft({ leadHours: "1", leadMinutes: "0" });
    expect(isDraftDirty(draft({ leadHours: "01", leadMinutes: "" }), base)).toBe(false);
    expect(isDraftDirty(draft({ leadHours: "", leadMinutes: "60" }), base)).toBe(true); // 60 min es inválido (>59)
  });
  it("cambiar el número del cupo con el override apagado no ensucia", () => {
    const base = rowToDraft(baseRow);
    expect(isDraftDirty(draft({ maxConcurrent: "9" }), base)).toBe(false);
  });
  it("cada switch ensucia", () => {
    const base = rowToDraft(baseRow);
    expect(isDraftDirty(draft({ enabled: false }), base)).toBe(true);
    expect(isDraftDirty(draft({ visibility: "PRIVATE" }), base)).toBe(true);
    expect(isDraftDirty(draft({ notifyOnBooking: true }), base)).toBe(true);
    expect(isDraftDirty(draft({ concurrencyOverride: true }), base)).toBe(true);
  });
});

describe("coberturas", () => {
  const rows: PractitionerPayerRow[] = [
    { insurerId: "part", name: "Particular", isParticular: true, insurerActive: true, hasRow: true, active: true },
    { insurerId: "osde", name: "O.S.D.E.", isParticular: false, insurerActive: true, hasRow: true, active: true },
    { insurerId: "gal", name: "Galeno", isParticular: false, insurerActive: true, hasRow: false, active: true },
    { insurerId: "ioma", name: "IOMA", isParticular: false, insurerActive: false, hasRow: true, active: false },
    { insurerId: "sm", name: "Swiss Médical", isParticular: false, insurerActive: true, hasRow: true, active: false },
  ];

  it("selección inicial: activas + Particular siempre", () => {
    const withPartOff = rows.map((r) => (r.isParticular ? { ...r, active: false } : r));
    expect([...initialPayerSelection(withPartOff)].sort()).toEqual(["gal", "osde", "part"]);
  });

  it("búsqueda sin acentos ni puntos", () => {
    expect(filterPayers(rows, "osde").map((r) => r.insurerId)).toEqual(["osde"]);
    expect(filterPayers(rows, "medica").map((r) => r.insurerId)).toEqual(["sm"]);
    expect(filterPayers(rows, "  ")).toHaveLength(rows.length);
  });

  it("Ninguna deja solo Particular; Todas marca todo", () => {
    const sel = initialPayerSelection(rows);
    expect([...applyBulk(sel, rows, "none")]).toEqual(["part"]);
    expect([...applyBulk(sel, rows, "all")].sort()).toEqual(["gal", "ioma", "osde", "part", "sm"]);
  });

  it("Todas/Ninguna con búsqueda afecta solo a lo filtrado", () => {
    const sel = initialPayerSelection(rows);
    const next = applyBulk(sel, filterPayers(rows, "osde"), "none");
    expect([...next].sort()).toEqual(["gal", "part"]);
  });

  it("Particular no se puede destildar", () => {
    const sel = initialPayerSelection(rows);
    const part = rows[0];
    expect(togglePayer(sel, part).has("part")).toBe(true);
    expect(togglePayer(sel, rows[1]).has("osde")).toBe(false);
    expect(togglePayer(sel, rows[4]).has("sm")).toBe(true);
  });

  it("payload: siempre incluye Particular y respeta el orden del listado", () => {
    expect(payerIdsForSave(rows, new Set(["sm", "osde"]))).toEqual(["part", "osde", "sm"]);
  });

  it("dirty: tildar y destildar vuelve a limpio; Particular no cuenta", () => {
    const base = initialPayerSelection(rows);
    const t1 = togglePayer(base, rows[4]);
    expect(isPayerSelectionDirty(rows, base, t1)).toBe(true);
    expect(isPayerSelectionDirty(rows, base, togglePayer(t1, rows[4]))).toBe(false);
    const noPart = new Set(base);
    noPart.delete("part");
    expect(isPayerSelectionDirty(rows, base, noPart)).toBe(false);
  });
});
