import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [DIR-3e] /plataforma/directorio: lógica pura (filtros, estados derivados, motivo) y las listas server montadas de
 * verdad. Solo se mockean los paneles de acciones (cliente: router, confirm y toast no existen en node); se los
 * reemplaza por un marcador que deja ver qué props reciben. `lib/platform-directory-read` se reemplaza por su
 * constante: es server-only (Prisma + sesión) y las listas solo toman de ahí el tope y los tipos.
 */
vi.mock("@/lib/platform-directory-read", () => ({ PLATFORM_DIRECTORY_LIMIT: 200 }));
vi.mock("@/components/plataforma/directory/moderation-actions", () => ({
  ClinicModerationActions: (p: { tenantId: string; hidden: unknown }) => (
    <span data-clinic-actions={p.tenantId} data-hidden={p.hidden ? "1" : "0"} />
  ),
  ProfileModerationActions: (p: { profileId: string; license: { text: string; verified: boolean } | null }) => (
    <span data-profile-actions={p.profileId} data-license={p.license ? `${p.license.text}|${p.license.verified}` : "none"} />
  ),
}));

import {
  clinicStatus,
  directoryAdminHref,
  hideReasonError,
  isHideReasonDirty,
  licenseText,
  profileDisplayName,
  profileStatus,
  publicClinicHref,
  publicProfileHref,
} from "@/components/plataforma/directory/moderation-logic";
import { DirectoryClinicList, DirectoryFilters, DirectoryProfileList } from "@/components/plataforma/directory/directory-lists";
import type {
  PlatformDirectoryClinicRow,
  PlatformDirectoryProfileRow,
  PlatformDirectoryView,
} from "@/lib/platform-directory-read";

const clinic = (o: Partial<PlatformDirectoryClinicRow> = {}): PlatformDirectoryClinicRow => ({
  tenantId: "t1",
  name: "Kine Centro",
  slug: "kine-centro",
  directoryListed: true,
  directoryListedAt: "2026-10-01T15:00:00.000Z",
  publicBookingEnabled: true,
  tenantStatus: "ACTIVE",
  hasDescription: true,
  hidden: null,
  ...o,
});

const profile = (o: Partial<PlatformDirectoryProfileRow> = {}): PlatformDirectoryProfileRow => ({
  profileId: "p1",
  userId: "u-123",
  publicName: "Ana Pérez",
  honorific: "LIC",
  license: { kind: "MP", number: "4567", jurisdiction: "X", verifiedAt: null },
  listed: true,
  consentAt: "2026-10-02T15:00:00.000Z",
  consentVersion: "2026-10-v1",
  consentWithdrawnAt: null,
  hidden: null,
  clinics: [{ tenantId: "t1", name: "Kine Centro", slug: "kine-centro" }],
  updatedAt: "2026-10-02T15:00:00.000Z",
  ...o,
});

const view = (o: Partial<PlatformDirectoryView> = {}): PlatformDirectoryView => ({
  filters: { q: "", estado: "todos" },
  clinics: [clinic()],
  profiles: [profile()],
  truncated: { clinics: false, profiles: false },
  ...o,
});

describe("[DIR-3e] moderation-logic", () => {
  it("directoryAdminHref omite los defaults y conserva q + estado", () => {
    expect(directoryAdminHref({})).toBe("/plataforma/directorio");
    expect(directoryAdminHref({ q: "  ", estado: "todos" })).toBe("/plataforma/directorio");
    expect(directoryAdminHref({ q: "ana", estado: "ocultos" })).toBe("/plataforma/directorio?q=ana&estado=ocultos");
  });

  it("el motivo exige 3..500 recortado (mismo rango que la action y el CHECK de M11)", () => {
    expect(hideReasonError("  ab  ")).toMatch(/mínimo 3/);
    expect(hideReasonError("abc")).toBeNull();
    expect(hideReasonError("x".repeat(500))).toBeNull();
    expect(hideReasonError("x".repeat(501))).toMatch(/hasta 500/);
  });

  it("dirty-guard: compara contra el motivo con que se abrió", () => {
    expect(isHideReasonDirty("", "")).toBe(false);
    expect(isHideReasonDirty("spam", "")).toBe(true);
    expect(isHideReasonDirty(" spam ", "spam")).toBe(false);
  });

  it("estado del consultorio: oculto manda; publicado sin turnero o inactivo explica por qué no aparece", () => {
    expect(clinicStatus(clinic()).label).toBe("Publicado");
    expect(clinicStatus(clinic({ hidden: { at: "2026-10-03T00:00:00.000Z", reason: "spam" } })).label).toBe("Oculto por Plataforma");
    expect(clinicStatus(clinic({ publicBookingEnabled: false })).note).toMatch(/turnero apagado/);
    expect(clinicStatus(clinic({ tenantStatus: "SUSPENDED" })).note).toMatch(/no está activo/);
  });

  it("estado del perfil: oculto > publicado > retiró el consentimiento > sin publicar", () => {
    expect(profileStatus(profile()).label).toBe("Publicado");
    expect(profileStatus(profile({ hidden: { at: "2026-10-03T00:00:00.000Z", reason: "x" } })).label).toBe("Oculto por Plataforma");
    expect(profileStatus(profile({ listed: false, consentWithdrawnAt: "2026-10-04T00:00:00.000Z" })).label).toBe(
      "Retiró el consentimiento"
    );
    expect(profileStatus(profile({ listed: false, consentAt: null })).label).toBe("Sin publicar");
  });

  it("nombre con honorífico conocido; matrícula con jurisdicción por nombre de provincia o el código tal cual", () => {
    expect(profileDisplayName(profile())).toBe("Lic. Ana Pérez");
    expect(profileDisplayName(profile({ honorific: "ZZ" }))).toBe("Ana Pérez");
    expect(licenseText(null)).toBeNull();
    expect(licenseText({ kind: "MN", number: "123", jurisdiction: null, verifiedAt: null })).toBe("MN 123");
    expect(licenseText({ kind: "MP", number: "9", jurisdiction: "X", verifiedAt: null })).toMatch(/^MP 9 · /);
  });

  it("link a la vista pública: solo con el directorio prendido y lo publicado y no oculto", () => {
    expect(publicProfileHref(profile(), "off")).toBeNull();
    expect(publicProfileHref(profile(), "preview")).toBe("/profesionales/ana-perez-p1");
    expect(publicProfileHref(profile({ hidden: { at: "x", reason: "y" } }), "public")).toBeNull();
    expect(publicProfileHref(profile({ consentWithdrawnAt: "2026-10-04T00:00:00.000Z" }), "public")).toBeNull();
    expect(publicClinicHref(clinic(), "public")).toBe("/consultorios/kine-centro");
    expect(publicClinicHref(clinic({ hidden: { at: "x", reason: "y" } }), "public")).toBeNull();
  });
});

describe("[DIR-3e] listas de /plataforma/directorio", () => {
  it("perfil: link a la ficha del usuario, consultorios donde atiende, matrícula a verificar; sin email", () => {
    const html = renderToStaticMarkup(<DirectoryProfileList view={view()} mode="off" />);
    expect(html).toContain('href="/plataforma/usuarios/u-123"');
    expect(html).toContain("Lic. Ana Pérez");
    expect(html).toContain('href="/plataforma/consultorios/t1"');
    expect(html).toContain("sin verificar");
    expect(html).toMatch(/data-license="MP 4567 · [^|"]+\|false"/);
    expect(html).not.toContain("@");
    // Modo off: sin link a la vista pública.
    expect(html).not.toContain("/profesionales/");
  });

  it("perfil oculto: muestra el motivo; perfil sin matrícula: acciones sin verificar", () => {
    const html = renderToStaticMarkup(
      <DirectoryProfileList
        view={view({ profiles: [profile({ license: null, hidden: { at: "2026-10-03T15:00:00.000Z", reason: "Foto falsa" } })] })}
        mode="public"
      />
    );
    expect(html).toContain("Oculto por Plataforma");
    expect(html).toContain("«Foto falsa»");
    expect(html).toContain('data-license="none"');
    expect(html).toContain("Sin matrícula cargada");
  });

  it("consultorio: estado, link al detalle y a la vista pública en preview; aviso de truncado", () => {
    const html = renderToStaticMarkup(
      <DirectoryClinicList view={view({ truncated: { clinics: true, profiles: false } })} mode="preview" />
    );
    expect(html).toContain('href="/plataforma/consultorios/t1"');
    expect(html).toContain('href="/consultorios/kine-centro"');
    expect(html).toContain('data-clinic-actions="t1"');
    expect(html).toContain("Se muestran los primeros 200");
  });

  it("vacíos: «sin verificar» explica que no aplica a consultorios", () => {
    const v = view({ filters: { q: "", estado: "sin_verificar" }, clinics: [], profiles: [] });
    expect(renderToStaticMarkup(<DirectoryClinicList view={v} mode="off" />)).toContain("no aplica a consultorios");
    expect(renderToStaticMarkup(<DirectoryProfileList view={v} mode="off" />)).toContain("No hay matrículas para verificar");
  });

  it("filtros: el chip activo marcado, la búsqueda conserva el estado y aparece «Limpiar»", () => {
    const html = renderToStaticMarkup(<DirectoryFilters filters={{ q: "ana", estado: "ocultos" }} />);
    expect(html).toMatch(/<a aria-current="true"[^>]*href="\/plataforma\/directorio\?q=ana&amp;estado=ocultos"/);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('<input type="hidden" name="estado" value="ocultos"/>');
    expect(html).toContain(">Limpiar<");
  });
});
