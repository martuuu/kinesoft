import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, fieldIds } from "@/components/ui/field";
import { PasswordInput, passwordToggleState } from "@/components/ui/password-input";
import { FormField } from "@/components/ui/form-field";

/**
 * [VX F-b2] C-F5: `Field` (ids/aria estables, server-safe), `PasswordInput` (mostrar/ocultar) y `FormField` sobre las
 * clases de C-F2 con `autoComplete` (cierra `formfield-sin-autocomplete-new-password`). SSR puro, sin jsdom: el toggle
 * se prueba por su función de estado, que es la que usa el componente.
 */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("[VX F-b2] Field", () => {
  it("label apunta al control; sin hint ni error no inventa aria", () => {
    const html = render(
      <Field id="email" label="Email">
        <input className="k-input" type="email" autoComplete="email" />
      </Field>,
    );
    expect(html).toContain('<label for="email" class="k-label">Email</label>');
    expect(html).toContain('<input class="k-input" type="email" autoComplete="email" id="email"/>');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });

  it("hint + error: aria-describedby suma ambos (y conserva el propio), aria-invalid y aria-errormessage", () => {
    const ids = fieldIds("pw");
    expect(ids).toEqual({ hint: "pw-hint", error: "pw-error" });
    const html = render(
      <Field id="pw" label="Contraseña" hint="Mínimo 8 caracteres" error="Es muy corta">
        <input className="k-input" aria-describedby="extra" />
      </Field>,
    );
    expect(html).toContain('aria-describedby="extra pw-hint pw-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-errormessage="pw-error"');
    expect(html).toContain('<p id="pw-hint" class="k-hint"');
    expect(html).toMatch(/<p id="pw-error" class="k-field-error"[^>]*><svg[^>]*aria-hidden="true"/);
    expect(html).toContain("Es muy corta");
  });

  it("optional y labelAside van en la fila del label", () => {
    const html = render(
      <Field id="tel" label="Teléfono" optional labelAside={<a href="/forgot">¿Olvidaste tu contraseña?</a>}>
        <input className="k-input" />
      </Field>,
    );
    expect(html).toContain('<div class="k-field-row"><label for="tel" class="k-label">Teléfono<span class="k-hint"> (opcional)</span></label><a href="/forgot">');
  });
});

describe("[VX F-b2] PasswordInput", () => {
  it("arranca oculto: type=password, botón con aria-pressed=false y «Mostrar contraseña»", () => {
    const html = render(
      <Field id="password" label="Contraseña" error="Requerida">
        <PasswordInput autoComplete="new-password" name="password" large />
      </Field>,
    );
    expect(html).toContain('<div class="k-input-wrap">');
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<input[^>]*autoComplete="new-password"/);
    expect(html).toMatch(/<input[^>]*id="password"/);
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*class="k-input k-input-lg"/);
    expect(html).toMatch(
      /<button type="button" class="k-input-action" aria-pressed="false" aria-label="Mostrar contraseña" aria-controls="password"/,
    );
  });

  it("toggle: mostrado = type=text, aria-pressed=true, «Ocultar contraseña»", () => {
    expect(passwordToggleState(false)).toEqual({ type: "password", pressed: false, label: "Mostrar contraseña" });
    expect(passwordToggleState(true)).toEqual({ type: "text", pressed: true, label: "Ocultar contraseña" });
  });
});

describe("[VX F-b2] FormField (misma API, clases de C-F2)", () => {
  it("input: .k-field/.k-label/.k-input, label con for, autoComplete pasa", () => {
    const html = render(
      <FormField label="Contraseña nueva" name="password" type="password" autoComplete="new-password" required />,
    );
    expect(html).toMatch(/^<div class="k-field"/);
    const id = html.match(/<input id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}" class="k-label"`);
    expect(html).toMatch(/<input[^>]*autoComplete="new-password"[^>]*class="k-input"[^>]*name="password"[^>]*type="password"/);
    expect(html).not.toMatch(/outline:\s*none/);
  });

  it("error: aria-invalid + aria-describedby al mensaje .k-field-error (sin hex suelto)", () => {
    const html = render(<FormField label="Email" name="email" error="Email inválido" hint="Te escribimos acá" />);
    const id = html.match(/<input id="([^"]+)"/)?.[1];
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`aria-describedby="${id}-error"`);
    expect(html).toContain(`<span id="${id}-error" class="k-field-error">Email inválido</span>`);
    expect(html).not.toContain("Te escribimos acá");
    expect(html).not.toMatch(/#9F1F1F/i);
  });

  it("hint sin error, textarea y select también reciben las clases y el id", () => {
    const hint = render(<FormField label="Notas" as="textarea" name="n" hint="Opcional" rows={4} />);
    expect(hint).toMatch(/<textarea id="([^"]+)" aria-describedby="\1-hint" class="k-input" name="n" rows="4">/);
    const sel = render(
      <FormField label="Tipo" as="select" name="t" options={[{ value: "a", label: "A" }]} defaultValue="a" />,
    );
    expect(sel).toMatch(/<select id="[^"]+" class="k-input" name="t">/);
  });

  it("label vacío no renderiza label; datetime-local sigue con el picker y el hidden input", () => {
    const html = render(<FormField label="" name="when" type="datetime-local" defaultValue="2026-10-15T10:00" />);
    expect(html).not.toContain("<label");
    expect(html).toContain('<input type="hidden" name="when" value="2026-10-15T10:00"/>');
  });
});
