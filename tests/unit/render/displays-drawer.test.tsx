/**
 * [TV-2w1] Drawer «Pantallas» de /sala (§26.4 «Drawer Pantallas»): chips de estado, dirty-guard, lectura en vivo del
 * link de YouTube con vista previa nocookie, desvincular por `useConfirm` y el código de vínculo visible UNA sola vez.
 *
 * Sin jsdom, como el resto de `tests/unit/render`: el render de servidor no corre efectos, así que la parte interactiva
 * se fija con las piezas puras que exportan los componentes (`readMediaLink`, `isDisplayFormDirty`, `revokeWithConfirm`,
 * `pairingAfterPanel`, `pairingCountdown`) y con los componentes presentacionales. Se mockean solo las server actions
 * (red/DB), el provider de `useConfirm` y el de toasts.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const actions = vi.hoisted(() => ({
  getDisplaysPanel: vi.fn(async () => ({ ok: true, data: { displays: [], locations: [], maxLive: 10 } })),
  createReceptionDisplay: vi.fn(async () => ({ ok: true, data: {} })),
  updateReceptionDisplay: vi.fn(async () => ({ ok: true, data: {} })),
  regenerateDisplayPairingCode: vi.fn(async () => ({ ok: true, data: {} })),
  revokeReceptionDisplay: vi.fn(async () => ({ ok: true, data: undefined })),
}));
vi.mock("@/lib/reception-displays", () => actions);
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() }),
}));

import {
  DisplaysDrawer,
  DisplaysPanelView,
  DISPLAY_STATUS_LABEL,
  REVOKE_CONFIRM_MESSAGE,
  drawerDirty,
  pairingAfterPanel,
  revokeWithConfirm,
} from "@/components/sala/displays/displays-drawer";
import {
  DisplayForm,
  buildDisplayInput,
  displayFormInitial,
  isDisplayFormDirty,
  mediaUrlFor,
  readMediaLink,
  type DisplayFormState,
} from "@/components/sala/displays/display-form";
import { PairingCodeCard, pairingCountdown } from "@/components/sala/displays/pairing-code-card";
import type { DisplayListItem, DisplaysPanel } from "@/lib/reception-displays-types";
import { parseYouTubeUrl } from "@/lib/youtube";

const noop = () => {};
const NOW = new Date("2026-10-22T13:00:00.000Z");
const ORIGIN = "https://app.kinesoft.test";

function item(o: Partial<DisplayListItem> = {}): DisplayListItem {
  return {
    id: "d1",
    name: "TV recepción",
    locationId: null,
    locationName: null,
    nameMode: "SHORT_NAME",
    theme: "DARK",
    mediaKind: "NONE",
    mediaRef: null,
    mediaLayout: "SIDE",
    mediaMuted: true,
    mediaDuringCall: "DUCK",
    pairedAt: null,
    lastSeenAt: null,
    pairingExpiresAt: null,
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-21T12:00:00.000Z",
    ...o,
  };
}

const LOCATIONS = [
  { id: "l1", name: "Centro", isPrimary: true },
  { id: "l2", name: "Palermo", isPrimary: false },
];

function panel(displays: DisplayListItem[]): DisplaysPanel {
  return { displays, locations: LOCATIONS, maxLive: 10 };
}

function viewHtml(p: DisplaysPanel, pairing: Parameters<typeof DisplaysPanelView>[0]["pairing"] = null) {
  return renderToStaticMarkup(
    <DisplaysPanelView
      panel={p}
      now={NOW}
      pairing={pairing}
      origin={ORIGIN}
      busyId={null}
      onAdd={noop}
      onEdit={noop}
      onRegenerate={noop}
      onRevoke={noop}
      onDismissPairing={noop}
    />,
  );
}

function formHtml(state: DisplayFormState, errors: Record<string, string[]> = {}) {
  return renderToStaticMarkup(
    <DisplayForm
      mode="create"
      state={state}
      onChange={noop}
      locations={LOCATIONS}
      origin={ORIGIN}
      fieldErrors={errors}
      error={null}
      pending={false}
      onSubmit={noop}
      onCancel={noop}
    />,
  );
}

describe("[TV-2w1] lista de pantallas", () => {
  it("[TV-2w1] chips «En línea», «Sin conexión», «Esperando el código», «Sin vincular», con sede y tope visible", () => {
    const html = viewHtml(
      panel([
        item({ id: "a", name: "Online", pairedAt: "2026-10-20T12:00:00.000Z", lastSeenAt: "2026-10-22T12:59:00.000Z", locationId: "l1", locationName: "Centro" }),
        item({ id: "b", name: "Offline", pairedAt: "2026-10-20T12:00:00.000Z", lastSeenAt: "2026-10-22T12:00:00.000Z" }),
        item({ id: "c", name: "Vinculando", pairingExpiresAt: "2026-10-22T13:05:00.000Z" }),
        item({ id: "d", name: "Suelta" }),
      ]),
    );
    expect(DISPLAY_STATUS_LABEL).toEqual({
      online: "En línea",
      offline: "Sin conexión",
      pairing: "Esperando el código",
      unpaired: "Sin vincular",
    });
    expect(html).toMatch(/data-display="a"[\s\S]*data-status="online"[\s\S]{0,120}?>En línea</);
    expect(html).toMatch(/data-display="b"[\s\S]*data-status="offline"[\s\S]{0,120}?>Sin conexión</);
    expect(html).toMatch(/data-display="c"[\s\S]*data-status="pairing"[\s\S]{0,120}?>Esperando el código</);
    expect(html).toMatch(/data-display="d"[\s\S]*data-status="unpaired"[\s\S]{0,120}?>Sin vincular</);
    expect(html).toContain("Centro");
    expect(html).toContain("Todas las sedes");
    expect(html).toContain("4 de 10 pantallas");
    for (const label of ["Editar", "Nuevo código", "Desvincular", "Agregar pantalla"]) expect(html).toContain(label);
    // La última conexión de una pantalla caída, en hora AR (12:00 UTC = 09:00 AR) aunque el host esté en UTC.
    expect(html).toContain("09:00");
  });

  it("[TV-2w1] estado vacío con el copy de §26.4", () => {
    const html = viewHtml(panel([]));
    expect(html).toContain(
      "Todavía no vinculaste ninguna pantalla. Abrí /tv en el navegador de la TV y cargá el código que te damos acá.",
    );
    expect(html).toContain("Agregar pantalla");
  });

  it("[TV-2w1] en el tope de 10, «Agregar pantalla» queda deshabilitado con el copy del server", () => {
    const ten = Array.from({ length: 10 }, (_, i) => item({ id: `d${i}`, name: `TV ${i}` }));
    const html = viewHtml(panel(ten));
    expect(html).toContain("10 de 10 pantallas");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Agregar pantalla/);
    expect(html).toContain("Llegaste al tope de 10 pantallas. Desvinculá una para sumar otra.");
  });

  it("[TV-2w1] el drawer abierto arranca cargando y no llama a nada al montar", () => {
    const html = renderToStaticMarkup(<DisplaysDrawer open onClose={noop} />);
    expect(html).toContain("Pantallas");
    expect(html).toContain("Cargando");
    expect(actions.getDisplaysPanel).not.toHaveBeenCalled();
  });
});

describe("[TV-2w1] código de vínculo: una sola vez", () => {
  it("[TV-2w1] la lista nunca muestra un código: solo el estado, aunque haya uno vivo", () => {
    const html = viewHtml(panel([item({ pairingExpiresAt: "2026-10-22T13:05:00.000Z" })]));
    expect(html).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect(html).not.toContain("data-testid=\"pairing-code\"");
  });

  it("[TV-2w1] recién generado: código grande, cuenta regresiva y la URL /tv con origin", () => {
    const html = viewHtml(panel([item({ pairingExpiresAt: "2026-10-22T13:10:00.000Z" })]), {
      displayId: "d1",
      displayName: "TV recepción",
      code: "ABCD-EFGH",
      expiresAt: "2026-10-22T13:10:00.000Z",
    });
    expect(html).toMatch(/data-testid="pairing-code"[^>]*>ABCD-EFGH</);
    expect(html).toContain(`${ORIGIN}/tv`);
    expect(html).toContain("Vence en 10:00");
    expect(html).toContain("Copiar");
  });

  it("[TV-2w1] vencido: «El código venció. Generá uno nuevo.» y no se muestra más el código", () => {
    const html = renderToStaticMarkup(
      <PairingCodeCard
        code="ABCD-EFGH"
        expiresAt="2026-10-22T12:59:00.000Z"
        displayName="TV recepción"
        origin={ORIGIN}
        now={NOW.getTime()}
        onRegenerate={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain("El código venció. Generá uno nuevo.");
    expect(html).not.toContain("ABCD-EFGH");
  });

  it("[TV-2w1] pairingCountdown: mm:ss hasta expiresAt; 0 → vencido", () => {
    const exp = "2026-10-22T13:09:42.000Z";
    expect(pairingCountdown(exp, NOW.getTime())).toEqual({ expired: false, label: "9:42" });
    expect(pairingCountdown(exp, new Date(exp).getTime())).toEqual({ expired: true, label: "0:00" });
    expect(pairingCountdown("basura", NOW.getTime()).expired).toBe(true);
  });

  it("[TV-2w1] pairingAfterPanel: el código se descarta cuando la pantalla vincula, se desvincula o el código se reemplaza", () => {
    const shown = { displayId: "d1", displayName: "TV", code: "ABCD-EFGH", expiresAt: "2026-10-22T13:10:00.000Z" };
    // Sigue esperando: se conserva.
    expect(pairingAfterPanel(shown, panel([item({ pairingExpiresAt: shown.expiresAt })]))).toBe(shown);
    // Vinculó (el server limpia el código): se va.
    expect(pairingAfterPanel(shown, panel([item({ pairedAt: "2026-10-22T13:01:00.000Z" })]))).toBeNull();
    // Desvinculada (ya no está en la lista viva): se va.
    expect(pairingAfterPanel(shown, panel([]))).toBeNull();
    // Otro código en el medio (otra pestaña): el que se ve ya no sirve.
    expect(pairingAfterPanel(shown, panel([item({ pairingExpiresAt: "2026-10-22T13:12:00.000Z" })]))).toBeNull();
    expect(pairingAfterPanel(null, panel([item()]))).toBeNull();
  });

  it("[TV-2w1] cerrar el drawer con el código a la vista pide confirmación (no se vuelve a mostrar)", () => {
    const shown = { displayId: "d1", displayName: "TV", code: "ABCD-EFGH", expiresAt: "2026-10-22T13:10:00.000Z" };
    expect(drawerDirty({ formDirty: false, pairing: shown, now: NOW.getTime() })).toBe(true);
    expect(drawerDirty({ formDirty: false, pairing: { ...shown, expiresAt: "2026-10-22T12:00:00.000Z" }, now: NOW.getTime() })).toBe(false);
    expect(drawerDirty({ formDirty: false, pairing: null, now: NOW.getTime() })).toBe(false);
    expect(drawerDirty({ formDirty: true, pairing: null, now: NOW.getTime() })).toBe(true);
  });
});

describe("[TV-2w1] desvincular por useConfirm", () => {
  it("[TV-2w1] pide confirmación con el copy y solo desvincula si acepta", async () => {
    expect(REVOKE_CONFIRM_MESSAGE).toBe("La pantalla deja de mostrar la sala. Para volver a usarla hay que vincularla de nuevo.");
    const revoke = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const no = vi.fn(async () => false);
    expect(await revokeWithConfirm(no, revoke, item())).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    expect(no).toHaveBeenCalledWith(
      expect.objectContaining({ message: REVOKE_CONFIRM_MESSAGE, confirmLabel: "Desvincular", tone: "danger" }),
    );
    const yes = vi.fn(async () => true);
    expect(await revokeWithConfirm(yes, revoke, item())).toEqual({ ok: true, data: undefined });
    expect(revoke).toHaveBeenCalledWith({ id: "d1" });
  });
});

describe("[TV-2w1] formulario", () => {
  it("[TV-2w1] campos y copy: sede «Todas las sedes», modos de nombre, tema, disposición, durante el llamado, sin sonido y aviso SADAIC", () => {
    const html = formHtml(displayFormInitial(null));
    for (const s of [
      "Nombre",
      "Todas las sedes",
      "Centro",
      "Palermo",
      "Nombre y apellido abreviado",
      "Hora del turno",
      "Oscuro",
      "Claro",
      "Link de YouTube",
      "Los derechos de exhibición del video son del consultorio (SADAIC / AADI-CAPIF si hay música).",
    ])
      expect(html).toContain(s);
    // Sin video no hay opciones de video ni vista previa.
    expect(html).not.toContain("Video al costado");
    expect(html).not.toContain("<iframe");
  });

  it("[TV-2w1] lectura en vivo del link: tipo + vista previa silenciada nocookie; error del parser sin iframe", () => {
    const ok = formHtml({ ...displayFormInitial(null), mediaUrl: "https://youtu.be/dQw4w9WgXcQ" });
    expect(ok).toContain("Video · se repite");
    expect(ok).toMatch(/<iframe[^>]*src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?[^"]*mute=1/);
    for (const s of ["Video al costado", "Video grande cuando no hay llamados", "bajar el volumen", "ocultar el video", "seguir igual", "Arrancar sin sonido"])
      expect(ok).toContain(s);

    const bad = formHtml({ ...displayFormInitial(null), mediaUrl: "https://vimeo.com/123" });
    expect(bad).toContain("Ese link no es de YouTube. Pegá un link de youtube.com o youtu.be.");
    expect(bad).not.toContain("<iframe");

    expect(readMediaLink("")).toEqual({ state: "none" });
    expect(readMediaLink("   ")).toEqual({ state: "none" });
    expect(readMediaLink("https://www.youtube.com/@canal/live")).toMatchObject({ state: "error" });
    expect(readMediaLink("https://www.youtube.com/playlist?list=PL0123456789ab")).toMatchObject({ state: "ok", label: "Lista" });
  });

  it("[TV-2w1] errores de fieldErrors del server bajo su campo", () => {
    const html = formHtml(displayFormInitial(null), { name: ["Ya hay una pantalla con ese nombre. Elegí otro."] });
    expect(html).toContain("Ya hay una pantalla con ese nombre. Elegí otro.");
    expect(html).toMatch(/aria-invalid="true"/);
  });

  it("[TV-2w1] editar reconstruye un link canónico que el parser lee igual (round-trip por tipo)", () => {
    const refs = {
      VIDEO: "dQw4w9WgXcQ",
      LIVE: "dQw4w9WgXcQ",
      PLAYLIST: "PL0123456789abcdef",
      CHANNEL_LIVE: "UC0123456789abcdefghijkl",
    } as const;
    for (const [kind, ref] of Object.entries(refs) as [keyof typeof refs, string][]) {
      const url = mediaUrlFor(kind, ref);
      expect(parseYouTubeUrl(url)).toEqual({ ok: true, media: { kind, ref } });
    }
    expect(mediaUrlFor("NONE", null)).toBe("");
    const s = displayFormInitial(item({ mediaKind: "VIDEO", mediaRef: "dQw4w9WgXcQ", locationId: "l2", theme: "LIGHT" }));
    expect(s).toMatchObject({ locationId: "l2", theme: "LIGHT", mediaUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("[TV-2w1] dirty-guard: igual a la base = limpio; cualquier cambio = sucio (espacios del link no cuentan)", () => {
    const base = displayFormInitial(item());
    expect(isDisplayFormDirty(base, { ...base })).toBe(false);
    expect(isDisplayFormDirty(base, { ...base, name: "Otra" })).toBe(true);
    expect(isDisplayFormDirty(base, { ...base, mediaMuted: !base.mediaMuted })).toBe(true);
    expect(isDisplayFormDirty(base, { ...base, mediaUrl: "  " })).toBe(false);
  });

  it("[TV-2w1] buildDisplayInput: nombre obligatorio, link inválido frena, vacío = sin video, sede vacía = todas", () => {
    expect(buildDisplayInput({ ...displayFormInitial(null), name: "  " })).toEqual({
      ok: false,
      fieldErrors: { name: ["Poné un nombre para la pantalla."] },
    });
    expect(buildDisplayInput({ ...displayFormInitial(null), name: "TV", mediaUrl: "https://vimeo.com/1" })).toMatchObject({
      ok: false,
      fieldErrors: { mediaUrl: [expect.stringContaining("no es de YouTube")] },
    });
    expect(buildDisplayInput({ ...displayFormInitial(null), name: " TV ", locationId: "" })).toEqual({
      ok: true,
      input: {
        name: "TV",
        locationId: null,
        nameMode: "SHORT_NAME",
        theme: "DARK",
        mediaUrl: null,
        mediaLayout: "SIDE",
        mediaMuted: true,
        mediaDuringCall: "DUCK",
      },
    });
  });
});
