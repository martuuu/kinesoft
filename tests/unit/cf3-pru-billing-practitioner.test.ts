import { describe, it, expect, vi } from "vitest";

// CF3 PR-U (D-CF3-1): el monto que el modal de turno pre-carga tiene que ser el que la agenda va a cobrar, y desde
// CF3 eso depende del profesional (su precio para el servicio entra en la escalera de `lib/copago.ts`). Antes el hook
// consultaba `getPatientBillingPreview(patientId, serviceId)` sin profesional y no re-consultaba al cambiarlo.
// Sin jsdom en el repo: se testea la lógica pura que usan el hook y `index.tsx` (los argumentos de la action y el plan
// de re-consulta al cambiar de profesional). La action es la red: se mockea el módulo para poder importar el hook.
vi.mock("@/lib/patients", () => ({ getPatientBillingPreview: vi.fn() }));

import {
  billingPreviewArgs,
  practitionerChangePlan,
} from "@/components/agenda/booking-modal/use-patient-billing";

describe("[CF3-PRU-1] preview de cobro con el profesional del turno", () => {
  it("pasa paciente, servicio y profesional a getPatientBillingPreview", () => {
    expect(billingPreviewArgs("pt1", "s1", "p2")).toEqual(["pt1", "s1", "p2"]);
  });
  it("sin servicio o sin profesional elegidos manda undefined (el server resuelve como antes)", () => {
    expect(billingPreviewArgs("pt1", "", "")).toEqual(["pt1", undefined, undefined]);
    expect(billingPreviewArgs("pt1", "s1", "")).toEqual(["pt1", "s1", undefined]);
  });
});

describe("[CF3-PRU-2] cambiar de profesional re-consulta una sola vez", () => {
  it("mismo profesional: nada que hacer", () => {
    expect(practitionerChangePlan({ current: "p1", next: "p1", serviceId: "s1", reconciledServiceId: "s1" })).toBeNull();
  });
  it("otro profesional que atiende el mismo servicio: re-consulta con el servicio de siempre", () => {
    expect(practitionerChangePlan({ current: "p1", next: "p2", serviceId: "s1", reconciledServiceId: "s1" })).toEqual({
      serviceId: "s1",
      serviceChanged: false,
    });
  });
  it("otro profesional que NO atiende el servicio: el servicio se re-concilia y la consulta va con el nuevo", () => {
    expect(practitionerChangePlan({ current: "p1", next: "p2", serviceId: "s1", reconciledServiceId: "" })).toEqual({
      serviceId: "",
      serviceChanged: true,
    });
  });
});
