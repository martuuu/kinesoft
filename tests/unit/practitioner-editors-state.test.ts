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
  inheritedPriceHint,
  isOwnService,
  isOwnServiceDirty,
  ownServiceDraftFrom,
  ownServicesLeft,
  ownServiceToPayload,
  visibleServiceRows,
  type ServiceDraft,
} from "@/lib/practitioner-editors-state";
import { OWN_SERVICES_MAX, SERVICES_COPY } from "@/lib/services-types";
import { ServiceInput } from "@/lib/validation";
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
  priceCents: null,
  servicePriceCents: 0,
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
      // CF3: sin baseline el precio viaja siempre (null = usa el del consultorio).
      priceCents: null,
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

  it("anticipación: minutos > 59, basura y más de 8 semanas → error", () => {
    const a = draftToInput(draft({ leadHours: "1", leadMinutes: "75" }));
    expect(!a.ok && a.errors.minLead).toBe("Los minutos van de 0 a 59.");
    const b = draftToInput(draft({ leadHours: "x" }));
    expect(!b.ok && b.errors.minLead).toBeTruthy();
    // [CF-U4] CF-D8: el tope pasó de 30 días a 8 semanas (= el del consultorio, `PUBLIC_MIN_LEAD_MAX_MINUTES`).
    const c = draftToInput(draft({ leadHours: String(56 * 24 + 1) }));
    expect(!c.ok && c.errors.minLead).toBe("Máximo 8 semanas de anticipación.");
    const ok = draftToInput(draft({ leadHours: String(56 * 24), leadMinutes: "" }));
    expect(ok.ok && ok.input.minLeadMinutes).toBe(56 * 24 * 60);
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

// ─── CF3 · AU-U1: precio por profesional, alcance «self» y servicios propios ─

describe("[CF3-AUU1] precio del profesional en el borrador", () => {
  it("[CF3-AUU1-1] la fila trae el precio; vacío = null y el hint muestra el precio del consultorio", () => {
    const d = rowToDraft({ ...baseRow, priceCents: 1_500_000 });
    expect(d.price).toBe(1_500_000);
    expect(rowToDraft(baseRow).price).toBeNull();
    const hint = inheritedPriceHint({ servicePriceCents: 2_000_000 }, false);
    expect(hint).toContain("precio del consultorio");
    expect(hint).toMatch(/20\.000/);
    expect(inheritedPriceHint({ servicePriceCents: 2_000_000 }, true)).toContain("precio del servicio");
  });

  it("[CF3-AUU1-2] con baseline: precio sin cambios NO viaja (undefined), vaciado viaja null, nuevo viaja el valor", () => {
    const base = rowToDraft({ ...baseRow, priceCents: 1_500_000 });
    const same = draftToInput({ ...base, durationMin: "60" }, base);
    expect(same.ok && "priceCents" in same.input).toBe(false);
    const cleared = draftToInput({ ...base, price: null }, base);
    expect(cleared.ok && cleared.input.priceCents).toBeNull();
    expect(cleared.ok && "priceCents" in cleared.input).toBe(true);
    const changed = draftToInput({ ...base, price: 1_800_000 }, base);
    expect(changed.ok && changed.input.priceCents).toBe(1_800_000);
    // El payload sin precio lo acepta el zod del server y sale `undefined` (= no se toca en la base).
    if (same.ok) expect(PractitionerServiceInput.parse(same.input).priceCents).toBeUndefined();
  });

  it("[CF3-AUU1-3] precio fuera de rango o con decimales de centavo → error por campo, sin viajar", () => {
    const over = draftToInput(draft({ price: 100_000_001 }));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.priceCents).toBeTruthy();
    const neg = draftToInput(draft({ price: -1 }));
    expect(!neg.ok && neg.errors.priceCents).toBeTruthy();
    const frac = draftToInput(draft({ price: 10.5 }));
    expect(!frac.ok && frac.errors.priceCents).toBeTruthy();
    expect(draftToInput(draft({ price: 0 })).ok).toBe(true); // 0 = sesión sin cargo, vale
  });

  it("[CF3-AUU1-4] dirty-guard: cambiar el precio ensucia; volver al valor original limpia", () => {
    const base = rowToDraft({ ...baseRow, priceCents: 1_500_000 });
    expect(isDraftDirty({ ...base, price: 1_600_000 }, base)).toBe(true);
    expect(isDraftDirty({ ...base, price: null }, base)).toBe(true);
    expect(isDraftDirty({ ...base, price: 1_500_000 }, base)).toBe(false);
  });
});

describe("[CF3-AUU1] alcance «self» y servicios propios", () => {
  const rows: PractitionerServiceRow[] = [
    { ...baseRow, serviceId: "shared", serviceOwnerPractitionerId: null },
    { ...baseRow, serviceId: "mine", serviceOwnerPractitionerId: "p1" },
    { ...baseRow, serviceId: "other", serviceOwnerPractitionerId: "p2" },
  ];

  it("[CF3-AUU1-5] «self» oculta los servicios propios de otro profesional; «config» muestra todos", () => {
    expect(visibleServiceRows(rows, "self", "p1").map((r) => r.serviceId)).toEqual(["shared", "mine"]);
    expect(visibleServiceRows(rows, "config", "p1").map((r) => r.serviceId)).toEqual(["shared", "mine", "other"]);
    expect(isOwnService(rows[1], "p1")).toBe(true);
    expect(isOwnService(rows[0], "p1")).toBe(false);
  });

  it("[CF3-AUU1-6] tope de servicios propios: con OWN_SERVICES_MAX no se crea más y el copy es el de SERVICES_COPY", () => {
    expect(ownServicesLeft(rows, "p1")).toEqual({ count: 1, canCreate: true, limitMessage: null });
    const full = Array.from({ length: OWN_SERVICES_MAX }, (_, i) => ({ serviceOwnerPractitionerId: "p1", i }));
    const r = ownServicesLeft(full, "p1");
    expect(r.canCreate).toBe(false);
    expect(r.limitMessage).toBe(SERVICES_COPY.ownLimit);
  });

  it("[CF3-AUU1-7] «Nuevo servicio»: 45 min y 1 por horario por defecto; el payload no lleva practitionerId y lo acepta ServiceInput", () => {
    const d = ownServiceDraftFrom();
    expect(d).toMatchObject({ durationMin: "45", maxConcurrent: "1", priceCents: null, color: null });
    const r = ownServiceToPayload({ ...d, name: "  Osteopatía  ", priceCents: 2_500_000, color: "#A6D8F0" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toEqual({ name: "Osteopatía", durationMin: 45, color: "#A6D8F0", priceCents: 2_500_000, maxConcurrent: "1" });
    expect("practitionerId" in r.payload).toBe(false);
    const parsed = ServiceInput.parse(r.payload);
    expect(parsed.maxConcurrent).toBe(1);
    expect(parsed.priceCents).toBe(2_500_000);
    // Sin precio = $ 0; cupo vacío = sin límite.
    const r0 = ownServiceToPayload({ ...d, name: "X", maxConcurrent: "" });
    expect(r0.ok && r0.payload.priceCents).toBe(0);
    expect(r0.ok && ServiceInput.parse(r0.payload).maxConcurrent).toBeNull();
  });

  it("[CF3-AUU1-8] validación del servicio propio: nombre, duración fuera de grilla, precio y cupo", () => {
    const d = ownServiceDraftFrom();
    const bad = ownServiceToPayload({ ...d, name: " ", durationMin: "40", priceCents: 100_000_001, maxConcurrent: "0" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(["durationMin", "maxConcurrent", "name", "priceCents"]);
    // Al editar un servicio viejo de 40 min, guardarlo sin tocar la duración vale.
    const old = ownServiceDraftFrom({ serviceName: "Viejo", serviceDurationMin: 40, serviceColor: null, servicePriceCents: 0, serviceMaxConcurrent: null });
    expect(ownServiceToPayload({ ...old, name: "Viejo 2" }, old).ok).toBe(true);
    expect(old.maxConcurrent).toBe("");
  });

  it("[CF3-AUU1-9] dirty del formulario propio: espacios del nombre y precio vacío vs 0 no ensucian", () => {
    const base = ownServiceDraftFrom({ serviceName: "Kine", serviceDurationMin: 45, serviceColor: null, servicePriceCents: 0, serviceMaxConcurrent: 1 });
    expect(isOwnServiceDirty({ ...base, name: "Kine " }, base)).toBe(false);
    expect(isOwnServiceDirty({ ...base, priceCents: null }, base)).toBe(false);
    expect(isOwnServiceDirty({ ...base, color: "#A6D8F0" }, base)).toBe(true);
    expect(isOwnServiceDirty({ ...base, durationMin: "60" }, base)).toBe(true);
  });
});
