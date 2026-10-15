/**
 * IAM-0b · Diagnóstico del canal de mail: manda una plantilla de prueba por el
 * transporte REAL (el mismo `sendEmail` que usa la app) y muestra qué pasó.
 *
 * Por qué existe: varios flujos (reset de contraseña, "ya tenés cuenta")
 * responden SIEMPRE lo mismo para no revelar si un email existe, así que desde
 * la pantalla es imposible distinguir "salió el mail" de "la app está muda".
 * Este script recorre el camino de la app y dice en qué escalón se corta.
 * Lo corre Martin antes de IAM-2, con el dominio ya cargado en Resend (§19.9).
 *
 * Seguridad:
 *  - Lee SOLO el env del proceso (nunca abre `.env*` por su cuenta) y nunca
 *    imprime la key: solo si está o no.
 *  - Si el transporte resultante es Resend (un mail REAL), exige `--confirm`.
 *  - Los links de la plantilla apuntan a `--url` (o NEXT_PUBLIC_APP_URL). Con
 *    Resend y una URL local el envío sale `blocked`: es la barrera de la app
 *    funcionando, no un bug del script. Pasá `--url https://tu-dominio`.
 *
 * Uso (desde la raíz):
 *   # Local con Mailpit (docker compose --profile mail up -d mailpit):
 *   EMAIL_TRANSPORT=mailpit npx tsx --conditions=react-server \
 *     scripts/diagnose-email.ts --to vos@ejemplo.com [--kind staff_invite | --all]
 *
 *   # Resend de verdad (probar el dominio; manda un mail REAL):
 *   RESEND_API_KEY=… EMAIL_FROM="KineSoft <no-reply@mail.tudominio>" EMAIL_TRANSPORT=resend \
 *     npx tsx --conditions=react-server scripts/diagnose-email.ts \
 *     --to vos@ejemplo.com --url https://tudominio --confirm
 *
 * `--conditions=react-server` porque `lib/email/index.ts` es `server-only`
 * (molde de `scripts/plans-dedupe-session-index.ts`). Sale con código 1 si el
 * mail no salió.
 */
import { decideEmailTransport, maskEmail, normalizeEmailAddress, resolveBaseFrom, composeFrom, DEFAULT_EMAIL_FROM } from "../lib/email/transport";
import { sendEmail } from "../lib/email/index";
import type { EmailKind, RenderedEmail } from "../lib/email/types";
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
  trialReminderEmail,
  platformHealthDigestEmail,
  tenantExportRequestEmail,
} from "../lib/email/templates";

const TENANT = "Consultorio de prueba";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = process.argv[i + 1];
    return next && !next.startsWith("--") ? next : "";
  }
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

/**
 * PL-1a sumó a `EmailKind` los kinds de PL (2FA, cobros, mensajes) pero sus plantillas son de PL-2: hasta
 * entonces quedan afuera del diagnóstico. PL-2 los suma acá y vuelve a `Record<EmailKind, …>` completo.
 */
type PendingPlKind =
  | "two_factor_code"
  | "two_factor_changed"
  | "recovery_codes_used"
  | "billing_charge_created"
  | "billing_payment_received"
  | "billing_payment_rejected"
  | "billing_past_due"
  | "billing_price_change"
  | "billing_auto_debit_changed"
  | "support_message_platform"
  | "support_reply_tenant"
  | "lead_received"
  | "lead_reply";
type DiagnosableKind = Exclude<EmailKind, PendingPlKind>;

function samples(base: string): Record<DiagnosableKind, () => RenderedEmail> {
  const link = (path: string) => `${base}${path}`;
  const inAWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  return {
    staff_invite: () =>
      staffInviteEmail({ tenantName: TENANT, inviterName: "Laura Ramos", roleLabel: "Profesional", url: link("/invite/diagnostico"), expiresAt: inAWeek }),
    portal_invite: () => portalInviteEmail({ tenantName: TENANT, url: link("/portal") }),
    portal_magic_link: () => portalMagicLinkEmail({ tenantName: TENANT, url: link("/portal") }),
    email_verification: () => emailVerificationEmail({ url: link("/onboarding") }),
    password_reset: () => passwordResetEmail({ url: link("/reset") }),
    admin_password_reset: () => adminPasswordResetEmail({ tenantName: TENANT, url: link("/reset") }),
    account_exists: () => accountExistsEmail({ loginUrl: link("/login"), resetUrl: link("/reset") }),
    welcome: () => welcomeEmail({ tenantName: TENANT, url: link("/agenda") }),
    tenant_activation: () => tenantOwnerActivationEmail({ tenantName: TENANT, url: link("/reset") }),
    platform_access_link: () => platformAccessLinkEmail({ url: link("/reset"), purpose: "activation" }),
    support_access: () =>
      supportAccessEmail({ tenantName: TENANT, superadminEmail: "soporte@kinesoft.com.ar", startedAt: new Date(), url: link("/configuracion") }),
    // BO5-A (cron) y BO5-C (export). El link de prueba usa los mismos `?tab=` que mandan los jobs y la action
    // (`plan` y `exportar` son ids reales de CONFIG_TABS en components/configuracion/controls.tsx).
    trial_reminder: () => trialReminderEmail({ tenantName: TENANT, daysLeft: 3, expired: false, url: link("/configuracion?tab=plan") }),
    platform_health_digest: () =>
      platformHealthDigestEmail({
        dateKey: "2026-10-14",
        lines: [{ label: "Invitaciones vencidas sin anular", count: 2 }],
        unavailable: [],
        url: link("/plataforma/salud"),
      }),
    tenant_export_request: () => tenantExportRequestEmail({ tenantName: TENANT, url: link("/configuracion?tab=exportar") }),
  };
}

async function main(): Promise<number> {
  const to = normalizeEmailAddress(arg("to"));
  if (!to) {
    console.error("Falta --to <email> (una dirección válida).");
    return 1;
  }
  const base = (arg("url") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const all = arg("all") !== undefined;
  const kindArg = (arg("kind") || "welcome") as DiagnosableKind;
  const table = samples(base);
  if (!all && !(kindArg in table)) {
    console.error(`--kind desconocido. Opciones: ${Object.keys(table).join(", ")}`);
    return 1;
  }
  const kinds = all ? (Object.keys(table) as DiagnosableKind[]) : [kindArg];

  const env = process.env;
  const probe = table[kinds[0]]();
  const route = decideEmailTransport(env, probe);
  const baseFrom = resolveBaseFrom(env);

  console.log("\n── Diagnóstico del canal de mail ──\n");
  console.log(`Entorno         VERCEL_ENV=${env.VERCEL_ENV ?? "(sin setear)"} NODE_ENV=${env.NODE_ENV ?? "(sin setear)"}`);
  console.log(`RESEND_API_KEY  ${env.RESEND_API_KEY?.trim() ? "presente" : "ausente"}`);
  console.log(`EMAIL_FROM      ${baseFrom ?? "(ausente: en Production no sale nada)"}`);
  console.log(`Remitente       ${composeFrom(baseFrom ?? DEFAULT_EMAIL_FROM, TENANT)}`);
  console.log(`EMAIL_TRANSPORT ${env.EMAIL_TRANSPORT?.trim() || "(sin setear)"}`);
  console.log(`Base de links   ${base}`);
  console.log(`Destinatario    ${maskEmail(to)}`);
  console.log(`Transporte      ${route.transport} — ${route.why}`);

  if (route.transport === "resend" && arg("confirm") === undefined) {
    console.error(`\nEl transporte es Resend: esto manda ${kinds.length} mail(s) REAL(es). Repetí con --confirm.`);
    return 1;
  }

  let failures = 0;
  console.log("");
  for (const kind of kinds) {
    const m = table[kind]();
    const r = await sendEmail({ ...m, kind, to, fromName: TENANT, entity: "diagnose-email" });
    if (r.ok) {
      console.log(`OK    ${kind.padEnd(21)} ${r.transport} id=${r.providerId ?? "(sin id)"}`);
    } else {
      // skipped (log) no es un fallo del canal si el entorno lo decidió a propósito.
      const isFailure = !r.skipped || r.reason === "no_api_key" || r.reason === "no_from";
      if (isFailure) failures++;
      console.log(`${isFailure ? "FALLA" : "NO SE MANDÓ"} ${kind.padEnd(21)} ${r.transport} reason=${r.reason}${r.status ? ` status=${r.status}` : ""}`);
      if (r.status === 401) console.log("      401: API key inválida o revocada.");
      if (r.status === 403) console.log("      403: dominio sin verificar en Resend, o key restringida a otro dominio.");
      if (r.status === 422) console.log("      422: EMAIL_FROM mal formado o de un dominio no autorizado.");
      if (r.reason === "unsafe_link_host") console.log("      Links a localhost: pasá --url https://tu-dominio.");
      if (r.reason === "mailpit_unreachable") console.log("      Mailpit no responde: docker compose --profile mail up -d mailpit");
    }
  }
  if (route.transport === "mailpit" && failures === 0) {
    console.log(`\nAbrí ${(env.MAILPIT_URL?.trim() || "http://localhost:8025").replace(/\/+$/, "")} para verlos.`);
  }
  console.log(failures ? `\n${failures} envío(s) con problema.` : "\nCanal OK con este entorno.");
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
