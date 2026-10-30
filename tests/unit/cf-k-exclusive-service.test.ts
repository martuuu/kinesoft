/**
 * [CF-K3] CF (§28, decisiones 1 y 2 de Martin, 30-oct; CF-D3, CF-D5) — `lib/availability/exclusive-service.ts`.
 *
 * Predicado único «el profesional ya atiende OTRO servicio en ese horario» que comparten motor, escrituras y
 * turnero. Cuenta como el cupo (no CANCELLED ∧ `isHoldingCapacity`, AUDIT §5.18); solape semiabierto (tocarse en
 * el borde no pisa); otro turno del MISMO paciente (no nulo) no cuenta (CF-D3); un guest nunca está exento.
 * Instantes con offset -03:00 explícito: corre igual en TZ=UTC y TZ=AR. Símbolo real, sin mocks.
 */
import { describe, expect, it } from "vitest";
import { isOtherServiceConflict, otherServiceConflicts } from "@/lib/availability/exclusive-service";
import { PENDING_PUBLIC_HOLD_MS } from "@/lib/booking-capacity";

const ar = (local: string) => new Date(`${local}-03:00`);
const NOW = ar("2026-11-02T08:00:00");

type B = {
  id: string;
  practitionerId: string;
  serviceId: string;
  patientId: string | null;
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  idempotencyKey: string;
};

let seq = 0;
function bk(local: string, over: Partial<B> = {}): B {
  seq++;
  return {
    id: `bk-${seq}`,
    practitionerId: "p1",
    serviceId: "svcA",
    patientId: "pat-otro",
    scheduledFor: ar(local),
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: ar("2026-11-01T10:00:00"),
    idempotencyKey: `k-${seq}`,
    ...over,
  };
}

/** Pedido: servicio B, 10:00–10:30 AR, paciente pat-1. */
const q = (over: Partial<{ serviceId: string; patientId: string | null; start: Date; end: Date }> = {}) => ({
  serviceId: "svcB",
  patientId: "pat-1" as string | null,
  start: ar("2026-11-02T10:00:00"),
  end: ar("2026-11-02T10:30:00"),
  now: NOW,
  ...over,
});

describe("[CF-K3] isOtherServiceConflict", () => {
  it("otro servicio que solapa → conflicto", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T09:30:00"), q())).toBe(true); // 09:30–10:15
    expect(isOtherServiceConflict(bk("2026-11-02T10:15:00"), q())).toBe(true); // 10:15–11:00
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { durationMin: 15 }), q())).toBe(true);
  });

  it("bordes que se tocan no pisan (semiabierto)", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T09:15:00"), q())).toBe(false); // termina 10:00
    expect(isOtherServiceConflict(bk("2026-11-02T10:30:00"), q())).toBe(false); // empieza 10:30
  });

  it("el mismo servicio no cuenta (lo decide el cupo, no esta regla)", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { serviceId: "svcB" }), q())).toBe(false);
  });

  it("mismo paciente (no nulo) exento; otro paciente o turno sin paciente, no", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: "pat-1" }), q())).toBe(false);
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: "pat-2" }), q())).toBe(true);
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: null }), q())).toBe(true);
  });

  it("guest (pedido sin paciente) no es exento, aunque el turno tampoco tenga paciente", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: null }), q({ patientId: null }))).toBe(true);
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: "pat-1" }), q({ patientId: null }))).toBe(true);
    const { patientId: _omit, ...noPatient } = q();
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { patientId: "pat-1" }), noPatient)).toBe(true);
  });

  it("CANCELLED no cuenta; NO_SHOW y COMPLETED sí (CF-D5)", () => {
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { status: "CANCELLED" }), q())).toBe(false);
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { status: "NO_SHOW" }), q())).toBe(true);
    expect(isOtherServiceConflict(bk("2026-11-02T10:00:00", { status: "COMPLETED" }), q())).toBe(true);
  });

  it("hold público impago vencido no cuenta; vigente sí (isHoldingCapacity)", () => {
    const pub = (createdAt: Date) =>
      bk("2026-11-02T10:00:00", {
        status: "PENDING",
        paymentStatus: "UNPAID",
        patientId: "pat-web",
        idempotencyKey: "pub:t1:6f1c2a52-7f43-4c43-9b8e-6b3a1f0c9d11",
        createdAt,
      });
    const expired = pub(new Date(NOW.getTime() - PENDING_PUBLIC_HOLD_MS - 1));
    const live = pub(new Date(NOW.getTime() - PENDING_PUBLIC_HOLD_MS));
    expect(isOtherServiceConflict(expired, q())).toBe(false);
    expect(isOtherServiceConflict(live, q())).toBe(true);
  });
});

describe("[CF-K3] otherServiceConflicts", () => {
  it("filtra por profesional, excluye el turno editado y devuelve solo los que pisan", () => {
    const hit = bk("2026-11-02T10:00:00", { id: "hit" });
    const otherPrac = bk("2026-11-02T10:00:00", { id: "otro-prof", practitionerId: "p2" });
    const sameSvc = bk("2026-11-02T10:00:00", { id: "mismo-svc", serviceId: "svcB" });
    const edited = bk("2026-11-02T10:00:00", { id: "editado" });
    const touching = bk("2026-11-02T10:30:00", { id: "toca" });
    const cancelled = bk("2026-11-02T10:00:00", { id: "cancelado", status: "CANCELLED" });
    const all = [hit, otherPrac, sameSvc, edited, touching, cancelled];
    const res = otherServiceConflicts(all, { ...q(), practitionerId: "p1", excludeBookingId: "editado" });
    expect(res.map((b) => b.id)).toEqual(["hit"]);
    // Sin excludeBookingId el editado vuelve a contar; el resultado conserva el tipo de entrada.
    expect(otherServiceConflicts(all, { ...q(), practitionerId: "p1" }).map((b) => b.id)).toEqual(["hit", "editado"]);
  });

  it("otro profesional nunca cuenta (la regla es por profesional)", () => {
    const res = otherServiceConflicts([bk("2026-11-02T10:00:00", { practitionerId: "p2" })], { ...q(), practitionerId: "p1" });
    expect(res).toEqual([]);
  });
});
