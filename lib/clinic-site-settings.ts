"use server";

/**
 * CF3 (SD-S, §30 D-CF3-9/D-CF3-10): Configuración → «Sitio web», la sede digital pública `/<slug>`.
 *
 * Gate `tenant.sensitive` (`requireTenantSensitive`) en las DOS actions, también en la lectura: prender la sede publica
 * el consultorio en Google (D-CF3-10: prendida = indexable y en el sitemap), como abrir el turnero, que ya es
 * `tenant.sensitive` (T3, C-AS1). La Secretaria con «Configuración» no la prende ni edita lo que dice.
 *
 * Soporte: SIN `withSupportWritable` a propósito (decisión con default de SD-S). Publicar una página que no pidió el
 * consultorio no es «ayudar a configurar»; el superadmin la prende o apaga desde Plataforma con doble audit
 * (`setPlatformTenantSite`, `lib/platform-tenants.ts`). Un soporte en el consultorio está en solo lectura y el
 * guardado rebota por `withReadOnlyResult`. Si Martin lo quiere, se suma a `SUPPORT_WRITABLE_ACTIONS` y se envuelve.
 *
 * Escritura (una tx, `runWithRls`):
 *   1. `updateTenantProfileInTx` (núcleo de BO2-D compartido con /plataforma y `updateTenantBasics`): FOR UPDATE de la
 *      fila + CAS contra `expectedUpdatedAt` + diff del contacto (teléfono, WhatsApp, email). El CAS acá es
 *      OBLIGATORIO: el superadmin puede estar cambiando el mismo contacto o el switch desde Plataforma.
 *   2. Diff y write de lo propio de la sede (switch, frase, descripción) con `updatedAt` estrictamente mayor que el que
 *      dejó el paso 1 (dos writes en el mismo ms dejarían pasar un CAS viejo; mismo motivo que el núcleo).
 *      `siteEnabledAt` = ahora SOLO al pasar de apagada a prendida; apagar no lo borra (auditoría, M22).
 *   3. Audit `tenant.site.update` en la misma tx con las CLAVES que cambiaron (sin valores) y el switch final.
 *   Sin cambios reales: ni write ni audit ni revalidación (el `updatedAt` del form sigue vigente).
 *
 * Después del commit (nunca adentro: un rollback dejaría el cache invalidado contra datos viejos y otro request lo
 * llenaría con el estado previo): `CLINIC_SITES_TAG` (snapshot de la sede), `tags.directory()` (el directorio publica
 * la misma descripción y el mismo contacto, `lib/directory-internal.ts:52`), `/<slug>` (ISR de la sede),
 * `/configuracion` y, si cambió el contacto o los colores, el turnero (`clinicPhone` del turnero, PR-T; BR-P: el
 * turnero pinta `Tenant.palette`).
 *
 * BR-P · «Colores del sitio y del turnero» (`palette`): las cuatro generales o la de marca que el consultorio tenga
 * ASIGNADA (hoy = la que ya tiene guardada; la asigna Plataforma, `setPlatformTenantSite`). Se valida contra la fila
 * ya bloqueada por el paso 1 (no contra el input ni contra lo que vio el form): si la de marca no es la suya, la tx se
 * revierte entera (`PaletteNotAllowed`) y el contacto del paso 1 tampoco queda escrito.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError } from "@/lib/session";
import { requireTenantSensitive } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { CLINIC_SITES_TAG, tags } from "@/lib/cache-tags";
import { RESERVED_SLUGS } from "@/lib/onboarding-logic";
import { updateTenantProfileInTx } from "@/lib/tenant-profile-internal";
import { isAppPalette, paletteAllowedForTenant, palettesForTenant, type AppPalette } from "@/lib/brand-palettes";
import {
  SITE_SETTINGS_COPY,
  SiteSettingsExpected,
  SiteSettingsInput,
  type SiteSettings,
  type SiteSettingsInputValues,
  type SiteSettingsKey,
} from "@/lib/clinic-site-settings-schemas";
import type { ActionResult } from "@/lib/validation";

// CF3 ZF2 (B3): el copy tiene que decir lo mismo que el gate `tenant.sensitive` (lib/capabilities.ts, C-AS1): el Titular
// siempre; un Administrador o un profesional solo con «Configuración» (antes decía «el administrador» a secas, y un
// Administrador sin la delegación tampoco pasa); Secretaría y Facturación nunca, aunque tengan «Configuración» (corte
// de staff). Lo usan la lectura y el guardado, por eso «lo maneja» y no «puede cambiar».
const FORBIDDEN =
  "El sitio web lo maneja el titular, o un administrador o profesional con permiso de «Configuración». Secretaría y Facturación no tienen acceso.";

/** Corta la tx (rollback del paso 1): la paleta de marca pedida no es la del consultorio. */
class PaletteNotAllowed extends Error {
  constructor() {
    super("palette_not_allowed");
    this.name = "PaletteNotAllowed";
  }
}

async function sensitiveActor() {
  try {
    return { ok: true as const, actor: await requireTenantSensitive(FORBIDDEN) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false as const, error: e.message };
    throw e;
  }
}

/** Lo que muestra la pestaña «Sitio web». */
export async function getSiteSettings(): Promise<ActionResult<SiteSettings>> {
  const gate = await sensitiveActor();
  if (!gate.ok) return gate;
  const { actor } = gate;
  const row = await runWithRls(actor.tenantId, (tx) =>
    tx.tenant.findFirst({
      where: { id: actor.tenantId },
      select: {
        slug: true,
        siteEnabled: true,
        siteEnabledAt: true,
        siteTagline: true,
        publicDescription: true,
        phone: true,
        whatsapp: true,
        publicEmail: true,
        logoStorageKey: true,
        palette: true,
        updatedAt: true,
      },
    })
  );
  if (!row) return { ok: false, error: SITE_SETTINGS_COPY.notFound };
  const palette: AppPalette = isAppPalette(row.palette) ? row.palette : "sky";
  return {
    ok: true,
    data: {
      slug: row.slug,
      sitePath: `/${row.slug}`,
      siteEnabled: row.siteEnabled,
      siteEnabledAt: row.siteEnabledAt?.toISOString() ?? null,
      siteTagline: row.siteTagline,
      publicDescription: row.publicDescription,
      phone: row.phone,
      whatsapp: row.whatsapp,
      publicEmail: row.publicEmail,
      hasLogo: row.logoStorageKey !== null,
      slugReserved: RESERVED_SLUGS.has(row.slug),
      updatedAt: row.updatedAt.toISOString(),
      palette,
      paletteOptions: palettesForTenant(row.palette),
    },
  };
}

type WriteOutcome =
  | { ok: true; changed: SiteSettingsKey[]; updatedAt: Date; slug: string; siteEnabled: boolean }
  | { ok: false; reason: "stale" | "not-found" };

/**
 * Guarda el formulario entero de «Sitio web». `expectedUpdatedAt` = `SiteSettings.updatedAt` que leyó el form.
 * Devuelve el `updatedAt` nuevo (o el mismo si no cambió nada) para el próximo guardado.
 */
export async function updateSiteSettings(
  input: SiteSettingsInputValues,
  expectedUpdatedAt: string
): Promise<ActionResult<{ updatedAt: string; changed: SiteSettingsKey[] }>> {
  return withReadOnlyResult(async () => {
    const gate = await sensitiveActor();
    if (!gate.ok) return gate;
    const { actor } = gate;

    const parsed = SiteSettingsInput.safeParse(input);
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
      const first = Object.values(fieldErrors)[0]?.[0] ?? parsed.error.issues[0]?.message;
      return { ok: false as const, error: first ?? SITE_SETTINGS_COPY.invalid, fieldErrors };
    }
    const expected = SiteSettingsExpected.safeParse(expectedUpdatedAt);
    if (!expected.success) return { ok: false as const, error: SITE_SETTINGS_COPY.stale };
    const v = parsed.data;

    let r: WriteOutcome;
    try {
      r = await runWithRls(actor.tenantId, async (tx) => {
        const profile = await updateTenantProfileInTx(tx, {
          tenantId: actor.tenantId,
          patch: { phone: v.phone, whatsapp: v.whatsapp, publicEmail: v.publicEmail },
          expectedUpdatedAt: new Date(expected.data),
        });
        if (!profile.ok) return profile;

        const cur = await tx.tenant.findFirst({
          where: { id: actor.tenantId },
          select: { slug: true, siteEnabled: true, siteTagline: true, publicDescription: true, palette: true },
        });
        if (!cur) return { ok: false as const, reason: "not-found" as const };

        const changed: SiteSettingsKey[] = [...profile.changed] as SiteSettingsKey[];
        const data: {
          siteEnabled?: boolean;
          siteEnabledAt?: Date;
          siteTagline?: string | null;
          publicDescription?: string | null;
          palette?: AppPalette;
        } = {};
        const now = new Date();
        if (cur.siteEnabled !== v.siteEnabled) {
          changed.push("siteEnabled");
          data.siteEnabled = v.siteEnabled;
          if (v.siteEnabled) data.siteEnabledAt = now;
        }
        if (cur.siteTagline !== v.siteTagline) {
          changed.push("siteTagline");
          data.siteTagline = v.siteTagline;
        }
        if (cur.publicDescription !== v.publicDescription) {
          changed.push("publicDescription");
          data.publicDescription = v.publicDescription;
        }
        if (v.palette !== undefined && v.palette !== cur.palette) {
          if (!paletteAllowedForTenant(v.palette, cur.palette)) throw new PaletteNotAllowed();
          changed.push("palette");
          data.palette = v.palette;
        }

        let updatedAt = profile.updatedAt;
        if (Object.keys(data).length > 0) {
          updatedAt = new Date(Math.max(now.getTime(), profile.updatedAt.getTime() + 1));
          await tx.tenant.update({ where: { id: actor.tenantId }, data: { ...data, updatedAt }, select: { id: true } });
        }
        if (changed.length > 0) {
          await auditInTx(tx, {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            action: "tenant.site.update",
            entity: "Tenant",
            entityId: actor.tenantId,
            payload: { changed, siteEnabled: v.siteEnabled },
          });
        }
        return { ok: true as const, changed, updatedAt, slug: cur.slug, siteEnabled: v.siteEnabled };
      });
    } catch (e) {
      if (e instanceof PaletteNotAllowed) {
        return {
          ok: false as const,
          error: SITE_SETTINGS_COPY.paletteNotAllowed,
          fieldErrors: { palette: [SITE_SETTINGS_COPY.paletteNotAllowed] },
        };
      }
      throw e;
    }

    if (!r.ok) {
      return { ok: false as const, error: r.reason === "stale" ? SITE_SETTINGS_COPY.stale : SITE_SETTINGS_COPY.notFound };
    }
    if (r.changed.length > 0) {
      revalidateTag(CLINIC_SITES_TAG);
      revalidateTag(tags.directory());
      revalidatePath(`/${r.slug}`);
      revalidatePath("/configuracion");
      if (r.changed.some((k) => k === "phone" || k === "whatsapp" || k === "publicEmail" || k === "palette")) {
        revalidatePath(`/c/${r.slug}/booking`);
      }
    }
    return { ok: true as const, data: { updatedAt: r.updatedAt.toISOString(), changed: r.changed } };
  });
}
