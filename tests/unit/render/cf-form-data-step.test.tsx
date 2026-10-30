/**
 * CF-FORM (§28, decisión 5 de Martin): «Tus datos» del turnero. Obligatorios: nombre, apellido, email, teléfono, DNI y
 * el «diagnóstico» de la vertical (Kinesiología → `title` «Diagnóstico»; General → `notes` «Motivo de consulta»). La
 * fecha de nacimiento es opcional. La regla pura (`isTurneroHcComplete` / `missingTurneroReason`) es la misma que usa el
 * submit (tests/integration/cf-form-turnero.test.ts) y el render tiene que marcar lo mismo.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DataStep } from "@/components/booking/wizard/data-step";
import type { PatientHC } from "@/components/booking/public-booking-wizard";
import { isTurneroHcComplete, missingTurneroReason, turneroReasonField } from "@/lib/public-wizard-state";
import type { PublicClinic } from "@/lib/public-booking-types";

const HC: PatientHC = {
  firstName: "Ana",
  lastName: "Pérez",
  email: "ana@test.local",
  phone: "1144556677",
  documentId: "30111222",
  dateOfBirth: "",
  coverageInsurer: "",
  coveragePlan: "",
  emergencyName: "",
  emergencyPhone: "",
  notes: "",
  title: "",
  description: "",
};

const clinic = (vertical?: "GENERAL" | "KINESIOLOGY"): PublicClinic & { vertical?: "GENERAL" | "KINESIOLOGY" } => ({
  slug: "demo",
  name: "Consultorio Demo",
  legalName: null,
  palette: "sky",
  practitioners: [],
  services: [],
  vertical,
});

const render = (vertical?: "GENERAL" | "KINESIOLOGY") =>
  renderToStaticMarkup(<DataStep clinic={clinic(vertical)} session={null} hc={HC} setHc={() => {}} error={null} />);
/** El bloque del `Field` (label + control) de un id. */
const field = (html: string, id: string) => {
  const start = html.indexOf(`for="booking-${id}"`);
  if (start < 0) return "";
  const next = html.indexOf('<label for="booking-', start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
const control = (html: string, id: string) =>
  html.match(new RegExp(`<(?:input|textarea)[^>]*id="booking-${id}"[^>]*>`))?.[0] ?? "";

describe("CF-FORM · regla pura", () => {
  it("[CF-D1] sin fecha de nacimiento alcanza (Kine con diagnóstico, General con motivo)", () => {
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia" }, "KINESIOLOGY")).toBe(true);
    expect(isTurneroHcComplete({ ...HC, notes: "Control" }, "GENERAL")).toBe(true);
    // Con fecha completa también; una fecha a medio tipear no.
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia", dateOfBirth: "1990-05-10" }, "KINESIOLOGY")).toBe(true);
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia", dateOfBirth: "1990-05" }, "KINESIOLOGY")).toBe(false);
  });

  it("[CF-D2] Kine exige el diagnóstico (no el motivo); General el motivo (no el diagnóstico); sin vertical = Kine", () => {
    expect(isTurneroHcComplete({ ...HC, notes: "Me duele" }, "KINESIOLOGY")).toBe(false);
    expect(isTurneroHcComplete({ ...HC, title: "   " }, "KINESIOLOGY")).toBe(false);
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia" }, "GENERAL")).toBe(false);
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia" }, undefined)).toBe(true);
    expect(isTurneroHcComplete({ ...HC, title: "Lumbalgia" }, null)).toBe(true);

    expect(missingTurneroReason({ title: "" }, "KINESIOLOGY")).toEqual({
      error: "Completá el diagnóstico.",
      fieldErrors: { title: ["Completá el diagnóstico."] },
    });
    expect(missingTurneroReason({ notes: " ", title: "x" }, "GENERAL")).toEqual({
      error: "Completá el motivo de consulta.",
      fieldErrors: { notes: ["Completá el motivo de consulta."] },
    });
    expect(missingTurneroReason({ title: "Lumbalgia" }, "KINESIOLOGY")).toBeNull();
    expect(turneroReasonField("GENERAL").label).toBe("Motivo de consulta");
    expect(turneroReasonField("KINESIOLOGY").label).toBe("Diagnóstico");
  });

  it("el resto de los obligatorios sigue igual", () => {
    const ok = { ...HC, title: "Lumbalgia" };
    for (const k of ["firstName", "lastName", "email", "phone", "documentId"] as const) {
      expect(isTurneroHcComplete({ ...ok, [k]: "" }, "KINESIOLOGY")).toBe(false);
    }
  });
});

describe("CF-FORM · render de «Tus datos»", () => {
  it("[CF-D1] fecha de nacimiento «(opcional)» y sin required", () => {
    for (const v of ["KINESIOLOGY", "GENERAL"] as const) {
      const html = render(v);
      expect(field(html, "dateOfBirth")).toContain("(opcional)");
      expect(control(html, "dateOfBirth")).not.toMatch(/\brequired\b/);
      expect(control(html, "dateOfBirth")).toContain('type="date"');
    }
  });

  it("[CF-D2] Kine: «Diagnóstico» obligatorio con hint, «Motivo de consulta» opcional", () => {
    const html = render("KINESIOLOGY");
    expect(field(html, "title")).not.toContain("(opcional)");
    expect(control(html, "title")).toMatch(/\brequired\b/);
    expect(field(html, "title")).toContain("Si no tenés un diagnóstico médico");
    expect(field(html, "notes")).toContain("(opcional)");
    expect(control(html, "notes")).not.toMatch(/\brequired\b/);
    // Sin vertical (PublicClinic viejo) = Kinesiología.
    expect(control(render(undefined), "title")).toMatch(/\brequired\b/);
  });

  it("[CF-ZF4 M5] Kine: el «Diagnóstico» obligatorio va antes del «Motivo de consulta» opcional", () => {
    const html = render("KINESIOLOGY");
    const title = html.indexOf('for="booking-title"');
    const notes = html.indexOf('for="booking-notes"');
    expect(title).toBeGreaterThan(-1);
    expect(notes).toBeGreaterThan(title);
  });

  it("[CF-D2] General: sin «Diagnóstico» y «Motivo de consulta» obligatorio", () => {
    const html = render("GENERAL");
    expect(html).not.toContain('id="booking-title"');
    expect(field(html, "notes")).toContain("Motivo de consulta");
    expect(field(html, "notes")).not.toContain("(opcional)");
    expect(control(html, "notes")).toMatch(/\brequired\b/);
  });

  it("los obligatorios de siempre no llevan «(opcional)»", () => {
    const html = render("KINESIOLOGY");
    for (const id of ["firstName", "lastName", "email", "phone", "documentId"]) {
      expect(field(html, id)).not.toContain("(opcional)");
      expect(control(html, id)).toMatch(/\brequired\b/);
    }
  });
});
