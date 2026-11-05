"use client";

/**
 * CF3 (SD-C, §30 D-CF3-9/D-CF3-10): Configuración → «Sitio web», la sede digital pública `/<slug>`.
 *
 * Qué hace el consultorio acá:
 *   • prende o apaga «Publicar el sitio del consultorio». Apagado por defecto (D-CF3-10): prendido = la página
 *     `/<slug>` se ve, la indexa Google y entra en el sitemap. Apagar pide confirmación (`useConfirm`) porque el link
 *     que el consultorio ya repartió deja de andar;
 *   • ve la dirección completa (`window.location.origin + sitePath`, solo después de montar: en el render del server
 *     no hay `window` y un origin inventado mostraría un dominio equivocado en un preview de Vercel), con «Ver mi
 *     sitio» (pestaña nueva) y «Copiar»;
 *   • carga la frase (≤ `SITE_TAGLINE_MAX`, una línea), la descripción (≤ `SITE_DESCRIPTION_MAX`, la MISMA columna que
 *     el directorio, §30.3) y el contacto público (teléfono, WhatsApp, email). El email se edita acá porque es el único
 *     editor del contacto del consultorio, pero la sede NO lo publica (D-CF3-9 «nunca el email de nadie»; default de
 *     SD-S), y se lo decimos al lado del campo para que nadie lo cargue esperando verlo;
 *   • avisos: slug tapado por una ruta fija de la app (`slugReserved`: aunque se prenda no se publica, lo resuelve
 *     Plataforma) y consultorio sin logo (se sube en General).
 *
 * Datos: el panel se carga solo con `getSiteSettings()` (sin props: lo registra AU-U2 como una pestaña más). La lectura
 * es `tenant.sensitive`; si el server la rechaza se muestra su mensaje y nada más.
 *
 * Guardado: el formulario entero con `updateSiteSettings(input, expectedUpdatedAt)`. El CAS es obligatorio en el
 * server (el superadmin puede estar tocando el mismo switch desde Plataforma): si rebota con «Otro cambio se guardó
 * antes», el form NO se pisa solo (se perdería lo que la persona escribió) y ofrece «Traer lo último» (con
 * confirmación si hay cambios). Antes de mandar se valida con el MISMO zod del server (`SiteSettingsInput`): mismos
 * mensajes, un viaje menos, y el valor normalizado (WhatsApp en E.164, email en minúsculas) queda como base nueva sin
 * releer. El switch guarda al toque (como el del directorio) mandando la BASE guardada con el switch cambiado: lo que
 * esté a medio escribir en los campos no viaja con él y sigue sin guardar.
 *
 * Dirty-guard: aviso de cambios sin guardar, «Descartar» con `useConfirm`, `beforeunload` y `onDirtyChange` (el shell
 * de Configuración frena el cambio de pestaña si lo pasa).
 *
 * BR-P · «Colores del sitio y del turnero» (`Tenant.palette`): las cuatro generales + la de marca si es la asignada
 * (`settings.paletteOptions`, del server). Va con el resto del form («Guardar», dirty-guard); el switch manda la paleta
 * GUARDADA, como manda la base de los textos. Si el consultorio tiene la de marca y elige otra, se avisa que para
 * volver a ella hay que pedirla a soporte (la asigna Plataforma). No cambia la Apariencia de nadie en la app.
 * CF3 ZF5 (B, default de Martin pendiente): además de la nota, «Guardar» pide confirmación (`useConfirm`,
 * `confirmBrandPaletteLeave`) antes de dejar la de marca: guardarla la saca de la lista para siempre (el server no
 * cambia de regla: solo Plataforma la vuelve a asignar) y la nota al lado del campo se puede no leer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button, buttonClassName } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { FormField } from "@/components/ui/form-field";
import { IconAlert } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { useConfirm, type ConfirmOptions } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { getSiteSettings, updateSiteSettings } from "@/lib/clinic-site-settings";
import { brandPaletteFor, palettesForTenant, type AppPalette } from "@/lib/brand-palettes";
import { BRAND_NAME } from "@/lib/brand";
import { BRAND_PALETTE_OPTIONS, PALETTE_OPTIONS, type PaletteOption } from "@/components/layout/appearance-options";
import {
  SITE_DESCRIPTION_MAX,
  SITE_SETTINGS_COPY,
  SITE_TAGLINE_MAX,
  SiteSettingsInput,
  type SiteSettings,
  type SiteSettingsInputValues,
} from "@/lib/clinic-site-settings-schemas";
import type { ActionResult } from "@/lib/validation";
import styles from "./site-panel.module.css";

// ───────────────────────────── lógica pura (exportada para los tests) ─────────────────────────────

export type SiteFormState = {
  siteTagline: string;
  publicDescription: string;
  phone: string;
  whatsapp: string;
  publicEmail: string;
};

export type SiteFieldKey = keyof SiteFormState;
/** BR-P: `palette` no es un campo de texto del form, pero el server puede marcarla (de marca ajena, valor inválido). */
export type SiteFieldErrors = Partial<Record<SiteFieldKey | "palette", string>>;

export const SITE_PANEL_COPY = {
  switchLabel: "Publicar el sitio del consultorio",
  on: "El sitio está publicado: cualquiera lo ve con el link y aparece en Google.",
  off: "El sitio no está publicado: la dirección todavía no muestra nada.",
  emailNote: "El email no se publica en el sitio.",
  reserved:
    "La dirección de tu consultorio coincide con una página de la app, así que el sitio no se puede publicar con ella. Escribinos desde Soporte y te la cambiamos.",
  noLogo: "Tu consultorio todavía no tiene logo: el sitio muestra solo el nombre.",
  noLogoLink: "Subilo en General",
  turnOffTitle: "¿Dejar de publicar el sitio?",
  turnOffMessage:
    "El link que compartiste deja de mostrar el consultorio y Google lo va a ir sacando. Lo que cargaste queda guardado y lo podés volver a publicar cuando quieras.",
  reload: "Traer lo último",
  saved: "Sitio web guardado",
  published: "El sitio del consultorio está publicado",
  unpublished: "El sitio del consultorio ya no está publicado",
  copied: "Dirección copiada",
  copyFailed: "No se pudo copiar. Seleccioná la dirección y copiala a mano.",
  network: "No se pudo guardar. Revisá la conexión y probá de nuevo.",
  loadFailed: "No se pudo cargar el sitio web. Recargá la página.",
  paletteLegend: "Colores del sitio y del turnero",
  paletteHint: "Los usan la página del consultorio y los turnos online. No cambian cómo ve la app cada uno (eso es Apariencia).",
  brandLeaving: (label: string) =>
    `${label} son los colores de tu marca. Si elegís otros y guardás, para volver a ellos escribinos desde Soporte.`,
} as const;

/**
 * CF3 ZF5: diálogo de «Guardar» cuando la paleta GUARDADA es la de marca y la elegida es otra (ver la cabecera). null =
 * no hace falta preguntar (sin cambio, entre generales, volviendo a la de marca, o sin paleta del server).
 */
export function brandPaletteLeaveDialog(saved: AppPalette | undefined, next: AppPalette | undefined): ConfirmOptions | null {
  const brand = saved ? brandPaletteFor(saved) : null;
  if (!brand || next === undefined || next === saved) return null;
  const to = sitePaletteOption(next).label;
  return {
    title: "¿Dejar los colores de tu marca?",
    message: `Si cambiás a ${to}, la paleta ${brand.label} solo la puede volver a asignar el equipo de ${BRAND_NAME}.`,
    confirmLabel: `Cambiar a ${to}`,
    cancelLabel: `Seguir con ${brand.label}`,
    tone: "danger",
  };
}

/** `true` = seguir guardando (no hacía falta preguntar o la persona confirmó). Exportado para el test (sin jsdom). */
export async function confirmBrandPaletteLeave(
  confirm: (o: ConfirmOptions) => Promise<boolean>,
  saved: AppPalette | undefined,
  next: AppPalette | undefined
): Promise<boolean> {
  const dialog = brandPaletteLeaveDialog(saved, next);
  return dialog ? confirm(dialog) : true;
}

/** BR-P: swatch y rótulo de cada paleta (los mismos de Apariencia). */
export function sitePaletteOption(p: AppPalette): PaletteOption {
  const brand = brandPaletteFor(p);
  return brand ? BRAND_PALETTE_OPTIONS[brand.key] : (PALETTE_OPTIONS.find((o) => o.value === p) ?? PALETTE_OPTIONS[0]);
}

/** `char_length` de Postgres cuenta code points (como el CHECK y el zod): un emoji es 1, no 2. */
export function codePointLength(s: string): number {
  return [...s.trim()].length;
}

export function formFromSettings(s: Pick<SiteSettings, SiteFieldKey>): SiteFormState {
  return {
    siteTagline: s.siteTagline ?? "",
    publicDescription: s.publicDescription ?? "",
    phone: s.phone ?? "",
    whatsapp: s.whatsapp ?? "",
    publicEmail: s.publicEmail ?? "",
  };
}

const FIELDS: SiteFieldKey[] = ["siteTagline", "publicDescription", "phone", "whatsapp", "publicEmail"];

/** Recortado, como lo compara el server: un espacio al final no es un cambio. */
export function siteFormDirty(a: SiteFormState, b: SiteFormState): boolean {
  return FIELDS.some((k) => a[k].trim() !== b[k].trim());
}

/** BR-P: `palette` solo viaja si el form la conoce (ausente = el server no la toca). */
export function toSiteInput(form: SiteFormState, siteEnabled: boolean, palette?: AppPalette): SiteSettingsInputValues {
  return palette === undefined ? { siteEnabled, ...form } : { siteEnabled, ...form, palette };
}

/** Primer mensaje de cada campo (el server manda `string[]`). Lo que no es un campo del form se ignora. */
export function pickFieldErrors(fe: Record<string, string[] | undefined> | undefined): SiteFieldErrors {
  const out: SiteFieldErrors = {};
  for (const k of [...FIELDS, "palette" as const]) {
    const m = fe?.[k]?.[0];
    if (m) out[k] = m;
  }
  return out;
}

export type SiteSaveOutcome =
  | { ok: true; updatedAt: string; saved: SiteFormState; siteEnabled: boolean; palette?: AppPalette }
  | { ok: false; error: string; fieldErrors: SiteFieldErrors; stale: boolean };

type UpdateFn = (
  input: SiteSettingsInputValues,
  expectedUpdatedAt: string
) => Promise<ActionResult<{ updatedAt: string; changed: string[] }>>;

/**
 * Valida con el zod del server y, si pasa, guarda con CAS. `saved` = el valor NORMALIZADO por el mismo zod (lo que
 * quedó en la base), para usarlo de base sin releer. `stale` = el CAS rebotó (otro guardado en el medio).
 */
export async function saveSiteForm(
  form: SiteFormState,
  siteEnabled: boolean,
  expectedUpdatedAt: string,
  update: UpdateFn = updateSiteSettings,
  palette?: AppPalette
): Promise<SiteSaveOutcome> {
  const parsed = SiteSettingsInput.safeParse(toSiteInput(form, siteEnabled, palette));
  if (!parsed.success) {
    const fieldErrors = pickFieldErrors(parsed.error.flatten().fieldErrors as Record<string, string[]>);
    return { ok: false, error: Object.values(fieldErrors)[0] ?? SITE_SETTINGS_COPY.invalid, fieldErrors, stale: false };
  }
  let r: Awaited<ReturnType<UpdateFn>>;
  try {
    r = await update(toSiteInput(form, siteEnabled, palette), expectedUpdatedAt);
  } catch {
    return { ok: false, error: SITE_PANEL_COPY.network, fieldErrors: {}, stale: false };
  }
  if (!r.ok) {
    return {
      ok: false,
      error: r.error,
      fieldErrors: pickFieldErrors(r.fieldErrors),
      stale: r.error === SITE_SETTINGS_COPY.stale,
    };
  }
  const v = parsed.data;
  return {
    ok: true,
    updatedAt: r.data.updatedAt,
    siteEnabled: v.siteEnabled,
    ...(v.palette !== undefined ? { palette: v.palette } : {}),
    saved: formFromSettings({
      siteTagline: v.siteTagline,
      publicDescription: v.publicDescription,
      phone: v.phone,
      whatsapp: v.whatsapp,
      publicEmail: v.publicEmail,
    }),
  };
}

// ───────────────────────────── componente ─────────────────────────────

export function SitePanel({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getSiteSettings();
      if (!r.ok) {
        setLoadError(r.error);
        return;
      }
      setLoadError(null);
      setSettings(r.data);
    } catch {
      setLoadError(SITE_PANEL_COPY.loadFailed);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError && !settings) {
    return (
      <div role="alert" className={styles.note}>
        <IconAlert size={16} />
        <span>{loadError}</span>
      </div>
    );
  }
  if (!settings) {
    return (
      <Card className={styles.card} aria-busy="true">
        <span className={styles.state}>Cargando el sitio web…</span>
      </Card>
    );
  }
  // `key`: al «Traer lo último» el form arranca de cero con la foto nueva (sin mezclar estados viejos).
  return <SiteForm key={settings.updatedAt} settings={settings} onReload={load} onDirtyChange={onDirtyChange} />;
}

export function SiteForm({
  settings,
  onReload,
  onDirtyChange,
  update = updateSiteSettings,
  initialForm,
  initialErrors,
  initialStale = false,
}: {
  settings: SiteSettings;
  onReload: () => Promise<void> | void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Inyectable solo para los tests; en la app es la action real. */
  update?: UpdateFn;
  /** Solo tests (render en node sin interacción): estado del form y errores como quedarían tras un guardado. */
  initialForm?: SiteFormState;
  initialErrors?: { error: string; fieldErrors: SiteFieldErrors };
  initialStale?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const [baseline, setBaseline] = useState<SiteFormState>(() => formFromSettings(settings));
  const [form, setForm] = useState<SiteFormState>(() => initialForm ?? formFromSettings(settings));
  const [enabled, setEnabled] = useState(settings.siteEnabled);
  const [version, setVersion] = useState(settings.updatedAt);
  const [error, setError] = useState<string | null>(initialErrors?.error ?? null);
  const [fieldErrors, setFieldErrors] = useState<SiteFieldErrors>(initialErrors?.fieldErrors ?? {});
  const [stale, setStale] = useState(initialStale);
  const [pending, setPending] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);
  // BR-P: la guardada (base) y la elegida. `undefined` = el server no la mandó (fixtures viejos): no se muestra ni viaja.
  const [basePalette, setBasePalette] = useState<AppPalette | undefined>(settings.palette);
  const [palette, setPalette] = useState<AppPalette | undefined>(settings.palette);
  const [paletteOptions, setPaletteOptions] = useState<AppPalette[]>(
    settings.paletteOptions ?? (settings.palette ? palettesForTenant(settings.palette) : [])
  );

  useEffect(() => setOrigin(window.location.origin), []);

  const dirty = siteFormDirty(form, baseline) || palette !== basePalette;
  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyRef.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const set = (k: SiteFieldKey, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (fieldErrors[k]) setFieldErrors((fe) => ({ ...fe, [k]: undefined }));
  };

  const applyFailure = (o: Extract<SiteSaveOutcome, { ok: false }>) => {
    setError(o.error);
    setFieldErrors(o.fieldErrors);
    setStale(o.stale);
  };

  const save = async () => {
    if (pending || !dirty) return;
    // CF3 ZF5: dejar la paleta de marca no tiene vuelta desde acá (ver la cabecera): se pregunta antes de mandar.
    if (!(await confirmBrandPaletteLeave(confirm, basePalette, palette))) return;
    setPending(true);
    setError(null);
    setFieldErrors({});
    setStale(false);
    const o = await saveSiteForm(form, enabled, version, update, palette);
    setPending(false);
    if (!o.ok) return applyFailure(o);
    setVersion(o.updatedAt);
    setBaseline(o.saved);
    setForm(o.saved);
    if (o.palette !== undefined) {
      setBasePalette(o.palette);
      // Dejar la de marca la saca de la lista (para volver la asigna Plataforma): mismo cálculo que el server.
      setPaletteOptions(palettesForTenant(o.palette));
    }
    toast.success(SITE_PANEL_COPY.saved);
  };

  const toggle = async () => {
    if (pending) return;
    const next = !enabled;
    if (!next) {
      const ok = await confirm({
        title: SITE_PANEL_COPY.turnOffTitle,
        message: SITE_PANEL_COPY.turnOffMessage,
        confirmLabel: "Dejar de publicar",
        cancelLabel: "Seguir publicado",
        tone: "danger",
      });
      if (!ok) return;
    }
    setPending(true);
    setError(null);
    setStale(false);
    // La BASE con el switch cambiado: lo que esté a medio escribir no viaja con el switch.
    const o = await saveSiteForm(baseline, next, version, update, basePalette);
    setPending(false);
    if (!o.ok) return applyFailure({ ...o, fieldErrors: {} });
    setEnabled(next);
    setVersion(o.updatedAt);
    toast.success(next ? SITE_PANEL_COPY.published : SITE_PANEL_COPY.unpublished);
  };

  const discard = async () => {
    const ok = await confirm({
      title: "¿Descartar los cambios?",
      message: "El sitio web vuelve a como estaba guardado.",
      confirmLabel: "Descartar",
      tone: "danger",
    });
    if (!ok) return;
    setForm(baseline);
    setPalette(basePalette);
    setError(null);
    setFieldErrors({});
  };

  const reload = async () => {
    if (dirty) {
      const ok = await confirm({
        title: "¿Traer lo último?",
        message: "Se pierde lo que cambiaste acá y ves lo que quedó guardado.",
        confirmLabel: "Traer lo último",
        tone: "danger",
      });
      if (!ok) return;
    }
    onDirtyRef.current?.(false);
    await onReload();
  };

  const url = origin ? `${origin}${settings.sitePath}` : settings.sitePath;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(SITE_PANEL_COPY.copied);
    } catch {
      toast.error(SITE_PANEL_COPY.copyFailed);
    }
  };

  const taglineLen = codePointLength(form.siteTagline);
  const descLen = codePointLength(form.publicDescription);
  const taglineOver = taglineLen > SITE_TAGLINE_MAX;
  const descOver = descLen > SITE_DESCRIPTION_MAX;

  return (
    <div className={styles.panel}>
      {settings.slugReserved && (
        <div role="alert" className={styles.note}>
          <IconAlert size={16} />
          <span>{SITE_PANEL_COPY.reserved}</span>
        </div>
      )}

      <Card className={styles.card}>
        <div>
          <EyebrowLabel>Sitio web</EyebrowLabel>
          <p className={styles.lead}>
            Una página del consultorio con el logo, la frase, la descripción, los profesionales, los horarios, las sedes,
            las obras sociales y el contacto, con el botón para sacar turno. Nunca muestra datos de pacientes, el WhatsApp
            de un profesional ni emails.
          </p>
        </div>

        <div className={styles.switchRow}>
          <Switch
            on={enabled}
            onChange={() => void toggle()}
            disabled={pending}
            aria-label={SITE_PANEL_COPY.switchLabel}
          />
          <span className={styles.switchLabel}>{SITE_PANEL_COPY.switchLabel}</span>
        </div>
        <div className={styles.state} aria-live="polite">
          {enabled ? SITE_PANEL_COPY.on : SITE_PANEL_COPY.off}
        </div>

        <div className={styles.urlRow}>
          <span className={styles.url} data-testid="site-url">
            {url}
          </span>
          <div className={styles.urlActions}>
            {enabled && !settings.slugReserved && (
              <a className={buttonClassName({ variant: "ghost" })} href={settings.sitePath} target="_blank" rel="noopener noreferrer">
                Ver mi sitio
              </a>
            )}
            <Button type="button" variant="ghost" onClick={() => void copy()}>
              Copiar
            </Button>
          </div>
        </div>

        {!settings.hasLogo && (
          <div role="note" className={styles.note}>
            <IconAlert size={16} />
            <span>
              {SITE_PANEL_COPY.noLogo} <a href="/configuracion?tab=general">{SITE_PANEL_COPY.noLogoLink}</a>.
            </span>
          </div>
        )}
      </Card>

      <Card className={styles.card}>
        <div className={styles.fields}>
          <FormField
            label="Frase"
            value={form.siteTagline}
            onChange={(v) => set("siteTagline", v.replace(/[\r\n]+/g, " "))}
            placeholder="Ej.: Kinesiología y osteopatía en Rosario"
            hint="Va arriba de todo, debajo del nombre. Una línea."
            error={fieldErrors.siteTagline}
            describedBy="site-tagline-count"
            disabled={pending}
          />
          {/* CF3 ZF3 (revisor de UI): sin `aria-live` (anunciaba el contador en cada tecla). El contador describe al
              campo con `describedBy` de FormField (se suma al `aria-describedby` del hint o del error). */}
          <div id="site-tagline-count" className={`${styles.counter} ${taglineOver ? styles.counterOver : ""}`}>
            {taglineLen} / {SITE_TAGLINE_MAX}
          </div>

          <FormField
            as="textarea"
            rows={5}
            label="Descripción"
            value={form.publicDescription}
            onChange={(v) => set("publicDescription", v)}
            placeholder="Contá en pocas líneas qué atienden y cómo trabajan."
            hint="Es la misma descripción que usa el directorio."
            error={fieldErrors.publicDescription}
            describedBy="site-description-count"
            disabled={pending}
          />
          <div id="site-description-count" className={`${styles.counter} ${descOver ? styles.counterOver : ""}`}>
            {descLen} / {SITE_DESCRIPTION_MAX}
          </div>

          <div className={styles.contact}>
            <FormField
              label="Teléfono"
              type="tel"
              value={form.phone}
              onChange={(v) => set("phone", v)}
              placeholder="0341 455-1234"
              error={fieldErrors.phone}
              disabled={pending}
              autoComplete="off"
            />
            <FormField
              label="WhatsApp"
              type="tel"
              value={form.whatsapp}
              onChange={(v) => set("whatsapp", v)}
              placeholder="341 555-1234"
              hint="Un celular. El sitio arma el botón de WhatsApp con él."
              error={fieldErrors.whatsapp}
              disabled={pending}
              autoComplete="off"
            />
            <FormField
              label="Email del consultorio"
              type="email"
              value={form.publicEmail}
              onChange={(v) => set("publicEmail", v)}
              hint={SITE_PANEL_COPY.emailNote}
              error={fieldErrors.publicEmail}
              disabled={pending}
              autoComplete="off"
            />
          </div>

          {palette !== undefined && paletteOptions.length > 0 && (
            <SitePaletteField
              value={palette}
              saved={basePalette}
              options={paletteOptions}
              error={fieldErrors.palette}
              disabled={pending}
              onChange={(p) => {
                setPalette(p);
                if (fieldErrors.palette) setFieldErrors((fe) => ({ ...fe, palette: undefined }));
              }}
            />
          )}
        </div>

        {error && (
          <div role="alert" className={styles.note} style={{ background: "var(--danger-bg)", borderColor: "var(--danger-border)", color: "var(--danger-fg)" }}>
            <IconAlert size={16} />
            <span style={{ display: "grid", gap: 8 }}>
              <span>{error}</span>
              {stale && (
                <span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => void reload()}>
                    {SITE_PANEL_COPY.reload}
                  </Button>
                </span>
              )}
            </span>
          </div>
        )}

        <div className={styles.footer}>
          <span role="status" className={dirty ? styles.dirty : styles.clean}>
            {dirty ? "Tenés cambios sin guardar" : "Sin cambios"}
          </span>
          <div className={styles.footerActions}>
            {dirty && (
              <Button type="button" variant="ghost" onClick={() => void discard()} disabled={pending}>
                Descartar
              </Button>
            )}
            <Button
              type="button"
              variant="primary"
              onClick={() => void save()}
              disabled={!dirty || pending || taglineOver || descOver}
            >
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * BR-P: «Colores del sitio y del turnero». Botones con `aria-pressed` (mismo patrón que la paleta de Apariencia), con el
 * nombre visible además del swatch: el color solo no alcanza para elegir (WCAG 1.4.1). Exportado para el test de render.
 */
export function SitePaletteField({
  value,
  saved,
  options,
  error,
  disabled,
  onChange,
}: {
  value: AppPalette;
  saved: AppPalette | undefined;
  options: AppPalette[];
  error?: string;
  disabled?: boolean;
  onChange: (p: AppPalette) => void;
}) {
  const savedBrand = saved ? brandPaletteFor(saved) : null;
  const leavingBrand = savedBrand !== null && value !== saved;
  return (
    <fieldset className={styles.paletteField} aria-describedby="site-palette-hint">
      <legend className={styles.paletteLegend}>{SITE_PANEL_COPY.paletteLegend}</legend>
      <div className={styles.paletteGrid}>
        {options.map((p) => {
          const o = sitePaletteOption(p);
          const on = p === value;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              data-palette-option={p}
              className={`${styles.paletteOption} ${on ? styles.paletteOptionOn : ""}`}
              onClick={() => onChange(p)}
              disabled={disabled}
            >
              <span className={styles.paletteSwatch} aria-hidden="true">
                {o.swatch.map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
      <div id="site-palette-hint" className={styles.state}>
        {SITE_PANEL_COPY.paletteHint}
      </div>
      {leavingBrand && (
        <div role="note" className={styles.note}>
          <IconAlert size={16} />
          <span>{SITE_PANEL_COPY.brandLeaving(savedBrand.label)}</span>
        </div>
      )}
      {error && (
        <div role="alert" className={styles.paletteError}>
          {error}
        </div>
      )}
    </fieldset>
  );
}
