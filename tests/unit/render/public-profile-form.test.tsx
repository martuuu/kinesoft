import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [DIR-3d] `/cuenta/perfil-publico` (C-DIR8/C-DIR9, DIR-D11/D20/D21). Render real sin jsdom; se mockean solo las
 * server actions (red) y el router. Lo que se fija:
 *  - la casilla de consentimiento muestra el texto LITERAL de `DIRECTORY_CONSENT_TEXT` y NO viene tildada (Ley 25.326:
 *    consentimiento expreso; una casilla pre-tildada no lo es);
 *  - «Publicar» sin la casilla no llama a la action; con la casilla manda la versión vigente;
 *  - «Dejar de publicar» es un click + `useConfirm`: cancelar no retira, aceptar retira;
 *  - «verificada» solo con `licenseVerified` y la matrícula sin tocar (DIR-D10/D21);
 *  - el nombre se prellena con `defaultPublicName` (nunca un email, decisión 19);
 *  - la entrada «Mi perfil público» del menú de cuenta y del drawer móvil solo para quien atiende.
 */
const calls = vi.hoisted(() => ({ publish: [] as unknown[], save: [] as unknown[], withdraw: 0 }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/public-profile", () => ({
  getMyPublicProfile: async () => ({ ok: false, error: "no" }),
  savePublicProfile: async (input: unknown) => {
    calls.save.push(input);
    return { ok: true, data: { status: "draft" } };
  },
  publishPublicProfile: async (input: unknown) => {
    calls.publish.push(input);
    return { ok: true, data: { status: "published" } };
  },
  withdrawPublicProfile: async () => {
    calls.withdraw++;
    return { ok: true, data: { status: "withdrawn" } };
  },
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import {
  PublicProfileForm,
  PublicProfileWithdrawOnly,
  confirmAndWithdraw,
  publishWithConsent,
} from "@/components/account/public-profile-form";
import { TopbarAccountMenu, showsPublicProfileEntry, PUBLIC_PROFILE_HREF } from "@/components/layout/topbar-account-menu";
import { TenantChoiceProvider } from "@/components/layout/tenant-switcher";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { DIRECTORY_CONSENT_TEXT, DIRECTORY_CONSENT_VERSION } from "@/lib/directory-constants";
import { modulesFor } from "@/lib/tenant-modules";
import type { MyPublicProfile } from "@/lib/public-profile-types";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const unescape = (html: string) =>
  html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const render = (data: MyPublicProfile, directoryOpen = true) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <PublicProfileForm data={data} backHref="/dashboard" directoryOpen={directoryOpen} />
      </ConfirmProvider>
    </ToastProvider>
  );

const NONE: MyPublicProfile = { defaultPublicName: "Ana Pérez", status: "none", profile: null };
const PUBLISHED: MyPublicProfile = {
  defaultPublicName: "Ana Pérez",
  status: "published",
  profile: {
    publicName: "Ana Pérez",
    honorific: "KLGA",
    licenseKind: "MP",
    licenseNumber: "12345",
    licenseJurisdiction: "X",
    bio: "Rehabilitación deportiva.",
    consentVersion: DIRECTORY_CONSENT_VERSION,
    consentAt: "2026-10-16T13:00:00.000Z",
    hiddenReason: null,
    licenseVerified: true,
  },
};

describe("[DIR-3d] consentimiento", () => {
  it("muestra el texto LITERAL de la constante y la casilla NO viene tildada", () => {
    const html = render(NONE);
    expect(text(unescape(html))).toContain(DIRECTORY_CONSENT_TEXT);
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(box).toHaveLength(1);
    expect(box[0]).not.toMatch(/\schecked/);
    expect(box[0]).toMatch(/aria-describedby="[^"]+"/);
  });

  it("también sin tildar al volver a publicar después de un retiro", () => {
    const html = render({ ...PUBLISHED, status: "withdrawn" });
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(box).toHaveLength(1);
    expect(box[0]).not.toMatch(/\schecked/);
    expect(text(html)).toContain("Publicar");
    expect(text(html)).not.toContain("Dejar de publicar");
  });

  it("publicado con la versión vigente: sin casilla, con «Dejar de publicar» y la fecha del consentimiento", () => {
    const html = render(PUBLISHED);
    expect(html).not.toMatch(/type="checkbox"/);
    expect(text(html)).toContain("Dejar de publicar");
    expect(text(html)).toContain("Publicado");
    // 13:00 UTC = 10:00 en Buenos Aires (timeZone explícito: en Vercel el host es UTC).
    expect(text(html)).toMatch(/16 (de )?oct\.? (de )?2026/);
  });

  it("publicado con una versión vieja del texto: pide aceptar el nuevo (casilla sin tildar)", () => {
    const html = render({ ...PUBLISHED, profile: { ...PUBLISHED.profile!, consentVersion: "2025-01-v0" } });
    const box = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(box).toHaveLength(1);
    expect(box[0]).not.toMatch(/\schecked/);
    expect(text(html)).toContain("El texto del consentimiento cambió");
  });

  it("«Publicar» sin la casilla NO llama a la action; con la casilla manda la versión vigente", async () => {
    calls.publish.length = 0;
    const fields = { publicName: "Ana Pérez", honorific: "", licenseKind: "", licenseNumber: "", licenseJurisdiction: "", bio: "" };
    const no = await publishWithConsent(fields, false);
    expect(no.ok).toBe(false);
    expect(calls.publish).toHaveLength(0);
    const yes = await publishWithConsent(fields, true);
    expect(yes.ok).toBe(true);
    expect(calls.publish).toHaveLength(1);
    expect(calls.publish[0]).toMatchObject({ consentAccepted: true, consentVersion: DIRECTORY_CONSENT_VERSION, publicName: "Ana Pérez" });
    expect(calls.publish[0]).not.toHaveProperty("userId");
  });

  it("«Publicar» con un campo inválido no llama a la action (el email como nombre se frena antes)", async () => {
    calls.publish.length = 0;
    const r = await publishWithConsent(
      { publicName: "ana@kinesoft.test", honorific: "", licenseKind: "", licenseNumber: "", licenseJurisdiction: "", bio: "" },
      true
    );
    expect(r.ok).toBe(false);
    expect(calls.publish).toHaveLength(0);
  });
});

describe("[DIR-3d] retirar = un click + useConfirm", () => {
  it("cancelar el confirm no retira; aceptarlo retira", async () => {
    calls.withdraw = 0;
    const asked: unknown[] = [];
    const cancelled = await confirmAndWithdraw(async (o) => {
      asked.push(o);
      return false;
    });
    expect(cancelled).toBeNull();
    expect(calls.withdraw).toBe(0);
    expect(asked[0]).toMatchObject({ tone: "danger", confirmLabel: "Dejar de publicar" });
    const done = await confirmAndWithdraw(async () => true);
    expect(done).toMatchObject({ ok: true, data: { status: "withdrawn" } });
    expect(calls.withdraw).toBe(1);
  });

  it("quien ya no atiende igual puede retirar (vista solo de retiro)", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <PublicProfileWithdrawOnly backHref="/dashboard" />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(text(html)).toContain("Dejar de publicar");
    expect(html).not.toMatch(/type="checkbox"/);
  });
});

describe("[DIR-3d] formulario y vista previa", () => {
  it("prellena el nombre público con `defaultPublicName` y sin título ni matrícula", () => {
    const html = render(NONE);
    expect(html).toMatch(/<input[^>]*value="Ana Pérez"/);
    expect(text(html)).toContain("Vista previa");
    expect(text(html.slice(html.indexOf("Vista previa")))).not.toContain("Verificada");
  });

  it("vista previa: título + nombre, matrícula con provincia y «Verificada» solo si Plataforma la verificó", () => {
    // Solo la vista previa (el texto de ayuda de la matrícula también nombra «Verificada»).
    const preview = (h: string) => text(h.slice(h.indexOf("Vista previa")));
    const html = preview(render(PUBLISHED));
    expect(html).toContain("Klga. Ana Pérez");
    expect(html).toContain("MP 12345 · Córdoba");
    expect(html).toContain("Verificada");
    const unverified = preview(render({ ...PUBLISHED, profile: { ...PUBLISHED.profile!, licenseVerified: false } }));
    expect(unverified).not.toContain("Verificada");
  });

  it("oculto por Plataforma: banda con el motivo", () => {
    const html = text(render({ ...PUBLISHED, status: "hidden", profile: { ...PUBLISHED.profile!, hiddenReason: "Matrícula a revisar" } }));
    expect(html).toContain("Plataforma ocultó tu perfil: Matrícula a revisar");
  });

  it("directorio todavía cerrado: lo avisa sin esconder el formulario", () => {
    const html = text(render(NONE, false));
    expect(html).toContain("El directorio todavía no está abierto al público");
    expect(html).toContain("Publicar");
  });

  it("sin h1 propio: la única h1 es la de la página (StatusHeading); el formulario usa h2", () => {
    expect(render(NONE)).not.toMatch(/<h1/);
  });
});

describe("[DIR-3d] entrada «Mi perfil público»", () => {
  it("regla: atiende en el consultorio activo, o es Profesional en otro de sus consultorios", () => {
    expect(showsPublicProfileEntry(true, [])).toBe(true);
    expect(showsPublicProfileEntry(false, [{ role: "ASSISTANT" }])).toBe(false);
    expect(showsPublicProfileEntry(false, [{ role: "ASSISTANT" }, { role: "PRACTITIONER" }])).toBe(true);
    expect(showsPublicProfileEntry(false, [])).toBe(false);
  });

  it("menú de cuenta: aparece con ficha propia y no para la Secretaria", () => {
    const menu = (own: { practitionerId: string; enabled: boolean } | null) =>
      renderToStaticMarkup(
        <TenantModulesProvider modules={Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true }))}>
          <TenantChoiceProvider options={[]} activeTenantId="a" switchTenant={null}>
            <TopbarAccountMenu name="Ana Pérez" defaultOpen ownPublicBooking={own} />
          </TenantChoiceProvider>
        </TenantModulesProvider>
      );
    expect(PUBLIC_PROFILE_HREF).toBe("/cuenta/perfil-publico");
    expect(menu({ practitionerId: "p1", enabled: true })).toMatch(
      /<a href="\/cuenta\/perfil-publico" role="menuitem"[^>]*>.*Mi perfil público/
    );
    expect(menu(null)).not.toContain("Mi perfil público");
  });
});
