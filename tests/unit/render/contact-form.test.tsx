/**
 * [VX2-c2] Contacto de la landing (C-VX-L): `LandingContact` (server) + `ContactForm` (cliente) en SSR puro.
 *
 * Se mockean `useFormState`/`useFormStatus` de `react-dom` (el react-dom de node_modules es el 18 estable y no los
 * trae; en la app los da el React canary de Next) para inyectar cada estado de la action, y la server action
 * `submitLeadForm` (red/base). El componente bajo test y su lógica (`contactFeedback`, `contactFieldError`) corren
 * reales. El foco al mensaje corre en un efecto (sin DOM acá): se afirma lo que lo hace posible, `tabIndex=-1` y el rol.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const form = vi.hoisted(() => ({ state: null as unknown, pending: false }));

vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  // La action real (una función) es lo que Next serializa; el react-dom 18 de node no la sabe pintar en SSR y avisa.
  useFormState: () => [form.state, "/"],
  useFormStatus: () => ({ pending: form.pending, data: null, method: null, action: null }),
}));
vi.mock("@/lib/leads", () => ({ submitLeadForm: vi.fn() }));

import { LandingContact } from "@/components/landing/contact";
import {
  CONTACT_ERROR_FALLBACK,
  contactFeedback,
  contactFieldError,
} from "@/components/landing/contact-form";

const STARTED = 1_760_000_000_000;
const html = () => renderToStaticMarkup(<LandingContact startedAt={STARTED} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  form.state = null;
  form.pending = false;
});

describe("[VX2-c2] LandingContact", () => {
  it("contrato C-VX-L: section#contacto con h2#contacto-title y el copy de §3.1", () => {
    const h = html();
    expect(h).toMatch(/<section id="contacto" aria-labelledby="contacto-title"/);
    expect(h).toContain('id="contacto-title"');
    const t = text(h);
    expect(t).toContain("Hablemos");
    expect(t).toContain("Contanos cómo trabaja tu consultorio. Te respondemos por email.");
    expect(t).toContain("Dudas sobre planes y precios");
    expect(t).toContain("Equipos de más de 10 usuarios (plan Libre)");
    expect(t).toContain("Ayuda para empezar");
    // PL-D15: no hay respuesta automática al lead.
    expect(t).not.toMatch(/te (mandamos|llega) un (e-?mail|correo|mail)/i);
  });

  it("startedAt OBLIGATORIO: hidden con el instante del render (sin JS queda ese)", () => {
    expect(html()).toContain(`<input type="hidden" name="startedAt" value="${STARTED}"/>`);
  });

  it("honeypot `website`: fuera del tab, sin autocompletar, contenedor aria-hidden", () => {
    const h = html();
    expect(h).toMatch(/<div class="[^"]*" aria-hidden="true"><label for="contact-website">No completar<\/label><input id="contact-website" name="website" type="text" tabindex="-1" autoComplete="off" value=""\/><\/div>/);
  });

  it("campos de D-VX19 con label real, autocomplete y los nombres de `submitLead`", () => {
    const h = html();
    for (const [id, name] of [
      ["contact-name", "name"],
      ["contact-email", "email"],
      ["contact-phone", "phone"],
      ["contact-clinic", "clinicName"],
      ["contact-plan", "planInterest"],
      ["contact-message", "message"],
    ]) {
      expect(h).toContain(`<label for="${id}" class="k-label">`);
      expect(h).toMatch(new RegExp(`name="${name}"[^>]*id="${id}"`));
    }
    expect(h).toContain('autoComplete="email"');
    expect(h).toContain('autoComplete="tel"');
    expect(h).toMatch(/<option value="" selected="">Todavía no sé<\/option>/);
    for (const v of ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]) expect(h).toContain(`<option value="${v}">`);
    expect(text(h)).toContain("No incluyas datos de pacientes.");
    expect(h).toMatch(/aria-describedby="contact-message-hint"/);
  });

  it("sin estado: no hay mensaje; botón «Enviar consulta»", () => {
    const h = html();
    expect(h).not.toContain('role="status"');
    expect(h).not.toContain('role="alert"');
    expect(text(h)).toContain("Enviar consulta");
  });

  it("éxito: role=status, enfocable, copy sin promesa de mail automático", () => {
    form.state = { ok: true, data: { received: true } };
    const h = html();
    expect(h).toMatch(/<div tabindex="-1" role="status" class="k-alert k-alert-success/);
    expect(text(h)).toContain("Recibimos tu consulta. Te respondemos al email que dejaste.");
  });

  it("error: role=alert, enfocable, con el error de la action y el campo marcado", () => {
    form.state = { ok: false, error: "Revisá el email.", fieldErrors: { email: ["Revisá el email."] } };
    const h = html();
    expect(h).toMatch(/<div tabindex="-1" role="alert" class="k-alert /);
    expect(text(h)).toContain("Revisá el email.");
    expect(h).toMatch(/name="email"[^>]*id="contact-email" aria-describedby="contact-email-error" aria-invalid="true" aria-errormessage="contact-email-error"/);
    expect(h).not.toMatch(/id="contact-name"[^>]*aria-invalid/);
  });

  it("enviando: aria-disabled y «Enviando…»", () => {
    form.pending = true;
    const h = html();
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*aria-disabled="true"/);
    expect(text(h)).toContain("Enviando…");
  });
});

describe("[VX2-c2] contactFeedback / contactFieldError", () => {
  it("mapea el ActionResult; error vacío cae al genérico", () => {
    expect(contactFeedback(null)).toBeNull();
    expect(contactFeedback({ ok: true, data: { received: true } })).toEqual({
      kind: "success",
      text: "Te respondemos al email que dejaste.",
    });
    expect(contactFeedback({ ok: false, error: "Probá de nuevo en 10 minutos." })).toEqual({
      kind: "error",
      text: "Probá de nuevo en 10 minutos.",
    });
    expect(contactFeedback({ ok: false, error: " " })).toEqual({ kind: "error", text: CONTACT_ERROR_FALLBACK });
    expect(contactFieldError({ ok: false, error: "x", fieldErrors: { name: ["Decinos tu nombre."] } }, "name")).toBe(
      "Decinos tu nombre."
    );
    expect(contactFieldError({ ok: true, data: { received: true } }, "name")).toBeUndefined();
  });
});
