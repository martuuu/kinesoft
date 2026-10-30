/**
 * [CF-U4] Configuración → reglas de la agenda (CF, §28; M20): lo que guardan los setters REALES
 * (`setTenantAgendaRules`, `setPractitionerAgendaRules`) es lo que trae `loadConfiguracionPage` para las tarjetas de
 * General y de la ficha del profesional, y el form de General abre y guarda sin cambiar nada (ida y vuelta
 * horas/días/semanas). Contra Postgres en los dos roles; se mockea solo la cookie de sesión (`asUser`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { setTenantAgendaRules } from "@/lib/tenant-settings";
import { setPractitionerAgendaRules } from "@/lib/practitioner-schedule";
import { loadConfiguracionPage } from "@/lib/configuracion-page-loader";
import { tenantAgendaRulesDraft, tenantAgendaRulesInput } from "@/components/configuracion/panels/general-panel";
import { practitionerAgendaRulesInput } from "@/components/configuracion/panels/practitioners/agenda-rules-editor";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CF-U4] loader de Configuración ↔ setters de reglas de agenda", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };

  const load = async () => {
    const actor = await getActor();
    return loadConfiguracionPage(actor, await capabilitiesForActor(actor));
  };

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    kine = await addPractitioner(db, A);
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    asUser(A.userId);
    await db.tenant.update({
      where: { id: A.tenantId },
      data: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null },
    });
    await db.practitioner.update({
      where: { id: kine.practitionerId },
      data: { allowParallelServices: false, agendaSlotStepMin: null, publicSlotStepMin: null },
    });
  });

  it("sin configurar: el tenant trae los tres NULL y cada profesional el interruptor apagado", async () => {
    const page = await load();
    expect(page.tenant).toMatchObject({ agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null });
    const mine = page.scheduleSummary.find((s) => s.practitionerId === kine.practitionerId);
    expect(mine?.agendaRules).toEqual({
      allowParallelServices: false,
      agendaSlotStepMin: null,
      publicSlotStepMin: null,
      tenant: { agendaSlotStepMin: null, publicSlotStepMin: null },
    });
  });

  it("lo que guarda el form de General vuelve igual por el loader y reabre igual (2 semanas)", async () => {
    const saved0 = { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null };
    const form = tenantAgendaRulesInput(
      { ...tenantAgendaRulesDraft(saved0), agendaStep: "30", publicStep: "45", leadValue: "2", leadUnit: "weeks" },
      saved0
    );
    expect(form.ok).toBe(true);
    if (!form.ok) return;
    expect(await setTenantAgendaRules(form.input)).toEqual({ ok: true, data: undefined });
    const page = await load();
    expect(page.tenant).toMatchObject({ agendaSlotStepMin: 30, publicSlotStepMin: 45, publicMinLeadMinutes: 2 * 10080 });
    const t = page.tenant!;
    expect(tenantAgendaRulesDraft(t)).toEqual({ agendaStep: "30", publicStep: "45", leadValue: "2", leadUnit: "weeks" });
    // La ficha del profesional rotula «Como el consultorio» con lo nuevo.
    const mine = page.scheduleSummary.find((s) => s.practitionerId === kine.practitionerId);
    expect(mine?.agendaRules.tenant).toEqual({ agendaSlotStepMin: 30, publicSlotStepMin: 45 });
  });

  it("lo que guarda la ficha del profesional vuelve por el loader", async () => {
    const input = practitionerAgendaRulesInput({ allowParallelServices: true, agendaStep: "60", publicStep: "" });
    expect(await setPractitionerAgendaRules(kine.practitionerId, input)).toEqual({ ok: true, data: undefined });
    const mine = (await load()).scheduleSummary.find((s) => s.practitionerId === kine.practitionerId);
    expect(mine?.agendaRules).toMatchObject({ allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: null });
    // El titular no se tocó.
    const owner = (await load()).scheduleSummary.find((s) => s.practitionerId === A.practitionerId);
    expect(owner?.agendaRules.allowParallelServices).toBe(false);
  });

  it("un valor fuera de rango vuelve con el error en su campo (lo que la tarjeta pinta al lado)", async () => {
    const r = await setTenantAgendaRules({ agendaSlotStepMin: 20, publicSlotStepMin: null, publicMinLeadMinutes: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors ?? {})).toEqual(["agendaSlotStepMin"]);
  });
});
