import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { ContactForm } from "@/components/landing/contact-form";
import { SessionTicketForm } from "@/components/contact/session-ticket-form";
import { CONTACT_LIMITS, CONTACT_PLAN_OPTIONS, contactPlanOf } from "@/components/contact/contact-options";
import { getAccessSnapshot, sessionBlockOf, type AccessSnapshot } from "@/lib/session";
import { getSessionUser } from "@/lib/session-user";
import { supportEmail } from "@/lib/support-contact";
import {
  isTicketSourceAllowed,
  motivoOfSource,
  ticketSourceFromMotivo,
  type SupportTicketSourceValue,
} from "@/lib/support-ticket-sources";
import {
  TICKET_ERROR_COPY,
  TICKET_PAGE_COPY,
  sessionTicketMailFallback,
  sessionTicketSub,
} from "@/lib/tickets-types";
import { LEAD_PHONE_MAX, SUPPORT_BODY_MAX } from "@/lib/support-threads-types";
import { BRAND_NAME } from "@/lib/brand";
import { logger } from "@/lib/logger";

/**
 * `/contacto?motivo=<slug>&plan=<SaasPlan>` (PV §27, TK-U2): la entrada pública ÚNICA de contacto. Reemplaza a los
 * `mailto:` de soporte (landing, /suspendido, /cuenta-desactivada, banda de acceso, alta). Decisión de Martin (27-oct,
 * literal): «que todos los contactos de formularios y consultas a soporte vayan a la parte de /plataforma de
 * Superadmin, y se abran como "tickets" para resolver desde ahi».
 *
 * Decide por la SESIÓN (no por el link), con la misma foto que el gate (`getAccessSnapshot`, verificación local del
 * token, sin red a GoTrue) y sin forzar login:
 *  - sin sesión → form de lead de la landing (hilo LEAD) con `source` oculto si el motivo es un origen LEAD válido
 *    (uno solo-TENANT, p. ej. `suspendido` con la sesión vencida, cae en LANDING: el CHECK de M19 no lo acepta en LEAD);
 *  - con un consultorio usable → Configuración → Soporte con el borrador (`nuevo=<slug>`): el ticket va como hilo
 *    TENANT con su historia, que el consultorio ve;
 *  - sin ninguna membresía (`needs_onboarding`) y un motivo que NO es el alta (`alta`/`onboarding`) → el form de lead,
 *    como sin sesión (PV INT-c). Un paciente del portal con sesión no tiene membresías, igual que un alta a medio hacer:
 *    antes veía «¿Necesitás ayuda con el alta?» y `submitSessionTicket` abría un LEAD ONBOARDING aunque viniera por
 *    `privacidad`. La página no distingue paciente de profesional sin consultorio (no hace falta): el motivo dice a qué
 *    vino, y el form de lead lleva su `source`;
 *  - bloqueada o sin consultorio → `SessionTicketForm`: identidad de la sesión, nunca del form. El destino lo vuelve a
 *    decidir `submitSessionTicket` con la misma foto; acá solo se elige el copy y se evita mostrar un form que la
 *    action va a rechazar (miembro sin rol de titular de un consultorio suspendido).
 *
 * Si leer la sesión falla (base caída), se muestra el form de lead: dejar escribir es mejor que un 500 justo en la
 * página de «tengo un problema». El form de sesión no tiene esa red: la action relee la sesión y responde con error.
 *
 * Superficie pública (C-F3, grupo de bundle `public`): `AuthShell centered`, sin providers, Drawer, Modal, Toast ni
 * framer. Lo único cliente son los dos forms (`useFormState`, funcionan sin JS). `force-dynamic`: lee la cookie.
 */
export const dynamic = "force-dynamic";

type SearchParams = { motivo?: string | string[]; plan?: string | string[] };

/** Marca para partir el copy de la segunda opción alrededor del email (no puede aparecer en un texto real). */
const MAIL_MARK = "\u0000";

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function generateMetadata({ searchParams }: { searchParams: SearchParams }): Metadata {
  const motivo = first(searchParams.motivo);
  const source = ticketSourceFromMotivo(motivo);
  const title = `${TICKET_PAGE_COPY[source].title} · ${BRAND_NAME}`;
  // Solo `/contacto` pelado se indexa: las variantes por motivo son entradas desde otras pantallas (o de una sesión
  // bloqueada) y no tienen nada que buscar.
  const isDefault = !motivo && !first(searchParams.plan);
  return isDefault ? { title } : { title, robots: { index: false, follow: true } };
}

async function readSnapshot(): Promise<AccessSnapshot | null> {
  try {
    return await getAccessSnapshot();
  } catch (e) {
    logger.warn("contacto.session_read_failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Origen del ticket que va a abrir `submitSessionTicket` con esta foto (espejo de su `destinationOf`). */
function sessionSourceOf(s: AccessSnapshot): SupportTicketSourceValue {
  const block = sessionBlockOf(s);
  if (block?.kind === "user_disabled") return "ACCOUNT_DISABLED";
  if (block) return "TENANT_SUSPENDED";
  return "ONBOARDING";
}

/** Motivos del alta: con sesión y sin consultorio siguen yendo al form de sesión (ticket ONBOARDING con su identidad). */
const ONBOARDING_SOURCES: ReadonlySet<SupportTicketSourceValue> = new Set(["SIGNUP_ASSISTED", "ONBOARDING"]);

export default async function ContactoPage({ searchParams }: { searchParams: SearchParams }) {
  const source = ticketSourceFromMotivo(first(searchParams.motivo));
  const slug = motivoOfSource(source);
  const snap = await readSnapshot();

  const block = snap ? sessionBlockOf(snap) : null;
  const leadForm = !snap || (!block && snap.state.kind === "needs_onboarding" && !ONBOARDING_SOURCES.has(source));

  if (leadForm) {
    const copy = TICKET_PAGE_COPY[source];
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading title={copy.title} />
        <StatusText last>{copy.sub}</StatusText>
        <ContactForm
          // Página dinámica: el instante del render es el de ahora (el anti-bot pide ≥ 3 s hasta el envío).
          startedAt={Date.now()}
          planOptions={CONTACT_PLAN_OPTIONS}
          limits={CONTACT_LIMITS}
          source={isTicketSourceAllowed("LEAD", source) ? source : undefined}
          defaultPlan={contactPlanOf(first(searchParams.plan))}
          title={copy.title}
          stacked
        />
      </AuthShell>
    );
  }

  // Fuera de cualquier try: `redirect` de Next tira para cortar el render.
  if (!block && snap.state.kind === "ok") redirect(`/configuracion?tab=soporte&nuevo=${encodeURIComponent(slug)}`);

  // El título es el del ticket que se va a abrir (lo decide la sesión), no el del link: un titular suspendido que
  // llega desde «Pedinos el precio» abre un ticket de su consultorio, y la página lo dice.
  const sessionSource = sessionSourceOf(snap);
  const copy = TICKET_PAGE_COPY[sessionSource];

  // Consultorios bloqueados donde puede escribir por el consultorio. El suspendido primero (el que se puede
  // reactivar), como `sessionBlockOf` y la action.
  const adminBlocks =
    sessionSource === "TENANT_SUSPENDED"
      ? snap.tenantBlocks
          .filter((b) => b.role === "OWNER" || b.role === "ADMIN")
          .sort((a, b) => Number(b.kind === "suspended") - Number(a.kind === "suspended"))
      : [];
  if (sessionSource === "TENANT_SUSPENDED" && adminBlocks.length === 0) {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading title={copy.title} />
        <StatusText last>{TICKET_ERROR_COPY.notAdmin}</StatusText>
        <StatusLink href="/suspendido" variant="ghost">
          Volver
        </StatusLink>
      </AuthShell>
    );
  }

  // El email al que respondemos es el de la sesión (el mismo orden que la action: GoTrue, después el perfil).
  const user = await getSessionUser();
  const email = (user?.email ?? snap.profile?.email ?? "").trim().toLowerCase();
  const fallback = supportEmail();
  const [mailBefore, mailAfter] = sessionTicketMailFallback(MAIL_MARK).split(MAIL_MARK);

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading title={copy.title} />
      <StatusText>{copy.sub}</StatusText>
      {email ? <StatusText last>{sessionTicketSub(email)}</StatusText> : null}
      <SessionTicketForm
        motivo={slug}
        title={copy.title}
        limits={{ message: SUPPORT_BODY_MAX, phone: LEAD_PHONE_MAX }}
        tenants={adminBlocks.map((b) => ({ tenantId: b.tenantId, tenantName: b.tenantName }))}
      />
      {fallback ? (
        // Segunda opción (literal del brief). Es el único `mailto:` de soporte que queda, y solo con el canal configurado:
        // quien no quiere usar el form igual tiene a dónde escribir. El copy sale entero de `sessionTicketMailFallback`
        // (se parte en el email para linkearlo).
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: "20px 0 0", lineHeight: 1.55 }}>
          {mailBefore}
          <a href={`mailto:${fallback}`} className="k-link" style={{ overflowWrap: "anywhere" }}>
            {fallback}
          </a>
          {mailAfter}
        </p>
      ) : null}
    </AuthShell>
  );
}
