/**
 * PV · TK-S1 (§27) · piezas puras del intake: el prefijo del asunto por origen (`ticketSubject`) y los mails al inbox
 * con origen. Los tickets de SESIÓN que entran como lead no llevan el texto en el mail (quien escribe es un usuario de
 * la app, puede pegar un dato de un paciente); los leads de la web sí (PL-2d, sin cambios).
 */
import { describe, it, expect } from "vitest";
import { ticketSubject } from "@/lib/support-threads-internal";
import { leadReceivedEmail, leadReplyEmail, supportMessagePlatformEmail } from "@/lib/email/templates-support";
import { SUPPORT_TEAM_NAME } from "@/lib/support-threads-types";
import { BRAND_NAME } from "@/lib/brand";

describe("[TK-S1] intake: piezas puras", () => {
  it("ticketSubject: prefijo por origen, sin prefijo en LANDING y en los del consultorio, recorte a 200", () => {
    expect(ticketSubject("PRICING", "Consulta de Ana")).toBe("Precio · Consulta de Ana");
    expect(ticketSubject("PLAN_LIBRE", "Consulta de Ana")).toBe("Plan Libre · Consulta de Ana");
    expect(ticketSubject("SIGNUP_ASSISTED", "Consulta de Ana")).toBe("Alta asistida · Consulta de Ana");
    expect(ticketSubject("ACCOUNT_DISABLED", "Ana")).toBe("Cuenta desactivada · Ana");
    expect(ticketSubject("TENANT_SUSPENDED", "Ana")).toBe("Consultorio suspendido · Ana");
    expect(ticketSubject("ONBOARDING", "Ana")).toBe("Alta en curso · Ana");
    expect(ticketSubject("LANDING", "Consulta de Ana")).toBe("Consulta de Ana");
    expect(ticketSubject("PLAN_CHANGE", "Quiero Clínica")).toBe("Quiero Clínica");
    const long = ticketSubject("PRICING", "x".repeat(300));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("aviso al inbox: el origen va delante del asunto; sin origen, el asunto de siempre", () => {
    const base = { tenantName: "Kine Centro", subject: "Cobro", isReply: false, url: "https://app.example/plataforma/mensajes/t1" };
    expect(supportMessagePlatformEmail(base).subject).toBe("Mensaje de Kine Centro: Cobro");
    expect(supportMessagePlatformEmail({ ...base, sourceLabel: "Elegir plan" }).subject).toBe("Elegir plan · Mensaje de Kine Centro: Cobro");
  });

  it("lead: con origen lo dice; el ticket de sesión NO lleva el texto del mensaje", () => {
    const p = {
      name: "Ana",
      email: "ana@example.com",
      phone: null,
      clinicName: null,
      planLabel: null,
      message: "Mi paciente Zqxtks1 no puede…",
      url: "https://app.example/plataforma/mensajes/l1",
    };
    const web = leadReceivedEmail({ ...p, sourceLabel: "Web · precios" });
    expect(web.subject).toBe("Web · precios · Consulta de Ana");
    expect(web.text).toContain("Zqxtks1");
    expect(web.text).toContain("Origen: Web · precios");

    const session = leadReceivedEmail({ ...p, sourceLabel: "Cuenta desactivada", includeMessage: false });
    expect(session.subject).toBe("Cuenta desactivada · Consulta de Ana");
    expect(session.text).not.toContain("Zqxtks1");
    expect(session.html).not.toContain("Zqxtks1");
    expect(session.text).toContain("el mensaje no viene en este mail");
  });

  it("la firma de la respuesta al lead sale de BRAND_NAME (SUPPORT_TEAM_NAME), no de un literal", () => {
    expect(SUPPORT_TEAM_NAME).toBe(`Equipo de ${BRAND_NAME}`);
    expect(leadReplyEmail({ name: "Ana", subject: "Hola", body: "Listo." }).text).toContain(SUPPORT_TEAM_NAME);
  });
});
