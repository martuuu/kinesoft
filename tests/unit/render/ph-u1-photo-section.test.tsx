import { describe, it, expect, vi, beforeAll } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PH-U1] Foto del profesional (CF3b, M24, contrato FOTO): «Tu foto» en «Mi agenda» y el avatar propio en el shell.
 *
 * Render sin jsdom de los componentes REALES (`PhotoSection`, `MiAgendaPanel`, `TopbarAccountMenu`, `ProfileMenu`,
 * `AppShell`) con `PractitionerPhoto` real (PH-U2) y el `TenantBrandProvider` real. Se mockean solo la red (server
 * actions), el router, `next/dynamic` (corre el mismo loader) y los providers pesados del shell. Lo que decide un click
 * (switch deshabilitado sin foto, el hint) vive en `photoSwitchUiOf` y se prueba directo; la reducción con canvas, en
 * `tests/unit/ph-u1-photo-resize.test.ts`.
 */
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
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
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/user-photo", () => ({
  uploadOwnPhoto: async () => ({ ok: true, data: { photoUrl: "/api/me/photo?v=2" } }),
  removeOwnPhoto: async () => ({ ok: true, data: undefined }),
  setOwnShowPhotoPublic: async (show: boolean) => ({ ok: true, data: { showPhotoPublic: show } }),
}));
vi.mock("@/lib/user-license", () => ({
  setOwnLicense: async () => ({ ok: true, data: { license: null, updatedAt: null } }),
  getOwnLicense: async () => ({ ok: true, data: { license: null, updatedAt: null } }),
}));
vi.mock("@/lib/practitioner-self-settings", () => ({
  setOwnLeadContact: async () => ({ ok: true, data: { contactWhatsapp: null, show: false } }),
  setOwnBookingNotifications: async () => ({ ok: true, data: { email: false, push: false } }),
  setOwnShowPublicPrice: async () => ({ ok: true, data: { showPublicPrice: true } }),
  setOwnInsuredContact: async () => ({ ok: true, data: { showContactForInsured: true } }),
  setPractitionerPublicLead: async () => ({ ok: true, data: { publicMinLeadMinutes: null } }),
  hidePractitionerLeadContact: async () => ({ ok: true, data: { show: false } }),
}));
vi.mock("@/lib/locations", () => ({ listLocations: async () => [] }));
vi.mock("@/lib/rooms", () => ({ listRooms: async () => [] }));
vi.mock("@/lib/web-push-actions", () => ({
  savePushSubscription: async () => ({ ok: true, data: { deviceId: "d" } }),
  deletePushSubscription: async () => ({ ok: true, data: { removed: true } }),
  deleteMyPushDevice: async () => ({ ok: true, data: { removed: true } }),
  listMyPushDevices: async () => ({ ok: true, data: [] }),
  sendTestPush: async () => ({ ok: true, data: { sent: 1, removed: 0, failed: 0 } }),
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));
vi.mock("@/components/configuracion/panels/practitioners/services-editor", () => ({ ServicesEditor: () => null }));
vi.mock("@/components/configuracion/panels/practitioners/schedule-editor", () => ({ ScheduleEditor: () => null }));
vi.mock("@/components/configuracion/panels/practitioners/exceptions-editor", () => ({ ExceptionsEditor: () => null }));
vi.mock("@/components/configuracion/panels/practitioners/lead-editor", () => ({ PractitionerLeadEditor: () => null }));
vi.mock("@/components/providers/arrival-alerts", () => ({ ArrivalAlerts: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/providers/realtime-provider", () => ({
  RealtimeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useRealtime: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/components/global/command-palette", () => ({ CommandPalette: () => null }));

import { PhotoSection, type PhotoSectionData } from "@/components/configuracion/panels/photo-section";
import { MiAgendaPanel } from "@/components/configuracion/panels/mi-agenda-panel";
import { PHOTO_COPY, photoSwitchUiOf } from "@/components/configuracion/panels/mi-agenda-logic";
import { TopbarAccountMenu } from "@/components/layout/topbar-account-menu";
import { ProfileMenu } from "@/components/global/profile-menu";
import { AppShell } from "@/components/layout/app-shell";
import { UserPhotoProvider } from "@/components/layout/user-photo-context";
import { TenantBrandProvider } from "@/components/layout/tenant-brand-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { PHOTO_ACCEPT } from "@/lib/photo-resize";
import { ownPhotoUrlFor } from "@/lib/user-photo-logic";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import type { ConfiguracionMiAgendaData } from "@/lib/configuracion-page-loader";
import type { Preferences } from "@/lib/preferences-constants";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const LOGO = "/api/consultorio/logo?t=t1&v=123";
const PHOTO = ownPhotoUrlFor({ photoStorageKey: "users/u1/photo/abc.png", photoUpdatedAt: new Date("2026-11-05T12:00:00.000Z") })!;

function wrap(node: ReactNode, logoUrl: string | null = LOGO) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantBrandProvider value={{ name: "Consultorio TMP", logoUrl, palette: "sky" }}>{node}</TenantBrandProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
const section = (initial: PhotoSectionData, readOnly = false, logoUrl: string | null = LOGO) =>
  wrap(<PhotoSection initial={initial} name="Ana Gómez" readOnly={readOnly} />, logoUrl);
/** El `<button role="switch">` de la sección (el único). */
const switchTag = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? "";

describe("[PH-U1-5] switch «Mostrar mi foto…» (lógica pura)", () => {
  it("sin foto: apagado y deshabilitado aunque el flag guardado esté prendido; pide subir una", () => {
    for (const showPublic of [false, true])
      expect(photoSwitchUiOf({ hasPhoto: false, showPublic, readOnly: false, pending: false })).toEqual({
        on: false,
        disabled: true,
        hint: PHOTO_COPY.publicNeedsPhoto,
      });
  });
  it("con foto: muestra lo guardado; modo lectura o guardando lo deshabilitan", () => {
    expect(photoSwitchUiOf({ hasPhoto: true, showPublic: true, readOnly: false, pending: false })).toEqual({
      on: true,
      disabled: false,
      hint: PHOTO_COPY.publicHintOn,
    });
    expect(photoSwitchUiOf({ hasPhoto: true, showPublic: false, readOnly: false, pending: false }).hint).toBe(PHOTO_COPY.publicHintOff);
    expect(photoSwitchUiOf({ hasPhoto: true, showPublic: false, readOnly: true, pending: false }).disabled).toBe(true);
    expect(photoSwitchUiOf({ hasPhoto: true, showPublic: false, readOnly: false, pending: true }).disabled).toBe(true);
  });
});

describe("[PH-U1-6] «Tu foto» sin foto", () => {
  const html = section({ url: null, showPublic: true });
  it("marco con iniciales y el logo del consultorio; sin <img> de foto", () => {
    expect(html).toContain('data-photo-section="empty"');
    expect(html).toMatch(/role="img"[^>]*aria-label="Ana Gómez"/);
    expect(text(html)).toContain(" AG ");
    expect(html).toContain(`src="${LOGO.replace(/&/g, "&amp;")}"`);
    expect(html).not.toContain("/api/me/photo");
  });
  it("«Subir foto»: input file PNG/JPEG/WEBP con su <label> (un solo control, formatos por aria-describedby)", () => {
    const input = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain(`accept="${PHOTO_ACCEPT}"`);
    expect(input).toContain('name="file"');
    expect(input).not.toContain("aria-label");
    expect(input).not.toContain("disabled");
    const id = /id="([^"]+)"/.exec(input)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(input)?.[1];
    expect(id).toBeTruthy();
    expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${PHOTO_COPY.upload}</label>`));
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>${PHOTO_COPY.formats}</p>`));
    expect(text(html)).not.toContain(PHOTO_COPY.remove);
  });
  it("la nota de la foto y el switch apagado + deshabilitado con «Primero subí una foto.»", () => {
    expect(text(html)).toContain(PHOTO_COPY.note);
    const sw = switchTag(html);
    expect(sw).toContain('aria-checked="false"');
    expect(sw).toContain("disabled");
    expect(sw).toContain(`aria-label="${PHOTO_COPY.publicLabel}"`);
    expect(text(html)).toContain(PHOTO_COPY.publicNeedsPhoto);
  });
});

describe("[PH-U1-7] «Tu foto» con foto", () => {
  it("la foto en el marco (alt = nombre, eager), «Cambiar foto», «Quitar foto» y el switch con lo guardado", () => {
    const html = section({ url: PHOTO, showPublic: true });
    expect(html).toContain('data-photo-section="with-photo"');
    const img = new RegExp(`<img[^>]*src="${PHOTO.replace(/[?]/g, "\\?")}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(img).toContain('alt="Ana Gómez"');
    expect(img).toContain('loading="eager"');
    expect(text(html)).toContain(PHOTO_COPY.change);
    expect(html).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>${PHOTO_COPY.remove}</button>`));
    const sw = switchTag(html);
    expect(sw).toContain('aria-checked="true"');
    expect(sw).not.toContain("disabled");
    expect(text(html)).toContain(PHOTO_COPY.publicHintOn);
  });
  it("sin logo del consultorio: la foto sin insignia", () => {
    const html = section({ url: PHOTO, showPublic: false }, false, null);
    expect(html).not.toContain("/api/consultorio/logo");
    expect(text(html)).toContain(PHOTO_COPY.publicHintOff);
  });
  it("consultorio en modo lectura: el switch (del consultorio) bloqueado; subir y quitar (de la persona) no", () => {
    const html = section({ url: PHOTO, showPublic: false }, true);
    expect(switchTag(html)).toContain("disabled");
    expect(/<input[^>]*type="file"[^>]*>/.exec(html)?.[0]).not.toContain("disabled");
    expect(html).toMatch(new RegExp(`<button[^>]*type="button"(?![^>]*disabled)[^>]*>${PHOTO_COPY.remove}</button>`));
  });
});

const DATA: ConfiguracionMiAgendaData = {
  practitionerId: "pr_1",
  name: "Ana Gómez",
  publicBookingEnabled: true,
  tenantPublicBookingEnabled: true,
  publicMinLeadMinutes: null,
  tenantPublicMinLeadMinutes: 60,
  contactWhatsapp: null,
  showContactInLeadWindow: false,
  contactConsentAt: null,
  notifyBookingEmail: true,
  notifyBookingPush: false,
  ownPublicBookingEnabled: true,
  showPublicPrice: true,
  showContactForInsured: false,
  tenantSlug: "tmp",
  bookingUrl: "/c/tmp/booking?pro=pr_1",
  license: { license: null, updatedAt: null },
  photo: { url: PHOTO, showPublic: false },
};

describe("[PH-U1-8] «Mi agenda»: «Tu foto» arriba, junto a la matrícula", () => {
  it("orden: foto y matrícula primero (en la misma fila), después las secciones de la agenda", () => {
    const html = wrap(
      <TweaksProvider>
        <MiAgendaPanel data={DATA} vapidPublicKey={null} agendaCatalog={{ locations: [], rooms: [] }} />
      </TweaksProvider>
    );
    const order = Array.from(html.matchAll(/data-mi-agenda-section="([^"]+)"/g), (m) => m[1]);
    expect(order).toEqual(["foto", "matricula", "servicios", "horarios", "excepciones", "turnero", "avisos"]);
    expect(text(html)).toContain(PHOTO_COPY.section);
    // La foto del loader llega a la sección.
    expect(html).toContain(`src="${PHOTO}"`);
  });
});

describe("[PH-U1-9] avatar propio en el shell", () => {
  const menuImg = (html: string) => /<img[^>]*data-user-photo[^>]*>/.exec(html)?.[0] ?? null;

  it("menú de cuenta: con foto, la foto (decorativa: el botón ya dice de quién es); sin foto o sin provider, iniciales", () => {
    const withPhoto = renderToStaticMarkup(
      <UserPhotoProvider value={PHOTO}>
        <TopbarAccountMenu name="Ana Gómez" />
      </UserPhotoProvider>
    );
    const img = menuImg(withPhoto);
    expect(img).toContain(`src="${PHOTO}"`);
    expect(img).toContain('alt=""');
    expect(withPhoto).toContain('aria-label="Menú de cuenta de Ana Gómez"');
    for (const html of [
      renderToStaticMarkup(
        <UserPhotoProvider value={null}>
          <TopbarAccountMenu name="Ana Gómez" />
        </UserPhotoProvider>
      ),
      renderToStaticMarkup(<TopbarAccountMenu name="Ana Gómez" />),
    ]) {
      expect(menuImg(html)).toBeNull();
      expect(text(html)).toContain("AG");
    }
  });

  it("ProfileMenu (dashboard, chrome «Barra lateral»): la misma foto", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <UserPhotoProvider value={PHOTO}>
          <ProfileMenu name="Ana Gómez" preferences={{} as Preferences} />
        </UserPhotoProvider>
      </ToastProvider>
    );
    expect(menuImg(html)).toContain(`src="${PHOTO}"`);
  });

  it("AppShell: `userPhotoUrl` llega al avatar de la barra móvil; sin la prop, iniciales", () => {
    const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] }));
    const shell = (userPhotoUrl?: string | null) =>
      renderToStaticMarkup(
        <TweaksProvider>
          <AppShell
            modules={KINE}
            caps={Array.from(capabilitiesFor("PRACTITIONER"))}
            realtime={{ driver: "off", tenantId: "t1" }}
            alertViewer={{ practitionerId: null, canOperateAll: false }}
            initialAlertPrefs={{ arrivalAlert: "off", callAlert: "off" } as never}
            userName="Ana Gómez"
            userPhotoUrl={userPhotoUrl}
          >
            <p>contenido</p>
          </AppShell>
        </TweaksProvider>
      );
    const html = shell(PHOTO);
    const bar = /<header[^>]*data-mobile-bar[^>]*>[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
    expect(menuImg(bar)).toContain(`src="${PHOTO}"`);
    expect(menuImg(shell())).toBeNull();
    expect(menuImg(shell(null))).toBeNull();
  });
});
