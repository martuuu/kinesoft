import { describe, it, expect } from "vitest";

/**
 * [PL-3a] Lógica pura de Configuración → Plan y uso / Facturación (lib/saas-billing-view.ts). Corre en TZ=UTC y TZ=AR
 * (`npm test` y `npm run test:tz-ar`): las fechas tienen que dar lo mismo.
 */
import {
  balanceView,
  canReactivate,
  candidateLoadLabel,
  chargeStatusView,
  formatDateKey,
  formatInstantAR,
  moduleLabels,
  paymentStatusView,
  periodLabel,
  planChangeSelectionState,
  planSeatsLabel,
  planStatusView,
  selectableForDisable,
  selectionHint,
  shouldCompressReceipt,
  validateReceiptForm,
  RECEIPT_NOTE_MAX,
} from "@/lib/saas-billing-view";
import type { PlanChangeCandidate, PlanChangePreview } from "@/lib/saas-plan-change-types";
import { seatUsageByKind } from "@/lib/plan-catalog";

function cand(id: string, p: Partial<PlanChangeCandidate> = {}): PlanChangeCandidate {
  return {
    membershipId: id,
    userId: `u-${id}`,
    name: `Persona ${id}`,
    role: "PRACTITIONER",
    clinical: true,
    kind: "professional",
    isOwner: false,
    isSelf: false,
    futureBookings: 0,
    assignedPatients: 0,
    activePlans: 0,
    ...p,
  };
}

/** Clínica → Consultorio con 7 activos (Titular que es quien cambia + 6): sobran 2. */
function downgrade(): PlanChangePreview {
  const candidates = [
    cand("owner", { role: "OWNER", isOwner: true, isSelf: true }),
    cand("p1"),
    cand("p2"),
    cand("p3"),
    cand("p4"),
    cand("s1", { role: "ASSISTANT", clinical: false, kind: "staff" }),
    cand("s2", { role: "ASSISTANT", clinical: false, kind: "staff" }),
  ];
  const limits = { maxUsers: 5, maxProfessionals: null, maxStaff: null };
  return {
    from: "CLINICA",
    to: "CONSULTORIO",
    limits,
    usage: seatUsageByKind({ professional: 5, staff: 2 }, limits),
    mustDisable: { professional: 0, staff: 0, total: 2 },
    candidates,
    invitesToRevoke: [],
    reactivatable: [],
    modulesLost: ["salas", "salaEspera"],
    modulesGained: [],
    priceCents: 2500000,
    tenantUpdatedAt: "2026-10-15T12:00:00.000Z",
  };
}

const S = (...ids: string[]) => new Set(ids);

describe("[PL-3a] cupos y estado", () => {
  it("cupos como los nombra el plan", () => {
    expect(planSeatsLabel("INDIVIDUAL", { used: 1, limit: 1 })).toBe("1 de 1");
    expect(planSeatsLabel("CONSULTORIO", { used: 4, limit: 5 })).toBe("Total 4 de 5");
    expect(planSeatsLabel("CLINICA", { used: 7, limit: 10 })).toBe("Total 7 de 10");
    expect(planSeatsLabel("LIBRE", { used: 23, limit: null })).toBe("23 usuarios · cupo a medida");
    // Libre con override de cupo: se dice como un total.
    expect(planSeatsLabel("LIBRE", { used: 12, limit: 30 })).toBe("Total 12 de 30");
  });

  it("estado: «Activa» se dice «Al día»; el llamado ya no es «escribinos»; modo lectura pinta warn", () => {
    expect(planStatusView({ label: "Activa", tone: "ok", detail: null, contact: null }, false)).toEqual({
      label: "Al día",
      tone: "ok",
      detail: null,
      cta: null,
      readOnly: false,
    });
    const expired = planStatusView({ label: "Prueba terminada", tone: "warn", detail: "La prueba terminó.", contact: "para elegir un plan" }, true);
    expect(expired.cta).toBe("Elegí un plan con «Cambiar de plan».");
    expect(expired.readOnly).toBe(true);
    const pastDue = planStatusView({ label: "Pago pendiente", tone: "warn", detail: "Hay un pago pendiente.", contact: "para regularizarlo" }, false);
    expect(pastDue.cta).toBe("Informá el pago desde Facturación.");
    const trial = planStatusView({ label: "En prueba", tone: "info", detail: "Te quedan 5 días de prueba (hasta el 20 de octubre).", contact: null }, false);
    expect(trial).toMatchObject({ label: "En prueba", tone: "info", cta: null });
  });

  it("módulos visibles sin los que todavía no son pantallas reales", () => {
    expect(moduleLabels(["agenda", "evoluciones", "reportes", "turneroPublico", "salas"])).toEqual(["Agenda", "Salas"]);
  });
});

describe("[PL-3a] cambio de plan: elegir exactamente lo que sobra", () => {
  it("sin elegir a nadie no se puede confirmar; faltan 2", () => {
    const st = planChangeSelectionState(downgrade(), S(), S());
    expect(st.required).toBe(2);
    expect(st.canConfirm).toBe(false);
    expect(selectionHint(st)).toBe("Faltan elegir 2 personas más.");
  });

  it("con 1 elegido falta 1; con 2 entra; con 3 sobra (no deshabilita a alguien que entra)", () => {
    const p = downgrade();
    expect(selectionHint(planChangeSelectionState(p, S("p1"), S()))).toBe("Falta elegir 1 persona más.");
    const ok = planChangeSelectionState(p, S("p1", "s1"), S());
    expect(ok).toMatchObject({ required: 2, selected: 2, fits: true, canConfirm: true });
    expect(selectionHint(ok)).toBeNull();
    const extra = planChangeSelectionState(p, S("p1", "p2", "s1"), S());
    expect(extra.canConfirm).toBe(false);
    expect(extra.extra).toBe(1);
    expect(selectionHint(extra)).toMatch(/Elegiste de más/);
  });

  it("el Titular y uno mismo no se pueden elegir; si llegan igual, no cuenta como válido", () => {
    const p = downgrade();
    expect(selectableForDisable(p.candidates[0])).toBe(false);
    expect(selectableForDisable(cand("x", { isSelf: true }))).toBe(false);
    expect(selectableForDisable(cand("x"))).toBe(true);
    const st = planChangeSelectionState(p, S("owner", "p1"), S());
    expect(st.selected).toBe(1);
    expect(st.canConfirm).toBe(false);
  });

  it("con tope por tipo, elegir del tipo equivocado no entra", () => {
    const p = { ...downgrade(), limits: { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 } };
    // 5 profesionales (Titular incluido) + 2 staff → sobran 1 profesional y 1 staff.
    const wrong = planChangeSelectionState(p, S("p1", "p2"), S());
    expect(wrong.fits).toBe(false);
    expect(selectionHint(wrong)).toBe("Falta elegir 1 persona de recepción o administración más.");
    expect(planChangeSelectionState(p, S("p1", "s2"), S()).canConfirm).toBe(true);
  });

  it("subir: se reactiva solo quien entra; Libre y el mismo plan nunca se confirman", () => {
    const limits = { maxUsers: 10, maxProfessionals: null, maxStaff: null };
    const up: PlanChangePreview = {
      ...downgrade(),
      from: "CONSULTORIO",
      to: "CLINICA",
      limits,
      usage: seatUsageByKind({ professional: 5, staff: 2 }, limits),
      mustDisable: { professional: 0, staff: 0, total: 0 },
      reactivatable: [1, 2, 3, 4].map((n) => ({
        membershipId: `r${n}`,
        name: `Vuelve ${n}`,
        role: "PRACTITIONER" as const,
        clinical: true,
        disabledAt: "2026-09-01T12:00:00.000Z",
      })),
    };
    expect(planChangeSelectionState(up, S(), S()).canConfirm).toBe(true);
    // 7 activos + 3 = 10: el cuarto no entra.
    expect(canReactivate(up, S(), S("r1", "r2"), "r3")).toBe(true);
    expect(canReactivate(up, S(), S("r1", "r2", "r3"), "r4")).toBe(false);
    // Ya tildado: siempre se puede destildar.
    expect(canReactivate(up, S(), S("r1", "r2", "r3"), "r3")).toBe(true);
    expect(planChangeSelectionState(up, S(), S("r1", "r2", "r3")).canConfirm).toBe(true);
    expect(planChangeSelectionState({ ...up, to: "LIBRE" }, S(), S()).canConfirm).toBe(false);
    expect(planChangeSelectionState({ ...up, to: "CONSULTORIO", from: "CONSULTORIO" }, S(), S()).canConfirm).toBe(false);
  });

  it("carga de cada uno, sin PHI", () => {
    expect(candidateLoadLabel({ futureBookings: 1, assignedPatients: 12, activePlans: 0 })).toBe("1 turno próximo · 12 pacientes");
    expect(candidateLoadLabel({ futureBookings: 3, assignedPatients: 1, activePlans: 2 })).toBe("3 turnos próximos · 1 paciente · 2 planes activos");
  });
});

describe("[PL-3a] Facturación: fechas, estados y saldo", () => {
  it("claves civiles sin pasar por el TZ del host", () => {
    expect(formatDateKey("2026-10-01")).toBe("1 oct 2026");
    expect(formatDateKey("nope")).toBe("");
    expect(periodLabel("2026-10-05", "2026-11-04")).toBe("5 oct – 4 nov 2026");
    expect(periodLabel("2026-12-05", "2027-01-04")).toBe("5 dic 2026 – 4 ene 2027");
    // 01:30 UTC del 15 = 22:30 AR del 14.
    expect(formatInstantAR("2026-10-15T01:30:00.000Z")).toBe("14 oct 2026");
  });

  it("estados de cargos y pagos", () => {
    expect(chargeStatusView({ status: "OPEN", overdue: true, paidCents: 0 }).label).toBe("Vencido");
    expect(chargeStatusView({ status: "OPEN", overdue: false, paidCents: 100 }).label).toBe("Pago parcial");
    expect(chargeStatusView({ status: "PAID", overdue: false, paidCents: 100 }).label).toBe("Pagado");
    expect(paymentStatusView("PENDING_REVIEW").label).toBe("En revisión");
    expect(paymentStatusView("REJECTED").label).toBe("Rechazado");
    expect(paymentStatusView("APPROVED").tone).toBe("lime");
  });

  it("saldo", () => {
    const fmt = (c: number) => `$${c / 100}`;
    expect(balanceView(150000, fmt)).toEqual({ label: "Debés $1500", tone: "warn" });
    expect(balanceView(-5000, fmt)).toEqual({ label: "Saldo a favor $50", tone: "ok" });
    expect(balanceView(0, fmt)).toEqual({ label: "Al día", tone: "ok" });
  });
});

describe("[PL-3a] comprobante: validación en el cliente", () => {
  const now = new Date("2026-10-15T02:00:00.000Z"); // 14-oct 23:00 AR
  const pdf = { type: "application/pdf", size: 200_000 };
  const base = { file: pdf, amountCents: 2500000, amountInvalid: false, paidOn: "2026-10-14", note: "" };

  it("un comprobante válido pasa", () => {
    expect(validateReceiptForm(base, now)).toEqual({});
  });

  it("archivo: obligatorio, tipo permitido y ≤ 4 MB", () => {
    expect(validateReceiptForm({ ...base, file: null }, now).file).toMatch(/Adjuntá/);
    expect(validateReceiptForm({ ...base, file: { type: "image/gif", size: 10 } }, now).file).toMatch(/PDF, JPG, PNG o WEBP/);
    expect(validateReceiptForm({ ...base, file: { type: "application/pdf", size: 4 * 1024 * 1024 + 1 } }, now).file).toMatch(/máximo es 4 MB/);
    expect(validateReceiptForm({ ...base, file: { type: "image/webp", size: 4 * 1024 * 1024 } }, now).file).toBeUndefined();
  });

  it("monto y fecha: mayor a cero, sin fecha futura en AR (no la del host)", () => {
    expect(validateReceiptForm({ ...base, amountCents: null }, now).amount).toBeDefined();
    expect(validateReceiptForm({ ...base, amountCents: 0 }, now).amount).toBeDefined();
    expect(validateReceiptForm({ ...base, amountInvalid: true }, now).amount).toMatch(/Revisá el monto/);
    // En UTC ya es 15; en AR sigue siendo 14: el 15 es futuro.
    expect(validateReceiptForm({ ...base, paidOn: "2026-10-15" }, now).paidOn).toMatch(/futura/);
    expect(validateReceiptForm({ ...base, paidOn: "" }, now).paidOn).toBeDefined();
  });

  it("[PL-F1a] la nota es entera de la persona (el medio va en su columna): el tope es el del server", () => {
    expect(validateReceiptForm({ ...base, note: "x".repeat(RECEIPT_NOTE_MAX) }, now).note).toBeUndefined();
    expect(validateReceiptForm({ ...base, note: "x".repeat(RECEIPT_NOTE_MAX + 1) }, now).note).toBe("La nota puede tener hasta 500 caracteres.");
  });

  it("solo se achican fotos pesadas, nunca un PDF", () => {
    expect(shouldCompressReceipt({ type: "image/jpeg", size: 5_000_000 })).toBe(true);
    expect(shouldCompressReceipt({ type: "image/png", size: 500_000 })).toBe(false);
    expect(shouldCompressReceipt({ type: "application/pdf", size: 5_000_000 })).toBe(false);
  });
});
