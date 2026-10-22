/**
 * TP-3k (§25.1 #2, §25.10 «aviso de reintegro al cancelar (drawer, Turnos y candado)», Anexo C «3k Cancelar:
 * confirmaciones del drawer, Turnos y candado con el texto de la seña»).
 *
 * Los componentes escriben el aviso literal (no importan `lib/online-charge-logic.ts` por el techo de bundle de
 * `/agenda` y `/pacientes/[id]`), así que acá se compara contra el símbolo real `depositRefundNotice`: si alguien
 * cambia el copy en un lado y no en el otro, esto falla.
 */
import { describe, it, expect, vi } from "vitest";

// Frontera de red: las vistas importan server actions que acá no se invocan.
vi.mock("@/lib/bookings", () => ({ setBookingStatus: vi.fn(), deleteBooking: vi.fn() }));
vi.mock("@/lib/time-blocks", () => ({ previewDayLock: async () => null, applyDayLock: async () => null, removeDayLock: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { depositRefundNotice } from "@/lib/online-charge-logic";
import { cancelBookingConfirm, depositCancelWarning } from "@/components/agenda/booking-drawer/status-actions";
import { turnosDepositCancelConfirm } from "@/components/patients/profile/views/turnos-view";
import { dayLockPaymentNote } from "@/components/agenda/day-lock/day-lock-dialog";

const AMOUNTS = [100, 6_000_00, 123_456, 100_000_000];

describe("[TP-3k] drawer: la confirmación de «Cancelar turno» avisa la seña antes", () => {
  it("con seña: el mensaje termina con el aviso literal de depositRefundNotice", () => {
    for (const cents of AMOUNTS) {
      const c = cancelBookingConfirm({ patientName: "Juana Gómez", scheduledFor: "2026-10-05T12:00:00.000Z", onlineDepositCents: cents });
      expect(c.message.endsWith(` ${depositRefundNotice(cents)}`)).toBe(true);
      expect(c.message).toContain("reintegrala desde Mercado Pago");
      expect(c.tone).toBe("danger");
      expect(depositCancelWarning(cents)).toBe(depositRefundNotice(cents));
    }
    expect(cancelBookingConfirm({ patientName: "J", scheduledFor: "2026-10-05T12:00:00.000Z", onlineDepositCents: 6_000_00 }).message)
      .toMatch(/^El horario queda libre en la agenda\..* Este turno tiene una seña de \$\s?6\.000: si corresponde, reintegrala desde Mercado Pago\.$/);
  });

  it("sin seña (ausente, 0, negativa o no entera): el mensaje de siempre, sin mencionar la seña", () => {
    const base = cancelBookingConfirm({ patientName: "J", scheduledFor: "2026-10-05T12:00:00.000Z" }).message;
    expect(base).toBe("El horario queda libre en la agenda. Si fue un error, lo podés reactivar desde «Cambiar estado».");
    for (const v of [undefined, null, 0, -100, 1.5]) {
      expect(cancelBookingConfirm({ patientName: "J", scheduledFor: "2026-10-05T12:00:00.000Z", onlineDepositCents: v }).message).toBe(base);
      expect(depositCancelWarning(v)).toBeNull();
    }
  });
});

describe("[TP-3k] Turnos del perfil: cancelar un turno con seña confirma con el aviso", () => {
  it("con seña: confirmación danger con el texto literal y un «no» que no dice «Cancelar»", () => {
    for (const cents of AMOUNTS) {
      const c = turnosDepositCancelConfirm({ onlineDepositCents: cents });
      expect(c).not.toBeNull();
      expect(c!.message).toBe(depositRefundNotice(cents));
      expect(c!.confirmLabel).toBe("Cancelar turno");
      expect(c!.cancelLabel).not.toMatch(/cancelar/i);
      expect(c!.tone).toBe("danger");
    }
  });

  it("sin seña: null (se cancela en un click, como antes)", () => {
    for (const v of [undefined, null, 0, -1, 2.5]) expect(turnosDepositCancelConfirm({ onlineDepositCents: v })).toBeNull();
  });
});

describe("[TP-3k] candado: los turnos con cobro (seña incluida) no se cancelan y el aviso dice cómo se reintegra", () => {
  it("cuenta los turnos con cobro y nombra el reintegro desde Mercado Pago (vocabulario «reintegro», nunca «reembolso»)", () => {
    const one = dayLockPaymentNote([{ hasPayment: true }, { hasPayment: false }]);
    expect(one).toMatch(/^1 turno tiene un cobro registrado/);
    expect(one).toContain("seña de Mercado Pago");
    expect(one).toContain("se reintegra desde Mercado Pago");
    const two = dayLockPaymentNote([{ hasPayment: true }, { hasPayment: true }, { hasPayment: false }]);
    expect(two).toMatch(/^2 turnos tienen un cobro registrado/);
    expect(two).toContain("no se cancelan");
    for (const t of [one, two]) {
      expect(t).not.toMatch(/reembols|devuelvas/i);
    }
  });

  it("sin cobros: null (no hay nota)", () => {
    expect(dayLockPaymentNote([])).toBeNull();
    expect(dayLockPaymentNote([{ hasPayment: false }])).toBeNull();
  });
});
