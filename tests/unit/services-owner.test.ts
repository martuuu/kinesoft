import { describe, it, expect } from "vitest";
import { ServiceCreateInput, serviceOwnerFor, serviceScopeOf } from "@/lib/services-schemas";

/**
 * [CF3-SV7] CF3b · sesión SV: quién queda como dueño del servicio que se crea con «Para todo el consultorio»
 * (`forClinic`). La pertenencia y que el dueño sea reservable las prueba `tests/integration/cf3-own-services.test.ts`
 * ([CF3-SV1..6]) contra la base; acá, la tabla de la regla pura.
 */
const pro = { practitionerId: "p1" };
const noAgenda = { practitionerId: null };

describe("[CF3-SV7] serviceOwnerFor", () => {
  it("marcado: del consultorio por cualquier vía, aunque venga un profesional (el checkbox gana en el alta)", () => {
    expect(serviceOwnerFor(pro, { via: "self", forClinic: true })).toBeNull();
    expect(serviceOwnerFor(pro, { via: "config", forClinic: true, practitionerId: "p2" })).toBeNull();
    expect(serviceOwnerFor(noAgenda, { via: "config", forClinic: true })).toBeNull();
  });

  it("vía propia, desmarcado o sin el campo: del profesional del actor", () => {
    expect(serviceOwnerFor(pro, { via: "self", forClinic: false })).toBe("p1");
    expect(serviceOwnerFor(pro, { via: "self" })).toBe("p1");
  });

  it("«Configuración» desmarcado: el elegido; sin elegir, el propio si atiende; sin agenda propia, del consultorio", () => {
    expect(serviceOwnerFor(pro, { via: "config", forClinic: false, practitionerId: "p2" })).toBe("p2");
    expect(serviceOwnerFor(pro, { via: "config", forClinic: false })).toBe("p1");
    expect(serviceOwnerFor(pro, { via: "config", forClinic: false, practitionerId: null })).toBe("p1");
    expect(serviceOwnerFor(noAgenda, { via: "config", forClinic: false })).toBeNull();
  });

  it("«Configuración» sin el campo (cliente de antes): vacío = del consultorio, como siempre", () => {
    expect(serviceOwnerFor(pro, { via: "config" })).toBeNull();
    expect(serviceOwnerFor(pro, { via: "config", practitionerId: "p2" })).toBe("p2");
  });

  it("scope del audit y schema: booleano estricto, y la edición no lo conoce", () => {
    expect(serviceScopeOf(null)).toBe("clinic");
    expect(serviceScopeOf("p1")).toBe("own");
    expect(ServiceCreateInput.safeParse({ name: "X", forClinic: true }).success).toBe(true);
    expect(ServiceCreateInput.safeParse({ name: "X", forClinic: "true" }).success).toBe(false);
    expect(ServiceCreateInput.safeParse({ name: "X" }).data?.forClinic).toBeUndefined();
  });
});
