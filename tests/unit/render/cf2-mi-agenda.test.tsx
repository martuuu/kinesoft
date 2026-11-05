import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF2-TU1] Configuración › «Mi agenda» (brief CF2 T.C): las tres tarjetas, el consentimiento del teléfono, el estado de
 * «Este dispositivo» en el SSR (nunca pide permiso: eso es solo al tocar «Activar») y el texto sin VAPID.
 *
 * Componentes REALES (`ConfiguracionClient` y `MiAgendaPanel`). Se mockean `next/dynamic` (resuelto en `beforeAll`),
 * el router, las server actions (red) y `PractitionerLeadEditor` (de otra sesión, T-U2: acá solo importa con qué props
 * se monta). El repo no tiene DOM en los tests de render: lo que decide un click vive en `mi-agenda-logic.ts` y se
 * prueba en `tests/unit/cf2-mi-agenda-logic.test.ts`.
 */
const { dynamicLoads, leadProps, actions } = vi.hoisted(() => ({
  dynamicLoads: [] as Promise<unknown>[],
  leadProps: [] as Record<string, unknown>[],
  actions: { listMyPushDevices: 0, requestPermission: 0 },
}));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  let n = -1;
  while (n !== dynamicLoads.length) {
    n = dynamicLoads.length;
    await Promise.all(dynamicLoads);
  }
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/practitioner-self-settings", () => ({
  setOwnLeadContact: async () => ({ ok: true, data: { contactWhatsapp: null, show: false } }),
  setOwnBookingNotifications: async () => ({ ok: true, data: { email: false, push: false } }),
  setPractitionerPublicLead: async () => ({ ok: true, data: { publicMinLeadMinutes: null } }),
  hidePractitionerLeadContact: async () => ({ ok: true, data: { show: false } }),
}));
vi.mock("@/lib/web-push-actions", () => ({
  savePushSubscription: async () => ({ ok: true, data: { deviceId: "d" } }),
  deletePushSubscription: async () => ({ ok: true, data: { removed: true } }),
  deleteMyPushDevice: async () => ({ ok: true, data: { removed: true } }),
  listMyPushDevices: async () => {
    actions.listMyPushDevices += 1;
    return { ok: true, data: [] };
  },
  sendTestPush: async () => ({ ok: true, data: { sent: 1, removed: 0, failed: 0 } }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/components/configuracion/panels/practitioners/lead-editor", () => ({
  PractitionerLeadEditor: (p: Record<string, unknown>) => {
    leadProps.push(p);
    return <div data-lead-editor="" />;
  },
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/support-session-tenant", () => ({ endSupportAccessForTenant: async () => ({ ok: true, data: undefined }) }));

import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { MiAgendaPanel } from "@/components/configuracion/panels/mi-agenda-panel";
import { MI_AGENDA_COPY } from "@/components/configuracion/panels/mi-agenda-logic";
import { OWN_TURNERO_OFF_HINT } from "@/components/configuracion/panels/practitioners/public-booking-switch";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { LEAD_CONTACT_CONSENT_COPY } from "@/lib/public-lead-contact";
import { modulesFor } from "@/lib/tenant-modules";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const VAPID = "B" + "A".repeat(86);

const DATA: ConfiguracionMiAgendaData = {
  practitionerId: "pr_1",
  name: "Ana Gómez",
  publicBookingEnabled: true,
  tenantPublicBookingEnabled: true,
  publicMinLeadMinutes: 180,
  tenantPublicMinLeadMinutes: 60,
  contactWhatsapp: "+5491123456789",
  showContactInLeadWindow: false,
  contactConsentAt: null,
  notifyBookingEmail: true,
  notifyBookingPush: false,
  ownPublicBookingEnabled: true,
  showPublicPrice: true,
  showContactForInsured: false,
  tenantSlug: "tmp",
  bookingUrl: "/c/tmp/booking?pro=pr_1",
  // CF3b CT-L (M23): la matrícula de la persona (sin cargar).
  license: { license: null, updatedAt: null },
  // CF3b PH-U1 (M24, contrato FOTO): sin foto subida.
  photo: { url: null, showPublic: false },
};

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={KINE} vertical="KINESIOLOGY">
          <TweaksProvider>{node}</TweaksProvider>
        </TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function page(miAgenda: ConfiguracionMiAgendaData | null, vapidPublicKey: string | null = VAPID) {
  return wrap(
    <ConfiguracionClient
      role="PRACTITIONER"
      access={{ tenantAdmin: false, billing: false, team: false, sensitive: false }}
      modules={KINE}
      tenant={null}
      insurers={[]}
      services={[]}
      team={[]}
      pending={[]}
      practitioners={[]}
      customConditions={[]}
      locations={[]}
      rooms={[]}
      scheduleSummary={[]}
      planUsage={null}
      supportSessions={[]}
      initialTab="mi-agenda"
      miAgenda={miAgenda}
      webPushPublicKey={vapidPublicKey}
    />
  );
}

describe("[CF2-TU1] pestaña «Mi agenda»", () => {
  it("[CF2-TU1-20] con datos, la pestaña existe y abre el panel con sus tres tarjetas", () => {
    const html = page(DATA);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Mi agenda</);
    const t = text(html);
    expect(t).toContain(MI_AGENDA_COPY.cardTurnero);
    expect(t).toContain(MI_AGENDA_COPY.cardLeadContact);
    expect(t).toContain(MI_AGENDA_COPY.cardNotifications);
    expect(t).toContain("Aparece en el turnero online");
  });

  it("[CF2-TU1-21] sin datos (Secretaria, soporte) no hay pestaña ni panel", () => {
    const html = page(null);
    expect(html).not.toMatch(/role="tab"[^>]*>Mi agenda</);
    expect(text(html)).not.toContain(MI_AGENDA_COPY.cardTurnero);
  });

  it("[CF2-TU1-22] el editor de anticipación se monta en modo propio con lo del loader", () => {
    leadProps.length = 0;
    wrap(<MiAgendaPanel data={DATA} vapidPublicKey={VAPID} />);
    expect(leadProps.at(-1)).toMatchObject({
      practitionerId: "pr_1",
      practitionerName: "Ana Gómez",
      own: 180,
      tenant: 60,
      self: true,
    });
  });

  it("[CF2-TU1-23] con el turnero del consultorio apagado, el switch propio lo dice y queda deshabilitado", () => {
    const html = wrap(<MiAgendaPanel data={{ ...DATA, tenantPublicBookingEnabled: false }} vapidPublicKey={VAPID} />);
    expect(text(html)).toContain(OWN_TURNERO_OFF_HINT);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*aria-label="Aparece en el turnero online: Ana Gómez"[^>]*disabled=""/);
  });

  it("[CF2-TU1-24] contacto: número cargado, switch apagado y sin la casilla (todavía no hay qué aceptar)", () => {
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={VAPID} />);
    expect(html).toContain('value="+54 9 1123456789"');
    expect(html).toMatch(/type="tel"/);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*aria-label="Mostrar mi contacto en el turnero"/);
    expect(text(html)).not.toContain(LEAD_CONTACT_CONSENT_COPY);
  });

  it("[CF2-TU1-25] prendido sin consentimiento registrado: se ve la casilla con el texto que se acepta", () => {
    const html = wrap(<MiAgendaPanel data={{ ...DATA, showContactInLeadWindow: true }} vapidPublicKey={VAPID} />);
    expect(text(html)).toContain(LEAD_CONTACT_CONSENT_COPY);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="acceptConsent"/);
    // Con el consentimiento ya dado, no se vuelve a pedir.
    const ok = wrap(
      <MiAgendaPanel
        data={{ ...DATA, showContactInLeadWindow: true, contactConsentAt: "2026-11-01T12:00:00.000Z" }}
        vapidPublicKey={VAPID}
      />
    );
    expect(text(ok)).not.toContain(LEAD_CONTACT_CONSENT_COPY);
  });

  it("[CF2-TU1-26] avisos: el mail refleja lo guardado; el dispositivo arranca «revisando» sin pedir permiso", () => {
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={VAPID} />);
    expect(html).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Avisarme por mail"/);
    expect(text(html)).toContain(MI_AGENDA_COPY.pushChecking);
    // En el SSR no hay navegador: ni permiso, ni lista (la pide el efecto al montar).
    expect(text(html)).not.toContain(MI_AGENDA_COPY.activate);
    expect(actions.listMyPushDevices).toBe(0);
  });

  it("[CF2-ZF2-11] el texto de cada switch es su <label> (clic en el texto lo cambia) y el hint del contacto se entiende", () => {
    // ZB-11: el texto al lado del Switch era un <span> suelto: clic en «Avisarme por mail» no hacía nada.
    const html = wrap(<MiAgendaPanel data={{ ...DATA, showContactInLeadWindow: true }} vapidPublicKey={VAPID} />);
    for (const label of ["Mostrar mi contacto en el turnero", "Avisarme por mail", "Avisarme con una notificación"]) {
      const row = new RegExp(
        `<label[^>]*>(?:(?!</label>)[\\s\\S])*role="switch"[^>]*aria-label="${label}"(?:(?!</label>)[\\s\\S])*>${label}</span></label>`,
      );
      expect(html).toMatch(row);
    }
    expect(text(html)).toContain(
      "Tu celular aparece en el turnero solo cuando alguien busca turno para hoy dentro de tu anticipación mínima y todavía tenés lugar.",
    );
    expect(text(html)).not.toContain("Se muestra solo hoy");
  });

  it("[CF2-TU1-27] sin VAPID: el texto de «todavía no habilitados» y nada de activar ni probar", () => {
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={null} />);
    const t = text(html);
    expect(t).toContain("Los avisos al celular todavía no están habilitados en este consultorio");
    expect(t).not.toContain(MI_AGENDA_COPY.activate);
    expect(t).not.toContain(MI_AGENDA_COPY.test);
    // El mail sigue.
    expect(html).toMatch(/aria-label="Avisarme por mail"/);
  });

  it("[CF2-TU1-28] la clave VAPID del panel es solo la pública (la página nunca manda la privada)", async () => {
    const src = (await import("node:fs")).readFileSync("app/(app)/configuracion/page.tsx", "utf8");
    expect(src).toMatch(/webPushVapid\(\)\?\.publicKey \?\? null/);
    expect(src).not.toMatch(/privateKey/);
  });
});
