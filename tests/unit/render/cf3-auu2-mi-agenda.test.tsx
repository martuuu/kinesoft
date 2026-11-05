import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF3-AUU2] Configuración › «Mi agenda» como configuración completa del profesional (D-CF3-13), su link propio del
 * turnero (D-CF3-12), los dos switches nuevos (D-CF3-3 / D-CF3-5) y la pestaña «Sitio web» (D-CF3-10).
 *
 * Símbolos REALES: `visibleConfigTabs`, `initialConfigTab`, `ConfiguracionClient`, `MiAgendaPanel` y la lógica pura de
 * `mi-agenda-logic.ts`. Se mockean `next/dynamic` (resuelto en `beforeAll`), las server actions (red) y los tres
 * editores de Profesionales (de otras sesiones; acá solo importa con qué props se montan). Sin DOM: lo que decide un
 * click vive en la lógica pura y se prueba directo.
 */
const { dynamicLoads, mounted, catalogCalls } = vi.hoisted(() => ({
  dynamicLoads: [] as Promise<unknown>[],
  mounted: [] as { editor: string; props: Record<string, unknown> }[],
  catalogCalls: { locations: 0, rooms: 0 },
}));
const { editorMock } = vi.hoisted(() => ({
  editorMock: (editor: string) => (p: Record<string, unknown>) => {
    mounted.push({ editor, props: p });
    return null;
  },
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
  setOwnShowPublicPrice: async () => ({ ok: true, data: { showPublicPrice: true } }),
  setOwnInsuredContact: async () => ({ ok: true, data: { showContactForInsured: true } }),
  setPractitionerPublicLead: async () => ({ ok: true, data: { publicMinLeadMinutes: null } }),
  hidePractitionerLeadContact: async () => ({ ok: true, data: { show: false } }),
}));
vi.mock("@/lib/locations", () => ({
  listLocations: async () => {
    catalogCalls.locations += 1;
    return [];
  },
}));
vi.mock("@/lib/rooms", () => ({
  listRooms: async () => {
    catalogCalls.rooms += 1;
    return [];
  },
}));
vi.mock("@/lib/web-push-actions", () => ({
  savePushSubscription: async () => ({ ok: true, data: { deviceId: "d" } }),
  deletePushSubscription: async () => ({ ok: true, data: { removed: true } }),
  deleteMyPushDevice: async () => ({ ok: true, data: { removed: true } }),
  listMyPushDevices: async () => ({ ok: true, data: [] }),
  sendTestPush: async () => ({ ok: true, data: { sent: 1, removed: 0, failed: 0 } }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/components/configuracion/panels/practitioners/lead-editor", () => ({
  PractitionerLeadEditor: editorMock("lead"),
}));
vi.mock("@/components/configuracion/panels/practitioners/services-editor", () => ({
  ServicesEditor: editorMock("services"),
}));
vi.mock("@/components/configuracion/panels/practitioners/schedule-editor", () => ({
  ScheduleEditor: editorMock("schedule"),
}));
vi.mock("@/components/configuracion/panels/practitioners/exceptions-editor", () => ({
  ExceptionsEditor: editorMock("exceptions"),
}));
vi.mock("@/components/configuracion/panels/site-panel", () => ({
  SitePanel: () => <div data-site-panel="" />,
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
import {
  MI_AGENDA_COPY,
  insuredContactUiOf,
  insuredErrorOf,
  ownBookingLinkOf,
  ownBookingWhatsAppHref,
} from "@/components/configuracion/panels/mi-agenda-logic";
import {
  CONFIG_TABS,
  initialConfigTab,
  visibleConfigTabs,
  type ConfigTabAccess,
} from "@/components/configuracion/controls";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const DATA: ConfiguracionMiAgendaData = {
  practitionerId: "pr_1",
  name: "Ana Gómez",
  publicBookingEnabled: true,
  tenantPublicBookingEnabled: true,
  publicMinLeadMinutes: null,
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

const NONE: ConfigTabAccess = { tenantAdmin: false, billing: false, team: false, canExport: false };
const PRO: ConfigTabAccess = { ...NONE, fichas: true, miAgenda: true };
const OWNER: ConfigTabAccess = {
  tenantAdmin: true,
  billing: true,
  team: true,
  canExport: true,
  sensitive: true,
  fichas: true,
  miAgenda: true,
  directory: true,
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

function page(access: Omit<ConfigTabAccess, "canExport">, miAgenda: ConfiguracionMiAgendaData | null, initialTab?: string) {
  return wrap(
    <ConfiguracionClient
      role="PRACTITIONER"
      access={access}
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
      initialTab={initialTab}
      miAgenda={miAgenda}
      webPushPublicKey={null}
      clinicName="Consultorio TMP"
    />
  );
}

describe("[CF3-AUU2] pestañas e inicial por rol", () => {
  it("[CF3-AUU2-1] Profesional sin «Configuración»: entra a «Mi agenda»; no ve General, Sedes, Profesionales ni Sitio web", () => {
    const v = visibleConfigTabs(PRO, KINE);
    expect(initialConfigTab(undefined, v)).toBe("mi-agenda");
    expect(initialConfigTab("general", v)).toBe("mi-agenda");
    for (const t of ["general", "sedes", "profesionales", "sitio-web"] as const) expect(v).not.toContain(t);
    const html = page({ tenantAdmin: false, billing: false, team: false }, DATA);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Mi agenda</);
  });

  it("[CF3-AUU2-2] Profesional con «Planes y pagos» delegado también entra a «Mi agenda» (antes, «Plan y uso»)", () => {
    const v = visibleConfigTabs({ ...PRO, billing: true }, KINE);
    expect(v[0]).toBe("plan");
    expect(initialConfigTab(undefined, v)).toBe("mi-agenda");
    // Por URL sigue abriendo lo que pidió.
    expect(initialConfigTab("facturacion", v)).toBe("facturacion");
  });

  it("[CF3-AUU2-3] Titular que atiende: ve «Mi agenda» además de las del consultorio y entra a General", () => {
    const v = visibleConfigTabs(OWNER, KINE);
    expect(v).toContain("mi-agenda");
    expect(v).toContain("general");
    expect(initialConfigTab(undefined, v)).toBe("general");
  });

  it("[CF3-AUU2-4] Secretaria / Facturación (sin `miAgenda`): no ven «Mi agenda» y siguen en su primera", () => {
    const secretaria: ConfigTabAccess = { ...NONE, tenantAdmin: true };
    const v = visibleConfigTabs(secretaria, KINE);
    expect(v).not.toContain("mi-agenda");
    expect(initialConfigTab("mi-agenda", v)).toBe("general");
    expect(initialConfigTab(undefined, visibleConfigTabs(NONE, KINE))).toBe("soporte");
  });

  it("[CF3-AUU2-5] «Sitio web»: con `tenant.sensitive`, justo después de «Directorio»; se abre por URL", () => {
    expect(CONFIG_TABS).toContain("sitio-web");
    const v = visibleConfigTabs(OWNER, KINE);
    expect(v.indexOf("sitio-web")).toBe(v.indexOf("directorio") + 1);
    // Sin directorio, igual existe (en su lugar del orden).
    expect(visibleConfigTabs({ ...OWNER, directory: false }, KINE)).toContain("sitio-web");
    // La Secretaria con «Configuración» (sin lo delicado) no.
    expect(visibleConfigTabs({ ...NONE, tenantAdmin: true }, KINE)).not.toContain("sitio-web");
    const html = page({ tenantAdmin: true, billing: true, team: true, sensitive: true }, null, "sitio-web");
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Sitio web</);
    expect(html).toContain("data-site-panel");
  });
});

describe("[CF3-AUU2] secciones de «Mi agenda»", () => {
  it("[CF3-AUU2-6] cinco secciones en orden, con los editores en modo propio", () => {
    mounted.length = 0;
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={null} clinicName="TMP" agendaCatalog={{ locations: [], rooms: [] }} />);
    const order = Array.from(html.matchAll(/data-mi-agenda-section="([^"]+)"/g), (m) => m[1]);
    // CF3b PH-U1 (M24): «Tu foto» arriba y, junto a ella, «Matrícula» (CT-L la había dejado al final); las cinco de la
    // agenda después, en su orden (`tests/unit/render/ph-u1-photo-section.test.tsx` [PH-U1-8]).
    expect(order).toEqual(["foto", "matricula", "servicios", "horarios", "excepciones", "turnero", "avisos"]);
    const t = text(html);
    for (const title of [
      MI_AGENDA_COPY.sectionServices,
      MI_AGENDA_COPY.sectionWeek,
      MI_AGENDA_COPY.sectionExceptions,
      MI_AGENDA_COPY.cardTurnero,
      MI_AGENDA_COPY.cardNotifications,
    ])
      expect(t).toContain(title);
    expect(mounted.find((m) => m.editor === "services")?.props).toMatchObject({ practitionerId: "pr_1", scope: "self" });
    expect(mounted.find((m) => m.editor === "schedule")?.props).toMatchObject({ practitionerId: "pr_1", locations: [] });
    expect(mounted.find((m) => m.editor === "exceptions")?.props).toMatchObject({ practitionerId: "pr_1" });
  });

  it("[CF3-AUU2-7] sin catálogo del loader, la semana espera las sedes (SSR: «Cargando…», sin pedirlas en el server)", () => {
    mounted.length = 0;
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={null} />);
    expect(text(html)).toContain(MI_AGENDA_COPY.catalogLoading);
    expect(mounted.some((m) => m.editor === "schedule")).toBe(false);
    expect(catalogCalls.locations).toBe(0);
  });

  it("[CF3-AUU2-8] link propio habilitado: ruta con su id, «Copiar» y «Compartir por WhatsApp» con el texto de invitación", () => {
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={null} clinicName="Consultorio TMP" agendaCatalog={{ locations: [], rooms: [] }} />);
    expect(html).toContain('data-own-booking-link="on"');
    expect(html).toContain('value="/c/tmp/booking?pro=pr_1"');
    const wa = ownBookingWhatsAppHref("Consultorio TMP", "Ana Gómez", "/c/tmp/booking?pro=pr_1").replace(/&/g, "&amp;");
    expect(html).toContain(`href="${wa}"`);
    expect(decodeURIComponent(wa.split("text=")[1])).toBe("Reservá tu turno con Ana Gómez en Consultorio TMP: /c/tmp/booking?pro=pr_1");
    expect(html).not.toContain("data-own-booking-link-reason");
  });

  it("[CF3-AUU2-9] link deshabilitado con el motivo: switch propio apagado / turnero del consultorio apagado", () => {
    const own = wrap(<MiAgendaPanel data={{ ...DATA, ownPublicBookingEnabled: false, publicBookingEnabled: false }} vapidPublicKey={null} />);
    expect(own).toContain('data-own-booking-link="off"');
    expect(text(own)).toContain(MI_AGENDA_COPY.linkOffOwn);
    expect(own).not.toMatch(/href="https:\/\/wa\.me/);
    expect(own).toMatch(/<input[^>]*aria-label="Tu link para sacar turno"[^>]*disabled=""/);
    const tenant = wrap(<MiAgendaPanel data={{ ...DATA, tenantPublicBookingEnabled: false }} vapidPublicKey={null} />);
    expect(text(tenant)).toContain(MI_AGENDA_COPY.linkOffTenant);
    expect(text(tenant)).not.toContain(MI_AGENDA_COPY.linkOffOwn);
  });

  it("[CF3-AUU2-10] lógica del link: origin absoluto, consultorio primero", () => {
    expect(ownBookingLinkOf(DATA, "https://app.example.com/")).toEqual({
      url: "https://app.example.com/c/tmp/booking?pro=pr_1",
      enabled: true,
      reason: null,
    });
    expect(ownBookingLinkOf({ ...DATA, tenantPublicBookingEnabled: false, ownPublicBookingEnabled: false }, null).reason).toBe(
      MI_AGENDA_COPY.linkOffTenant
    );
  });

  it("[CF3-AUU2-11] precio visible y WhatsApp para OS: switches con su label y el estado guardado", () => {
    const html = wrap(<MiAgendaPanel data={{ ...DATA, showPublicPrice: false }} vapidPublicKey={null} />);
    expect(html).toMatch(new RegExp(`role="switch"[^>]*aria-checked="false"[^>]*aria-label="${MI_AGENDA_COPY.priceLabel}"`));
    expect(text(html)).toContain(MI_AGENDA_COPY.priceHintOff);
    expect(html).toMatch(new RegExp(`role="switch"[^>]*aria-checked="false"[^>]*aria-label="${MI_AGENDA_COPY.insuredLabel}"`));
    expect(text(html)).toContain(MI_AGENDA_COPY.insuredHintOff);
    // Sin número guardado, el hint dice qué falta.
    const noPhone = wrap(<MiAgendaPanel data={{ ...DATA, contactWhatsapp: null }} vapidPublicKey={null} />);
    expect(text(noPhone)).toContain(MI_AGENDA_COPY.insuredNeedsPhone);
  });

  it("[CF3-AUU2-12] lógica del WhatsApp para OS: número válido guardado, consentimiento por adelantado o pedido por el server", () => {
    expect(insuredContactUiOf(DATA)).toEqual({ canEnable: true, needsConsentUpfront: true });
    expect(insuredContactUiOf({ contactWhatsapp: "+541143210000", contactConsentAt: "2026-11-01T00:00:00Z" })).toEqual({
      canEnable: false,
      needsConsentUpfront: false,
    });
    expect(insuredErrorOf({ ok: false, error: "x", fieldErrors: { acceptConsent: ["y"] } })).toEqual({ needsConsent: true, error: null });
    expect(insuredErrorOf({ ok: false, error: "x", fieldErrors: { contactWhatsapp: ["Cargá"] } })).toEqual({
      needsConsent: false,
      error: "Cargá",
    });
  });

  it("[CF3-AUU2-13] a 390 px nada fuerza ancho fijo: grilla minmax(0,1fr), fila del link con wrap y input sin min-width", () => {
    const html = wrap(<MiAgendaPanel data={DATA} vapidPublicKey={null} agendaCatalog={{ locations: [], rooms: [] }} />);
    expect(html).toContain("grid-template-columns:minmax(0, 1fr)");
    expect(html).toMatch(/flex-wrap:wrap[^"]*"[^>]*>\s*<input[^>]*class="k-input"[^>]*style="flex:1 1 220px;min-width:0/);
    // Ningún ancho fijo mayor a 390 en estilos inline.
    for (const m of html.matchAll(/(?:^|[;"])(?:min-)?width:(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(390);
  });
});
