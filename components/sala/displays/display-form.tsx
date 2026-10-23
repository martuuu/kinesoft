"use client";

/**
 * [TV-2w1] Formulario de alta / edición de una pantalla de la sala (§26.4 «Drawer Pantallas»).
 *
 * Controlado y presentacional: el estado y el dirty-guard viven en `DisplaysDrawer`. Las piezas puras (estado inicial,
 * lectura del link, dirty, armado del input) se exportan porque los render tests no corren efectos ni eventos.
 *
 * El link de YouTube: la base guarda solo `mediaKind` + `mediaRef` (nunca la URL que pegó la persona; ver cabecera de
 * `lib/youtube.ts`). Al editar se reconstruye un link canónico con `mediaUrlFor` para que el campo no aparezca vacío;
 * el server lo vuelve a parsear al guardar, así que da lo mismo que no sea el link original. La lectura en vivo usa el
 * MISMO `parseYouTubeUrl` que el server: lo que dice el chip es lo que se va a guardar.
 *
 * Vista previa: el iframe se arma con `youtubeEmbedUrl` (nocookie, `mute=1` siempre) y solo si devuelve algo: con un
 * origin todavía vacío (antes de hidratar) o una ref rara no se embebe nada. La CSP de la app ya permite
 * `frame-src https://www.youtube-nocookie.com` (lo usan los videos de ejercicios).
 */
import { useId, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DRAWER_FOOTER_ATTR } from "@/components/ui/drawer";
import type {
  DisplayListItem,
  DisplayMediaDuringCall,
  DisplayMediaKind,
  DisplayMediaLayout,
  DisplayNameMode,
  DisplaysPanel,
  DisplayTheme,
  DisplayUpsertInput,
} from "@/lib/reception-displays-types";
import { mediaKindLabel, parseYouTubeUrl, youtubeEmbedUrl, type YouTubeMedia } from "@/lib/youtube";

export const DISPLAY_FORM_COPY = {
  name: "Nombre",
  namePlaceholder: "TV de la recepción",
  nameRequired: "Poné un nombre para la pantalla.",
  location: "Sede",
  allLocations: "Todas las sedes",
  nameMode: "Cómo se llama al paciente",
  nameModes: { SHORT_NAME: "Nombre y apellido abreviado", TURN_TIME: "Hora del turno" } satisfies Record<DisplayNameMode, string>,
  nameModeHint: { SHORT_NAME: "Ej.: «María G.»", TURN_TIME: "Ej.: «Turno de las 10:30». No se ve ningún nombre." } satisfies Record<
    DisplayNameMode,
    string
  >,
  theme: "Tema",
  themes: { DARK: "Oscuro", LIGHT: "Claro" } satisfies Record<DisplayTheme, string>,
  media: "Link de YouTube",
  mediaHint: "Opcional. Un video, una lista, un vivo o el vivo de un canal.",
  mediaPlaceholder: "https://www.youtube.com/watch?v=…",
  preview: "Vista previa del video (sin sonido)",
  layout: "Disposición",
  layouts: { SIDE: "Video al costado", HERO_IDLE: "Video grande cuando no hay llamados" } satisfies Record<DisplayMediaLayout, string>,
  duringCall: "Durante el llamado",
  duringCalls: { DUCK: "bajar el volumen", HIDE: "ocultar el video", KEEP: "seguir igual" } satisfies Record<
    DisplayMediaDuringCall,
    string
  >,
  muted: "Arrancar sin sonido",
  mutedHint: "En la TV el sonido se activa con un toque en la pantalla.",
  rights: "Los derechos de exhibición del video son del consultorio (SADAIC / AADI-CAPIF si hay música).",
  cancel: "Cancelar",
  create: "Agregar y generar código",
  save: "Guardar cambios",
  saving: "Guardando…",
} as const;

export type DisplayFormState = {
  name: string;
  /** "" = todas las sedes (el select no maneja null). */
  locationId: string;
  nameMode: DisplayNameMode;
  theme: DisplayTheme;
  mediaUrl: string;
  mediaLayout: DisplayMediaLayout;
  mediaMuted: boolean;
  mediaDuringCall: DisplayMediaDuringCall;
};

/**
 * Link canónico para una ref guardada. Cada forma es una que `parseYouTubeUrl` lee de vuelta al mismo kind + ref
 * (test de round-trip en `tests/unit/render/displays-drawer.test.tsx`).
 */
export function mediaUrlFor(kind: DisplayMediaKind, ref: string | null): string {
  if (!ref) return "";
  switch (kind) {
    case "VIDEO":
      return `https://www.youtube.com/watch?v=${ref}`;
    case "LIVE":
      return `https://www.youtube.com/live/${ref}`;
    case "PLAYLIST":
      return `https://www.youtube.com/playlist?list=${ref}`;
    case "CHANNEL_LIVE":
      return `https://www.youtube.com/channel/${ref}/live`;
    default:
      return "";
  }
}

/** Defaults de alta (TV-D11: tema oscuro) o los valores de la pantalla que se edita. */
export function displayFormInitial(item: DisplayListItem | null): DisplayFormState {
  if (!item) {
    return {
      name: "",
      locationId: "",
      nameMode: "SHORT_NAME",
      theme: "DARK",
      mediaUrl: "",
      mediaLayout: "SIDE",
      mediaMuted: true,
      mediaDuringCall: "DUCK",
    };
  }
  return {
    name: item.name,
    locationId: item.locationId ?? "",
    nameMode: item.nameMode,
    theme: item.theme,
    mediaUrl: mediaUrlFor(item.mediaKind, item.mediaRef),
    mediaLayout: item.mediaLayout,
    mediaMuted: item.mediaMuted,
    mediaDuringCall: item.mediaDuringCall,
  };
}

export type MediaReading =
  | { state: "none" }
  | { state: "ok"; media: YouTubeMedia; label: string }
  | { state: "error"; message: string };

/** Lectura en vivo del campo. Vacío = sin video (el server hace lo mismo antes del parser: handoff TV-1a). */
export function readMediaLink(raw: string): MediaReading {
  if (raw.trim() === "") return { state: "none" };
  const r = parseYouTubeUrl(raw);
  return r.ok ? { state: "ok", media: r.media, label: mediaKindLabel(r.media.kind) } : { state: "error", message: r.error };
}

function normalized(s: DisplayFormState): DisplayFormState {
  return { ...s, name: s.name.trim(), mediaUrl: s.mediaUrl.trim() };
}

/** Espacios en los bordes no cuentan como cambio (el server los recorta igual). */
export function isDisplayFormDirty(base: DisplayFormState, cur: DisplayFormState): boolean {
  const a = normalized(base);
  const b = normalized(cur);
  return (Object.keys(a) as (keyof DisplayFormState)[]).some((k) => a[k] !== b[k]);
}

/**
 * Estado → input de la action. Valida en el cliente solo lo que el usuario puede corregir sin ir al server (nombre y
 * link); el resto lo valida `DisplayUpsertSchema` igual.
 */
export function buildDisplayInput(
  s: DisplayFormState,
): { ok: true; input: DisplayUpsertInput } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const name = s.name.trim();
  if (!name) fieldErrors.name = [DISPLAY_FORM_COPY.nameRequired];
  const media = readMediaLink(s.mediaUrl);
  if (media.state === "error") fieldErrors.mediaUrl = [media.message];
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };
  return {
    ok: true,
    input: {
      name,
      locationId: s.locationId === "" ? null : s.locationId,
      nameMode: s.nameMode,
      theme: s.theme,
      mediaUrl: media.state === "none" ? null : s.mediaUrl.trim(),
      mediaLayout: s.mediaLayout,
      mediaMuted: s.mediaMuted,
      mediaDuringCall: s.mediaDuringCall,
    },
  };
}

const noteStyle: CSSProperties = { margin: 0, fontSize: 13, color: "var(--navy-500)" };

const optionStyle = (on: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  minHeight: 44,
  padding: "10px 14px",
  borderRadius: 12,
  border: `1px solid ${on ? "var(--sky-700)" : "rgba(15, 30, 51, 0.14)"}`,
  background: on ? "var(--sky-50, rgba(31, 79, 190, 0.06))" : "var(--card-bg)",
  color: "var(--navy-900)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
});

const radioStyle: CSSProperties = { width: 18, height: 18, margin: "1px 0 0", accentColor: "var(--sky-700)", flexShrink: 0 };

function RadioGroup<V extends string>({
  name,
  legend,
  value,
  options,
  hints,
  onChange,
  disabled,
  columns = 1,
}: {
  name: string;
  legend: string;
  value: V;
  options: Record<V, string>;
  hints?: Partial<Record<V, string>>;
  onChange: (v: V) => void;
  disabled: boolean;
  columns?: 1 | 2;
}) {
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }} disabled={disabled}>
      <legend className="k-label" style={{ padding: 0, marginBottom: 8 }}>
        {legend}
      </legend>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: columns === 2 ? "repeat(auto-fit, minmax(150px, 1fr))" : "1fr" }}>
        {(Object.keys(options) as V[]).map((k) => (
          <label key={k} style={optionStyle(value === k)} data-option={k}>
            <input type="radio" name={name} value={k} checked={value === k} onChange={() => onChange(k)} style={radioStyle} />
            <span style={{ display: "grid", gap: 2 }}>
              <span>{options[k]}</span>
              {hints?.[k] && <span style={{ fontSize: 12, fontWeight: 400, color: "var(--navy-500)" }}>{hints[k]}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="k-field-error">
      {children}
    </span>
  );
}

export type DisplayFormProps = {
  mode: "create" | "edit";
  state: DisplayFormState;
  onChange: (patch: Partial<DisplayFormState>) => void;
  locations: DisplaysPanel["locations"];
  /** `window.location.origin` para el `origin=` del embed; vacío = sin vista previa. */
  origin: string;
  /** `fieldErrors` del server (o de `buildDisplayInput`), por nombre de campo del schema. */
  fieldErrors: Record<string, string[] | undefined>;
  /** Error general (copy del server). */
  error: string | null;
  pending: boolean;
  onSubmit: () => void;
  onCancel: () => void;
};

export function DisplayForm(p: DisplayFormProps) {
  const uid = useId();
  const C = DISPLAY_FORM_COPY;
  const { state, onChange } = p;
  const err = (k: string) => p.fieldErrors[k]?.[0];
  const media = readMediaLink(state.mediaUrl);
  // El error del parser se muestra en vivo; el del server (si lo hay) gana mientras no se toque el campo.
  const mediaError = err("mediaUrl") ?? (media.state === "error" ? media.message : undefined);
  const embed = media.state === "ok" && p.origin ? youtubeEmbedUrl(media.media, { origin: p.origin }) : null;
  const ids = {
    name: `${uid}-name`,
    nameErr: `${uid}-name-err`,
    loc: `${uid}-loc`,
    locErr: `${uid}-loc-err`,
    media: `${uid}-media`,
    mediaHint: `${uid}-media-hint`,
    mediaRead: `${uid}-media-read`,
    mediaErr: `${uid}-media-err`,
    muted: `${uid}-muted`,
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        p.onSubmit();
      }}
      style={{ display: "grid", gap: 18 }}
      data-testid="display-form"
    >
      <div className="k-field">
        <label className="k-label" htmlFor={ids.name}>
          {C.name}
        </label>
        <input
          id={ids.name}
          className="k-input"
          value={state.name}
          maxLength={60}
          placeholder={C.namePlaceholder}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-invalid={err("name") ? true : undefined}
          aria-describedby={err("name") ? ids.nameErr : undefined}
          disabled={p.pending}
          required
          autoComplete="off"
        />
        {err("name") && <FieldError id={ids.nameErr}>{err("name")}</FieldError>}
      </div>

      {p.locations.length > 0 && (
        <div className="k-field">
          <label className="k-label" htmlFor={ids.loc}>
            {C.location}
          </label>
          <select
            id={ids.loc}
            className="k-input"
            value={state.locationId}
            onChange={(e) => onChange({ locationId: e.target.value })}
            aria-invalid={err("locationId") ? true : undefined}
            aria-describedby={err("locationId") ? ids.locErr : undefined}
            disabled={p.pending}
          >
            <option value="">{C.allLocations}</option>
            {p.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {err("locationId") && <FieldError id={ids.locErr}>{err("locationId")}</FieldError>}
        </div>
      )}

      <RadioGroup
        name={`${uid}-nameMode`}
        legend={C.nameMode}
        value={state.nameMode}
        options={C.nameModes}
        hints={C.nameModeHint}
        onChange={(v) => onChange({ nameMode: v })}
        disabled={p.pending}
      />

      <RadioGroup
        name={`${uid}-theme`}
        legend={C.theme}
        value={state.theme}
        options={C.themes}
        onChange={(v) => onChange({ theme: v })}
        disabled={p.pending}
        columns={2}
      />

      <div className="k-field">
        <label className="k-label" htmlFor={ids.media}>
          {C.media}
        </label>
        <input
          id={ids.media}
          className="k-input"
          type="url"
          inputMode="url"
          value={state.mediaUrl}
          maxLength={2048}
          placeholder={C.mediaPlaceholder}
          onChange={(e) => onChange({ mediaUrl: e.target.value })}
          aria-invalid={mediaError ? true : undefined}
          aria-describedby={[ids.mediaHint, media.state === "ok" ? ids.mediaRead : null, mediaError ? ids.mediaErr : null]
            .filter(Boolean)
            .join(" ")}
          disabled={p.pending}
          autoComplete="off"
          spellCheck={false}
        />
        <p id={ids.mediaHint} style={noteStyle}>
          {C.mediaHint}
        </p>
        <div aria-live="polite">
          {mediaError ? (
            <FieldError id={ids.mediaErr}>{mediaError}</FieldError>
          ) : media.state === "ok" ? (
            <p id={ids.mediaRead} style={{ ...noteStyle, color: "var(--navy-700)", fontWeight: 600 }} data-testid="media-reading">
              {media.label}
            </p>
          ) : null}
        </div>
      </div>

      {media.state === "ok" && (
        <>
          {embed && (
            <div
              style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden", background: "#000" }}
            >
              <iframe
                src={embed}
                title={C.preview}
                // Sin `fullscreen`: es una vista previa. `autoplay` con `mute=1` (lo fuerza `youtubeEmbedUrl`).
                allow="autoplay; encrypted-media"
                loading="lazy"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              />
            </div>
          )}
          <RadioGroup
            name={`${uid}-layout`}
            legend={C.layout}
            value={state.mediaLayout}
            options={C.layouts}
            onChange={(v) => onChange({ mediaLayout: v })}
            disabled={p.pending}
          />
          <RadioGroup
            name={`${uid}-during`}
            legend={C.duringCall}
            value={state.mediaDuringCall}
            options={C.duringCalls}
            onChange={(v) => onChange({ mediaDuringCall: v })}
            disabled={p.pending}
            columns={2}
          />
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 14, color: "var(--navy-900)" }}>
            <input
              id={ids.muted}
              type="checkbox"
              checked={state.mediaMuted}
              onChange={(e) => onChange({ mediaMuted: e.target.checked })}
              disabled={p.pending}
              style={radioStyle}
            />
            <span style={{ display: "grid", gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{C.muted}</span>
              <span style={{ fontSize: 12, color: "var(--navy-500)" }}>{C.mutedHint}</span>
            </span>
          </label>
        </>
      )}

      {/* El aviso va siempre (no solo con video): es lo primero que hay que saber antes de pegar un link. */}
      <p style={{ ...noteStyle, color: "var(--navy-700)" }} data-testid="media-rights">
        {C.rights}
      </p>

      <div aria-live="polite">
        {p.error && (
          <p className="k-alert" role="alert" style={{ margin: 0 }}>
            {p.error}
          </p>
        )}
      </div>

      <div
        {...{ [DRAWER_FOOTER_ATTR]: "" }}
        style={{
          position: "sticky",
          bottom: 0,
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          paddingTop: 12,
          background: "var(--card-bg)",
        }}
      >
        <Button type="button" variant="ghost" onClick={p.onCancel} disabled={p.pending}>
          {C.cancel}
        </Button>
        <Button type="submit" disabled={p.pending} aria-busy={p.pending || undefined}>
          {p.pending ? C.saving : p.mode === "create" ? C.create : C.save}
        </Button>
      </div>
    </form>
  );
}
