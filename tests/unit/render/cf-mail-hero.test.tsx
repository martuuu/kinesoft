import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF-G1] (§28 G · Mails): el aviso de «Enviar al portal» cuando el mail no sale. El cliente veía «No pudimos mandar
 * el mail…» igual si fallaba la generación del link de acceso (`link_<code>`) que si Resend rechazaba el envío
 * (`provider_error:…`), y no sabía qué hacer. Render estático del componente real (`PortalInviteNotice`, el mismo que
 * monta el hero); se mockea solo el módulo de server actions (no hay DB en unit) y el router.
 */
vi.mock("@/lib/patients", () => ({ sendPatientPortalInvite: vi.fn(), setPatientArchived: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/pacientes/x",
  useSearchParams: () => new URLSearchParams(),
}));

import { PORTAL_INVITE_COPY, PortalInviteNotice, type PortalInviteResult } from "@/components/patients/profile/hero";

const URL_PORTAL = "https://app.example.com/portal/c/consultorio-perez";
const failed = (emailReason: string, emailStatus = "failed"): PortalInviteResult => ({
  ok: true,
  emailSent: false,
  emailStatus,
  emailReason,
  portalUrl: URL_PORTAL,
});
const html = (r: PortalInviteResult, canSeeReason = false) =>
  renderToStaticMarkup(<PortalInviteNotice result={r} canSeeReason={canSeeReason} />);

describe("[CF-G1] aviso del hero cuando el mail del portal no sale", () => {
  it("[CF-G1] link_* → no pudimos generar el link, con el link y «Copiar»", () => {
    const out = html(failed("link_x"));
    expect(out).toContain("No pudimos generar el link de acceso. Probá de nuevo en unos minutos.");
    expect(out).not.toContain("El proveedor de mails rechazó el envío");
    expect(out).toContain(URL_PORTAL);
    expect(out).toContain("Copiar");
  });

  it("[CF-G1] provider_error:… → el proveedor rechazó el envío, con el link y «Copiar»", () => {
    const out = html(failed("provider_error:validation_error:403"));
    expect(out).toContain("El proveedor de mails rechazó el envío. Pasale este link al paciente:");
    expect(out).not.toContain("No pudimos generar el link");
    expect(out).toContain(URL_PORTAL);
    expect(out).toContain("Copiar");
  });

  it("[CF-G1] el código técnico lo ve solo quien administra", () => {
    const r = failed("provider_error:validation_error:403");
    expect(html(r, false)).not.toContain("validation_error");
    expect(html(r, true)).toContain("provider_error:validation_error:403");
    expect(html(failed("link_x"), true)).toContain("link_x");
  });

  it("[CF-G1] un reason con forma de dato (un email) no se muestra ni al admin", () => {
    const out = html(failed("invalid to: juan.perez@gmail.com"), true);
    expect(out).not.toContain("juan.perez@gmail.com");
    expect(out).toContain("El proveedor de mails rechazó el envío");
  });

  it("[CF-G1] enviado y entorno sin mails quedan como estaban", () => {
    expect(html({ ok: true, emailSent: true, portalUrl: URL_PORTAL, emailStatus: "sent", emailReason: null })).toContain(
      "Email enviado al paciente."
    );
    const skipped = html(failed("log_only", "skipped"), true);
    expect(skipped).toContain("Este entorno no manda mails");
    expect(skipped).toContain(URL_PORTAL);
  });

  it("[CF-G1] error de la action → el error, sin link", () => {
    const out = html({ ok: false, error: "No tenés acceso." });
    expect(out).toContain("No tenés acceso.");
    expect(out).not.toContain("Copiar");
  });
});

/*
 * [ZF3] M6 (CF-ZB): «El proveedor de mails rechazó el envío» salía también cuando el email del paciente era inválido
 * (`invalid_to`: lo corrige el profesional) o cuando Resend no contestó / limitó / no hubo red (reintentable). Los
 * códigos salen de `lib/email/transport.ts` (`EmailNotSentReason`); el de Resend viene con `:<name>:<status>` detrás.
 */
describe("[ZF3] M6 el aviso dice qué pasó según el código", () => {
  it("[ZF3] invalid_to → corregir el email en «Editar paciente», sin culpar al proveedor", () => {
    const out = html(failed("invalid_to"));
    expect(out).toContain("El email del paciente no es válido: corregilo en «Editar paciente».");
    expect(out).not.toContain("El proveedor de mails");
  });

  it.each(["rate_limited", "rate_limited:rate_limit_exceeded:429", "timeout", "network_error"])(
    "[ZF3] %s → reintentable: probá en unos minutos o pasale el link",
    (reason) => {
      const out = html(failed(reason));
      expect(out).toContain("No pudimos mandar el mail ahora. Probá de nuevo en unos minutos o pasale este link:");
      expect(out).not.toContain("El proveedor de mails");
      expect(out).toContain(URL_PORTAL);
    },
  );

  it("[ZF3] el resto sigue siendo del proveedor (provider_error, internal_error)", () => {
    for (const r of ["provider_error:validation_error:403", "internal_error"]) {
      expect(html(failed(r))).toContain(PORTAL_INVITE_COPY.providerFailed);
    }
  });

  it("[ZF3] B22: «Copiar» es un Button size=\"sm\"", () => {
    const out = html(failed("timeout"));
    expect(out).toMatch(/<button[^>]*class="[^"]*k-btn-sm[^"]*"[^>]*>Copiar<\/button>/);
  });
});
