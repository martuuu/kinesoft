/**
 * HF-1b / HF-1c (§22.2 H-RT1..3, §22.4) · cliente realtime: polling con driver off, indicador con motivo y detalle,
 * beacon una vez por código, y avisos de llegada solo con `salaEspera`.
 *
 * Sin jsdom no corren effects: `createVisiblePoller` y `createDiagBeacon` son los objetos que el provider usa en su
 * effect (no copias) y se testean directo con timers fake. El AppShell se renderiza de verdad, con `ArrivalAlerts`
 * reemplazado por un espía del prop `live` (lo que se cuida es el cableado del shell, no el motor).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/agenda",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/components/layout/tweaks-context", async (orig) => ({
  ...(await orig<typeof import("@/components/layout/tweaks-context")>()),
  useTweaks: () => ({
    t: { palette: "sky", dashChrome: "sidebar", sidebarCollapsed: true, minimised: true },
    set: () => {},
    agenda: { agendaShowWeekHeader: true, agendaShowSaturday: true, agendaShowSunday: false },
    setAgenda: () => {},
  }),
}));
const alerts = vi.hoisted(() => ({ live: [] as Array<boolean | undefined> }));
vi.mock("@/components/providers/arrival-alerts", () => ({
  ArrivalAlerts: ({ children, live }: { children: React.ReactNode; live?: boolean }) => {
    alerts.live.push(live);
    return <>{children}</>;
  },
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/notifications", () => ({
  listNotifications: async () => ({ rows: [], unread: 0 }),
  markAllNotificationsRead: async () => ({ ok: true }),
  markNotificationRead: async () => ({ ok: true }),
}));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));

import { AppShell, arrivalAlertsLive } from "@/components/layout/app-shell";
import {
  OFF_POLL_INTERVAL_MS,
  createDiagBeacon,
  createVisiblePoller,
  type RealtimeResyncReason,
} from "@/components/providers/realtime-provider";
import { LiveIndicator, liveIndicatorLabel, liveIndicatorTitle } from "@/components/realtime/live-indicator";
import { diagSteps } from "@/components/realtime/live-diagnostics";
import { POLL_INTERVAL_MS } from "@/lib/realtime-client-state";
import type { RealtimeDiag } from "@/lib/realtime-client-types";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const AUTH: RealtimeDiag = {
  step: "join",
  code: "auth",
  reason: "Unauthorized: invalid JWT signature",
  permanent: true,
  at: Date.parse("2026-10-18T13:42:00.000Z"),
};

describe("[HF-1b] driver off · polling visible", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("[HF-1b] driver off → resync cada 60 s solo visible", () => {
    const tab = { visible: true };
    const got: RealtimeResyncReason[] = [];
    const p = createVisiblePoller({ onPoll: (r) => got.push(r), isVisible: () => tab.visible });
    p.start();
    vi.advanceTimersByTime(OFF_POLL_INTERVAL_MS - 1);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(got).toEqual(["poll"]);
    vi.advanceTimersByTime(OFF_POLL_INTERVAL_MS);
    expect(got).toEqual(["poll", "poll"]);
    // Oculta: ni un pedido en 10 min.
    tab.visible = false;
    p.handleVisibility(false);
    vi.advanceTimersByTime(10 * OFF_POLL_INTERVAL_MS);
    expect(got).toEqual(["poll", "poll"]);
    // Vuelve: re-pide ya y la cuenta arranca de cero.
    tab.visible = true;
    p.handleVisibility(true);
    expect(got).toEqual(["poll", "poll", "visible"]);
    vi.advanceTimersByTime(OFF_POLL_INTERVAL_MS);
    expect(got).toEqual(["poll", "poll", "visible", "poll"]);
    p.stop();
    vi.advanceTimersByTime(10 * OFF_POLL_INTERVAL_MS);
    p.handleVisibility(true);
    expect(got).toHaveLength(4);
  });

  it("el 60 s inlineado del provider = POLL_INTERVAL_MS del hub", () => {
    expect(OFF_POLL_INTERVAL_MS).toBe(POLL_INTERVAL_MS);
  });

  it("el provider arranca el poller con driver off y ya no deja el `return` pelado (H-RT2)", () => {
    const src = readFileSync(resolve(process.cwd(), "components/providers/realtime-provider.tsx"), "utf8");
    expect(src).toMatch(/if \(driver === "off"\) \{[\s\S]*?return startPoller\(\);\s*\}/);
    expect(src).not.toMatch(/setInterval\(/);
  });
});

describe("[HF-1b] beacon", () => {
  it("una vez por código y por carga de página; null no manda nada", () => {
    const sent: string[] = [];
    const beacon = createDiagBeacon((e) => sent.push(e.message));
    beacon(null);
    beacon(AUTH);
    beacon({ ...AUTH, at: AUTH.at + 300_000 });
    beacon({ ...AUTH, step: "mint", code: "no_access", reason: "No tenés acceso" });
    expect(sent).toEqual(["realtime join/auth: Unauthorized: invalid JWT signature", "realtime mint/no_access: No tenés acceso"]);
  });

  it("un send que tira no rompe", () => {
    const beacon = createDiagBeacon(() => {
      throw new Error("x");
    });
    expect(() => beacon(AUTH)).not.toThrow();
  });
});

describe("[HF-1b] LiveIndicator · motivo y detalle", () => {
  it("fuera de vivo: motivo en title, botón «Ver detalle» con el motivo en su aria-label", () => {
    expect(liveIndicatorTitle("polling", AUTH)).toBe(
      "Sin conexión en vivo · se actualiza cada 60 s. El servidor rechazó la conexión",
    );
    const html = renderToStaticMarkup(<LiveIndicator state="polling" diag={AUTH} />);
    expect(html).toContain('title="Sin conexión en vivo · se actualiza cada 60 s. El servidor rechazó la conexión"');
    expect(html).toContain('data-diag="auth"');
    expect(html).toMatch(
      /<button type="button"[^>]*aria-haspopup="dialog" aria-label="Ver detalle de la conexión: [^"]*El servidor rechazó la conexión" data-live-detail[^>]*>Ver detalle<\/button>/,
    );
    // El panel no se monta cerrado (ni baja su chunk).
    expect(html).not.toContain("Pasos de la conexión");
    const compact = renderToStaticMarkup(<LiveIndicator state="polling" diag={AUTH} compact />);
    expect(compact).toMatch(/role="img"[^>]*aria-label="[^"]*El servidor rechazó la conexión"/);
    // Sin diag (fuera del provider) no hay botón.
    expect(renderToStaticMarkup(<LiveIndicator state="polling" />)).not.toContain("data-live-detail");
    expect(renderToStaticMarkup(<LiveIndicator state="live" diag={AUTH} />)).not.toContain("data-live-detail");
  });

  it("versión vieja: el badge pide recargar", () => {
    const stale: RealtimeDiag = { ...AUTH, step: "import", code: "stale_build", reason: "Loading chunk failed" };
    expect(liveIndicatorLabel("polling", stale)).toBe("Hay una versión nueva · Recargá");
    expect(liveIndicatorTitle("polling", stale)).toBe("Hay una versión nueva · Recargá");
    expect(renderToStaticMarkup(<LiveIndicator state="polling" diag={stale} />)).toContain(
      '<span class="k-live-dot" aria-hidden="true"></span>Hay una versión nueva · Recargá',
    );
  });

  it("en vivo, un diag viejo no cambia nada", () => {
    expect(liveIndicatorTitle("live", AUTH)).toBe("En vivo");
  });

  it("pasos ✓/✗: falló el join → ✓ hasta el socket; en vivo todo ✓; arrancando todo pendiente", () => {
    expect(diagSteps("polling", AUTH).map((r) => r.status)).toEqual(["ok", "ok", "ok", "ok", "fail"]);
    expect(diagSteps("polling", { ...AUTH, step: "mint" }).map((r) => r.status)).toEqual([
      "ok",
      "ok",
      "fail",
      "pending",
      "pending",
    ]);
    expect(diagSteps("live", null).every((r) => r.status === "ok")).toBe(true);
    expect(diagSteps("reconnecting", null).every((r) => r.status === "pending")).toBe(true);
  });

  it("el detalle baja dinámico: el indicador no lo importa estático", () => {
    const src = readFileSync(resolve(process.cwd(), "components/realtime/live-indicator.tsx"), "utf8");
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+["']\.\/live-diagnostics["']/m);
    expect(src).toMatch(/dynamic\(\s*\(\)\s*=>\s*import\(\s*["']\.\/live-diagnostics["']\s*\)/);
  });
});

describe("[HF-1c] avisos de llegada", () => {
  const OWNER = Array.from(capabilitiesFor("OWNER"));
  function shell(plan: "CLINICA" | "CONSULTORIO", driver: "supabase" | "off") {
    alerts.live = [];
    renderToStaticMarkup(
      <AppShell
        modules={Array.from(modulesFor({ vertical: "KINESIOLOGY", plan, publicBookingEnabled: false }))}
        caps={OWNER}
        realtime={{ driver, tenantId: "t1", url: "https://x.supabase.co", anonKey: "k" }}
        alertViewer={{ practitionerId: "p1", canOperateAll: true }}
        initialAlertPrefs={{ arrivalAlert: "sound", callAlert: "sound" } as never}
        userName="Ana"
      >
        <p>x</p>
      </AppShell>,
    );
    return alerts.live.at(-1);
  }

  it("[HF-1c] ArrivalAlerts sin salaEspera no arranca aunque haya canal", () => {
    expect(modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: false })).not.toContain(
      "salaEspera",
    );
    expect(shell("CONSULTORIO", "supabase")).toBe(false);
    expect(shell("CLINICA", "supabase")).toBe(true);
    expect(shell("CLINICA", "off")).toBe(false);
    expect(arrivalAlertsLive({ driver: "local" }, ["salaEspera"])).toBe(true);
    expect(arrivalAlertsLive({ driver: "local" }, [])).toBe(false);
  });
});
