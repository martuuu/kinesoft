/**
 * [VX2-e] Alta del consultorio: paso «¿Atendés pacientes?», placeholders neutros, `SupportContact` y el recorrido sin
 * «Tu horario» para un Titular que no atiende.
 *
 * Render real (`renderToStaticMarkup`, sin jsdom) de `OnboardingShell` y de los pasos. Se mockea solo lo de afuera:
 * el router de Next y las server actions (red + base). `onboardingStepsFor`/`stepPosition`, el contexto del recorrido,
 * `SupportContact` y el copy son los reales.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/onboarding", () => ({
  saveOnboardingClinic: vi.fn(),
  completeOnboarding: vi.fn(),
  saveOnboardingLocation: vi.fn(),
  openPendingInvitation: vi.fn(),
}));
vi.mock("@/lib/tenant-settings", () => ({ setBusinessHours: vi.fn() }));
vi.mock("@/lib/invitations", () => ({ createInvitation: vi.fn(), revokeInvitation: vi.fn() }));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { clinicInputFrom, OWNER_CLINICAL_HELP, StepClinic, StepDone } from "@/components/onboarding/steps-basic";
import { StepTeam } from "@/components/onboarding/step-team";
import { STEP } from "@/lib/onboarding-logic";
import type { OnboardingTenant } from "@/lib/onboarding-internal";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const TENANT: OnboardingTenant = {
  id: "t1",
  name: "Consultorio Norte",
  slug: "consultorio-norte",
  phone: null,
  whatsapp: null,
  publicEmail: null,
  businessHoursStart: 8,
  businessHoursEnd: 19,
  agendaSlotMinutes: 30,
  vertical: "KINESIOLOGY",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("[VX2-e] paso Consultorio", () => {
  it("al crear pregunta «¿Atendés pacientes?» con las dos opciones, «Sí» por default y la ayuda de §3.3", () => {
    const h = html(<StepClinic tenant={null} patientIdentity={false} />);
    const t = text(h);
    expect(t).toContain("¿Atendés pacientes?");
    expect(t).toContain("Sí, atiendo");
    expect(t).toContain("No, organizo el consultorio");
    expect(t).toContain(
      "Si no atendés, no vas a tener agenda propia ni ver historias clínicas. Lo podés cambiar después desde Configuración."
    );
    expect(OWNER_CLINICAL_HELP).toContain("no vas a tener agenda propia ni ver historias clínicas");
    // Radios nativos con nombre propio; el «Sí» viene tildado (default de PL-1a).
    const radios = [...h.matchAll(/<input[^>]*name="ownerClinical"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(2);
    const yes = radios.find((r) => r.includes('value="yes"'))!;
    const no = radios.find((r) => r.includes('value="no"'))!;
    expect(yes).toContain('type="radio"');
    expect(yes).toContain('checked=""');
    expect(no).not.toContain("checked");
    // La ayuda está atada al grupo (lector de pantalla).
    expect(h).toMatch(/<fieldset[^>]*aria-describedby="onb-owner-clinical-help"/);
    expect(h).toContain('id="onb-owner-clinical-help"');
  });

  it("re-entrando (con tenant) no se pregunta: el paso no lo cambia", () => {
    const t = text(html(<StepClinic tenant={TENANT} patientIdentity={false} />));
    expect(t).not.toContain("¿Atendés pacientes?");
  });

  it("re-entrando como Titular que no atiende, dice dónde se cambia", () => {
    const t = text(
      html(
        <OnboardingShell current={STEP.clinic} ownerClinical={false}>
          <StepClinic tenant={TENANT} patientIdentity={false} />
        </OnboardingShell>
      )
    );
    expect(t).toContain("Elegiste no atender pacientes");
  });

  it("lo que se manda al server: `ownerClinical` solo al crear", () => {
    const fd = new FormData();
    fd.set("name", "Mi consultorio");
    expect(clinicInputFrom(fd, { vertical: "GENERAL", ownerClinical: false, creating: true })).toMatchObject({
      name: "Mi consultorio",
      vertical: "GENERAL",
      ownerClinical: false,
    });
    expect(clinicInputFrom(fd, { vertical: "GENERAL", ownerClinical: true, creating: true }).ownerClinical).toBe(true);
    expect(clinicInputFrom(fd, { vertical: "GENERAL", ownerClinical: false, creating: false })).not.toHaveProperty(
      "ownerClinical"
    );
  });

  it("placeholders neutros (sin datos de demo)", () => {
    const h = html(<StepClinic tenant={null} patientIdentity={false} />);
    expect(h).not.toMatch(/movare|camila/i);
    expect(h).toContain('placeholder="Nombre de tu consultorio"');
  });

  it("«escribinos» con SupportContact: mailto con el canal configurado, sin link si no hay", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "soporte@ejemplo.com");
    const withEmail = html(<StepClinic tenant={null} patientIdentity={false} />);
    expect(withEmail).toMatch(/<a href="mailto:soporte@ejemplo\.com\?subject=[^"]+"[^>]*data-support-mailto/);
    expect(text(withEmail)).not.toContain("escribinos a soporte.");

    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
    const without = html(<StepClinic tenant={null} patientIdentity={false} />);
    expect(without).not.toContain("data-support-mailto");
    expect(text(without)).toContain("Después, escribile al equipo de KineSoft");
  });
});

describe("[VX2-e] recorrido de un Titular que no atiende", () => {
  it("el riel y el progreso mobile no tienen «Tu horario» y cuentan 8 pasos", () => {
    const t = text(
      html(
        <OnboardingShell current={STEP.services} maxReachable={STEP.services} ownerClinical={false}>
          <p>x</p>
        </OnboardingShell>
      )
    );
    expect(t).not.toContain("Tu horario");
    expect(t).toContain("Paso 5 de 8 · Servicios");
  });

  it("quien atiende sigue viendo los 9 pasos (default)", () => {
    const t = text(
      html(
        <OnboardingShell current={STEP.services} maxReachable={STEP.services}>
          <p>x</p>
        </OnboardingShell>
      )
    );
    expect(t).toContain("Tu horario");
    expect(t).toContain("Paso 6 de 9 · Servicios");
  });

  it("Listo: sin fila «Tu horario», Equipo marcado si nadie atiende, «Ir al panel» y el número de paso de su recorrido", () => {
    const done = (ownerClinical: boolean) =>
      text(
        html(
          <OnboardingShell current={STEP.done} ownerClinical={ownerClinical}>
            <StepDone
              tenant={TENANT}
              location={null}
              schedule={null}
              servicesCount={1}
              insurers={[{ name: "Particular", isParticular: true, copagoCents: 0 }]}
              invitationsCount={0}
            />
          </OnboardingShell>
        )
      );
    const no = done(false);
    expect(no).not.toContain("Tu horario");
    expect(no).toContain("Todavía nadie atiende");
    expect(no).toContain("Ir al panel");
    expect(no).toContain("Paso 8 · Listo");

    const yes = done(true);
    expect(yes).toContain("Tu horario");
    expect(yes).toContain("Ir a mi agenda");
    expect(yes).toContain("Paso 9 · Listo");
  });

  it("Equipo le dice que la agenda necesita un profesional", () => {
    const t = text(
      html(
        <ToastProvider>
          <ConfirmProvider>
            <OnboardingShell current={STEP.team} ownerClinical={false}>
              <StepTeam invitations={[]} vertical="KINESIOLOGY" />
            </OnboardingShell>
          </ConfirmProvider>
        </ToastProvider>
      )
    );
    expect(t).toContain("¿Quiénes atienden?");
    expect(t).toContain("la agenda necesita al menos un profesional");
    expect(t).toContain("Paso 7 · Equipo");
  });
});

describe("[VX2-e] bundle: el alta no arrastra el editor de Configuración", () => {
  // Grafo de imports real de los archivos del alta (no un grep del repo): el paso «Tu horario» usa el módulo
  // extraído, y ese módulo no importa Drawer/toast/confirm ni server actions (lo que inflaba /onboarding).
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const importsOf = (src: string) => [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

  it("ningún archivo del alta importa schedule-editor ni catalog-schemas por valor", () => {
    for (const f of [
      "components/onboarding/steps-agenda.tsx",
      "components/onboarding/steps-basic.tsx",
      "components/onboarding/steps-catalog.tsx",
      "components/onboarding/step-team.tsx",
      "components/onboarding/onboarding-shell.tsx",
      "components/onboarding/step-nav.tsx",
    ]) {
      const src = read(f);
      expect(importsOf(src), f).not.toContain("@/components/configuracion/panels/practitioners/schedule-editor");
      // `import type` se borra al compilar; un import por valor de catalog-schemas trae zod (~13 kB gz).
      expect(src, f).not.toMatch(/^import\s+(?!type\b)[^;]*from\s+"@\/lib\/catalog-schemas"/m);
    }
    expect(importsOf(read("components/onboarding/steps-agenda.tsx"))).toContain("@/components/schedule/range-rows-editor");
  });

  it("range-rows-editor no importa Drawer, toast, confirm ni actions", () => {
    const deps = importsOf(read("components/schedule/range-rows-editor.tsx"));
    for (const banned of [
      "@/components/ui/drawer",
      "@/components/ui/toast",
      "@/components/ui/confirm-dialog",
      "@/lib/practitioner-schedule",
      "next/navigation",
    ]) {
      expect(deps).not.toContain(banned);
    }
  });
});
