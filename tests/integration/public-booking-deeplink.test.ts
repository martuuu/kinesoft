/**
 * DIR-2d · deep link al turnero (C-DIR7) y `rating` fuera de `PublicClinic` (DIR-D18), contra Postgres real y en los
 * dos roles.
 *
 * Por qué:
 *   - El directorio linkea a `/c/<slug>/booking?pro=<practitionerId>`. Si el consultorio cambió de slug (BO2-D), el
 *     redirect del alias perdía la query y el paciente caía en el turnero sin el profesional que eligió.
 *   - `?pro=` es input de un anónimo: si no es un profesional reservable hoy (switch apagado, de otro consultorio,
 *     basura) se ignora en silencio y el wizard arranca como siempre. No revela si el id existe.
 *   - `getPublicClinic` mandaba `Practitioner.rating` (dato de seed, nadie lo escribe) al cliente sin que el wizard lo
 *     use. Se afirma sobre el payload real con un rating cargado en la fila: si vuelve, el test lo ve.
 *
 * Símbolos reales: la página `app/(booking)/c/[slug]/booking/page.tsx`, `loadPublicBookingPage`, `getPublicClinic` y
 * `initialWizardSelection`. Lo único que no corre es el render del wizard (cliente): se mira la prop que la página le
 * pasa; el render con la prop está en `tests/unit/render/public-booking-wizard.test.tsx`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as React from "react";
import type { ReactElement } from "react";
import type { PrismaClient } from "@prisma/client";
import PublicBookingPage from "@/app/(booking)/c/[slug]/booking/page";
import { getPublicClinic } from "@/lib/public-booking";
import { loadPublicBookingPage } from "@/lib/public-booking-internal";
import { initialWizardSelection } from "@/lib/public-wizard-state";
import { asAnonymous } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

// La config de integración transforma JSX con el runtime clásico (`React.createElement`) y la página no importa React
// (en Next lo inyecta el runtime automático). Solo para poder llamar a la página real acá.
(globalThis as { React?: typeof React }).React = React;

/** Lo que tira `permanentRedirect` de Next 14: `NEXT_REDIRECT;<tipo>;<url>;<status>`. */
function redirectOf(e: unknown): { url: string; status: number } | null {
  const digest = (e as { digest?: unknown })?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  const parts = digest.split(";");
  return { url: parts[2], status: Number(parts[3]) };
}

type PageProps = Parameters<typeof PublicBookingPage>[0];
const page = (props: unknown) => PublicBookingPage(props as PageProps);

describe.skipIf(!RUN)("DIR-2d · deep link al turnero", () => {
  let db: PrismaClient;
  /** Dos profesionales reservables (titular + `ON`) y uno con el switch apagado (`OFF`). */
  let T: EphemeralTenant;
  /** Otro consultorio: su profesional no es de T. */
  let X: EphemeralTenant;
  let onId: string;
  let offId: string;
  let alias: string;

  beforeAll(async () => {
    asAnonymous();
    db = ownerClient();
    T = await createEphemeralTenant(db);
    X = await createEphemeralTenant(db);
    onId = (await addPractitioner(db, T)).practitionerId;
    offId = (await addPractitioner(db, T)).practitionerId;
    await db.practitioner.update({ where: { id: offId }, data: { publicBookingEnabled: false } });
    // Servicio del consultorio (sin profesional): lo ofrecen todos por default. El de la factory es del titular, y sin
    // un servicio PUBLIC el profesional nuevo no sería reservable.
    await db.service.create({
      data: { tenantId: T.tenantId, name: "Sesión general", durationMin: 45, priceCents: 7000, maxConcurrent: 1 },
    });
    // Rating cargado a propósito: con el campo en el payload, el test de DIR-D18 lo vería.
    await db.practitioner.updateMany({ where: { tenantId: T.tenantId }, data: { rating: 4.7 } });
    alias = `viejo-${uniqueSuffix()}`.toLowerCase();
    await db.tenantSlugAlias.create({ data: { slug: alias, tenantId: T.tenantId } });
  });
  afterAll(async () => {
    asAnonymous();
    await T?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  it("[DIR-2d] el redirect del alias conserva ?pro=", async () => {
    const err = await page({
      params: { slug: alias },
      searchParams: { pro: onId, utm_source: ["dir", "x y"], vacio: undefined },
    }).then(
      () => null,
      (e) => e
    );
    const r = redirectOf(err);
    expect(r?.status).toBe(308);
    const url = new URL(r!.url, "http://x.test");
    expect(url.pathname).toBe(`/c/${T.slug}/booking`);
    expect(url.searchParams.get("pro")).toBe(onId);
    // Repetidos se conservan en orden; `undefined` se descarta.
    expect(url.searchParams.getAll("utm_source")).toEqual(["dir", "x y"]);
    expect(url.searchParams.has("vacio")).toBe(false);

    // Sin query, el redirect sigue como antes (sin `?` colgando).
    const plain = await page({ params: { slug: alias }, searchParams: {} }).then(
      () => null,
      (e) => e
    );
    expect(redirectOf(plain)).toEqual({ url: `/c/${T.slug}/booking`, status: 308 });
  });

  it("[DIR-2d] PublicClinic no expone rating", async () => {
    const clinic = await getPublicClinic(T.slug);
    expect(clinic?.practitioners.length).toBeGreaterThanOrEqual(2);
    for (const p of clinic!.practitioners) expect(Object.keys(p)).not.toContain("rating");
    expect(JSON.stringify(clinic)).not.toContain("rating");
  });

  it("?pro= de un profesional reservable: la página se lo pasa al wizard, que arranca en el paso 1 con él", async () => {
    const el = (await page({ params: { slug: T.slug }, searchParams: { pro: onId } })) as ReactElement<{
      initialPractitionerId: string | null;
    }>;
    expect(el.props.initialPractitionerId).toBe(onId);

    const data = await loadPublicBookingPage(T.slug);
    expect(data?.state).toBe("open");
    if (data?.state !== "open") return;
    expect(initialWizardSelection(data.clinic, onId)).toEqual({ step: 1, practitionerId: onId, mode: "pick" });
  });

  it("?pro= apagado, de otro consultorio, basura o repetido: se ignora y arranca como siempre", async () => {
    const data = await loadPublicBookingPage(T.slug);
    if (data?.state !== "open") throw new Error("turnero cerrado");
    // El apagado no viaja al cliente: ni siquiera está en `clinic.practitioners`.
    expect(data.clinic.practitioners.map((p) => p.id)).not.toContain(offId);
    const def = { step: 0, practitionerId: null, mode: "pick" };
    for (const pro of [offId, X.practitionerId, "no-existe", "", null]) {
      expect(initialWizardSelection(data.clinic, pro), String(pro)).toEqual(def);
    }
    // `?pro=a&pro=b` (array) no es un id: la página no lo pasa.
    const el = (await page({ params: { slug: T.slug }, searchParams: { pro: [onId, onId] } })) as ReactElement<{
      initialPractitionerId: string | null;
    }>;
    expect(el.props.initialPractitionerId).toBeNull();
  });
});
