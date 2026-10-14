/**
 * Plantillas de mail con la marca KineSoft (IAM-0b, C-IAM1). PURAS: ni red ni
 * env ni `server-only` (las importan los tests y el script de diagnóstico).
 * Cada una devuelve `{ subject, html, text }` listo para `sendEmail`.
 *
 * Layout (portado del v2 de Traze, con la paleta de KineSoft):
 *  - Tabla de 600 px con estilos INLINE: Gmail y Outlook descartan `<style>` en
 *    muchos casos y no leen variables CSS, por eso los colores son los hex
 *    literales de `app/globals.css` (EMAIL_COLORS) y no `var(--sky-700)`.
 *  - Sin imágenes, fuentes web ni píxeles de seguimiento: la marca es un
 *    wordmark en texto («Kine» navy + «Soft» sky, con la «K» en un cuadrado
 *    sky-700 como el `KineLogo`). Se ve igual con las imágenes bloqueadas,
 *    que es el default de muchos clientes corporativos.
 *  - `color-scheme: light` declarado y fondo explícito en cada celda, para que
 *    la inversión automática del modo oscuro no deje texto navy sobre negro.
 *  - CTA "a prueba de balas" (tabla con bgcolor, no un `<a>` con padding solo:
 *    Outlook lo ignora), alto ≥ 48 px, y debajo el link de respaldo para
 *    copiar (algunos clientes rompen los botones o los escáneres corporativos
 *    reescriben el href).
 *  - Pie: por qué te llegó el mail y cuándo vence el link.
 *  - Parte en texto plano con el MISMO contenido y el link crudo: mejora la
 *    entregabilidad (los filtros penalizan html sin texto) y es lo que leen los
 *    lectores de pantalla y los relojes.
 *
 * Seguridad: TODO dato de afuera (nombre del consultorio, de quien invita, rol,
 * URLs) pasa por `escapeHtml` en el html. Un consultorio llamado
 * `<a href="…">Hacé clic</a>` metería un link real en un mail con nuestra marca
 * (pasó en Traze, S3.7). Las URLs además pasan por `safeHref`: solo http(s).
 * El asunto es texto de cabecera: sin saltos ni `<>`.
 *
 * Copy en voseo rioplatense, sin emojis (los filtros de spam los penalizan y se
 * ven distinto en cada cliente).
 *
 * Duración de los links: los de Supabase (magic link, verificación, reset)
 * vencen según "Email OTP Expiration" del proyecto, que por default es 1 hora.
 * Si Martin la cambia en la consola, hay que cambiar `SUPABASE_LINK_TTL_COPY`.
 */
import type { RenderedEmail } from "@/lib/email/types";

/** Hex de los tokens de `app/globals.css` (paleta base, no la reasignada por `[data-palette]`). */
export const EMAIL_COLORS = {
  ink: "#0f1e33", // --navy-900: títulos y cuerpo (16:1 sobre blanco)
  body: "#1b2d4a", // --navy-700: párrafos
  muted: "#5a6b87", // --navy-400: secundario y pie (5.4:1, AA)
  brand: "#1f4fbe", // --sky-700: botón, «Soft», enlaces (6.6:1 con blanco)
  brandSoft: "#5e92cc", // --sky-500: borde del botón secundario
  accent: "#c8f564", // --lime-300: punto del logo
  canvas: "#eef4fb", // entre --sky-50 y --sky-100: fondo exterior
  card: "#ffffff",
  panel: "#f6f9fd", // --bg-panel: recuadro del link de respaldo
  line: "#d2e2f4", // --sky-200: filetes y bordes
  white: "#ffffff",
} as const;

const C = EMAIL_COLORS;

/** Pila de sistema (sin fuentes web). En Outlook (mso) todo cae a Arial. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

const AR_TZ = "America/Argentina/Buenos_Aires";

/** Copy de vencimiento de los links que emite Supabase (ver cabecera). */
export const SUPABASE_LINK_TTL_COPY = "1 hora";

// ── Escapes ──────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** La URL si es http(s); si no (`javascript:`, `data:`, basura), `#`. Sin escapar: escapá al usar. */
export function safeHref(url: string): string {
  const v = (url ?? "").trim();
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : "#";
  } catch {
    return "#";
  }
}

/** Texto de afuera para una línea de texto plano o un asunto: sin saltos ni controles. */
function plain(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/** Asunto: texto de cabecera, sin `<>` (algunos clientes los interpretan) y con techo. */
function subjectLine(s: string): string {
  const v = plain(s).replace(/[<>]/g, "");
  return v.length <= 120 ? v : `${v.slice(0, 119).trimEnd()}…`;
}

/**
 * «20 de octubre de 2026, 23:30» en hora argentina, aunque el server corra en
 * UTC (Vercel): con el TZ del host, una invitación que vence 23:30 AR diría
 * "21 de octubre, 02:30".
 */
export function formatExpiryAR(d: Date): string {
  const date = d.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: AR_TZ });
  const time = d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: AR_TZ });
  return `${date}, ${time}`;
}

// ── Piezas del layout ────────────────────────────────────────────────────────

const P = `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:26px;color:${C.body};`;
const P_SMALL = `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};`;

/** Párrafo de cuerpo. `html` ya escapado por quien lo arma. */
function para(html: string): string {
  return `<p style="${P}">${html}</p>`;
}

/** Botón primario (sólido sky-700) o secundario (contorno). `href` CRUDO: se valida y escapa acá. */
function button(href: string, label: string, variant: "primary" | "secondary" = "primary"): string {
  const h = escapeHtml(safeHref(href));
  const primary = variant === "primary";
  const bg = primary ? C.brand : C.white;
  const fg = primary ? C.white : C.brand;
  const border = primary ? C.brand : C.brandSoft;
  return `<table role="presentation" class="ks-btn" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:8px 0 0;">
  <tr><td align="center" bgcolor="${bg}" style="background-color:${bg};border:1px solid ${border};border-radius:10px;">
    <a href="${h}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:${fg};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}

/** «¿El botón no funciona?» + la URL entera en un recuadro, partible. */
function fallbackLink(href: string): string {
  const h = escapeHtml(safeHref(href));
  return `<p style="margin:28px 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">¿El botón no funciona? Copiá y pegá este link en tu navegador:</p>
<p style="margin:0;padding:12px 14px;background-color:${C.panel};border:1px solid ${C.line};border-radius:8px;font-family:${MONO};font-size:12px;line-height:18px;word-break:break-all;"><a href="${h}" target="_blank" rel="noopener" style="color:${C.brand};text-decoration:underline;">${h}</a></p>`;
}

type LayoutParts = {
  /** Texto de vista previa en la bandeja (texto plano; se escapa acá). */
  preheader: string;
  /** Rótulo a la derecha del encabezado: el consultorio, o el tipo de mensaje. Texto plano. */
  context: string | null;
  /** H1. Texto plano. */
  title: string;
  /** Cuerpo en HTML (cada dato de afuera YA escapado por quien lo arma). */
  bodyHtml: string;
  /** Pie: por qué te llegó y el vencimiento. Texto plano, una línea por ítem. */
  footer: string[];
};

function layout(p: LayoutParts): string {
  const pre = escapeHtml(p.preheader.slice(0, 110));
  const ctx = p.context ? escapeHtml(p.context) : "";
  return `<!doctype html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(p.title)}</title>
<!--[if mso]><style>* { font-family: Arial, sans-serif !important; }</style><![endif]-->
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  @media (max-width: 480px) {
    .ks-pad { padding-left: 22px !important; padding-right: 22px !important; }
    .ks-h1 { font-size: 22px !important; line-height: 28px !important; }
    .ks-btn { width: 100% !important; }
    .ks-btn a { display: block !important; }
    .ks-ctx { display: none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.canvas};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.canvas};font-size:1px;line-height:1px;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.canvas}" style="background-color:${C.canvas};">
<tr><td align="center" style="padding:32px 12px;background-color:${C.canvas};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="width:100%;max-width:600px;background-color:${C.card};border:1px solid ${C.line};border-radius:14px;border-collapse:separate;">
    <tr><td height="4" style="height:4px;background-color:${C.brand};border-radius:14px 14px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td class="ks-pad" style="padding:24px 40px 20px;background-color:${C.card};border-bottom:1px solid ${C.line};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle" style="font-family:${FONT};">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="30" height="30" align="center" valign="middle" bgcolor="${C.brand}" style="width:30px;height:30px;background-color:${C.brand};border-radius:9px;font-family:${FONT};font-size:17px;line-height:30px;font-weight:800;color:${C.white};">K</td>
            <td style="padding-left:10px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:700;letter-spacing:-0.02em;"><span style="color:${C.ink};">Kine</span><span style="color:${C.brand};">Soft</span></td>
          </tr></table>
        </td>
        ${ctx ? `<td class="ks-ctx" align="right" valign="middle" style="font-family:${FONT};font-size:13px;line-height:18px;color:${C.muted};">${ctx}</td>` : ""}
      </tr></table>
    </td></tr>
    <tr><td class="ks-pad" style="padding:36px 40px 32px;background-color:${C.card};">
      <h1 class="ks-h1" style="margin:0 0 20px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:700;letter-spacing:-0.01em;color:${C.ink};">${escapeHtml(p.title)}</h1>
      ${p.bodyHtml}
    </td></tr>
    <tr><td class="ks-pad" style="padding:20px 40px 28px;background-color:${C.panel};border-top:1px solid ${C.line};border-radius:0 0 14px 14px;">
      ${p.footer.map((l) => `<p style="${P_SMALL}">${escapeHtml(l)}</p>`).join("\n      ")}
      <p style="margin:14px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};"><strong style="color:${C.ink};">KineSoft</strong> · Gestión para consultorios de kinesiología y osteopatía</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

type TextParts = {
  title: string;
  paragraphs: string[];
  ctas: Array<{ label: string; url: string }>;
  footer: string[];
};

function textBody(t: TextParts): string {
  const lines = [
    "KineSoft",
    "",
    t.title,
    "",
    ...t.paragraphs.flatMap((p) => [p, ""]),
    ...t.ctas.flatMap((c) => [`${c.label}:`, safeHref(c.url), ""]),
    "--",
    ...t.footer,
    "",
    "KineSoft · Gestión para consultorios de kinesiología y osteopatía",
  ];
  return lines.join("\n");
}

/**
 * Arma un mail completo. `paragraphs` son TEXTO PLANO (se escapan para el html
 * y van tal cual al texto); `htmlParagraphs` permite resaltar partes con
 * `<strong>` armadas con datos ya escapados, y debe decir lo mismo.
 */
function compose(p: {
  subject: string;
  preheader: string;
  context: string | null;
  title: string;
  paragraphs: string[];
  htmlParagraphs?: string[];
  ctas: Array<{ label: string; url: string; variant?: "primary" | "secondary" }>;
  afterCta?: string[];
  footer: string[];
}): RenderedEmail {
  const parasHtml = (p.htmlParagraphs ?? p.paragraphs.map(escapeHtml)).map(para).join("\n");
  const buttons = p.ctas.map((c) => button(c.url, c.label, c.variant ?? "primary")).join("\n");
  const after = (p.afterCta ?? []).map((l) => `<p style="margin:20px 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.muted};">${escapeHtml(l)}</p>`).join("\n");
  const bodyHtml = `${parasHtml}\n${buttons}\n${after}\n${fallbackLink(p.ctas[0].url)}`;
  return {
    subject: subjectLine(p.subject),
    html: layout({ preheader: p.preheader, context: p.context, title: p.title, bodyHtml, footer: p.footer }),
    text: textBody({
      title: p.title,
      paragraphs: [...p.paragraphs, ...(p.afterCta ?? [])],
      ctas: p.ctas,
      footer: p.footer,
    }),
  };
}

const strong = (s: string) => `<strong style="color:${C.ink};font-weight:600;">${escapeHtml(s)}</strong>`;

const NOT_EXPECTED = "Si no esperabas este mail, podés ignorarlo: no se va a hacer ningún cambio.";

// ── Las 8 plantillas (C-IAM1) ────────────────────────────────────────────────

export function staffInviteEmail(p: {
  tenantName: string;
  inviterName: string | null;
  roleLabel: string;
  url: string;
  expiresAt: Date;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const inviter = plain(p.inviterName);
  const role = plain(p.roleLabel);
  const lead = inviter
    ? `${inviter} te invitó a sumarte a ${tenant} en KineSoft como ${role}.`
    : `Te invitaron a sumarte a ${tenant} en KineSoft como ${role}.`;
  const leadHtml = inviter
    ? `${strong(inviter)} te invitó a sumarte a ${strong(tenant)} en KineSoft como ${strong(role)}.`
    : `Te invitaron a sumarte a ${strong(tenant)} en KineSoft como ${strong(role)}.`;
  const second = "Aceptá la invitación para crear tu acceso. Vas a poder ver la agenda y trabajar con el resto del equipo.";
  const expiry = formatExpiryAR(p.expiresAt);
  return compose({
    subject: inviter ? `${inviter} te invitó a ${tenant} en KineSoft` : `Te invitaron a ${tenant} en KineSoft`,
    preheader: `Aceptá la invitación antes del ${expiry}.`,
    context: tenant,
    title: "Te invitaron a KineSoft",
    paragraphs: [lead, second],
    htmlParagraphs: [leadHtml, escapeHtml(second)],
    ctas: [{ label: "Aceptar invitación", url: p.url }],
    footer: [
      `Te llegó este mail porque alguien de ${tenant} te invitó a su equipo en KineSoft.`,
      `La invitación vence el ${expiry} (hora de Argentina). Si venció, pedile a ${tenant} que te la reenvíe.`,
      NOT_EXPECTED,
    ],
  });
}

export function portalInviteEmail(p: { tenantName: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  const second = "Desde tu portal podés ver tus turnos y la información que el consultorio comparte con vos.";
  return compose({
    subject: `${tenant} te dio acceso a tu portal de paciente`,
    preheader: "Entrá a tu portal para ver tus turnos.",
    context: tenant,
    title: "Tu portal de paciente",
    paragraphs: [`${tenant} te dio acceso a tu portal de paciente.`, second],
    htmlParagraphs: [`${strong(tenant)} te dio acceso a tu portal de paciente.`, escapeHtml(second)],
    ctas: [{ label: "Entrar a mi portal", url: p.url }],
    footer: [
      `Te llegó este mail porque ${tenant} te registró como paciente en KineSoft.`,
      `Por seguridad, el link vence. Si venció, podés pedir uno nuevo desde la pantalla de ingreso del portal.`,
      NOT_EXPECTED,
    ],
  });
}

export function portalMagicLinkEmail(p: { tenantName: string | null; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  const lead = tenant
    ? `Usá este link para entrar a tu portal de paciente de ${tenant}.`
    : "Usá este link para entrar a tu portal de paciente.";
  const leadHtml = tenant
    ? `Usá este link para entrar a tu portal de paciente de ${strong(tenant)}.`
    : escapeHtml(lead);
  const ttl = `El link vence en ${SUPABASE_LINK_TTL_COPY} y sirve una sola vez.`;
  return compose({
    subject: "Tu link para entrar al portal",
    preheader: ttl,
    context: tenant || "Portal de paciente",
    title: "Tu link para entrar al portal",
    paragraphs: [lead, ttl],
    htmlParagraphs: [leadHtml, escapeHtml(ttl)],
    ctas: [{ label: "Entrar a mi portal", url: p.url }],
    footer: [
      "Te llegó este mail porque alguien pidió un link de ingreso al portal con este email.",
      `${ttl} Si venció, pedí uno nuevo desde la pantalla de ingreso.`,
      "Si no lo pediste vos, ignorá este mail: nadie puede entrar sin este link.",
    ],
  });
}

export function emailVerificationEmail(p: { url: string }): RenderedEmail {
  const ttl = `El link vence en ${SUPABASE_LINK_TTL_COPY}.`;
  return compose({
    subject: "Confirmá tu email para KineSoft",
    preheader: "Un paso más para terminar de crear tu cuenta.",
    context: null,
    title: "Confirmá tu email",
    paragraphs: ["Confirmá tu email para terminar de crear tu cuenta.", "Es un solo clic: después ya podés configurar tu consultorio."],
    ctas: [{ label: "Confirmar mi email", url: p.url }],
    footer: [
      "Te llegó este mail porque alguien creó una cuenta en KineSoft con este email.",
      `${ttl} Si venció, pedí uno nuevo desde la pantalla de ingreso.`,
      "Si no fuiste vos, ignorá este mail: la cuenta no se activa sin confirmar.",
    ],
  });
}

export function passwordResetEmail(p: { url: string }): RenderedEmail {
  const ttl = `El link vence en ${SUPABASE_LINK_TTL_COPY} y sirve una sola vez.`;
  return compose({
    subject: "Restablecé tu contraseña de KineSoft",
    preheader: "Elegí una contraseña nueva para tu cuenta.",
    context: null,
    title: "Restablecé tu contraseña",
    paragraphs: ["Pediste restablecer tu contraseña.", "Tocá el botón para elegir una nueva."],
    ctas: [{ label: "Elegir contraseña nueva", url: p.url }],
    afterCta: ["Si no fuiste vos, ignorá este mail. Tu contraseña actual sigue funcionando."],
    footer: [
      "Te llegó este mail porque se pidió restablecer la contraseña de la cuenta de KineSoft asociada a este email.",
      `${ttl} Si venció, pedí uno nuevo desde «¿Olvidaste tu contraseña?».`,
    ],
  });
}

export function adminPasswordResetEmail(p: { tenantName: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  const ttl = `El link vence en ${SUPABASE_LINK_TTL_COPY} y sirve una sola vez.`;
  const second = "Tocá el botón para elegir tu contraseña. Nadie del consultorio la ve ni la conoce.";
  return compose({
    subject: "Creá una contraseña nueva para KineSoft",
    preheader: `${tenant} te mandó un link para crear una contraseña nueva.`,
    context: tenant,
    title: "Creá una contraseña nueva",
    paragraphs: [`${tenant} te mandó un link para crear una contraseña nueva.`, second],
    htmlParagraphs: [`${strong(tenant)} te mandó un link para crear una contraseña nueva.`, escapeHtml(second)],
    ctas: [{ label: "Crear contraseña nueva", url: p.url }],
    footer: [
      `Te llegó este mail porque alguien de ${tenant} pidió restablecer tu acceso a KineSoft.`,
      `${ttl} Si venció, pedile a ${tenant} uno nuevo.`,
      "Si no lo esperabas, ignorá este mail: tu contraseña actual sigue funcionando.",
    ],
  });
}

export function accountExistsEmail(p: { loginUrl: string; resetUrl: string }): RenderedEmail {
  return compose({
    subject: "Ya tenés una cuenta en KineSoft",
    preheader: "Ingresá con tu contraseña o recuperala.",
    context: null,
    title: "Ya tenés una cuenta",
    paragraphs: [
      "Ya tenés una cuenta en KineSoft con este email.",
      "Alguien (probablemente vos) intentó crear una cuenta nueva con esta dirección. No hace falta: ingresá con tu contraseña o, si no te la acordás, recuperala.",
    ],
    ctas: [
      { label: "Ingresar", url: p.loginUrl },
      { label: "Recuperar contraseña", url: p.resetUrl, variant: "secondary" },
    ],
    footer: [
      "Te llegó este mail porque se intentó crear una cuenta de KineSoft con este email.",
      "Si no fuiste vos, ignorá este mail: tu cuenta sigue igual y nadie entró.",
    ],
  });
}

export function welcomeEmail(p: { tenantName: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  const second = "Ya podés entrar con tu email y tu contraseña.";
  return compose({
    subject: `Ya sos parte de ${tenant} en KineSoft`,
    preheader: "Tu acceso ya está listo.",
    context: tenant,
    title: "Te damos la bienvenida a KineSoft",
    paragraphs: [`Ya sos parte de ${tenant} en KineSoft.`, second],
    htmlParagraphs: [`Ya sos parte de ${strong(tenant)} en KineSoft.`, escapeHtml(second)],
    ctas: [{ label: "Ir a KineSoft", url: p.url }],
    footer: [`Te llegó este mail porque activaste tu acceso al equipo de ${tenant} en KineSoft.`],
  });
}
