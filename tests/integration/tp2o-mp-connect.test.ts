/**
 * T5 · [TP-2o] Cuentas de Mercado Pago y política de cobro (plan §25.4, contratos C-TP4 y C-TP5).
 *
 * Nace en TP-K2 (tanda T5c) con las filas del camino feliz como `it.fails`: las actions son stubs que devuelven
 * «todavía no disponible» sin tocar la base, así que cada fila falla por el motivo correcto (`ok: false`). TP-2b las
 * implementa, completa el setup (cuenta fake con `installFakeMp` de `tests/helpers/mp-connect-fake.ts`, callback,
 * step-up) y las da vuelta a `it(...)`. Las filas de rechazo (Secretaria, soporte, sin step-up, `in_use`, …) las agrega
 * TP-2b: con el stub pasarían en verde sin probar nada (anti-false-green).
 *
 * Actions reales contra Postgres, en los dos roles. Se mockea la sesión de Supabase y `next/cache` (integration-setup).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  startMpConnect,
  disconnectMpAccount,
  setMpLinksDelegated,
  getMyMpAccount,
  getOnlinePaymentsSettings,
} from "@/lib/mp-connect-actions";
import { savePaymentPolicy } from "@/lib/booking-payment-policy";
import { ownerClient, createEphemeralTenant, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[TP-2o] OAuth y cuentas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.fails("[TP-2o] El profesional conecta: ACTIVE por service + credencial sellada + audit sin tokens.", async () => {
    // Solo el MP falso local (t5-common: nada de sandbox real). TP-2b sigue con el callback del fake.
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    asUser(kine.userId);
    const view = await getMyMpAccount();
    expect(view).toMatchObject({ status: "NONE", nickname: null, linksDelegated: false });
    const r = await startMpConnect({ target: "own" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = new URL(r.data.url);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBeTruthy();
  });

  it.fails("[TP-2o] Desconectar anula los links ACTIVE y vence la preferencia.", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    asUser(kine.userId);
    const r = await disconnectMpAccount({ target: "own" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cancelledLinks).toBeGreaterThanOrEqual(0);
  });

  it.fails("[TP-2o] Delegación solo el dueño.", async () => {
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    asUser(kine.userId);
    const r = await setMpLinksDelegated({ target: "own", delegated: true });
    expect(r).toEqual({ ok: true, data: undefined });
  });

  it.fails("[TP-2o] Política: `tenant.sensitive` sí; Secretaria con Configuración y Facturación no; zod espejo; stale.", async () => {
    asUser(T.userId);
    const settings = await getOnlinePaymentsSettings();
    expect(settings).not.toBeNull();
    const r = await savePaymentPolicy(
      { mode: "OPTIONAL", chargeKind: "PERCENT", fixedCents: null, percentBps: 3_000, useClinicAccount: false, cancellationNote: null },
      null
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.data.updatedAt).toBe("string");
  });
});
