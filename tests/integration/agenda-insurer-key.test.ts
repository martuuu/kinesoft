/**
 * [AS-2o] T3e-2o (plan §23.9) · clave de obra social de la agenda (`insurerKey`) contra Postgres real.
 *
 * Corre `listAgendaBookings` y `loadAgendaPage` REALES (solo se mockea la sesión de Supabase) en los dos roles
 * (`kinesoft_app` con RLS y owner BYPASSRLS). Regla segura:
 *   - id del catálogo solo con la cobertura vinculada a una OS que no es la Particular;
 *   - "particular" sin cobertura, con la Particular, con texto libre sin vincular o invitado;
 *   - null si el actor no ve facturación del paciente (acceso basic): el filtro nunca lo matchea, se oculta y se cuenta.
 * Y el cable (`oi`) devuelve exactamente eso en el cliente con el catálogo de la página.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listAgendaBookings } from "@/lib/bookings";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { agendaRowToDTO, decodeAgendaWire } from "@/lib/agenda-wire";
import {
  EMPTY_AGENDA_FILTERS,
  applyAgendaFilters,
  countInsurerAccessHidden,
  weekStartKey,
} from "@/lib/agenda-client-state";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addInsurer,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = "2027-05-04";
const at = (hhmm: string) => new Date(localToARIso(`${DAY}T${hhmm}:00`));

describe.skipIf(!RUN)("[AS-2o] insurerKey en la proyección liviana de la agenda", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let osde: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { sharedPatientView: false });
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    osde = await addInsurer(db, T, { name: `OSDE ${randomUUID().slice(0, 6)}`, copagoCents: 120000 });

    const pOsde = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    const pPart = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    const pFree = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    const pNone = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    await db.coverage.create({ data: { patientId: pOsde, insurer: "OSDE", insurerId: osde } });
    await db.coverage.create({ data: { patientId: pPart, insurer: "Particular", insurerId: T.particularInsurerId } });
    // Texto libre que coincide con el nombre del catálogo, sin vincular: sigue siendo particular.
    const osdeName = (await db.insurer.findUniqueOrThrow({ where: { id: osde } })).name;
    await db.coverage.create({ data: { patientId: pFree, insurer: osdeName, insurerId: null } });

    const mk = async (key: string, patientId: string | null, hhmm: string) => {
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          patientId,
          guestName: patientId ? null : "Reserva externa",
          scheduledFor: at(hhmm),
          durationMin: 30,
          status: "CONFIRMED",
          idempotencyKey: randomUUID(),
        },
      });
      ids[b.id] = key;
    };
    await mk("osde", pOsde, "09:00");
    await mk("part", pPart, "09:30");
    await mk("free", pFree, "10:00");
    await mk("none", pNone, "10:30");
    await mk("guest", null, "11:00");
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const keysOf = (rows: ReadonlyArray<{ id: string; insurerKey?: string | null }>) =>
    Object.fromEntries(rows.filter((r) => ids[r.id]).map((r) => [ids[r.id], r.insurerKey]));
  const range = { from: new Date(localToARIso(`${DAY}T00:00:00`)), to: new Date(localToARIso(`${DAY}T23:59:00`)) };

  it("[AS-2o] Titular (ve facturación): id del catálogo solo con OS vinculada; el resto «particular»", async () => {
    asUser(T.userId);
    expect(keysOf(await listAgendaBookings(range))).toEqual({
      osde,
      part: "particular",
      free: "particular",
      none: "particular",
      guest: "particular",
    });
  });

  it("[AS-2o] Secretaria (nivel admin: ve cobertura, no HC): mismas claves", async () => {
    asUser(assistant.userId);
    expect(keysOf(await listAgendaBookings(range))).toEqual({
      osde,
      part: "particular",
      free: "particular",
      none: "particular",
      guest: "particular",
    });
  });

  it("[AS-2o] Profesional sin acceso a los pacientes del colega: null (nunca matchea) y el invitado particular", async () => {
    asUser(kine.userId);
    const rows = await listAgendaBookings(range);
    expect(keysOf(rows)).toEqual({ osde: null, part: null, free: null, none: null, guest: "particular" });
    // Lo que no ve no sale por ningún lado: su obraSocial sigue siendo «Particular» por defecto.
    const osdeRow = rows.find((r) => ids[r.id] === "osde")!;
    expect(osdeRow.obraSocial).toBe("Particular");
    // Con filtro: los null se ocultan y se cuentan; con «particular» queda solo el invitado.
    const dtos = rows.map(agendaRowToDTO);
    const mine = dtos.filter((d) => ids[d.id]);
    const byOs = applyAgendaFilters(mine, { ...EMPTY_AGENDA_FILTERS, insurerKey: osde }, { primaryLocationId: null });
    expect(byOs).toEqual([]);
    expect(countInsurerAccessHidden(mine, osde)).toBe(4);
    const byPart = applyAgendaFilters(mine, { ...EMPTY_AGENDA_FILTERS, insurerKey: "particular" }, { primaryLocationId: null });
    expect(byPart.map((d) => ids[d.id])).toEqual(["guest"]);
  });

  for (const who of ["owner", "kine", "assistant"] as const) {
    it(`[AS-2o] cable de /agenda (${who}): decodificado con el catálogo de la página = las filas con insurerKey`, async () => {
      asUser(who === "owner" ? T.userId : who === "kine" ? kine.userId : assistant.userId);
      const actor = await getActor();
      const monday = weekStartKey(DAY);
      const data = await loadAgendaPage(actor, { monday, patientId: null });
      expect(data.insurers.map((i) => i.id)).toContain(osde);
      const decoded = decodeAgendaWire(data.bookings, {
        services: data.services,
        locations: data.locations,
        insurers: data.insurers,
      });
      const fresh = (await listAgendaBookings(range)).map(agendaRowToDTO);
      const decodedMine = decoded.filter((d) => ids[d.id]);
      expect(JSON.stringify(decodedMine)).toBe(JSON.stringify(fresh.filter((d) => ids[d.id])));
      for (const d of decodedMine) expect(d.insurerKey).not.toBeUndefined();
      // Solo paga bytes el caso raro (texto libre con el mismo nombre que una OS del catálogo, para quien ve la
      // cobertura: `oi: -1`); los demás se derivan de lo que ya viaja (null incluido, para el profesional).
      for (const w of data.bookings) {
        const key = ids[String(w.i)];
        if (key === "free" && who !== "kine") expect(w.oi).toBe(-1);
        else expect("oi" in w, JSON.stringify(w)).toBe(false);
      }
    });
  }
});
