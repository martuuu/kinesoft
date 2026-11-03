/**
 * [CF2-PU2-I] /caja de punta a punta (CF2 · P.2, sesión P-U2; plan §29 D-CF2-16/17). Corre en los 2 roles
 * (`test:integration` = `kinesoft_app` con RLS; `test:integration:owner` = BYPASSRLS, como prod) y con TZ=UTC.
 *
 * Se llama a la PÁGINA real (`app/(app)/caja/page.tsx`: `getActor` → `memberCapabilitiesForActor` → `loadCajaPage` →
 * `CajaView`) contra el fixture a mano de P-X y se mira el HTML, que es lo que llega al navegador: qué columnas, qué
 * filas y qué montos ve cada rol. Los números exactos de la liquidación los fija `cf2-caja.test.ts` ([CF2-PS2-*]);
 * acá solo que la página los pinta y que ningún rol ve lo que no le toca. Se mockean solo la sesión de Supabase y
 * `next/cache` (setup).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import type { PrismaClient } from "@prisma/client";
import CajaPage from "@/app/(app)/caja/page";
import { formatARS } from "@/lib/format";
import { CAJA_FIXTURE_NAMES, seedCajaFixture, INSURER_FEE_CENTS, type CajaFixture } from "@/tests/helpers/caja-fixture";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";
import { addStaff, createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const NOW = new Date("2026-10-20T18:00:00-03:00");

const bodyRows = (html: string) => (html.split("<tbody")[1] ?? "").split("</tbody>")[0].match(/<tr[\s>]/g) ?? [];

describe.skipIf(!RUN)("[CF2-PU2-I] /caja (página real, 2 roles)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fx: CajaFixture;
  let secretaria: { userId: string };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    fx = await seedCajaFixture(T, { now: NOW, db });
    secretaria = await addStaff(db, T, "ASSISTANT");
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    usePassthroughUnstableCache();
    asAnonymous();
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  async function htmlAs(userId: string, searchParams: Record<string, string>): Promise<string> {
    asUser(userId);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const el = (await CajaPage({ searchParams })) as ReactElement;
    return renderToStaticMarkup(createElement("div", null, el));
  }

  it("Titular (tenant): las 3 fuentes, los 3 profesionales, totales del día y el reparto", async () => {
    const html = await htmlAs(T.userId, { vista: "dia", fecha: fx.dayKey });
    expect(html).toContain(">Obra social<");
    for (const n of Object.values(CAJA_FIXTURE_NAMES)) expect([n, html.includes(n)]).toEqual([n, true]);
    expect(bodyRows(html)).toHaveLength(3);
    expect(html).toContain(formatARS(fx.expected.day[fx.dayKey].tenant.totals.gross));
    expect(html).toContain("Reparto vigente");
    expect(html).toContain("Por medio de pago");
    expect(html).toContain("vista=mes");
  });

  it("Secretaria (desk): hoy sin OS ni Mes, aunque la URL pida otro mes", async () => {
    const html = await htmlAs(secretaria.userId, { vista: "mes", mes: "2026-09" });
    expect(html).toContain("Cobrado hoy");
    expect(html).not.toContain("Obra social");
    expect(html).not.toContain("vista=mes");
    expect(html).not.toContain(formatARS(INSURER_FEE_CENTS));
    expect(html).toContain(formatARS(fx.expected.day[fx.dayKey].desk.totals.gross));
  });

  it("Profesional (own): su fila sola; nadie más como fila", async () => {
    const html = await htmlAs(fx.practitioners.junior.userId, { vista: "dia", fecha: fx.dayKey });
    expect(bodyRows(html)).toHaveLength(1);
    expect(html).toContain(CAJA_FIXTURE_NAMES.junior);
    expect(html).not.toContain(CAJA_FIXTURE_NAMES.other);
    expect(html).not.toContain("<tfoot");
    const mine = fx.expected.day[fx.dayKey].tenant.rows.find((r) => r.practitionerId === fx.practitioners.junior.practitionerId)!;
    expect(html).toContain(formatARS(mine.net));
  });
});
