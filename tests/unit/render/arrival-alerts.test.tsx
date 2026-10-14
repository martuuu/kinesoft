/**
 * [SV11b] Provider de avisos de la sala de espera (§18.8 fila SV11b).
 *
 * Sin jsdom no corren effects: el motor (`createArrivalAlertsEngine`) es el MISMO
 * objeto que el provider crea en su effect, y se testea directo con fakes de
 * registro a mano (fetch, toast, chime, título). El render cubre el primer paint:
 * hijos, controles de preferencias y qué filas aparecen según el viewer.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Server actions ("use server", Prisma/sesión) fuera del test: el motor recibe
// sus fetchers por deps; el provider solo los cablea.
vi.mock("@/lib/bookings", () => ({ listAgendaBookings: async () => [], listPractitioners: async () => [] }));
vi.mock("@/lib/rooms", () => ({ listRoomOptions: async () => [] }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: async () => ({ ok: true, data: {} }) }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
  usePathname: () => "/agenda",
}));
// general-panel importa las actions de Configuración ("use server"): fuera.
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true }),
  updateTenantBasics: async () => ({ ok: true }),
  setBusinessHours: async () => ({ ok: true }),
  setPublicBookingEnabled: async () => ({ ok: true }),
}));

import { ArrivalAlerts, alertsShouldRun, isSalaPath } from "@/components/providers/arrival-alerts";
import {
  createArrivalAlertsEngine,
  type AlertNames,
  type ArrivalAlertsEngineDeps,
} from "@/components/providers/arrival-alerts-engine";
import {
  AlertModeControl,
  SOUND_BLOCKED_NOTE,
  alertRadioKeyTarget,
} from "@/components/realtime/alert-prefs-controls";
import { AvisosMenuSection } from "@/components/agenda/view-options-menu";
import { AlertPrefsCard } from "@/components/configuracion/panels/general-panel";
import { ToastProvider, type ToastOptions } from "@/components/ui/toast";
import { effectivePrefs, type AlertPrefs, type AlertRow, type AlertViewer } from "@/lib/arrival-alert-state";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

const NOW = new Date("2026-10-14T13:40:00.000Z"); // 10:40 AR
const DAY = "2026-10-14";
const AT_1030 = "2026-10-14T13:30:00.000Z";
const ARRIVED = "2026-10-14T13:35:00.000Z";
const CALLED = "2026-10-14T13:38:00.000Z";

const AP: AlertViewer = { practitionerId: "pA", canOperateAll: false };
const SECRE: AlertViewer = { practitionerId: null, canOperateAll: true };

function row(over: Partial<AlertRow> & { id: string }): AlertRow {
  return {
    practitionerId: "pA",
    patientName: "María González",
    scheduledFor: AT_1030,
    status: "CONFIRMED",
    roomId: null,
    arrivedAt: null,
    calledAt: null,
    attendingAt: null,
    ...over,
  };
}

const reception = (over: Partial<RealtimeAgendaMessage> = {}): RealtimeAgendaMessage => ({
  v: 1,
  kind: "reception",
  bookingId: "b1",
  practitionerId: "pA",
  day: DAY,
  at: NOW.toISOString(),
  ...over,
});

/** Motor con fakes a mano. `pages` = lo que devuelve cada fetch, en orden (el último se repite). */
function harness(opts: {
  viewer: AlertViewer;
  prefs: AlertPrefs;
  pages: AlertRow[][];
  chimeOk?: boolean;
  names?: AlertNames;
  onSala?: boolean;
}) {
  const rec = {
    fetches: 0,
    nameFetches: 0,
    toasts: [] as Array<{ title: string; opts: ToastOptions }>,
    chimes: 0,
    titles: [] as string[],
    salaOpens: 0,
  };
  let prefs = opts.prefs;
  const deps: ArrivalAlertsEngineDeps = {
    viewer: opts.viewer,
    getPrefs: () => prefs,
    fetchToday: async (range) => {
      expect(range.day).toBe(DAY);
      const page = opts.pages[Math.min(rec.fetches, opts.pages.length - 1)];
      rec.fetches++;
      return page;
    },
    fetchNames: async () => {
      rec.nameFetches++;
      return opts.names ?? { rooms: new Map(), practitioners: new Map() };
    },
    show: (title, o) => rec.toasts.push({ title, opts: o }),
    chime: () => {
      rec.chimes++;
      return opts.chimeOk ?? true;
    },
    announceTitle: (t) => rec.titles.push(t),
    openSala: () => rec.salaOpens++,
    leading: (text) => text,
    now: () => NOW,
    suppressCallToast: () => opts.onSala ?? false,
  };
  const engine = createArrivalAlertsEngine(deps);
  return { engine, rec, setPrefs: (p: AlertPrefs) => (prefs = p) };
}

describe("[SV11b] motor de avisos", () => {
  it("pref off → no se crea el motor, y aunque exista no pide nada", async () => {
    const off: AlertPrefs = { arrivalAlert: "off", callAlert: "off" };
    expect(alertsShouldRun(AP, off, true)).toBe(false);
    expect(alertsShouldRun(AP, { arrivalAlert: "visual", callAlert: "off" }, false)).toBe(false);
    // La pref de llamado no aplica al profesional: queda off aunque diga sound.
    expect(alertsShouldRun(AP, { arrivalAlert: "off", callAlert: "sound" }, true)).toBe(false);
    expect(alertsShouldRun(SECRE, { arrivalAlert: "off", callAlert: "visual" }, true)).toBe(true);

    const { engine, rec } = harness({ viewer: AP, prefs: off, pages: [[row({ id: "b1" })]] });
    await engine.seed();
    engine.onBatch([reception()]);
    engine.onResync();
    await engine.idle();
    expect(rec.fetches).toBe(0);
    expect(rec.toasts).toEqual([]);
  });

  it("visual → toast «Llegó María G. · 10:30» con id, iniciales y «Ver sala», sin chime", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "visual" },
      pages: [[row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED })]],
    });
    await engine.seed();
    expect(rec.toasts).toEqual([]); // la semilla no avisa
    engine.onBatch([reception()]);
    await engine.idle();
    expect(rec.fetches).toBe(2);
    expect(rec.chimes).toBe(0);
    expect(rec.toasts).toHaveLength(1);
    const t = rec.toasts[0];
    expect(t.title).toBe("Llegó María G. · 10:30");
    expect(t.opts.id).toBe(`arr:b1:${ARRIVED}`);
    expect(t.opts.leading).toBe("MG");
    expect(t.opts.description).toBeUndefined();
    expect(t.opts.action?.label).toBe("Ver sala");
    t.opts.action?.onClick();
    expect(rec.salaOpens).toBe(1);
    expect(rec.titles).toEqual(["Llegó María G. · 10:30"]);
  });

  it("el mismo evento por lote y por resync no avisa dos veces", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [[row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED })]],
    });
    await engine.seed();
    engine.onBatch([reception()]);
    await engine.idle();
    engine.onResync();
    await engine.idle();
    expect(rec.toasts).toHaveLength(1);
  });

  it("sound → un chime por lote; si el navegador lo bloquea, el toast suma la nota", async () => {
    const pages = [
      [row({ id: "b1" }), row({ id: "b2", patientName: "Juan Pérez" })],
      [row({ id: "b1", arrivedAt: ARRIVED }), row({ id: "b2", patientName: "Juan Pérez", arrivedAt: ARRIVED })],
    ];
    const ok = harness({ viewer: AP, prefs: { arrivalAlert: "sound", callAlert: "off" }, pages });
    await ok.engine.seed();
    ok.engine.onBatch([reception()]);
    await ok.engine.idle();
    expect(ok.rec.toasts).toHaveLength(2);
    expect(ok.rec.chimes).toBe(1);
    expect(ok.rec.toasts.every((t) => t.opts.description === undefined)).toBe(true);

    const blocked = harness({ viewer: AP, prefs: { arrivalAlert: "sound", callAlert: "off" }, pages, chimeOk: false });
    await blocked.engine.seed();
    blocked.engine.onBatch([reception()]);
    await blocked.engine.idle();
    expect(blocked.rec.toasts.map((t) => t.opts.description)).toEqual([SOUND_BLOCKED_NOTE, SOUND_BLOCKED_NOTE]);
  });

  it("tras un resync los avisos salen sin sonido (SV-D16)", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "sound", callAlert: "off" },
      pages: [[row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED })]],
    });
    await engine.seed();
    engine.onResync();
    await engine.idle();
    expect(rec.toasts).toHaveLength(1);
    expect(rec.chimes).toBe(0);
  });

  it("3 o más en un lote → un solo toast «Llegaron 3 pacientes»", async () => {
    const ids = ["b1", "b2", "b3"];
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [ids.map((id) => row({ id })), ids.map((id) => row({ id, arrivedAt: ARRIVED }))],
    });
    await engine.seed();
    engine.onBatch([reception({ bookingId: undefined, practitionerId: "pA" })]);
    await engine.idle();
    expect(rec.toasts).toHaveLength(1);
    expect(rec.toasts[0].title).toBe("Llegaron 3 pacientes");
    expect(rec.toasts[0].opts.description).toBe("María G., María G. y María G.");
  });

  it("la pestaña que marcó «Llegó» no se auto-avisa (noteLocal con el resultado de la action)", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [[row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED })]],
    });
    await engine.seed();
    engine.noteLocal("b1", { arrivedAt: ARRIVED, calledAt: null });
    engine.onBatch([reception()]);
    await engine.idle();
    expect(rec.fetches).toBe(2);
    expect(rec.toasts).toEqual([]);
  });

  it("lotes durante un refetch en vuelo se coalescen en UN refetch más", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [[row({ id: "b1" })]],
    });
    await engine.seed();
    engine.onBatch([reception()]);
    engine.onBatch([reception()]);
    engine.onBatch([reception()]);
    await engine.idle();
    expect(rec.fetches).toBe(3); // semilla + el que arrancó + uno coalescido
  });

  it("un lote que no es de recepción ni de hoy no re-pide", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [[row({ id: "b1" })]],
    });
    await engine.seed();
    engine.onBatch([reception({ kind: "booking" }), reception({ day: "2026-10-20" })]);
    await engine.idle();
    expect(rec.fetches).toBe(1);
  });

  it("llamado a la Secretaria: «Pase María G. · Consultorio 2 · Dra. Pérez»", async () => {
    const { engine, rec } = harness({
      viewer: SECRE,
      prefs: { arrivalAlert: "sound", callAlert: "visual" },
      pages: [
        [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED, roomId: "r2" })],
        [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED, roomId: "r2", calledAt: CALLED })],
      ],
      names: { rooms: new Map([["r2", "Consultorio 2"]]), practitioners: new Map([["pB", "Dra. Pérez"]]) },
    });
    await engine.seed();
    engine.onBatch([reception({ kind: "called", practitionerId: "pB" })]);
    await engine.idle();
    expect(rec.toasts.map((t) => [t.title, t.opts.id])).toEqual([
      ["Pase María G. · Consultorio 2 · Dra. Pérez", `call:b1:${CALLED}`],
    ]);
    // La llegada no aplica a la Secretaria aunque su fila diga sound: sin chime.
    expect(rec.chimes).toBe(0);
    expect(rec.nameFetches).toBe(1);
  });

  it("[FX2b M2] en /sala el llamado NO saca toast (lo anuncia la banda); título y sonido siguen", async () => {
    const { engine, rec } = harness({
      viewer: SECRE,
      prefs: { arrivalAlert: "off", callAlert: "sound" },
      pages: [
        [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED })],
        [row({ id: "b1", practitionerId: "pB", arrivedAt: ARRIVED, calledAt: CALLED })],
      ],
      onSala: true,
    });
    await engine.seed();
    engine.onBatch([reception({ kind: "called", practitionerId: "pB" })]);
    await engine.idle();
    expect(rec.toasts).toEqual([]);
    expect(rec.titles).toEqual(["Pase María G."]);
    expect(rec.chimes).toBe(1);
  });

  it("[FX2b M2] en /sala la llegada SÍ saca toast", async () => {
    const { engine, rec } = harness({
      viewer: AP,
      prefs: { arrivalAlert: "visual", callAlert: "off" },
      pages: [[row({ id: "b1" })], [row({ id: "b1", arrivedAt: ARRIVED })]],
      onSala: true,
    });
    await engine.seed();
    engine.onBatch([reception()]);
    await engine.idle();
    expect(rec.toasts.map((t) => t.title)).toEqual(["Llegó María G. · 10:30"]);
  });

  it("[FX2b M2] isSalaPath", () => {
    expect(isSalaPath("/sala")).toBe(true);
    expect(isSalaPath("/sala/x")).toBe(true);
    expect(isSalaPath("/salas")).toBe(false);
    expect(isSalaPath("/agenda")).toBe(false);
    expect(isSalaPath(null)).toBe(false);
  });

  it("cambio de día AR: el primer fetch del día nuevo es semilla", async () => {
    let now = new Date("2026-10-14T13:40:00.000Z");
    const rec = { toasts: 0 };
    const engine = createArrivalAlertsEngine({
      viewer: AP,
      getPrefs: () => ({ arrivalAlert: "visual", callAlert: "off" }),
      fetchToday: async (r) => (r.day === DAY ? [row({ id: "b1" })] : [row({ id: "b9", arrivedAt: "2026-10-15T11:00:00.000Z" })]),
      fetchNames: async () => null,
      show: () => rec.toasts++,
      chime: () => true,
      announceTitle: () => {},
      openSala: () => {},
      leading: () => null,
      now: () => now,
    });
    await engine.seed();
    now = new Date("2026-10-15T11:05:00.000Z");
    engine.onResync();
    await engine.idle();
    expect(rec.toasts).toBe(0);
  });
});

describe("[SV11b] render", () => {
  const wrap = (viewer: AlertViewer, prefs: AlertPrefs, live = true) =>
    renderToStaticMarkup(
      <ToastProvider>
        <ArrivalAlerts viewer={viewer} initialPrefs={prefs} live={live}>
          <p>hijo</p>
          <AvisosMenuSection />
        </ArrivalAlerts>
      </ToastProvider>,
    );

  it("renderiza los hijos; pref off no agrega nada al markup", () => {
    const html = wrap(AP, { arrivalAlert: "off", callAlert: "off" });
    expect(html).toContain("<p>hijo</p>");
    expect(html).not.toContain("role=\"status\"");
  });

  it("menú «Avisos»: el profesional ve solo la llegada, la Secretaria solo el llamado", () => {
    const ap = wrap(AP, { arrivalAlert: "visual", callAlert: "visual" });
    expect(ap).toContain("Cuando llega un paciente mío");
    expect(ap).not.toContain("Cuando un profesional llama a un paciente");
    const secre = wrap(SECRE, { arrivalAlert: "visual", callAlert: "sound" });
    expect(secre).not.toContain("Cuando llega un paciente mío");
    expect(secre).toContain("Cuando un profesional llama a un paciente");
    expect(secre).toMatch(/aria-checked="true"[^>]*>Visual y sonido</);
  });

  it("sin canal realtime (driver off) el menú «Vista» no muestra Avisos; fuera del provider tampoco", () => {
    expect(wrap(AP, { arrivalAlert: "visual", callAlert: "visual" }, false)).not.toContain("Avisos");
    expect(renderToStaticMarkup(<AvisosMenuSection />)).toBe("");
  });

  describe("[FX2b M4] Card de Configuración → General por rol, con y sin canal", () => {
    const OWNER_ATIENDE: AlertViewer = { practitionerId: "pO", canOperateAll: true };
    const BILLING: AlertViewer = { practitionerId: null, canOperateAll: false };
    const NOTE = "Los avisos se activan cuando la sala en vivo esté encendida en el consultorio.";
    const card = (viewer: AlertViewer, live: boolean) =>
      renderToStaticMarkup(
        <ToastProvider>
          <ArrivalAlerts viewer={viewer} initialPrefs={{ arrivalAlert: "visual", callAlert: "sound" }} live={live}>
            <AlertPrefsCard />
          </ArrivalAlerts>
        </ToastProvider>,
      );

    for (const live of [true, false]) {
      it(`${live ? "con" : "sin"} canal: profesional → llegada; Secretaria → llamado; OWNER que atiende → las dos; BILLING → nada`, () => {
        const ap = card(AP, live);
        expect(ap).toContain("Avisos de la sala de espera");
        expect(ap).toContain("Cuando llega un paciente mío");
        expect(ap).not.toContain("Cuando un profesional llama a un paciente");

        const secre = card(SECRE, live);
        expect(secre).toContain("Avisos de la sala de espera");
        expect(secre).not.toContain("Cuando llega un paciente mío");
        expect(secre).toContain("Cuando un profesional llama a un paciente");
        expect(secre).toMatch(/aria-checked="true"[^>]*>Visual y sonido</);

        const owner = card(OWNER_ATIENDE, live);
        expect(owner).toContain("Cuando llega un paciente mío");
        expect(owner).toContain("Cuando un profesional llama a un paciente");

        expect(card(BILLING, live)).toBe("");

        // La nota aparece solo sin canal.
        for (const html of [ap, secre, owner]) {
          if (live) expect(html).not.toContain(NOTE);
          else expect(html).toContain(NOTE);
        }
      });
    }
  });

  it("control: tres opciones con el valor marcado, «Probar sonido» y la ayuda", () => {
    const html = renderToStaticMarkup(<AlertModeControl label="Cuando llega un paciente mío" value="visual" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Cuando llega un paciente mío"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>Visual</);
    expect(html).toContain(">Visual y sonido<");
    expect(html).toContain(">Apagado<");
    expect(html).toContain("Probar sonido");
    expect(html).toContain(SOUND_BLOCKED_NOTE);
  });

  it("[FX2b a11y] radiogroup: roving tabindex (solo el marcado en el orden de Tab), ≥ 32 px, ayuda en navy-500", () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(
        <AlertModeControl label="Cuando llega un paciente mío" value="sound" onChange={() => {}} compact={compact} />,
      );
      const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
      expect(radios).toHaveLength(3);
      expect(radios.map((r) => /tabindex="0"/.test(r))).toEqual([false, true, false]);
      expect(radios.filter((r) => /tabindex="-1"/.test(r))).toHaveLength(2);
      for (const r of radios) expect(r).toContain("min-height:32px");
      // «Probar sonido» también a 32 px en el compacto.
      expect(html).toMatch(/<button[^>]*height:32px[^>]*>Probar sonido</);
      expect(html).not.toContain("var(--navy-300)");
    }
  });

  it("[FX2b a11y] flechas, Inicio y Fin (con vuelta); otras teclas no son del grupo", () => {
    expect(alertRadioKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(alertRadioKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(alertRadioKeyTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(alertRadioKeyTarget("ArrowUp", 1, 3)).toBe(0);
    expect(alertRadioKeyTarget("Home", 2, 3)).toBe(0);
    expect(alertRadioKeyTarget("End", 0, 3)).toBe(2);
    expect(alertRadioKeyTarget("Tab", 0, 3)).toBeNull();
    expect(alertRadioKeyTarget(" ", 0, 3)).toBeNull();
  });
});

/**
 * [FX3] Bundle (§18.10 punto 7): `ArrivalAlerts` y `AppShell` van en el first-load
 * de TODAS las rutas del workspace. El motor (con `lib/arrival-alert-state`, el
 * chime y el título) entra por `import()` solo si `alertsShouldRun`, y los
 * controles solo los importan Configuración y la agenda.
 */
describe("[FX3] avisos · bundle liviano", () => {
  const read = (f: string) => readFileSync(resolve(process.cwd(), f), "utf8");
  const staticValueImport = (src: string, mod: string) => {
    const m = mod.replace(/[/.@-]/g, (c) => `\\${c}`);
    return (
      new RegExp(`^\\s*import\\s+(?!type\\b)[^;]*?from\\s+["']${m}["']`, "m").test(src) ||
      new RegExp(`^\\s*export\\s+(?!type\\b)[^;]*?from\\s+["']${m}["']`, "m").test(src)
    );
  };
  const HEAVY = [
    "@/components/providers/arrival-alerts-engine",
    "@/components/realtime/alert-prefs-controls",
    "@/lib/arrival-alert-state",
    "@/lib/arrival-chime",
    "@/lib/tab-title",
  ];

  it("ni el provider de avisos ni el AppShell importan estáticamente el motor ni los controles", () => {
    for (const f of ["components/providers/arrival-alerts.tsx", "components/layout/app-shell.tsx"]) {
      const src = read(f);
      for (const mod of HEAVY) expect(staticValueImport(src, mod), `${f} → ${mod}`).toBe(false);
    }
    expect(read("components/providers/arrival-alerts.tsx")).toMatch(
      /import\(\s*["']@\/components\/providers\/arrival-alerts-engine["']\s*\)/,
    );
    // El detector sí ve un import de valor (no es un falso verde).
    expect(staticValueImport('import {\n  x,\n} from "@/lib/tab-title";', "@/lib/tab-title")).toBe(true);
    expect(staticValueImport('import type { X } from "@/lib/tab-title";', "@/lib/tab-title")).toBe(false);
  });

  it("alertsShouldRun (inlineado) coincide con effectivePrefs en todas las combinaciones", () => {
    const modes = ["off", "visual", "sound"] as const;
    const viewers: AlertViewer[] = [
      AP,
      SECRE,
      { practitionerId: "pA", canOperateAll: true },
      { practitionerId: null, canOperateAll: false },
    ];
    for (const v of viewers)
      for (const a of modes)
        for (const c of modes)
          for (const live of [true, false]) {
            const prefs: AlertPrefs = { arrivalAlert: a, callAlert: c };
            const eff = effectivePrefs(v, prefs);
            expect(alertsShouldRun(v, prefs, live)).toBe(live && (eff.arrival !== "off" || eff.call !== "off"));
          }
  });
});
