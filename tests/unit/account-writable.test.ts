/**
 * PL-1e · C-PL10: allowlist de escrituras de cuenta en solo lectura (lib/account-writable.ts).
 * El efecto en la base (escribe el Titular, no el soporte) lo cubre tests/integration/pl1e-session.test.ts.
 */
import { describe, it, expect } from "vitest";
import { ACCOUNT_WRITABLE_ACTIONS, isAccountWritableAction, withAccountWritable } from "@/lib/account-writable";
import { SUPPORT_WRITABLE_ACTIONS } from "@/lib/support-writable";

describe("[PL-1e] ACCOUNT_WRITABLE_ACTIONS", () => {
  it("es exactamente la lista del contrato C-PL10 (PL-2b: sin las actions de Mercado Pago)", () => {
    expect([...ACCOUNT_WRITABLE_ACTIONS].sort()).toEqual(
      [
        "lib/saas-billing.ts#applyPlanChange",
        "lib/saas-billing.ts#submitPaymentReceipt",
        "lib/support-threads.ts#createSupportThread",
        "lib/support-threads.ts#replySupportThread",
        "lib/support-threads.ts#markSupportThreadRead",
      ].sort()
    );
  });

  it("no se cruza con la allowlist de soporte (son dos excepciones distintas)", () => {
    for (const n of ACCOUNT_WRITABLE_ACTIONS) expect(SUPPORT_WRITABLE_ACTIONS.has(n)).toBe(false);
  });

  it("un nombre fuera de la lista es un error de programación: tira antes de correr nada", async () => {
    let ran = false;
    await expect(
      withAccountWritable("lib/patients.ts#createPatient", async () => {
        ran = true;
      })
    ).rejects.toThrow(/ACCOUNT_WRITABLE_ACTIONS/);
    expect(ran).toBe(false);
    expect(isAccountWritableAction("lib/patients.ts#createPatient")).toBe(false);
    expect(isAccountWritableAction("lib/saas-billing.ts#applyPlanChange")).toBe(true);
  });
});
