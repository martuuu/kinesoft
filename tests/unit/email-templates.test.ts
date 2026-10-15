import { describe, it, expect } from "vitest";
import {
  staffInviteEmail,
  portalInviteEmail,
  portalMagicLinkEmail,
  emailVerificationEmail,
  passwordResetEmail,
  adminPasswordResetEmail,
  accountExistsEmail,
  welcomeEmail,
  tenantOwnerActivationEmail,
  platformAccessLinkEmail,
  supportAccessEmail,
  escapeHtml,
  safeHref,
  formatExpiryAR,
  EMAIL_COLORS,
} from "@/lib/email/templates";
import type { RenderedEmail } from "@/lib/email/types";

// [IAM-0b] Plantillas con marca (C-IAM1). Puras: ni red ni env.
//
// Lo que fijan: (1) todo dato de afuera (nombre del consultorio, de quien
// invita, rol, URL) sale escapado — un consultorio llamado `<a href=…>` no
// puede meter un link real en un mail con nuestra marca; (2) cada mail tiene
// la estructura de marca (wordmark, CTA, link de respaldo, pie con el porqué)
// y su parte en texto plano con el MISMO link; (3) voseo y sin emojis; (4) la
// fecha de vencimiento en hora argentina aunque el server corra en UTC.

const URL = "https://app.kinesoft.com.ar/auth/confirm?token_hash=abc123&type=invite&next=/agenda";
const URL_HTML = "https://app.kinesoft.com.ar/auth/confirm?token_hash=abc123&amp;type=invite&amp;next=/agenda";
const EXPIRES = new Date("2026-10-21T02:30:00Z"); // 20/10 23:30 en AR: el día cambia con UTC

const PAYLOAD = '<a href="https://evil.example">Hacé clic</a>';
const RAW = '<a href="https://evil.example"';

const ALL: Array<[string, () => RenderedEmail]> = [
  ["staffInvite", () => staffInviteEmail({ tenantName: "Consultorio Ramos", inviterName: "Laura Ramos", roleLabel: "Profesional", url: URL, expiresAt: EXPIRES })],
  ["portalInvite", () => portalInviteEmail({ tenantName: "Consultorio Ramos", url: URL })],
  ["portalMagicLink", () => portalMagicLinkEmail({ tenantName: "Consultorio Ramos", url: URL })],
  ["emailVerification", () => emailVerificationEmail({ url: URL })],
  ["passwordReset", () => passwordResetEmail({ url: URL })],
  ["adminPasswordReset", () => adminPasswordResetEmail({ tenantName: "Consultorio Ramos", url: URL })],
  ["accountExists", () => accountExistsEmail({ loginUrl: URL, resetUrl: "https://app.kinesoft.com.ar/reset" })],
  ["welcome", () => welcomeEmail({ tenantName: "Consultorio Ramos", url: URL })],
  // BO2: mails de Plataforma.
  ["tenantActivation", () => tenantOwnerActivationEmail({ tenantName: "Consultorio Ramos", url: URL })],
  ["platformAccessLink activation", () => platformAccessLinkEmail({ url: URL, purpose: "activation" })],
  ["platformAccessLink recovery", () => platformAccessLinkEmail({ url: URL, purpose: "recovery" })],
  ["supportAccess", () => supportAccessEmail({ tenantName: "Consultorio Ramos", superadminEmail: "soporte@kinesoft.com.ar", startedAt: EXPIRES, url: URL })],
];

// Pictográficos + variación: cualquier emoji en asunto, html o texto.
const EMOJI = /\p{Extended_Pictographic}/u;

describe("estructura de marca, igual en todas", () => {
  it.each(ALL)("%s", (_n, render) => {
    const m = render();
    expect(m.subject.length).toBeGreaterThan(5);
    expect(m.subject).not.toMatch(/[\r\n<>]/);
    // Layout: doctype, lang es, tabla de 600 px, estilos inline, sin hojas externas ni imágenes obligatorias.
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
    expect(m.html).toContain('lang="es"');
    expect(m.html).toContain("max-width:600px");
    expect(m.html).toContain('role="presentation"');
    expect(m.html).not.toMatch(/<link\b|<script\b|<img\b|var\(--/);
    // Wordmark en el encabezado.
    expect(m.html).toMatch(/>Kine<\/span><span[^>]*>Soft</);
    // CTA + link de respaldo.
    expect(m.html).toContain("Copiá y pegá este link");
    expect(m.html).toContain(`href="${URL_HTML}"`);
    // Pie con el porqué.
    expect(m.html).toContain("Te llegó este mail porque");
    // Texto plano equivalente: el link crudo (sin &amp;), sin tags.
    expect(m.text).toContain(URL);
    expect(m.text).not.toMatch(/<[a-z]/i);
    expect(m.text).toContain("Te llegó este mail porque");
    for (const s of [m.subject, m.html, m.text]) expect(s).not.toMatch(EMOJI);
    // Voseo: nada de «usted»/«haga clic».
    expect(`${m.html} ${m.text}`).not.toMatch(/\busted\b|haga clic|ingrese|su contraseña/i);
  });
});

describe("copy por plantilla", () => {
  it("staff_invite: quién invita, consultorio, rol, CTA y vencimiento en hora AR", () => {
    const m = staffInviteEmail({ tenantName: "Consultorio Ramos", inviterName: "Laura Ramos", roleLabel: "Profesional", url: URL, expiresAt: EXPIRES });
    expect(m.text).toContain("Laura Ramos te invitó a sumarte a Consultorio Ramos en KineSoft como Profesional.");
    expect(m.html).toMatch(/<strong[^>]*>Laura Ramos<\/strong> te invitó a sumarte a <strong[^>]*>Consultorio Ramos<\/strong> en KineSoft como <strong[^>]*>Profesional<\/strong>\./);
    expect(m.html).toContain("Aceptar invitación");
    expect(m.html).toContain("20 de octubre de 2026");
    expect(m.html).toContain("23:30");
    expect(m.text).toContain("20 de octubre de 2026");
    expect(m.subject).toContain("Consultorio Ramos");
  });
  it("staff_invite sin quien invita: copy impersonal", () => {
    const m = staffInviteEmail({ tenantName: "Consultorio Ramos", inviterName: null, roleLabel: "Secretaria", url: URL, expiresAt: EXPIRES });
    expect(m.text).toContain("Te invitaron a sumarte a Consultorio Ramos en KineSoft como Secretaria.");
    expect(m.html).not.toContain("null");
    expect(m.text).not.toContain("null");
  });
  it("portal_invite", () => {
    const m = portalInviteEmail({ tenantName: "Consultorio Ramos", url: URL });
    expect(m.text).toContain("Consultorio Ramos te dio acceso a tu portal de paciente.");
    expect(m.html).toContain("Entrar a mi portal");
  });
  it("portal_magic_link: vence en 1 hora; con y sin consultorio", () => {
    const a = portalMagicLinkEmail({ tenantName: "Consultorio Ramos", url: URL });
    expect(a.html).toContain("Tu link para entrar al portal");
    expect(a.html).toContain("1 hora");
    const b = portalMagicLinkEmail({ tenantName: null, url: URL });
    expect(b.html).toContain("Tu link para entrar al portal");
    expect(b.html).not.toContain("null");
  });
  it("email_verification", () => {
    expect(emailVerificationEmail({ url: URL }).html).toContain("Confirmá tu email para terminar de crear tu cuenta.");
  });
  it("password_reset: con el «si no fuiste vos»", () => {
    const m = passwordResetEmail({ url: URL });
    expect(m.html).toContain("Pediste restablecer tu contraseña.");
    expect(m.html).toContain("Si no fuiste vos, ignorá este mail.");
    expect(m.text).toContain("Si no fuiste vos, ignorá este mail.");
  });
  it("admin_password_reset", () => {
    expect(adminPasswordResetEmail({ tenantName: "Consultorio Ramos", url: URL }).text).toContain(
      "Consultorio Ramos te mandó un link para crear una contraseña nueva.",
    );
  });
  it("account_exists: dos CTAs (Ingresar y Recuperar contraseña) con sus links", () => {
    const m = accountExistsEmail({ loginUrl: "https://app.kinesoft.com.ar/login", resetUrl: "https://app.kinesoft.com.ar/reset" });
    expect(m.html).toContain("Ya tenés una cuenta en KineSoft con este email.");
    expect(m.html).toContain(">Ingresar<");
    expect(m.html).toContain(">Recuperar contraseña<");
    expect(m.html).toContain('href="https://app.kinesoft.com.ar/login"');
    expect(m.html).toContain('href="https://app.kinesoft.com.ar/reset"');
    expect(m.text).toContain("https://app.kinesoft.com.ar/login");
    expect(m.text).toContain("https://app.kinesoft.com.ar/reset");
  });
  it("welcome", () => {
    const m = welcomeEmail({ tenantName: "Consultorio Ramos", url: URL });
    expect(m.text).toContain("Ya sos parte de Consultorio Ramos en KineSoft.");
    expect(m.html).toContain("Ir a KineSoft");
  });
});

describe("plantillas de Plataforma (BO2)", () => {
  it("tenant_activation: titular, CTA, vence en 1 hora y el porqué", () => {
    const m = tenantOwnerActivationEmail({ tenantName: "Consultorio Ramos", url: URL });
    expect(m.subject).toBe("Tu consultorio Consultorio Ramos ya está en KineSoft");
    expect(m.text).toContain("Activá tu acceso");
    expect(m.text).toContain("Te dimos de alta como titular de Consultorio Ramos en KineSoft.");
    expect(m.text).toContain("El link vence en 1 hora y sirve una sola vez.");
    expect(m.text).toContain("Activar mi acceso");
    expect(m.text).toContain("creó el consultorio Consultorio Ramos con este email como titular");
  });

  it("[BO-Z] tenant_activation con needsPassword:false (ya tiene cuenta): no pide elegir contraseña", () => {
    const m = tenantOwnerActivationEmail({ tenantName: "Consultorio Ramos", url: URL, needsPassword: false });
    expect(m.text).toContain(
      "Tocá el botón para entrar al consultorio. También podés entrar con tu email y tu contraseña de siempre."
    );
    expect(m.text).toContain("Entrar al consultorio");
    expect(m.text).not.toMatch(/elegir tu contraseña|Activar mi acceso/);
    expect(m.text).toContain("Te dimos de alta como titular de Consultorio Ramos en KineSoft.");
  });

  it("platform_access_link: activación y recuperación con copy distinto, firmado por soporte de KineSoft", () => {
    const a = platformAccessLinkEmail({ url: URL, purpose: "activation" });
    const r = platformAccessLinkEmail({ url: URL, purpose: "recovery" });
    expect(a.subject).toBe("Activá tu acceso a KineSoft");
    expect(r.subject).not.toBe(a.subject);
    expect(a.text).toContain("Activar mi acceso");
    expect(r.text).toContain("Elegir contraseña nueva");
    for (const m of [a, r]) expect(m.text).toContain("soporte de KineSoft");
  });

  it("support_access: quién, cuándo (hora AR), sin HC, dónde ver la lista; el motivo tipeado NO viaja", () => {
    const m = supportAccessEmail({ tenantName: "Consultorio Ramos", superadminEmail: "soporte@kinesoft.com.ar", startedAt: EXPIRES, url: URL });
    expect(m.subject).toBe("Soporte de KineSoft entró a Consultorio Ramos");
    expect(m.text).toContain("soporte@kinesoft.com.ar");
    expect(m.text).toContain("20 de octubre de 2026");
    // [BO-Z] C8: «… a las HH:MM …» y rol con género neutro.
    expect(m.text).toMatch(/20 de octubre de 2026 a las \d{2}:\d{2}/);
    expect(m.text).toContain("un/a Secretario/a");
    expect(m.text).toContain("nada de historia clínica");
    expect(m.text).toContain("Configuración → Accesos de soporte");
    expect(m.text).not.toMatch(/Motivo:/);
  });
});

describe("escape de todo dato de afuera", () => {
  const evil = [
    () => staffInviteEmail({ tenantName: PAYLOAD, inviterName: PAYLOAD, roleLabel: PAYLOAD, url: URL, expiresAt: EXPIRES }),
    () => portalInviteEmail({ tenantName: PAYLOAD, url: URL }),
    () => portalMagicLinkEmail({ tenantName: PAYLOAD, url: URL }),
    () => adminPasswordResetEmail({ tenantName: PAYLOAD, url: URL }),
    () => welcomeEmail({ tenantName: PAYLOAD, url: URL }),
    () => tenantOwnerActivationEmail({ tenantName: PAYLOAD, url: URL }),
    () => supportAccessEmail({ tenantName: PAYLOAD, superadminEmail: PAYLOAD, startedAt: EXPIRES, url: URL }),
  ];
  it.each(evil.map((f, i) => [i, f] as const))("plantilla #%i: el nombre no se interpreta como HTML", (_i, render) => {
    const m = render();
    expect(m.html).not.toContain(RAW);
    expect(m.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(m.html).not.toContain("&amp;lt;");
    // El asunto es texto plano: sin < ni saltos (cabecera).
    expect(m.subject).not.toMatch(/[<>\r\n]/);
  });

  it("una URL con comillas no rompe el atributo href", () => {
    const m = emailVerificationEmail({ url: 'https://app.kinesoft.com.ar/x?a="><script>alert(1)</script>' });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("una URL que no es http(s) no llega al href", () => {
    const m = emailVerificationEmail({ url: "javascript:alert(1)" });
    expect(m.html).not.toContain("javascript:");
    expect(m.text).not.toContain("javascript:");
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("data:text/html,x")).toBe("#");
    expect(safeHref("https://a.com/x")).toBe("https://a.com/x");
    expect(safeHref("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });

  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("saltos de línea en el nombre no llegan al asunto", () => {
    const m = welcomeEmail({ tenantName: "Kine\r\nBcc: x@y.com", url: URL });
    expect(m.subject).not.toMatch(/[\r\n]/);
  });
});

describe("fechas y colores", () => {
  it("formatExpiryAR: en hora argentina aunque el proceso corra en UTC", () => {
    expect(formatExpiryAR(EXPIRES)).toBe("20 de octubre de 2026, 23:30");
  });
  it("los colores son hex literales de la paleta (los clientes de mail no leen var())", () => {
    for (const v of Object.values(EMAIL_COLORS)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(EMAIL_COLORS.brand).toBe("#1f4fbe"); // --sky-700
    expect(EMAIL_COLORS.ink).toBe("#0f1e33"); // --navy-900
  });
});
