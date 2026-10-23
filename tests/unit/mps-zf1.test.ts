/**
 * [ZF1] Fixer de cobros del cierre de T6+T7 (revisor ZA), la parte pura y por texto:
 *  - re-anclaje (`planReanchorRow`): «ya anclada» no depende de `autoDebitAllowed` (re-anclar no toca el bloqueo de
 *    Plataforma: antes una suscripción bloqueada nunca salía «skip» y cada corrida la re-escribía con el débito
 *    permitido);
 *  - logs de la sync con MP: solo `err.name`, nunca `err.message` (un mensaje de Prisma o de fetch puede traer la URL
 *    con credenciales, el email del pagador o el payload de MP).
 * Lo que escribe en la base está en `tests/integration/mps-zf1-core.test.ts` y `mps-zf1-mp.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planReanchorRow, type ReanchorInput } from "@/lib/saas-reanchor-internal";

const NOW = new Date("2030-03-10T15:00:00Z");

const input = (over: Partial<ReanchorInput> = {}): ReanchorInput => ({
  tenantId: "t1",
  tenantName: "Kine Centro",
  saasPlan: "CONSULTORIO",
  subscriptionStatus: "ACTIVE",
  trialEndsAt: null,
  createdAt: new Date("2030-01-01T15:00:00Z"),
  anchorDay: 4,
  nextChargeAt: new Date("2030-04-04T03:00:00Z"),
  billableFrom: new Date("2030-03-10T00:00:00Z"),
  autoDebitAllowed: true,
  lastChargePeriodEnd: null,
  priceCents: 3_100_000,
  ...over,
});

describe("[ZF1] re-anclaje: el débito bloqueado no cuenta para «ya anclada»", () => {
  it("[ZF1] anclada al 4 con el débito BLOQUEADO por Plataforma → skip (no se re-escribe ni se desbloquea)", () => {
    const r = planReanchorRow(input({ autoDebitAllowed: false }), NOW);
    expect(r.action).toBe("skip");
    expect(r.oldAutoDebitAllowed).toBe(false);
  });

  it("[ZF1] la fila no promete un débito permitido: no hay campo nuevo de débito, solo el valor actual", () => {
    const r = planReanchorRow(input({ anchorDay: 21, nextChargeAt: new Date("2030-03-21T03:00:00Z"), billableFrom: null, autoDebitAllowed: false }), NOW);
    expect(r.action).toBe("update");
    expect(r.oldAutoDebitAllowed).toBe(false);
    expect(Object.keys(r).filter((k) => /autoDebit/i.test(k))).toEqual(["oldAutoDebitAllowed"]);
  });
});

describe("[ZF1] logs de la sync con Mercado Pago", () => {
  const src = readFileSync(resolve(__dirname, "../../lib/saas-mp-sync-internal.ts"), "utf8");
  it("[ZF1] ningún log usa err.message (solo err.name)", () => {
    expect(src).not.toMatch(/err\.message|e\.message|error\.message/);
    expect(src).toMatch(/err instanceof Error \? err\.name : "unknown"/);
  });
});
