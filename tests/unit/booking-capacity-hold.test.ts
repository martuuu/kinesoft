/**
 * isHoldingCapacity (A2a-S06) — la reserva pública impaga sostiene el cupo
 * 30 min (decisión del dueño, 30-sep). Corre en TZ=UTC (`npm test`) y en
 * TZ=AR (`test:tz-ar`): el predicado es aritmética de instantes, no depende
 * del reloj del host.
 */
import { describe, it, expect } from "vitest";
import { isHoldingCapacity, isPublicReservation, PENDING_PUBLIC_HOLD_MS } from "@/lib/booking-capacity";

const now = new Date("2027-03-10T13:00:00.000Z"); // 10:00 AR
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
// Ids con forma de cuid (25 chars), como en prod.
const TENANT = "cmg1tenant000000000000001";
const PRAC = "cmg1prac00000000000000001";
const PAT = "cmg1pat000000000000000001";
const UUID = "0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10";
/** Key del turnero público actual (A2b-S-pub). */
const PUB_KEY = `pub:${TENANT}:${UUID}`;
/** Key del turnero público pre-A2 (a550972): la que tienen las filas de prod. */
const LEGACY_PUB_KEY = `${TENANT}:${PRAC}:2027-03-10T13:00:00.000Z:${PAT}`;
const pub = (
  createdAt: Date,
  extra: Partial<{ status: string; paymentStatus: string; patientId: string | null; idempotencyKey: string }> = {}
) => ({
  status: "PENDING",
  paymentStatus: "UNPAID",
  patientId: PAT,
  idempotencyKey: PUB_KEY,
  createdAt,
  ...extra,
});

describe("isHoldingCapacity", () => {
  it("el plazo es 30 minutos", () => {
    expect(PENDING_PUBLIC_HOLD_MS).toBe(30 * 60_000);
  });

  it("pendiente pública impaga: sostiene hasta los 30 min inclusive, después no", () => {
    expect(isHoldingCapacity(pub(ago(0)), now)).toBe(true);
    expect(isHoldingCapacity(pub(ago(29)), now)).toBe(true);
    expect(isHoldingCapacity(pub(ago(30)), now)).toBe(true);
    expect(isHoldingCapacity(pub(new Date(ago(30).getTime() - 1)), now)).toBe(false);
    expect(isHoldingCapacity(pub(ago(24 * 60)), now)).toBe(false);
  });

  it("pago rechazado (FAILED): vence igual que la impaga", () => {
    expect(isHoldingCapacity(pub(ago(29), { paymentStatus: "FAILED" }), now)).toBe(true);
    expect(isHoldingCapacity(pub(ago(31), { paymentStatus: "FAILED" }), now)).toBe(false);
  });

  it("pagada o autorizada: sostiene siempre", () => {
    expect(isHoldingCapacity(pub(ago(120), { paymentStatus: "PAID" }), now)).toBe(true);
    expect(isHoldingCapacity(pub(ago(120), { paymentStatus: "AUTHORIZED" }), now)).toBe(true);
  });

  it("confirmado / realizado / ausente: sostiene siempre", () => {
    for (const status of ["CONFIRMED", "COMPLETED", "NO_SHOW"]) {
      expect(isHoldingCapacity(pub(ago(120), { status }), now)).toBe(true);
    }
  });

  it("guest de la recepción (PENDING sin paciente): no vence", () => {
    expect(isHoldingCapacity(pub(ago(120), { patientId: null }), now)).toBe(true);
  });

  it("no depende del reloj del host: mismo resultado cruzando la medianoche AR", () => {
    const lateNow = new Date("2027-03-11T03:10:00.000Z"); // 00:10 AR del día siguiente
    const created = new Date("2027-03-11T02:30:00.000Z"); // 23:30 AR, 40 min antes
    expect(isHoldingCapacity(pub(created), lateNow)).toBe(false);
  });

  it("revisión A2: un turno de la agenda con paciente en PENDING/UNPAID (guest al que se asignó paciente) NO vence", () => {
    expect(isHoldingCapacity(pub(ago(120), { idempotencyKey: UUID }), now)).toBe(true);
    expect(isHoldingCapacity(pub(ago(120), { idempotencyKey: "9f86d081884c7d659a2feaa0c55ad015" }), now)).toBe(true);
  });

  it("la reserva pública pre-A2 (key vieja) vence igual", () => {
    expect(isHoldingCapacity(pub(ago(31), { idempotencyKey: LEGACY_PUB_KEY }), now)).toBe(false);
    expect(isHoldingCapacity(pub(ago(29), { idempotencyKey: LEGACY_PUB_KEY }), now)).toBe(true);
  });
});

describe("isPublicReservation (discriminante por idempotencyKey)", () => {
  const is = (idempotencyKey: string, patientId: string | null = PAT) =>
    isPublicReservation({ idempotencyKey, patientId });

  it("turnero actual: pub:<tenant>:<uuid>", () => {
    expect(is(PUB_KEY)).toBe(true);
  });

  it("turnero pre-A2: <tenant>:<prof>:<ISO>:<patientId> solo si el último segmento es el paciente de la fila", () => {
    expect(is(LEGACY_PUB_KEY)).toBe(true);
    // Paciente reasignado después → ya no se reconoce (ante la duda, retiene).
    expect(is(LEGACY_PUB_KEY, "cmg1pat000000000000000002")).toBe(false);
    // Guest viejo de la agenda: la identity era el email/teléfono, no un patientId.
    expect(is(`${TENANT}:${PRAC}:2027-03-10T13:00:00.000Z:ana@test.local`)).toBe(false);
  });

  it("agenda: UUID del modal o 32 hex al azar → no", () => {
    expect(is(UUID)).toBe(false);
    expect(is("9f86d081884c7d659a2feaa0c55ad015")).toBe(false);
  });

  it("batch: <base>:<ISO> (con UUID o seriesId de base) → no", () => {
    expect(is(`${UUID}:2027-03-10T13:00:00.000Z`)).toBe(false);
    expect(is(`a1b2c3d4e5f6a1b2c3d4e5f6:2027-03-10T13:00:00.000Z`)).toBe(false);
    // Aunque la base imite `pub:`: tiene más de dos `:`.
    expect(is(`pub:${TENANT}:2027-03-10T13:00:00.000Z`)).toBe(false);
  });

  it("sin paciente nunca es reserva pública (guest de la recepción)", () => {
    expect(is(PUB_KEY, null)).toBe(false);
    expect(is(LEGACY_PUB_KEY, null)).toBe(false);
  });
});
